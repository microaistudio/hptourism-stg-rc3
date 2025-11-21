import express from "express";
import { z } from "zod";
import { and, desc, eq, inArray } from "drizzle-orm";
import { requireAuth } from "../core/middleware";
import { storage } from "../../storage";
import { db } from "../../db";
import { homestayApplications, documents } from "@shared/schema";
import { deriveDistrictRoutingLabel } from "@shared/districtRouting";
import { MAX_ROOMS_ALLOWED } from "@shared/fee-calculator";
import {
  DEFAULT_EXISTING_RC_MIN_ISSUE_DATE,
  EXISTING_RC_MIN_ISSUE_DATE_SETTING_KEY,
  normalizeIsoDateSetting,
} from "@shared/appSettings";
import { getSystemSettingRecord } from "../../services/systemSettings";
import {
  LEGACY_LOCATION_TYPES,
  generateLegacyApplicationNumber,
} from "../helpers/legacy";
import { trimOptionalString, trimRequiredString, parseIsoDateOrNull } from "../helpers/format";
import { removeUndefined } from "../helpers/object";
import { isPgUniqueViolation } from "../helpers/db";
import { linkDocumentToStorage } from "../../storageManifest";
import { logger } from "../../logger";

const existingOwnersLog = logger.child({ module: "existing-owners-router" });

const uploadedFileSchema = z.object({
  fileName: z.string().min(1),
  filePath: z.string().min(1),
  fileSize: z.number().int().nonnegative().optional(),
  mimeType: z.string().min(3).optional(),
});

const existingOwnerIntakeSchema = z.object({
  ownerName: z.string().min(3),
  ownerMobile: z.string().min(6),
  ownerEmail: z.string().email().optional().or(z.literal("")),
  propertyName: z.string().min(3),
  district: z.string().min(2),
  tehsil: z.string().min(2),
  address: z.string().min(5),
  pincode: z.string().min(4),
  locationType: z.enum(LEGACY_LOCATION_TYPES),
  totalRooms: z.coerce.number().int().min(1).max(MAX_ROOMS_ALLOWED),
  guardianName: z.string().min(3),
  rcNumber: z.string().min(3),
  rcIssueDate: z.string().min(4),
  rcExpiryDate: z.string().min(4),
  notes: z.string().optional(),
  certificateDocuments: z.array(uploadedFileSchema).min(1),
  identityProofDocuments: z.array(uploadedFileSchema).min(1),
});

const getExistingOwnerIntakeCutoff = async () => {
  const record = await getSystemSettingRecord(EXISTING_RC_MIN_ISSUE_DATE_SETTING_KEY);
  const iso = normalizeIsoDateSetting(record?.settingValue, DEFAULT_EXISTING_RC_MIN_ISSUE_DATE);
  return parseIsoDateOrNull(iso) ?? parseIsoDateOrNull(DEFAULT_EXISTING_RC_MIN_ISSUE_DATE) ?? new Date("2022-01-01");
};

const findActiveExistingOwnerRequest = async (userId: string) => {
  const [application] = await db
    .select({
      id: homestayApplications.id,
      applicationNumber: homestayApplications.applicationNumber,
      status: homestayApplications.status,
      createdAt: homestayApplications.createdAt,
    })
    .from(homestayApplications)
    .where(
      and(
        eq(homestayApplications.userId, userId),
        inArray(homestayApplications.status, ['legacy_rc_review']),
      ),
    )
    .orderBy(desc(homestayApplications.createdAt))
    .limit(1);

  return application ?? null;
};

const findApplicationByCertificateNumber = async (certificateNumber: string) => {
  const normalized = certificateNumber?.trim();
  if (!normalized) {
    return null;
  }

  const [application] = await db
    .select({
      id: homestayApplications.id,
      applicationNumber: homestayApplications.applicationNumber,
      status: homestayApplications.status,
      userId: homestayApplications.userId,
    })
    .from(homestayApplications)
    .where(eq(homestayApplications.certificateNumber, normalized))
    .limit(1);

  return application ?? null;
};

export function createExistingOwnersRouter() {
  const router = express.Router();

  router.get("/settings", requireAuth, async (_req, res) => {
    try {
      const cutoff = await getExistingOwnerIntakeCutoff();
      res.json({ minIssueDate: cutoff.toISOString() });
    } catch (error) {
      existingOwnersLog.error({ err: error, route: "GET /settings" }, "Failed to load intake settings");
      res.status(500).json({ message: "Unable to load onboarding settings" });
    }
  });

  router.get("/active", requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId!;
      const application = await findActiveExistingOwnerRequest(userId);
      res.json({ application });
    } catch (error) {
      existingOwnersLog.error({ err: error, route: "GET /active" }, "Failed to load active onboarding request");
      res.status(500).json({ message: "Unable to load active onboarding request" });
    }
  });

  router.post("/", requireAuth, async (req, res) => {
    try {
      const payload = existingOwnerIntakeSchema.parse(req.body ?? {});
      const userId = req.session.userId!;
      const user = await storage.getUser(userId);

      if (!user) {
        return res.status(401).json({ message: "User not found" });
      }

      if (!user.aadhaarNumber) {
        return res.status(400).json({
          message: "Please add your Aadhaar number in profile before submitting existing owner intake.",
        });
      }

      const existingActive = await findActiveExistingOwnerRequest(userId);
      if (existingActive) {
        return res.status(409).json({
          message: "We already captured your existing license request. Please wait for the Admin-RC desk to verify.",
          applicationId: existingActive.id,
        });
      }

      const certificateIssuedDate = parseIsoDateOrNull(payload.rcIssueDate);
      const certificateExpiryDate = parseIsoDateOrNull(payload.rcExpiryDate);

      if (!certificateIssuedDate || !certificateExpiryDate) {
        return res.status(400).json({ message: "Invalid certificate dates provided" });
      }

      const cutoffDate = await getExistingOwnerIntakeCutoff();
      if (certificateIssuedDate < cutoffDate) {
        return res.status(400).json({
          message: `Certificates issued before ${cutoffDate.toISOString().slice(0, 10)} are not eligible for onboarding.`,
        });
      }
      if (certificateExpiryDate <= certificateIssuedDate) {
        return res.status(400).json({ message: "Certificate expiry must be after the issue date" });
      }

      const now = new Date();
      const routedLegacyDistrict =
        deriveDistrictRoutingLabel(payload.district, payload.tehsil) ?? payload.district;
      const applicationNumber = generateLegacyApplicationNumber(routedLegacyDistrict);
      const sanitizedGuardian = trimOptionalString(payload.guardianName);
      const sanitizedNotes = trimOptionalString(payload.notes);
      const derivedAreaSqm = Math.max(50, payload.totalRooms * 30);

      const [application] = await db
        .insert(homestayApplications)
        .values({
          userId,
          applicationNumber,
          applicationKind: 'renewal',
          propertyName: trimRequiredString(payload.propertyName),
          category: 'silver',
          locationType: payload.locationType,
          totalRooms: payload.totalRooms,
          singleBedRooms: payload.totalRooms,
          doubleBedRooms: 0,
          familySuites: 0,
          attachedWashrooms: payload.totalRooms,
          district: trimRequiredString(routedLegacyDistrict),
          tehsil: trimRequiredString(payload.tehsil),
          block: null,
          gramPanchayat: null,
          address: trimRequiredString(payload.address),
          pincode: trimRequiredString(payload.pincode),
          ownerName: trimRequiredString(payload.ownerName),
          ownerMobile: trimRequiredString(payload.ownerMobile || user.mobile || ""),
          ownerEmail: trimOptionalString(payload.ownerEmail) ?? user.email ?? null,
          ownerAadhaar: user.aadhaarNumber,
          ownerGender: 'other',
          propertyOwnership: 'owned',
          projectType: 'existing_property',
          propertyArea: String(derivedAreaSqm),
          guardianName: sanitizedGuardian ?? null,
          rooms: [
            {
              roomType: "Declared Rooms",
              size: 0,
              count: payload.totalRooms,
            },
          ],
          status: 'legacy_rc_review',
          currentStage: 'legacy_rc_review',
          submittedAt: now,
          createdAt: now,
          updatedAt: now,
          certificateNumber: trimRequiredString(payload.rcNumber),
          certificateIssuedDate,
          certificateExpiryDate,
          parentCertificateNumber: trimRequiredString(payload.rcNumber),
          parentApplicationNumber: trimRequiredString(payload.rcNumber),
          serviceNotes:
            sanitizedNotes ??
            `Existing owner onboarding request captured on ${now.toLocaleDateString()} with RC #${payload.rcNumber}.`,
          serviceContext: removeUndefined({
            requestedRooms: {
              total: payload.totalRooms,
            },
            legacyGuardianName: sanitizedGuardian ?? undefined,
            inheritsCertificateExpiry: certificateExpiryDate.toISOString(),
            requiresPayment: false,
            note: sanitizedNotes ?? undefined,
            legacyOnboarding: true,
          }),
        })
        .returning();

      if (!application) {
        throw new Error("Failed to create legacy onboarding record");
      }

      const certificateDocuments = payload.certificateDocuments.map((file) => ({
        applicationId: application.id,
        documentType: "legacy_certificate",
        fileName: file.fileName,
        filePath: file.filePath,
        fileSize: Math.max(1, Math.round(file.fileSize ?? 0)),
        mimeType: file.mimeType || "application/pdf",
      }));

      const identityProofDocuments = payload.identityProofDocuments.map((file) => ({
        applicationId: application.id,
        documentType: "owner_identity_proof",
        fileName: file.fileName,
        filePath: file.filePath,
        fileSize: Math.max(1, Math.round(file.fileSize ?? 0)),
        mimeType: file.mimeType || "application/pdf",
      }));

      if (certificateDocuments.length > 0) {
        const insertedCertificateDocs = await db.insert(documents).values(certificateDocuments).returning();
        for (const doc of insertedCertificateDocs) {
          await linkDocumentToStorage(doc);
        }
      }
      if (identityProofDocuments.length > 0) {
        const insertedIdentityDocs = await db.insert(documents).values(identityProofDocuments).returning();
        for (const doc of insertedIdentityDocs) {
          await linkDocumentToStorage(doc);
        }
      }

      res.status(201).json({
        message: "Existing owner submission received. An Admin-RC editor will verify the certificate shortly.",
        application: {
          id: application.id,
          applicationNumber: application.applicationNumber,
          status: application.status,
        },
      });
    } catch (error) {
      existingOwnersLog.error({ err: error, route: "POST /" }, "Failed to capture onboarding request");
      if (isPgUniqueViolation(error, "homestay_applications_certificate_number_key")) {
        const certificateNumber = typeof req.body?.rcNumber === "string" ? req.body.rcNumber : undefined;
        if (certificateNumber) {
          const existing = await findApplicationByCertificateNumber(certificateNumber);
          if (existing) {
            return res.status(409).json({
              message:
                "This RC / certificate number is already registered in the system. Please open the captured request instead of submitting a new one.",
              applicationId: existing.id,
            });
          }
        }
        return res.status(409).json({
          message: "This RC / certificate number already exists in the system.",
        });
      }
      if (error instanceof z.ZodError) {
        return res.status(400).json({ message: "Invalid input", errors: error.flatten() });
      }
      res.status(500).json({ message: "Failed to submit onboarding request" });
    }
  });

  return router;
}
