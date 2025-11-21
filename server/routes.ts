import type { Express, Request, Response, NextFunction } from "express";
import { createServer, type Server } from "http";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import { Pool as PgPool } from "pg";
import { pool, db } from "./db";
import { storage } from "./storage";
import { logApplicationAction } from "./audit";
import { logger, logHttpTrace } from "./logger";
import { authRateLimiter, uploadRateLimiter } from "./security/rateLimit";
import { config as appConfig } from "@shared/config";
import {
  HIMKOSH_GATEWAY_SETTING_KEY,
  HimkoshGatewaySettingValue,
  resolveHimkoshGatewayConfig,
  trimMaybe as trimHimkoshString,
  parseOptionalNumber as parseOptionalHimkoshNumber,
} from "./himkosh/gatewayConfig";
import { HimKoshCrypto, buildRequestString } from "./himkosh/crypto";
import { fetchAllDdoCodes, resolveDistrictDdo } from "./himkosh/ddo";
import type { DbConnectionRecord } from "@shared/dbConfig";
import { updateDbEnvFiles } from "./dbConfigManager";
import {
  type User,
  type HomestayApplication,
  type InsertHomestayApplication,
  type ApplicationServiceContext,
  homestayApplications,
  documents,
  payments,
  productionStats,
  users,
  userProfiles,
  type UserProfile,
  inspectionOrders,
  inspectionReports,
  objections,
  clarifications,
  certificates,
  notifications,
  applicationActions,
  reviews,
  auditLogs,
  himkoshTransactions,
  ddoCodes,
  systemSettings,
  type SystemSetting,
  lgdDistricts,
  lgdTehsils,
  lgdBlocks,
  lgdGramPanchayats,
  lgdUrbanBodies
} from "@shared/schema";
import {
  DEFAULT_UPLOAD_POLICY,
  UPLOAD_POLICY_SETTING_KEY,
  type UploadPolicy,
  normalizeUploadPolicy,
} from "@shared/uploadPolicy";
import {
  DEFAULT_CATEGORY_ENFORCEMENT,
  DEFAULT_CATEGORY_RATE_BANDS,
  DEFAULT_ROOM_CALC_MODE,
  ENFORCE_CATEGORY_SETTING_KEY,
  ROOM_RATE_BANDS_SETTING_KEY,
  ROOM_CALC_MODE_SETTING_KEY,
  DA_SEND_BACK_SETTING_KEY,
  LEGACY_DTD0_FORWARD_SETTING_KEY,
  LOGIN_OTP_SETTING_KEY,
  EXISTING_RC_MIN_ISSUE_DATE_SETTING_KEY,
  DEFAULT_EXISTING_RC_MIN_ISSUE_DATE,
  normalizeCategoryEnforcementSetting,
  normalizeCategoryRateBands,
  normalizeRoomCalcModeSetting,
  normalizeBooleanSetting,
  normalizeIsoDateSetting,
} from "@shared/appSettings";
import { deriveDistrictRoutingLabel } from "@shared/districtRouting";
import { isLegacyApplication as isLegacyApplicationRecord } from "@shared/legacy";
import express from "express";
import { randomUUID, randomInt, createHash } from "crypto";
import path from "path";
import fs from "fs";
import fsPromises from "fs/promises";
import { z } from "zod";
import bcrypt from "bcrypt";
import { eq, desc, asc, ne, notInArray, and, or, sql, gte, lte, like, ilike, inArray, type AnyColumn } from "drizzle-orm";
import { startScraperScheduler } from "./scraper";
import { ObjectStorageService, OBJECT_STORAGE_MODE, LOCAL_OBJECT_DIR, LOCAL_MAX_UPLOAD_BYTES } from "./objectStorage";
import {
  linkDocumentToStorage,
  buildLocalObjectKey,
  upsertStorageMetadata,
  markStorageObjectAccessed,
} from "./storageManifest";
import { differenceInCalendarDays, format, subDays } from "date-fns";
import {
  DEFAULT_EMAIL_BODY,
  DEFAULT_EMAIL_SUBJECT,
  DEFAULT_SMS_BODY,
  sendTestEmail,
  sendTestSms,
  sendTwilioSms,
  sendNicV2Sms,
} from "./services/communications";
import type { SmsGatewayV2Settings } from "./services/communications";
import himkoshRoutes from "./himkosh/routes";
import { MAX_ROOMS_ALLOWED, MAX_BEDS_ALLOWED, validateCategorySelection } from "@shared/fee-calculator";
import type { CategoryType } from "@shared/fee-calculator";
import {
  lookupStaffAccountByIdentifier,
  lookupStaffAccountByMobile,
  getDistrictStaffManifest,
} from "@shared/districtStaffManifest";
import { formatUserForResponse } from "./routes/core/users";
import {
  CAPTCHA_SETTING_KEY,
  getCaptchaSetting,
  shouldBypassCaptcha,
  updateCaptchaSettingCache,
} from "./routes/core/captcha";
import "./staffManifestSync";
import { getSystemSettingRecord } from "./services/systemSettings";
import { requireAuth, requireRole } from "./routes/core/middleware";
import {
  createLoginOtpChallenge,
  createPasswordResetChallenge,
  findUserByIdentifier,
  getLoginOtpSetting,
  maskEmailAddress,
  maskMobileNumber,
  type PasswordResetChannel,
} from "./routes/auth/utils";
import { createAuthRouter, createProfileRouter } from "./routes/auth";
import {
  EMAIL_GATEWAY_SETTING_KEY,
  SMS_GATEWAY_SETTING_KEY,
  NOTIFICATION_RULES_SETTING_KEY,
  sanitizeEmailGateway,
  sanitizeSmsGateway,
  buildNotificationResponse,
  notificationEventDefinitions,
  queueNotification,
  resolveNotificationChannelState,
  createInAppNotification,
  emailProviders,
  formatGatewaySetting,
  type EmailGatewayProvider,
  type EmailGatewaySettingValue,
  type EmailGatewaySecretSettings,
  type SmsGatewayProvider,
  type SmsGatewaySettingValue,
  type NotificationSettingsValue,
  type NotificationRuleValue,
  type NicSmsGatewaySettings,
  type TwilioSmsGatewaySecretSettings,
  type NotificationEventId,
  extractLegacyEmailProfile,
  getEmailProfileFromValue,
} from "./services/notifications";
import {
  BYTES_PER_MB,
  normalizeMime,
  getExtension,
  validateDocumentsAgainstPolicy,
  type NormalizedDocumentRecord,
} from "./services/documentValidation";
import { createApplicationsRouter } from "./routes/applications";
import { createOwnerApplicationsRouter } from "./routes/applications/owner";
import { createServiceCenterRouter } from "./routes/applications/service-center";
import { createExistingOwnersRouter } from "./routes/applications/existing-owners";
import { createUploadRouter } from "./routes/uploads";
import { trimOptionalString, trimRequiredString, parseIsoDateOrNull } from "./routes/helpers/format";
import { removeUndefined } from "./routes/helpers/object";
import { districtsMatch, buildDistrictWhereClause } from "./routes/helpers/district";
import { summarizeTimelineActor } from "./routes/helpers/timeline";
import {
  ADMIN_RC_ALLOWED_ROLES,
  LEGACY_CATEGORY_OPTIONS,
  LEGACY_LOCATION_TYPES,
  LEGACY_OWNER_GENDERS,
  LEGACY_PROPERTY_OWNERSHIP,
  LEGACY_RC_PREFIX,
  LEGACY_STATUS_OPTIONS,
} from "./routes/helpers/legacy";
import { isPgUniqueViolation } from "./routes/helpers/db";
import { CORRECTION_CONSENT_TEXT } from "./routes/constants";

// Extend express-session types
declare module "express-session" {
  interface SessionData {
    userId: string;
    captchaAnswer?: string | null;
    captchaIssuedAt?: number | null;
  }
}

const routeLog = logger.child({ module: "routes" });
const notificationDefinitionMap = new Map(
  notificationEventDefinitions.map((def) => [def.id, def]),
);
const adminHimkoshCrypto = new HimKoshCrypto();
const DB_CONNECTION_SETTING_KEY = "db_connection_settings";
type DbConnectionSettingValue = DbConnectionRecord;

const parseDatabaseUrlFromEnv = (): DbConnectionSettingValue | null => {
  try {
    const urlString = appConfig.database.url;
    if (!urlString) {
      return null;
    }
    const parsed = new URL(urlString);
    const database = parsed.pathname.replace(/^\//, "");
    if (!parsed.hostname || !database || !parsed.username) {
      return null;
    }
    return {
      host: parsed.hostname,
      port: parsed.port ? Number(parsed.port) : 5432,
      database,
      user: decodeURIComponent(parsed.username),
      password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
      lastAppliedAt: null,
      lastVerifiedAt: null,
      lastVerificationResult: null,
      lastVerificationMessage: null,
    };
  } catch (error) {
    routeLog.warn("[db-config] Failed to parse DATABASE_URL", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
};

const getDbConnectionSettings = async (): Promise<DbConnectionSettingValue | null> => {
  const [record] = await db
    .select()
    .from(systemSettings)
    .where(eq(systemSettings.settingKey, DB_CONNECTION_SETTING_KEY))
    .limit(1);
  if (!record?.settingValue) {
    return null;
  }
  return record.settingValue as DbConnectionSettingValue;
};

const saveDbConnectionSettings = async (
  value: DbConnectionSettingValue,
  userId: string | null,
) => {
  const [existing] = await db
    .select({ key: systemSettings.settingKey })
    .from(systemSettings)
    .where(eq(systemSettings.settingKey, DB_CONNECTION_SETTING_KEY))
    .limit(1);

  if (existing) {
    await db
      .update(systemSettings)
      .set({
        settingValue: value,
        updatedAt: new Date(),
        updatedBy: userId,
        description: "External database connection",
        category: "infrastructure",
      })
      .where(eq(systemSettings.settingKey, DB_CONNECTION_SETTING_KEY));
  } else {
    await db.insert(systemSettings).values({
      settingKey: DB_CONNECTION_SETTING_KEY,
      settingValue: value,
      updatedBy: userId,
      description: "External database connection",
      category: "infrastructure",
    });
  }
};

const normalizeStringField = (value: unknown, fallback = "", maxLength?: number) => {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (!trimmed) {
    return fallback;
  }
  if (typeof maxLength === "number" && maxLength > 0 && trimmed.length > maxLength) {
    return trimmed.slice(0, maxLength);
  }
  return trimmed;
};

const toNullableString = (value: unknown, maxLength?: number) => {
  const normalized = normalizeStringField(value, "", maxLength);
  return normalized || null;
};

const preprocessNumericInput = (val: unknown) => {
  if (typeof val === "number") {
    return Number.isNaN(val) ? undefined : val;
  }
  if (typeof val === "string") {
    const trimmed = val.trim();
    if (!trimmed || trimmed.toLowerCase() === "nan") {
      return undefined;
    }
    const parsed = Number(trimmed);
    return Number.isNaN(parsed) ? undefined : trimmed;
  }
  return val;
};

const coerceNumberField = (value: unknown, fallback = 0) => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallback;
};

const toDateOnly = (value: Date) => {
  const normalized = new Date(value);
  normalized.setHours(0, 0, 0, 0);
  return normalized;
};

const EARLY_INSPECTION_OVERRIDE_WINDOW_DAYS = 7;

const STAFF_PROFILE_ROLES = ['dealing_assistant', 'district_tourism_officer', 'district_officer'] as const;

const staffProfileSchema = z.object({
  fullName: z.string().min(3, "Full name must be at least 3 characters"),
  firstName: z.string().min(1).optional().or(z.literal("")),
  lastName: z.string().min(1).optional().or(z.literal("")),
  mobile: z.string().regex(/^[6-9]\d{9}$/, "Enter a valid 10-digit mobile number"),
  email: z.string().email("Enter a valid email address").optional().or(z.literal("")),
  alternatePhone: z.string().regex(/^[6-9]\d{9}$/, "Enter a valid 10-digit alternate number").optional().or(z.literal("")),
  officePhone: z.string().regex(/^[0-9+\-()\s]{5,20}$/, "Enter a valid office contact number").optional().or(z.literal("")),
  designation: z.string().max(120, "Designation must be 120 characters or fewer").optional().or(z.literal("")),
  department: z.string().max(120, "Department must be 120 characters or fewer").optional().or(z.literal("")),
  employeeId: z.string().max(50, "Employee ID must be 50 characters or fewer").optional().or(z.literal("")),
  officeAddress: z.string().max(500, "Office address must be 500 characters or fewer").optional().or(z.literal("")),
});

const numberOrNull = (value: number | null | undefined) => {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof value !== "number" || Number.isNaN(value)) {
    return null;
  }
  return value;
};

const sanitizeHimkoshGatewaySetting = (value?: HimkoshGatewaySettingValue | null) => {
  if (!value) return null;
  return {
    merchantCode: value.merchantCode ?? "",
    deptId: value.deptId ?? "",
    serviceCode: value.serviceCode ?? "",
    ddo: value.ddo ?? "",
    head1: value.head1 ?? "",
    head2: value.head2 ?? "",
    head2Amount: typeof value.head2Amount === "number" ? value.head2Amount : null,
    returnUrl: value.returnUrl ?? "",
    allowFallback: value.allowFallback !== false,
  };
};

const getLegacyForwardEnabled = async () => {
  const record = await getSystemSettingRecord(LEGACY_DTD0_FORWARD_SETTING_KEY);
  return normalizeBooleanSetting(record?.settingValue, true);
};

const isServiceApplicationKind = (kind?: HomestayApplication["applicationKind"] | null) =>
  Boolean(kind && kind !== "new_registration");

const toNumberFromUnknown = (value: unknown) => {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

const decimalToString = (value?: number | null) =>
  value === undefined || value === null ? null : String(value);

const canViewInspectionReport = (user: User | null, application: HomestayApplication | null) => {
  if (!user || !application) {
    return false;
  }

  if (user.role === "property_owner") {
    return user.id === application.userId;
  }

  // Other authenticated roles can view inspection reports
  return true;
};


export async function registerRoutes(app: Express): Promise<Server> {
  // PostgreSQL session store for production
  const PgSession = connectPgSimple(session);
  
  // Session middleware
  app.use(
    session({
      store: new PgSession({
        pool: pool,
        tableName: 'session',
        createTableIfMissing: true,
      }),
      secret: process.env.SESSION_SECRET || "hp-tourism-secret-dev-only",
      resave: false,
      saveUninitialized: false,
      cookie: {
        secure: false, // Set to false for HTTP (non-HTTPS) deployments
        httpOnly: true,
        maxAge: 1000 * 60 * 60 * 24 * 7, // 7 days
      },
    })
  );

  app.use((req, _res, next) => {
    if (req.path.startsWith("/api/admin/settings")) {
      logHttpTrace("request", {
        method: req.method,
        path: req.path,
        userId: req.session.userId ?? "none",
      });
    }
    next();
  });

  app.use("/api/auth", createAuthRouter());
  app.use("/api/profile", createProfileRouter());
  app.use("/api/applications", createApplicationsRouter());
  app.use(
    "/api/applications",
    createOwnerApplicationsRouter({
      getRoomRateBandsSetting,
    }),
  );
  app.use("/api/service-center", createServiceCenterRouter());
  app.use("/api/existing-owners", createExistingOwnersRouter());

  const getUploadPolicy = async (): Promise<UploadPolicy> => {
    try {
      const [setting] = await db
        .select()
        .from(systemSettings)
        .where(eq(systemSettings.settingKey, UPLOAD_POLICY_SETTING_KEY))
        .limit(1);

      if (!setting) {
        return DEFAULT_UPLOAD_POLICY;
      }

      return normalizeUploadPolicy(setting.settingValue);
    } catch (error) {
      routeLog.error("[upload-policy] Failed to fetch policy, falling back to defaults:", error);
      return DEFAULT_UPLOAD_POLICY;
    }
  };

  app.use("/api", createUploadRouter({ getUploadPolicy }));

  const getCategoryEnforcementSetting = async () => {
    try {
      const [setting] = await db
        .select()
        .from(systemSettings)
        .where(eq(systemSettings.settingKey, ENFORCE_CATEGORY_SETTING_KEY))
        .limit(1);

      if (!setting) {
        return DEFAULT_CATEGORY_ENFORCEMENT;
      }

      return normalizeCategoryEnforcementSetting(setting.settingValue);
    } catch (error) {
      routeLog.error("[category-enforcement] Failed to fetch setting, falling back to defaults:", error);
      return DEFAULT_CATEGORY_ENFORCEMENT;
    }
  };

  async function getRoomRateBandsSetting() {
    try {
      const [setting] = await db
        .select()
        .from(systemSettings)
        .where(eq(systemSettings.settingKey, ROOM_RATE_BANDS_SETTING_KEY))
        .limit(1);

      if (!setting) {
        return DEFAULT_CATEGORY_RATE_BANDS;
      }

      return normalizeCategoryRateBands(setting.settingValue);
    } catch (error) {
      routeLog.error("[room-rate-bands] Failed to fetch setting, falling back to defaults:", error);
      return DEFAULT_CATEGORY_RATE_BANDS;
    }
  }

  const getRoomCalcModeSetting = async () => {
    try {
      const [setting] = await db
        .select()
        .from(systemSettings)
        .where(eq(systemSettings.settingKey, ROOM_CALC_MODE_SETTING_KEY))
        .limit(1);
      if (!setting) {
        return DEFAULT_ROOM_CALC_MODE;
      }
      return normalizeRoomCalcModeSetting(setting.settingValue);
    } catch (error) {
      routeLog.error("[room-calc-mode] Failed to fetch setting, falling back to defaults:", error);
      return DEFAULT_ROOM_CALC_MODE;
    }
  };

  app.get("/api/settings/upload-policy", requireAuth, async (_req, res) => {
    try {
      const policy = await getUploadPolicy();
      res.json(policy);
    } catch (error) {
      routeLog.error("[upload-policy] Failed to fetch policy:", error);
      res.status(500).json({ message: "Failed to fetch upload policy" });
    }
  });

  app.get("/api/settings/category-enforcement", requireAuth, async (_req, res) => {
    try {
      const setting = await getCategoryEnforcementSetting();
      res.json(setting);
    } catch (error) {
      routeLog.error("[category-enforcement] Failed to fetch setting:", error);
      res.status(500).json({ message: "Failed to fetch category enforcement setting" });
    }
  });

  app.get("/api/settings/room-rate-bands", requireAuth, async (_req, res) => {
    try {
      const setting = await getRoomRateBandsSetting();
      res.json(setting);
    } catch (error) {
      routeLog.error("[room-rate-bands] Failed to fetch setting:", error);
      res.status(500).json({ message: "Failed to fetch rate band setting" });
    }
  });

  app.get("/api/settings/room-calc-mode", requireAuth, async (_req, res) => {
    try {
      const setting = await getRoomCalcModeSetting();
      res.json(setting);
    } catch (error) {
      routeLog.error("[room-calc-mode] Failed to fetch setting:", error);
      res.status(500).json({ message: "Failed to fetch room configuration mode" });
    }
  });
  
  // Save application as draft (partial data allowed)
  app.get("/api/dtdo/applications/:id/timeline", requireAuth, async (req, res) => {
    const viewer = await storage.getUser(req.session.userId!);
    if (!viewer || (viewer.role !== 'district_tourism_officer' && viewer.role !== 'district_officer')) {
      return res.status(403).json({ message: "You are not allowed to view this timeline" });
    }
    try {
      const application = await storage.getApplication(req.params.id);
      if (!application) {
        return res.status(404).json({ message: "Application not found" });
      }

      const actions = await storage.getApplicationActions(req.params.id);
      const actorIds = Array.from(
        new Set(
          actions
            .map((action) => action.officerId)
            .filter((value): value is string => Boolean(value)),
        ),
      );
      const actorMap = new Map<string, ReturnType<typeof summarizeTimelineActor>>();
      await Promise.all(
        actorIds.map(async (actorId) => {
          const actor = await storage.getUser(actorId);
          if (actor) {
            actorMap.set(actorId, summarizeTimelineActor(actor));
          }
        }),
      );

      const timeline = actions.map((action) => ({
        id: action.id,
        action: action.action,
        previousStatus: action.previousStatus ?? null,
        newStatus: action.newStatus ?? null,
        feedback: action.feedback ?? null,
        createdAt: action.createdAt,
        actor: action.officerId ? actorMap.get(action.officerId) ?? null : null,
      }));

      res.json({ timeline });
    } catch (error) {
      routeLog.error("[dtdo timeline] Failed to fetch timeline:", error);
      res.status(500).json({ message: "Failed to fetch timeline" });
    }
  });

  app.get("/api/applications/:id/inspection-report", requireAuth, async (req, res) => {
    try {
      const application = await storage.getApplication(req.params.id);
      if (!application) {
        return res.status(404).json({ message: "Application not found" });
      }

      const viewer = await storage.getUser(req.session.userId!);
      if (!canViewInspectionReport(viewer ?? null, application)) {
        return res.status(403).json({ message: "You are not allowed to view this inspection report" });
      }

      const [report] = await db
        .select()
        .from(inspectionReports)
        .where(eq(inspectionReports.applicationId, application.id))
        .orderBy(desc(inspectionReports.submittedDate))
        .limit(1);

      if (!report) {
        return res.status(404).json({ message: "Inspection report not available yet" });
      }

      const [order] = await db
        .select()
        .from(inspectionOrders)
        .where(eq(inspectionOrders.id, report.inspectionOrderId))
        .limit(1);

      const owner = await storage.getUser(application.userId);
      const da = await storage.getUser(report.submittedBy);
      const dtdo = order?.scheduledBy ? await storage.getUser(order.scheduledBy) : application.dtdoId ? await storage.getUser(application.dtdoId) : null;

      res.json({
        report,
        inspectionOrder: order ?? null,
        application: {
          id: application.id,
          applicationNumber: application.applicationNumber,
          propertyName: application.propertyName,
          district: application.district,
          tehsil: application.tehsil,
          address: application.address,
          category: application.category,
          status: application.status,
          siteInspectionOutcome: application.siteInspectionOutcome ?? null,
          siteInspectionNotes: application.siteInspectionNotes ?? null,
          siteInspectionCompletedDate: application.siteInspectionCompletedDate ?? null,
        },
        owner: owner
          ? {
              id: owner.id,
              fullName: owner.fullName,
              mobile: owner.mobile,
              email: owner.email ?? null,
            }
          : null,
        da: da
          ? {
              id: da.id,
              fullName: da.fullName,
              mobile: da.mobile,
              district: da.district ?? null,
            }
          : null,
        dtdo: dtdo
          ? {
              id: dtdo.id,
              fullName: dtdo.fullName,
              mobile: dtdo.mobile,
              district: dtdo.district ?? null,
            }
          : null,
      });
    } catch (error) {
      routeLog.error("[inspection] Failed to fetch inspection report:", error);
      res.status(500).json({ message: "Failed to fetch inspection report" });
    }
  });

  // ========================================
  // DEALING ASSISTANT (DA) ROUTES
  // ========================================

  const handleStaffProfileUpdate = async (req: Request, res: Response) => {
    try {
      const userId = req.session.userId!;
      const payload = staffProfileSchema.parse(req.body);

      const userRecord = await storage.getUser(userId);
      if (!userRecord) {
        return res.status(404).json({ message: "User not found" });
      }

      const normalizedMobile = normalizeStringField(payload.mobile, "", 15);
      if (!normalizedMobile) {
        return res.status(400).json({ message: "Mobile number is required" });
      }

      if (normalizedMobile !== userRecord.mobile) {
        const existingUser = await storage.getUserByMobile(normalizedMobile);
        if (existingUser && existingUser.id !== userRecord.id) {
          return res.status(400).json({ message: "Another account already uses this mobile number" });
        }
      }

      const updates: Partial<User> = {
        fullName: normalizeStringField(payload.fullName, userRecord.fullName, 255),
        firstName: toNullableString(payload.firstName, 100),
        lastName: toNullableString(payload.lastName, 100),
        mobile: normalizedMobile,
        email: toNullableString(payload.email, 255),
        alternatePhone: toNullableString(payload.alternatePhone, 15),
        designation: toNullableString(payload.designation, 120),
        department: toNullableString(payload.department, 120),
        employeeId: toNullableString(payload.employeeId, 50),
        officeAddress: toNullableString(payload.officeAddress, 500),
        officePhone: toNullableString(payload.officePhone, 20),
      };

      const updatedUser = await storage.updateUser(userId, updates);
      if (!updatedUser) {
        return res.status(404).json({ message: "User not found" });
      }

      res.json({
        user: formatUserForResponse(updatedUser),
        message: "Profile updated successfully",
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({
          message: error.errors[0].message,
          errors: error.errors,
        });
      }
      routeLog.error("[staff-profile] Failed to update profile:", error);
      res.status(500).json({ message: "Failed to update profile" });
    }
  };

  const handleStaffPasswordChange = async (req: Request, res: Response) => {
    try {
      const userId = req.session.userId!;
      const { currentPassword, newPassword } = req.body;

      if (!currentPassword || !newPassword) {
        return res.status(400).json({ message: "Current and new password are required" });
      }

      if (typeof newPassword !== "string" || newPassword.length < 6) {
        return res.status(400).json({ message: "New password must be at least 6 characters" });
      }

      const userRecord = await storage.getUser(userId);
      if (!userRecord) {
        return res.status(404).json({ message: "User not found" });
      }

      const isValid = await bcrypt.compare(currentPassword, userRecord.password || "");
      if (!isValid) {
        return res.status(401).json({ message: "Current password is incorrect" });
      }

      const hashedPassword = await bcrypt.hash(newPassword, 10);
      await storage.updateUser(userId, { password: hashedPassword });

      res.json({ message: "Password changed successfully" });
    } catch (error) {
      routeLog.error("[staff-profile] Failed to change password:", error);
      res.status(500).json({ message: "Failed to change password" });
    }
  };

  app.patch("/api/staff/profile", requireRole(...STAFF_PROFILE_ROLES), handleStaffProfileUpdate);
  app.patch("/api/da/profile", requireRole('dealing_assistant'), handleStaffProfileUpdate);
  app.patch("/api/dtdo/profile", requireRole('district_tourism_officer', 'district_officer'), handleStaffProfileUpdate);

  app.post("/api/staff/change-password", requireRole(...STAFF_PROFILE_ROLES), handleStaffPasswordChange);
  app.post("/api/da/change-password", requireRole('dealing_assistant'), handleStaffPasswordChange);
  app.post("/api/dtdo/change-password", requireRole('district_tourism_officer', 'district_officer'), handleStaffPasswordChange);
  app.post("/api/owner/change-password", requireRole('property_owner'), handleStaffPasswordChange);

  // Get applications for DA (district-specific)
  app.get("/api/da/applications", requireRole('dealing_assistant'), async (req, res) => {
    try {
      const userId = req.session.userId!;
      const user = await storage.getUser(userId);
      
      if (!user || !user.district) {
        return res.status(400).json({ message: "DA must be assigned to a district" });
      }

      const districtCondition = buildDistrictWhereClause(homestayApplications.district, user.district);

      // Get all applications from this DA's district ordered by most recent
      const allApplications = await db
        .select()
        .from(homestayApplications)
        .where(districtCondition)
        .orderBy(desc(homestayApplications.createdAt));

      // Enrich with owner information
      const applicationsWithOwner = await Promise.all(
        allApplications.map(async (app) => {
          const owner = await storage.getUser(app.userId);
          const [latestCorrection] = await db
            .select({
              createdAt: applicationActions.createdAt,
              feedback: applicationActions.feedback,
            })
            .from(applicationActions)
            .where(
              and(
                eq(applicationActions.applicationId, app.id),
                eq(applicationActions.action, 'correction_resubmitted'),
              ),
            )
            .orderBy(desc(applicationActions.createdAt))
            .limit(1);
          return {
            ...app,
            ownerName: owner?.fullName || 'Unknown',
            ownerMobile: owner?.mobile || 'N/A',
            latestCorrection,
          };
        })
      );

      res.json(applicationsWithOwner);
    } catch (error) {
      routeLog.error("[da] Failed to fetch applications:", error);
      res.status(500).json({ message: "Failed to fetch applications" });
    }
  });

  // Get single application details for DA
  app.get("/api/da/applications/:id", requireRole('dealing_assistant'), async (req, res) => {
    try {
      const userRecord = await storage.getUser(req.session.userId!);
      const detail = await fetchApplicationWithOwner(req.params.id);

      if (!detail?.application) {
        return res.status(404).json({ message: "Application not found" });
      }

      const documents = await storage.getDocumentsByApplication(req.params.id);
      const [sendBackSetting] = await db
        .select()
        .from(systemSettings)
        .where(eq(systemSettings.settingKey, DA_SEND_BACK_SETTING_KEY))
        .limit(1);
      const sendBackEnabled = normalizeBooleanSetting(
        sendBackSetting?.settingValue,
        false,
      );
      const legacyForwardEnabled = await getLegacyForwardEnabled();

      const correctionHistory = await db
        .select({
          id: applicationActions.id,
          createdAt: applicationActions.createdAt,
          feedback: applicationActions.feedback,
        })
        .from(applicationActions)
        .where(
          and(
            eq(applicationActions.applicationId, req.params.id),
            eq(applicationActions.action, 'correction_resubmitted'),
          ),
        )
        .orderBy(desc(applicationActions.createdAt));

      res.json({
        application: detail.application,
        owner: detail.owner,
        documents,
        sendBackEnabled,
        legacyForwardEnabled,
        correctionHistory,
      });
    } catch (error) {
      routeLog.error("[da] Failed to fetch application details:", error);
      res.status(500).json({ message: "Failed to fetch application details" });
    }
  });

  // Start scrutiny (change status to under_scrutiny)
  app.post("/api/da/applications/:id/start-scrutiny", requireRole('dealing_assistant'), async (req, res) => {
    try {
      const userId = req.session.userId!;
      const application = await storage.getApplication(req.params.id);
      if (!application) {
        return res.status(404).json({ message: "Application not found" });
      }

      if (application.status !== 'submitted') {
        return res.status(400).json({ message: "Only submitted applications can be put under scrutiny" });
      }

      await storage.updateApplication(req.params.id, { status: 'under_scrutiny' });
      await logApplicationAction({
        applicationId: req.params.id,
        actorId: userId,
        action: "start_scrutiny",
        previousStatus: application.status,
        newStatus: "under_scrutiny",
      });
      
      res.json({ message: "Application is now under scrutiny" });
    } catch (error) {
      routeLog.error("[da] Failed to start scrutiny:", error);
      res.status(500).json({ message: "Failed to start scrutiny" });
    }
  });

  // Save scrutiny progress (document verifications)
  app.post("/api/da/applications/:id/save-scrutiny", requireRole('dealing_assistant'), async (req, res) => {
    try {
      const { verifications } = req.body;
      const userId = req.session.userId!;
      
      if (!verifications || !Array.isArray(verifications)) {
        return res.status(400).json({ message: "Invalid verification data" });
      }

      const targetApplication = await storage.getApplication(req.params.id);
      if (!targetApplication) {
        return res.status(404).json({ message: "Application not found" });
      }
      if (targetApplication.status !== 'under_scrutiny' && targetApplication.status !== 'legacy_rc_review') {
        return res.status(400).json({ message: "Document updates are locked once the application leaves scrutiny" });
      }

      // Update each document's verification status
      for (const verification of verifications) {
        await db.update(documents)
          .set({
            verificationStatus: verification.status,
            verificationNotes: verification.notes || null,
            isVerified: verification.status === 'verified',
            verifiedBy: verification.status !== 'pending' ? userId : null,
            verificationDate: verification.status !== 'pending' ? new Date() : null,
          })
          .where(eq(documents.id, verification.documentId));
      }
      
      res.json({ message: "Scrutiny progress saved successfully" });
    } catch (error) {
      routeLog.error("[da] Failed to save scrutiny progress:", error);
      res.status(500).json({ message: "Failed to save scrutiny progress" });
    }
  });

  // Forward to DTDO
  app.post("/api/da/applications/:id/forward-to-dtdo", requireRole('dealing_assistant'), async (req, res) => {
    try {
      const { remarks } = req.body;
      const userId = req.session.userId!;
      const trimmedRemarks = typeof remarks === "string" ? remarks.trim() : "";
      if (!trimmedRemarks) {
        return res.status(400).json({ message: "Scrutiny remarks are required before forwarding." });
      }
      const application = await storage.getApplication(req.params.id);
      
      if (!application) {
        return res.status(404).json({ message: "Application not found" });
      }

      if (application.status !== 'under_scrutiny' && application.status !== 'legacy_rc_review') {
        return res.status(400).json({ message: "Only applications under scrutiny can be forwarded" });
      }

      const legacyForwardEnabled = await getLegacyForwardEnabled();
      if (isLegacyApplicationRecord(application) && !legacyForwardEnabled) {
        return res.status(400).json({
          message: "Legacy RC onboarding cases must be completed by the DA. DTDO escalation is currently disabled.",
        });
      }

      const docs = await storage.getDocumentsByApplication(req.params.id);
      if (docs.length === 0) {
        return res.status(400).json({ message: "Upload and verify required documents before forwarding" });
      }

      const pendingDoc = docs.find((doc) => !doc.verificationStatus || doc.verificationStatus === 'pending');
      if (pendingDoc) {
        return res.status(400).json({ message: "Verify every document (mark Verified / Needs correction / Rejected) before forwarding" });
      }

      await storage.updateApplication(req.params.id, {
        status: 'forwarded_to_dtdo',
        daId: userId,
        daReviewDate: new Date(),
        daForwardedDate: new Date(),
        daRemarks: trimmedRemarks || null,
      } as Partial<HomestayApplication>);
      await logApplicationAction({
        applicationId: req.params.id,
        actorId: userId,
        action: "forwarded_to_dtdo",
        previousStatus: application.status,
        newStatus: "forwarded_to_dtdo",
        feedback: trimmedRemarks || null,
      });
      const daOwner = await storage.getUser(application.userId);
      const forwardedApplication = {
        ...application,
        status: 'forwarded_to_dtdo',
      } as HomestayApplication;
      queueNotification("forwarded_to_dtdo", {
        application: forwardedApplication,
        owner: daOwner ?? null,
      });
      
      // TODO: Add timeline entry with remarks when timeline system is implemented
      
      res.json({ message: "Application forwarded to DTDO successfully" });
    } catch (error) {
      routeLog.error("[da] Failed to forward to DTDO:", error);
      res.status(500).json({ message: "Failed to forward application" });
    }
  });

  // Send back to applicant
  app.post("/api/da/applications/:id/send-back", requireRole('dealing_assistant'), async (req, res) => {
    try {
      const { reason } = req.body;
      
      if (!reason || reason.trim().length === 0) {
        return res.status(400).json({ message: "Reason for sending back is required" });
      }

      const application = await storage.getApplication(req.params.id);
      if (!application) {
        return res.status(404).json({ message: "Application not found" });
      }

      if (application.status !== 'under_scrutiny' && application.status !== 'legacy_rc_review') {
        return res.status(400).json({ message: "Only applications under scrutiny can be sent back" });
      }

      const sanitizedReason = reason.trim();
      const updatedByDa = await storage.updateApplication(req.params.id, { status: 'reverted_to_applicant' } as Partial<HomestayApplication>);
      await logApplicationAction({
        applicationId: req.params.id,
        actorId: req.session.userId!,
        action: "reverted_by_da",
        previousStatus: application.status,
        newStatus: "reverted_to_applicant",
        feedback: sanitizedReason,
      });
      const owner = await storage.getUser(application.userId);
      queueNotification("da_send_back", {
        application: updatedByDa ?? { ...application, status: "reverted_to_applicant" },
        owner: owner ?? null,
        extras: { REMARKS: sanitizedReason },
      });
      
      res.json({ message: "Application sent back to applicant successfully" });
    } catch (error) {
      routeLog.error("[da] Failed to send back application:", error);
      res.status(500).json({ message: "Failed to send back application" });
    }
  });

  const LEGACY_VERIFY_ALLOWED_STATUSES = new Set([
    "legacy_rc_review",
    "submitted",
    "under_scrutiny",
    "forwarded_to_dtdo",
    "dtdo_review",
  ]);

  app.post(
    "/api/applications/:id/legacy-verify",
    requireRole("dealing_assistant", "district_tourism_officer", "district_officer"),
    async (req, res) => {
      try {
        const { remarks } = req.body ?? {};
        const trimmedRemarks = typeof remarks === "string" ? remarks.trim() : "";
        const actorId = req.session.userId!;
        const actor = await storage.getUser(actorId);
        const application = await storage.getApplication(req.params.id);

        if (!application) {
          return res.status(404).json({ message: "Application not found" });
        }

        if (!isServiceApplicationKind(application.applicationKind)) {
          return res
            .status(400)
            .json({ message: "Legacy verification is only available for service requests." });
        }

        if (!application.status || !LEGACY_VERIFY_ALLOWED_STATUSES.has(application.status)) {
          return res.status(400).json({
            message: "Application is not in a state that allows legacy verification.",
          });
        }

        if (actor?.district && !districtsMatch(actor.district, application.district)) {
          return res
            .status(403)
            .json({ message: "You can only process applications from your district." });
        }

        const now = new Date();
        const updates: Partial<HomestayApplication> = {
          status: "approved",
          currentStage: "final",
          approvedAt: now,
        };

        if (!application.certificateIssuedDate) {
          updates.certificateIssuedDate = now;
        }

        if (
          actor?.role === "district_tourism_officer" ||
          actor?.role === "district_officer"
        ) {
          updates.dtdoId = actorId;
          updates.dtdoReviewDate = now;
          updates.dtdoRemarks = trimmedRemarks || application.dtdoRemarks || null;
        } else if (actor?.role === "dealing_assistant") {
          updates.daId = actorId;
          updates.daReviewDate = now;
          updates.daRemarks = trimmedRemarks || application.daRemarks || null;
        }

        const updated = await storage.updateApplication(req.params.id, updates);
        await logApplicationAction({
          applicationId: req.params.id,
          actorId,
          action: "legacy_rc_verified",
          previousStatus: application.status,
          newStatus: "approved",
          feedback: trimmedRemarks || undefined,
        });

        res.json({
          message: "Legacy RC verified successfully.",
          application: updated ?? { ...application, ...updates },
        });
      } catch (error) {
        routeLog.error("[legacy] Failed to verify application:", error);
        res.status(500).json({ message: "Failed to verify legacy request" });
      }
    },
  );

  app.get(
    "/api/legacy/settings",
    requireRole(
      "dealing_assistant",
      "district_tourism_officer",
      "district_officer",
      "admin",
      "super_admin",
      "admin_rc",
    ),
    async (_req, res) => {
      try {
        const forwardEnabled = await getLegacyForwardEnabled();
        res.json({ forwardEnabled });
      } catch (error) {
        routeLog.error("[legacy] Failed to load settings", error);
        res.status(500).json({ message: "Failed to load legacy settings" });
      }
    },
  );

  // ========================================
  // DTDO (District Tourism Development Officer) ROUTES
  // ========================================

  // Get applications for DTDO (district-specific)
  app.get("/api/dtdo/applications", requireRole('district_tourism_officer', 'district_officer'), async (req, res) => {
    try {
      const userId = req.session.userId!;
      const user = await storage.getUser(userId);
      
      if (!user || !user.district) {
        return res.status(400).json({ message: "DTDO must be assigned to a district" });
      }

      const districtCondition = buildDistrictWhereClause(homestayApplications.district, user.district);

      // Get all applications from this DTDO's district ordered by most recent
      const allApplications = await db
        .select()
        .from(homestayApplications)
        .where(districtCondition)
        .orderBy(desc(homestayApplications.createdAt));

      let latestCorrectionMap: Map<
        string,
        { createdAt: Date | null; feedback: string | null }
      > | null = null;
      if (allApplications.length > 0) {
        const applicationIds = allApplications.map((app) => app.id);
        const correctionRows = await db
          .select({
            applicationId: applicationActions.applicationId,
            createdAt: applicationActions.createdAt,
            feedback: applicationActions.feedback,
          })
          .from(applicationActions)
          .where(
            and(
              inArray(applicationActions.applicationId, applicationIds),
              eq(applicationActions.action, "correction_resubmitted"),
            ),
          )
          .orderBy(desc(applicationActions.createdAt));
        latestCorrectionMap = new Map();
        for (const row of correctionRows) {
          if (!latestCorrectionMap.has(row.applicationId)) {
            latestCorrectionMap.set(row.applicationId, {
              createdAt: row.createdAt ?? null,
              feedback: row.feedback ?? null,
            });
          }
        }
      }

      // Enrich with owner and DA information
      const applicationsWithDetails = await Promise.all(
        allApplications.map(async (app) => {
          const owner = await storage.getUser(app.userId);
          
          // Get DA name if the application was forwarded by DA
          let daName = undefined;
          const daRemarks = (app as unknown as { daRemarks?: string }).daRemarks;
          if (daRemarks || app.daId) {
            const da = app.daId ? await storage.getUser(app.daId) : null;
            daName = da?.fullName || 'Unknown DA';
          }

          return {
            ...app,
            ownerName: owner?.fullName || 'Unknown',
            ownerMobile: owner?.mobile || 'N/A',
            daName,
            latestCorrection: latestCorrectionMap?.get(app.id) ?? null,
          };
        })
      );

      res.json(applicationsWithDetails);
    } catch (error) {
      routeLog.error("[dtdo] Failed to fetch applications:", error);
      res.status(500).json({ message: "Failed to fetch applications" });
    }
  });

  // Get single application details for DTDO
  app.get("/api/dtdo/applications/:id", requireRole('district_tourism_officer', 'district_officer'), async (req, res) => {
    try {
      const userId = req.session.userId!;
      const user = await storage.getUser(userId);
      
      const application = await storage.getApplication(req.params.id);
      if (!application) {
        return res.status(404).json({ message: "Application not found" });
      }

      // Verify application is from DTDO's district (handles labels like "Hamirpur (serving Una)")
      if (user?.district && !districtsMatch(user.district, application.district)) {
        return res.status(403).json({ message: "You can only access applications from your district" });
      }

      // Get owner information
      const owner = await storage.getUser(application.userId);
      
      // Get documents
      const documents = await storage.getDocumentsByApplication(req.params.id);

      // Get DA information if available
      let daInfo = null;
      if (application.daId) {
        const da = await storage.getUser(application.daId);
        daInfo = da ? { fullName: da.fullName, mobile: da.mobile } : null;
      }

      const correctionHistory = await db
        .select({
          id: applicationActions.id,
          createdAt: applicationActions.createdAt,
          feedback: applicationActions.feedback,
        })
        .from(applicationActions)
        .where(
          and(
            eq(applicationActions.applicationId, req.params.id),
            eq(applicationActions.action, 'correction_resubmitted'),
          ),
        )
        .orderBy(desc(applicationActions.createdAt));

      res.json({
        application,
        owner: owner ? {
          fullName: owner.fullName,
          mobile: owner.mobile,
          email: owner.email,
        } : null,
        documents,
        daInfo,
        correctionHistory,
      });
    } catch (error) {
      routeLog.error("[dtdo] Failed to fetch application details:", error);
      res.status(500).json({ message: "Failed to fetch application details" });
    }
  });

  // DTDO accept application (schedule inspection)
  app.post("/api/dtdo/applications/:id/accept", requireRole('district_tourism_officer', 'district_officer'), async (req, res) => {
    try {
      const { remarks } = req.body;
      const trimmedRemarks = typeof remarks === "string" ? remarks.trim() : "";
      if (!trimmedRemarks) {
        return res.status(400).json({ message: "Remarks are required when scheduling an inspection." });
      }
      const userId = req.session.userId!;
      const user = await storage.getUser(userId);

      const application = await storage.getApplication(req.params.id);
      if (!application) {
        return res.status(404).json({ message: "Application not found" });
      }

      // Verify application is from DTDO's district
      if (user?.district && !districtsMatch(user.district, application.district)) {
        return res.status(403).json({ message: "You can only process applications from your district" });
      }

      // Verify application status
      if (application.status !== 'forwarded_to_dtdo' && application.status !== 'dtdo_review') {
        return res.status(400).json({ message: "Application is not in the correct status for DTDO review" });
      }

      // Update application status to dtdo_review (intermediate state)
      // Will only move to inspection_scheduled after successful inspection scheduling
      await storage.updateApplication(req.params.id, {
        status: 'dtdo_review',
        dtdoRemarks: trimmedRemarks,
        dtdoId: userId,
        dtdoReviewDate: new Date(),
      });
      await logApplicationAction({
        applicationId: req.params.id,
        actorId: userId,
        action: "dtdo_accept",
        previousStatus: application.status,
        newStatus: "dtdo_review",
        feedback: trimmedRemarks,
      });

      res.json({ message: "Application accepted. Proceed to schedule inspection.", applicationId: req.params.id });
    } catch (error) {
      routeLog.error("[dtdo] Failed to accept application:", error);
      res.status(500).json({ message: "Failed to accept application" });
    }
  });

  // DTDO reject application
  app.post("/api/dtdo/applications/:id/reject", requireRole('district_tourism_officer', 'district_officer'), async (req, res) => {
    try {
      const { remarks } = req.body;
      
      if (!remarks || remarks.trim().length === 0) {
        return res.status(400).json({ message: "Rejection reason is required" });
      }

      const userId = req.session.userId!;
      const user = await storage.getUser(userId);

      const application = await storage.getApplication(req.params.id);
      if (!application) {
        return res.status(404).json({ message: "Application not found" });
      }

      // Verify application is from DTDO's district
      if (user?.district && !districtsMatch(user.district, application.district)) {
        return res.status(403).json({ message: "You can only process applications from your district" });
      }

      // Update application status to rejected
      await storage.updateApplication(req.params.id, {
        status: 'rejected',
        dtdoRemarks: remarks,
        dtdoId: userId,
        dtdoReviewDate: new Date(),
        rejectionReason: remarks,
      });

      res.json({ message: "Application rejected successfully" });
    } catch (error) {
      routeLog.error("[dtdo] Failed to reject application:", error);
      res.status(500).json({ message: "Failed to reject application" });
    }
  });

  // DTDO revert application to applicant
  app.post("/api/dtdo/applications/:id/revert", requireRole('district_tourism_officer', 'district_officer'), async (req, res) => {
    try {
      const { remarks } = req.body;
      
      if (!remarks || remarks.trim().length === 0) {
        return res.status(400).json({ message: "Please specify what corrections are needed" });
      }

      const userId = req.session.userId!;
      const user = await storage.getUser(userId);

      const application = await storage.getApplication(req.params.id);
      if (!application) {
        return res.status(404).json({ message: "Application not found" });
      }

      // Verify application is from DTDO's district
      if (user?.district && !districtsMatch(user.district, application.district)) {
        return res.status(403).json({ message: "You can only process applications from your district" });
      }

      const trimmedRemarks = remarks.trim();
      // Update application status to reverted_by_dtdo
      const revertedApplication = await storage.updateApplication(req.params.id, {
        status: 'reverted_by_dtdo',
        dtdoRemarks: trimmedRemarks,
        dtdoId: userId,
        dtdoReviewDate: new Date(),
      });
      await logApplicationAction({
        applicationId: req.params.id,
        actorId: userId,
        action: "dtdo_revert",
        previousStatus: application.status,
        newStatus: "reverted_by_dtdo",
        feedback: trimmedRemarks,
      });
      const owner = await storage.getUser(application.userId);
      queueNotification("dtdo_revert", {
        application: revertedApplication ?? { ...application, status: "reverted_by_dtdo" },
        owner: owner ?? null,
        extras: { REMARKS: trimmedRemarks },
      });

      res.json({ message: "Application reverted to applicant successfully" });
    } catch (error) {
      routeLog.error("[dtdo] Failed to revert application:", error);
      res.status(500).json({ message: "Failed to revert application" });
    }
  });

  // Get available DAs for DTDO's district
  app.get("/api/dtdo/available-das", requireRole('district_tourism_officer', 'district_officer'), async (req, res) => {
    try {
      const userId = req.session.userId!;
      const user = await storage.getUser(userId);
      
      if (!user || !user.district) {
        return res.status(400).json({ message: "DTDO must be assigned to a district" });
      }

      const districtCondition = buildDistrictWhereClause(users.district, user.district);
      const potentialUsers = await db
        .select()
        .from(users)
        .where(districtCondition);

      const manifestEntries = getDistrictStaffManifest().filter((entry) =>
        districtsMatch(entry.districtLabel, user.district),
      );
      const canonicalUsernameTokens = new Set(
        manifestEntries.map((entry) => entry.da.username.trim().toLowerCase()),
      );
      const canonicalMobiles = new Set(manifestEntries.map((entry) => entry.da.mobile.trim()));

      let filteredUsers = potentialUsers.filter(
        (u) =>
          u.role === 'dealing_assistant' &&
          districtsMatch(user.district, u.district ?? user.district),
      );

      if (manifestEntries.length > 0) {
        const manifestOnly = filteredUsers.filter((u) => {
          const normalizedUsername = (u.username || "").trim().toLowerCase();
          const normalizedMobile = (u.mobile || "").trim();
          return (
            (normalizedUsername && canonicalUsernameTokens.has(normalizedUsername)) ||
            (normalizedMobile && canonicalMobiles.has(normalizedMobile))
          );
        });
        if (manifestOnly.length > 0) {
          filteredUsers = manifestOnly;
        }
      }

      const das = filteredUsers.map((da) => ({
        id: da.id,
        fullName: da.fullName,
        mobile: da.mobile,
      }));

      routeLog.info("[dtdo] available-das", {
        officer: user.username,
        district: user.district,
        manifestMatches: manifestEntries.map((entry) => entry.da.username),
        options: das.map((da) => ({ id: da.id, fullName: da.fullName, mobile: da.mobile })),
      });

      res.json({ das });
    } catch (error) {
      routeLog.error("[dtdo] Failed to fetch DAs:", error);
      res.status(500).json({ message: "Failed to fetch available DAs" });
    }
  });

  // Schedule inspection (create inspection order)
  app.post("/api/dtdo/schedule-inspection", requireRole('district_tourism_officer', 'district_officer'), async (req, res) => {
    try {
      const { applicationId, inspectionDate, assignedTo, specialInstructions } = req.body;
      const userId = req.session.userId!;
      const user = await storage.getUser(userId);

      if (!applicationId || !inspectionDate || !assignedTo) {
        return res.status(400).json({ message: "Missing required fields" });
      }

      if (!user || !user.district) {
        return res.status(400).json({ message: "DTDO must be assigned to a district" });
      }

      const application = await storage.getApplication(applicationId);
      if (!application) {
        return res.status(404).json({ message: "Application not found" });
      }

      if (!districtsMatch(user.district, application.district)) {
        return res.status(403).json({ message: "You can only process applications from your district" });
      }

      // Verify application status - should be in dtdo_review after acceptance
      if (application.status !== 'dtdo_review') {
        return res.status(400).json({ message: "Application must be accepted by DTDO before scheduling inspection" });
      }

      const assignedDaUser = await storage.getUser(assignedTo);
      if (
        !assignedDaUser ||
        assignedDaUser.role !== 'dealing_assistant' ||
        !districtsMatch(user.district, assignedDaUser.district)
      ) {
        return res.status(400).json({ message: "Selected DA is not available for your district" });
      }

      // Create inspection order
      const newInspectionOrder = await db
        .insert(inspectionOrders)
        .values({
          applicationId,
          scheduledBy: userId,
          scheduledDate: new Date(),
          assignedTo,
          assignedDate: new Date(),
          inspectionDate: new Date(inspectionDate),
          inspectionAddress: application.address,
          specialInstructions: specialInstructions || null,
          status: 'scheduled',
        })
        .returning();
      routeLog.info("[dtdo] inspection scheduled", {
        applicationId,
        applicationNumber: application.applicationNumber,
        assignedDa: assignedDaUser.username,
        assignedDaId: assignedDaUser.id,
        assignedDaMobile: assignedDaUser.mobile,
        district: assignedDaUser.district,
      });

      // Only NOW update the application status to inspection_scheduled
      await storage.updateApplication(applicationId, {
        status: 'inspection_scheduled',
        daId: assignedDaUser.id,
      });

      const ownerUser = await storage.getUser(application.userId);

      const scheduleDisplay = format(new Date(inspectionDate), "dd MMM yyyy, hh:mm a");
      const notificationsToSend: Promise<void>[] = [];

      if (assignedDaUser) {
        notificationsToSend.push(
          createInAppNotification({
            userId: assignedDaUser.id,
            applicationId,
            type: "inspection_schedule",
            title: "New Inspection Assigned",
            message: `You have been assigned to inspect ${application.propertyName} on ${scheduleDisplay}.`,
          }),
        );
      }

      if (ownerUser) {
        const ownerMessageParts = [
          `Your site inspection has been scheduled for ${scheduleDisplay}.`,
          specialInstructions ? `Instructions: ${specialInstructions}` : null,
        ].filter(Boolean);

        notificationsToSend.push(
          createInAppNotification({
            userId: ownerUser.id,
            applicationId,
            type: "inspection_schedule_owner",
            title: "Inspection Scheduled",
            message: ownerMessageParts.join(" "),
          }),
        );
      }

      if (notificationsToSend.length > 0) {
        await Promise.allSettled(notificationsToSend);
      }

      res.json({ message: "Inspection scheduled successfully", inspectionOrder: newInspectionOrder[0] });
    } catch (error) {
      routeLog.error("[dtdo] Failed to schedule inspection:", error);
      res.status(500).json({ message: "Failed to schedule inspection" });
    }
  });

  app.get("/api/applications/:id/inspection-schedule", requireAuth, async (req, res) => {
    try {
      const { id } = req.params;
      const application = await storage.getApplication(id);
      if (!application) {
        return res.status(404).json({ message: "Application not found" });
      }

      const userId = req.session.userId!;
      const requester = await storage.getUser(userId);
      const isOwner = application.userId === userId;
      const officerRoles = new Set([
        'district_tourism_officer',
        'district_officer',
        'dealing_assistant',
        'state_officer',
        'admin',
        'super_admin',
      ]);

      if (!isOwner && (!requester || !officerRoles.has(requester.role))) {
        return res.status(403).json({ message: "You are not authorized to view this inspection schedule" });
      }

      const orderResult = await db
        .select()
        .from(inspectionOrders)
        .where(eq(inspectionOrders.applicationId, id))
        .orderBy(desc(inspectionOrders.createdAt))
        .limit(1);

      if (orderResult.length === 0) {
        return res.status(404).json({ message: "Inspection order not found" });
      }

      const order = orderResult[0];
      const assignedDa = await storage.getUser(order.assignedTo);

      const ackAction = await db
        .select()
        .from(applicationActions)
        .where(
          and(
            eq(applicationActions.applicationId, id),
            eq(applicationActions.action, 'inspection_acknowledged'),
          ),
        )
        .orderBy(desc(applicationActions.createdAt))
        .limit(1);

      res.json({
        order: {
          id: order.id,
          status: order.status,
          inspectionDate: order.inspectionDate,
          specialInstructions: order.specialInstructions,
          assignedTo: assignedDa
            ? { id: assignedDa.id, fullName: assignedDa.fullName, mobile: assignedDa.mobile }
            : null,
        },
        acknowledgedAt: ackAction.length ? ackAction[0].createdAt : null,
      });
    } catch (error) {
      routeLog.error("[owner] Failed to fetch inspection schedule:", error);
      res.status(500).json({ message: "Failed to fetch inspection schedule" });
    }
  });

  app.post("/api/applications/:id/inspection-schedule/acknowledge", requireAuth, async (req, res) => {
    try {
      const { id } = req.params;
      const userId = req.session.userId!;
      const application = await storage.getApplication(id);
      if (!application) {
        return res.status(404).json({ message: "Application not found" });
      }
      if (application.userId !== userId) {
        return res.status(403).json({ message: "Only the application owner can acknowledge the inspection schedule" });
      }

      const orderResult = await db
        .select()
        .from(inspectionOrders)
        .where(eq(inspectionOrders.applicationId, id))
        .orderBy(desc(inspectionOrders.createdAt))
        .limit(1);

      if (orderResult.length === 0) {
        return res.status(400).json({ message: "Inspection has not been scheduled yet" });
      }

      const order = orderResult[0];
      if (order.status === 'completed') {
        return res.status(400).json({ message: "Inspection already completed" });
      }

      const existingAck = await db
        .select()
        .from(applicationActions)
        .where(
          and(
            eq(applicationActions.applicationId, id),
            eq(applicationActions.action, 'inspection_acknowledged'),
          ),
        )
        .orderBy(desc(applicationActions.createdAt))
        .limit(1);

      if (existingAck.length > 0) {
        return res.json({
          message: "Inspection schedule already acknowledged",
          acknowledgedAt: existingAck[0].createdAt,
        });
      }

      await db.update(inspectionOrders)
        .set({ status: 'acknowledged', updatedAt: new Date() })
        .where(eq(inspectionOrders.id, order.id));

      const [ackRecord] = await db.insert(applicationActions).values({
        applicationId: id,
        officerId: userId,
        action: 'inspection_acknowledged',
        previousStatus: application.status,
        newStatus: application.status,
        feedback: "Owner acknowledged inspection schedule.",
      }).returning();

      res.json({
        message: "Inspection schedule acknowledged",
        acknowledgedAt: ackRecord?.createdAt ?? new Date(),
      });
    } catch (error) {
      routeLog.error("[owner] Failed to acknowledge inspection schedule:", error);
      res.status(500).json({ message: "Failed to acknowledge inspection schedule" });
    }
  });

  // Get inspection report for DTDO review
  app.get("/api/dtdo/inspection-report/:applicationId", requireRole('district_tourism_officer', 'district_officer'), async (req, res) => {
    try {
      const { applicationId } = req.params;
      const userId = req.session.userId!;
      const user = await storage.getUser(userId);
      
      // Get application
      const application = await storage.getApplication(applicationId);
      if (!application) {
        return res.status(404).json({ message: "Application not found" });
      }

      // Verify application is from DTDO's district
      if (user?.district && !districtsMatch(user.district, application.district)) {
        return res.status(403).json({ message: "You can only review applications from your district" });
      }

      // Get inspection order
      const inspectionOrder = await db
        .select()
        .from(inspectionOrders)
        .where(eq(inspectionOrders.applicationId, applicationId))
        .orderBy(desc(inspectionOrders.createdAt))
        .limit(1);

      if (inspectionOrder.length === 0) {
        return res.status(404).json({ message: "No inspection order found" });
      }

      // Get inspection report
      const report = await db
        .select()
        .from(inspectionReports)
        .where(eq(inspectionReports.inspectionOrderId, inspectionOrder[0].id))
        .limit(1);

      if (report.length === 0) {
        return res.status(404).json({ message: "Inspection report not found" });
      }

      // Get DA who submitted the report
      const da = await storage.getUser(report[0].submittedBy);

      // Get property owner
      const owner = await storage.getUser(application.userId);

      res.json({
        report: report[0],
        application,
        inspectionOrder: inspectionOrder[0],
        owner: owner ? {
          fullName: owner.fullName,
          mobile: owner.mobile,
          email: owner.email,
        } : null,
        da: da ? {
          fullName: da.fullName,
          mobile: da.mobile,
        } : null,
      });
    } catch (error) {
      routeLog.error("[dtdo] Failed to fetch inspection report:", error);
      res.status(500).json({ message: "Failed to fetch inspection report" });
    }
  });

  // DTDO approve inspection report
  app.post("/api/dtdo/inspection-report/:applicationId/approve", requireRole('district_tourism_officer', 'district_officer'), async (req, res) => {
    try {
      const { applicationId } = req.params;
      const { remarks } = req.body;
      const userId = req.session.userId!;
      const user = await storage.getUser(userId);
      
      const application = await storage.getApplication(applicationId);
      if (!application) {
        return res.status(404).json({ message: "Application not found" });
      }

      // Verify application is from DTDO's district
      if (user?.district && !districtsMatch(user.district, application.district)) {
        return res.status(403).json({ message: "You can only process applications from your district" });
      }

      // Verify application is in inspection_under_review status
      if (application.status !== 'inspection_under_review') {
        return res.status(400).json({ 
          message: `Cannot approve inspection report. Application must be in inspection_under_review status (current: ${application.status})` 
        });
      }

      // Update application status to verified_for_payment
      const verifiedApplication = await storage.updateApplication(applicationId, {
        status: 'verified_for_payment',
        districtNotes: remarks || 'Inspection report approved. Property meets all requirements.',
        districtOfficerId: userId,
        districtReviewDate: new Date(),
      });
      await logApplicationAction({
        applicationId,
        actorId: userId,
        action: "verified_for_payment",
        previousStatus: application.status,
        newStatus: "verified_for_payment",
        feedback: remarks || 'Inspection report approved. Property meets all requirements.',
      });

      const paymentOwner = await storage.getUser(application.userId);
      queueNotification("verified_for_payment", {
        application: verifiedApplication ?? {
          ...application,
          status: 'verified_for_payment',
        },
        owner: paymentOwner ?? null,
      });

      res.json({ message: "Inspection report approved successfully" });
    } catch (error) {
      routeLog.error("[dtdo] Failed to approve inspection report:", error);
      res.status(500).json({ message: "Failed to approve inspection report" });
    }
  });

  // DTDO reject inspection report
  app.post("/api/dtdo/inspection-report/:applicationId/reject", requireRole('district_tourism_officer', 'district_officer'), async (req, res) => {
    try {
      const { applicationId } = req.params;
      const { remarks } = req.body;
      
      if (!remarks || remarks.trim().length === 0) {
        return res.status(400).json({ message: "Rejection reason is required" });
      }

      const userId = req.session.userId!;
      const user = await storage.getUser(userId);
      
      const application = await storage.getApplication(applicationId);
      if (!application) {
        return res.status(404).json({ message: "Application not found" });
      }

      // Verify application is from DTDO's district
      if (user?.district && !districtsMatch(user.district, application.district)) {
        return res.status(403).json({ message: "You can only process applications from your district" });
      }

      // Verify application is in inspection_under_review status
      if (application.status !== 'inspection_under_review') {
        return res.status(400).json({ 
          message: `Cannot reject application. Application must be in inspection_under_review status (current: ${application.status})` 
        });
      }

      // Update application status to rejected
      await storage.updateApplication(applicationId, {
        status: 'rejected',
        rejectionReason: remarks,
        districtNotes: remarks,
        districtOfficerId: userId,
        districtReviewDate: new Date(),
      });
      await logApplicationAction({
        applicationId,
        actorId: userId,
        action: "dtdo_reject",
        previousStatus: application.status,
        newStatus: "rejected",
        feedback: remarks,
      });

      res.json({ message: "Application rejected successfully" });
    } catch (error) {
      routeLog.error("[dtdo] Failed to reject inspection report:", error);
      res.status(500).json({ message: "Failed to reject inspection report" });
    }
  });

  // DTDO raise objections on inspection report
  app.post("/api/dtdo/inspection-report/:applicationId/raise-objections", requireRole('district_tourism_officer', 'district_officer'), async (req, res) => {
    try {
      const { applicationId } = req.params;
      const { remarks } = req.body;
      
      if (!remarks || remarks.trim().length === 0) {
        return res.status(400).json({ message: "Please specify the objections" });
      }

      const userId = req.session.userId!;
      const user = await storage.getUser(userId);
      
      const application = await storage.getApplication(applicationId);
      if (!application) {
        return res.status(404).json({ message: "Application not found" });
      }

      // Verify application is from DTDO's district
      if (user?.district && !districtsMatch(user.district, application.district)) {
        return res.status(403).json({ message: "You can only process applications from your district" });
      }

      // Verify application is in inspection_under_review status
      if (application.status !== 'inspection_under_review') {
        return res.status(400).json({ 
          message: `Cannot raise objections. Application must be in inspection_under_review status (current: ${application.status})` 
        });
      }

      // Update application status to objection_raised
      const trimmedRemarks = remarks.trim();
      await storage.updateApplication(applicationId, {
        status: 'objection_raised',
        clarificationRequested: trimmedRemarks,
        districtNotes: trimmedRemarks,
        districtOfficerId: userId,
        districtReviewDate: new Date(),
      });
      await logApplicationAction({
        applicationId,
        actorId: userId,
        action: "objection_raised",
        previousStatus: application.status,
        newStatus: "objection_raised",
        feedback: trimmedRemarks,
      });
      const owner = await storage.getUser(application.userId);
      queueNotification("dtdo_objection", {
        application: { ...application, status: "objection_raised" },
        owner: owner ?? null,
        extras: { REMARKS: trimmedRemarks },
      });

      res.json({ message: "Objections raised successfully. Application will require re-inspection." });
    } catch (error) {
      routeLog.error("[dtdo] Failed to raise objections:", error);
      res.status(500).json({ message: "Failed to raise objections" });
    }
  });

  // ====================================================================
  // DA INSPECTION ROUTES
  // ====================================================================

  // Get all inspection orders assigned to this DA
  app.get("/api/da/inspections", requireRole('dealing_assistant'), async (req, res) => {
    try {
      const userId = req.session.userId!;
      const user = await storage.getUser(userId);
      
      if (!user) {
        return res.status(400).json({ message: "User not found" });
      }

      // Get all inspection orders assigned to this DA
      const inspectionOrdersData = await db
        .select()
        .from(inspectionOrders)
        .where(eq(inspectionOrders.assignedTo, userId))
        .orderBy(desc(inspectionOrders.createdAt));
      routeLog.info("[da] inspections query", {
        userId,
        username: user?.username,
        count: inspectionOrdersData.length,
        orderIds: inspectionOrdersData.map((order) => order.id),
      });

      // Enrich with application and property details
      const enrichedOrders = await Promise.all(
        inspectionOrdersData.map(async (order) => {
          const application = await storage.getApplication(order.applicationId);
          const owner = application ? await storage.getUser(application.userId) : null;
          
          // Check if report already exists
          const existingReport = await db
            .select()
            .from(inspectionReports)
            .where(eq(inspectionReports.inspectionOrderId, order.id))
            .limit(1);

          return {
            ...order,
            application: application
              ? {
                  id: application.id,
                  applicationNumber: application.applicationNumber,
                  propertyName: application.propertyName,
                  category: application.category,
                  status: application.status,
                  dtdoRemarks: application.dtdoRemarks ?? null,
                }
              : null,
            owner: owner ? {
              fullName: owner.fullName,
              mobile: owner.mobile,
            } : null,
            reportSubmitted: existingReport.length > 0,
          };
        })
      );

      res.json(enrichedOrders);
    } catch (error) {
      routeLog.error("[da] Failed to fetch inspections:", error);
      res.status(500).json({ message: "Failed to fetch inspections" });
    }
  });

  // Get single inspection order details
  app.get("/api/da/inspections/:id", requireRole('dealing_assistant'), async (req, res) => {
    try {
      const userId = req.session.userId!;
      
      const order = await db
        .select()
        .from(inspectionOrders)
        .where(eq(inspectionOrders.id, req.params.id))
        .limit(1);

      if (order.length === 0) {
        return res.status(404).json({ message: "Inspection order not found" });
      }

      // Verify this inspection is assigned to the logged-in DA
      if (order[0].assignedTo !== userId) {
        return res.status(403).json({ message: "You can only access inspections assigned to you" });
      }

      // Get application details
      const application = await storage.getApplication(order[0].applicationId);
      if (!application) {
        return res.status(404).json({ message: "Application not found" });
      }

      // Get owner details
      const owner = await storage.getUser(application.userId);

      // Get documents
      const documents = await storage.getDocumentsByApplication(application.id);

      // Check if report already submitted
      const existingReport = await db
        .select()
        .from(inspectionReports)
        .where(eq(inspectionReports.inspectionOrderId, req.params.id))
        .limit(1);

      res.json({
        order: order[0],
        application,
        owner: owner ? {
          fullName: owner.fullName,
          mobile: owner.mobile,
          email: owner.email,
        } : null,
        documents,
        reportSubmitted: existingReport.length > 0,
        existingReport: existingReport.length > 0 ? existingReport[0] : null,
      });
    } catch (error) {
      routeLog.error("[da] Failed to fetch inspection details:", error);
      res.status(500).json({ message: "Failed to fetch inspection details" });
    }
  });

  // Submit inspection report
  app.post("/api/da/inspections/:id/submit-report", requireRole('dealing_assistant'), async (req, res) => {
    try {
      const userId = req.session.userId!;
      const orderId = req.params.id;
      
      // Validate the inspection order exists and is assigned to this DA
      const order = await db
        .select()
        .from(inspectionOrders)
        .where(eq(inspectionOrders.id, orderId))
        .limit(1);

      if (order.length === 0) {
        return res.status(404).json({ message: "Inspection order not found" });
      }

      if (order[0].assignedTo !== userId) {
        return res.status(403).json({ message: "You can only submit reports for inspections assigned to you" });
      }

      // Check if report already exists
      const existingReport = await db
        .select()
        .from(inspectionReports)
        .where(eq(inspectionReports.inspectionOrderId, orderId))
        .limit(1);

      if (existingReport.length > 0) {
        return res.status(400).json({ message: "Inspection report already submitted for this order" });
      }

      // Validate actual inspection date
      const scheduledDate = new Date(order[0].inspectionDate);
      const actualInspectionDateInput = req.body.actualInspectionDate
        ? new Date(req.body.actualInspectionDate)
        : null;

      if (!actualInspectionDateInput || Number.isNaN(actualInspectionDateInput.getTime())) {
        return res.status(400).json({ message: "Actual inspection date is required" });
      }

      const normalizedScheduledDate = toDateOnly(scheduledDate);
      const normalizedActualDate = toDateOnly(actualInspectionDateInput);
      const normalizedToday = toDateOnly(new Date());
      const earliestOverrideDate = toDateOnly(subDays(normalizedScheduledDate, EARLY_INSPECTION_OVERRIDE_WINDOW_DAYS));
      const earlyOverrideEnabled = Boolean(req.body.earlyInspectionOverride);
      const earlyOverrideReason = typeof req.body.earlyInspectionReason === "string"
        ? req.body.earlyInspectionReason.trim()
        : "";
      const actualBeforeSchedule = normalizedActualDate < normalizedScheduledDate;

      if (actualBeforeSchedule) {
        if (!earlyOverrideEnabled) {
          return res.status(400).json({
            message: `Actual inspection date cannot be before the scheduled date (${format(normalizedScheduledDate, "PPP")}). Enable the early inspection override and record a justification.`,
          });
        }
        if (normalizedActualDate < earliestOverrideDate) {
          return res.status(400).json({
            message: `Early inspections can only be logged up to ${EARLY_INSPECTION_OVERRIDE_WINDOW_DAYS} days before the scheduled date.`,
          });
        }
        if (!earlyOverrideReason || earlyOverrideReason.length < 15) {
          return res.status(400).json({
            message: "Please provide a justification of at least 15 characters for the early inspection.",
          });
        }
      }

      if (normalizedActualDate > normalizedToday) {
        return res.status(400).json({ message: "Actual inspection date cannot be in the future" });
      }

      // Validate and prepare report data
      const daysEarly = actualBeforeSchedule
        ? differenceInCalendarDays(normalizedScheduledDate, normalizedActualDate)
        : 0;
      const earlyOverrideNote =
        actualBeforeSchedule && earlyOverrideEnabled
          ? `Early inspection override: Conducted ${daysEarly} day${daysEarly === 1 ? '' : 's'} before the scheduled date (${format(normalizedScheduledDate, "PPP")}). Reason: ${earlyOverrideReason}`
          : null;
      const mergedMandatoryRemarks = (() => {
        const baseRemarks = req.body.mandatoryRemarks?.trim();
        if (!earlyOverrideNote) {
          return baseRemarks || null;
        }
        return baseRemarks ? `${baseRemarks}\n\n${earlyOverrideNote}` : earlyOverrideNote;
      })();

      const reportData = {
        inspectionOrderId: orderId,
        applicationId: order[0].applicationId,
        submittedBy: userId,
        submittedDate: new Date(),
        actualInspectionDate: normalizedActualDate,
        // Basic verification fields
        roomCountVerified: req.body.roomCountVerified ?? false,
        actualRoomCount: req.body.actualRoomCount || null,
        categoryMeetsStandards: req.body.categoryMeetsStandards ?? false,
        recommendedCategory: req.body.recommendedCategory || null,
        // ANNEXURE-III Checklists
        mandatoryChecklist: req.body.mandatoryChecklist || null,
        mandatoryRemarks: mergedMandatoryRemarks,
        desirableChecklist: req.body.desirableChecklist || null,
        desirableRemarks: req.body.desirableRemarks || null,
        // Legacy compatibility fields
        amenitiesVerified: req.body.amenitiesVerified || null,
        amenitiesIssues: req.body.amenitiesIssues || null,
        fireSafetyCompliant: req.body.fireSafetyCompliant ?? false,
        fireSafetyIssues: req.body.fireSafetyIssues || null,
        structuralSafety: req.body.structuralSafety ?? false,
        structuralIssues: req.body.structuralIssues || null,
        // Overall assessment
        overallSatisfactory: req.body.overallSatisfactory ?? false,
        recommendation: req.body.recommendation || 'approve',
        detailedFindings: req.body.detailedFindings || '',
        // Additional fields
        inspectionPhotos: req.body.inspectionPhotos || null,
        reportDocumentUrl: req.body.reportDocumentUrl || null,
      };

      // Load application to capture previous status for logging
      const currentApplication = await storage.getApplication(order[0].applicationId);

      // Insert inspection report
      const [newReport] = await db.insert(inspectionReports).values(reportData).returning();

      // Update inspection order status to completed
      await db.update(inspectionOrders)
        .set({ status: 'completed', updatedAt: new Date() })
        .where(eq(inspectionOrders.id, orderId));

      const normalizedRecommendation = (reportData.recommendation || "").toLowerCase();
      const siteInspectionOutcome =
        normalizedRecommendation === "raise_objections"
          ? "objection"
          : normalizedRecommendation === "approve"
            ? "recommended"
            : "completed";
      const applicationId = order[0].applicationId;
      if (!applicationId) {
        return res.status(400).json({ message: "Inspection order is missing an application reference" });
      }
      const applicationIdSafe = applicationId as string;

      // Auto-create acknowledgement if owner never clicked it, so downstream stages are not blocked.
      const ackExists = await db
        .select({ id: applicationActions.id })
        .from(applicationActions)
        .where(
          and(
            eq(applicationActions.applicationId, applicationIdSafe),
            eq(applicationActions.action, "inspection_acknowledged"),
          ),
        )
        .limit(1);
      if (ackExists.length === 0) {
        await db.insert(applicationActions).values({
          applicationId: applicationIdSafe,
          officerId: userId,
          action: "inspection_acknowledged",
          previousStatus: currentApplication?.status ?? null,
          newStatus: currentApplication?.status ?? null,
          feedback: "Auto-acknowledged after inspection completion.",
        });
      }

      await storage.updateApplication(applicationIdSafe, {
        status: "inspection_under_review",
        currentStage: "inspection_completed",
        siteInspectionNotes: reportData.detailedFindings || null,
        siteInspectionOutcome,
        siteInspectionCompletedDate: new Date(),
        inspectionReportId: newReport.id,
        clarificationRequested: null,
        rejectionReason: null,
      } as Partial<HomestayApplication>);

      await logApplicationAction({
        applicationId: applicationIdSafe,
        actorId: userId,
        action: "inspection_completed",
        previousStatus: currentApplication?.status ?? null,
        newStatus: "inspection_under_review",
        feedback: reportData.detailedFindings || null,
      });

      res.json({
        report: newReport,
        message: "Inspection report submitted successfully",
      });
    } catch (error) {
      routeLog.error("[da] Failed to submit inspection report:", error);
      res.status(500).json({ message: "Failed to submit inspection report" });
    }
  });

  // Document Routes
  
  // Get documents for application
  app.get("/api/applications/:id/documents", requireAuth, async (req, res) => {
    try {
      const documents = await storage.getDocumentsByApplication(req.params.id);
      res.json({ documents });
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch documents" });
    }
  });

  // Payment Routes
  
  // Create payment
  app.post("/api/payments", requireAuth, async (req, res) => {
    try {
      const payment = await storage.createPayment(req.body);
      res.json({ payment });
    } catch (error) {
      res.status(500).json({ message: "Failed to create payment" });
    }
  });

  // Update payment (for gateway callback)
  app.patch("/api/payments/:id", async (req, res) => {
    try {
      const payment = await storage.updatePayment(req.params.id, req.body);
      if (!payment) {
        return res.status(404).json({ message: "Payment not found" });
      }
      
      res.json({ payment });
    } catch (error) {
      res.status(500).json({ message: "Failed to update payment" });
    }
  });

  // Get payments for application
  app.get("/api/applications/:id/payments", requireAuth, async (req, res) => {
    try {
      const payments = await storage.getPaymentsByApplication(req.params.id);
      res.json({ payments });
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch payments" });
    }
  });

  // Confirm payment (Officer only)
  app.post("/api/payments/:id/confirm", requireRole("district_officer", "state_officer"), async (req, res) => {
    try {
      const userId = req.session.userId!;
      const payment = await storage.getPaymentById(req.params.id);
      if (!payment) {
        return res.status(404).json({ message: "Payment not found" });
      }

      // Update payment status to success
      await storage.updatePayment(req.params.id, {
        paymentStatus: "success",
        completedAt: new Date(),
      });

      // Update application status to approved and generate certificate number
      const application = await storage.getApplication(payment.applicationId);
      if (!application) {
        return res.status(404).json({ message: "Application not found" });
      }

      const certificateNumber = `HP-HST-${new Date().getFullYear()}-${String(Math.floor(Math.random() * 100000)).padStart(5, '0')}`;
      const issueDate = new Date();
      const expiryDate = new Date(issueDate);
      expiryDate.setFullYear(expiryDate.getFullYear() + 1);
      const formatTimelineDate = (value: Date) =>
        value.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
      
      await storage.updateApplication(payment.applicationId, {
        status: "approved",
        certificateNumber,
        certificateIssuedDate: issueDate,
        certificateExpiryDate: expiryDate,
        approvedAt: issueDate,
      });
      await logApplicationAction({
        applicationId: payment.applicationId,
        actorId: userId,
        action: "payment_confirmed",
        previousStatus: application.status,
        newStatus: "approved",
        feedback: "Payment confirmed manually by officer.",
      });
      await logApplicationAction({
        applicationId: payment.applicationId,
        actorId: userId,
        action: "certificate_issued",
        previousStatus: "approved",
        newStatus: "approved",
        feedback: `Certificate ${certificateNumber} issued on ${formatTimelineDate(issueDate)} (valid till ${formatTimelineDate(
          expiryDate,
        )}).`,
      });

      res.json({ 
        message: "Payment confirmed and certificate issued",
        certificateNumber,
        applicationId: payment.applicationId
      });
    } catch (error) {
      routeLog.error('Payment confirmation error:', error);
      res.status(500).json({ message: "Failed to confirm payment" });
    }
  });

  // Get all pending payments (Officer only)
  app.get("/api/payments/pending", requireRole("district_officer", "state_officer"), async (req, res) => {
    try {
      const allApplications = await storage.getAllApplications();
      const pendingPaymentApps = allApplications.filter(a => a.status === 'payment_pending');
      
      const paymentsWithApps = await Promise.all(
        pendingPaymentApps.map(async (app) => {
          const payments = await storage.getPaymentsByApplication(app.id);
          return {
            application: app,
            payment: payments.find(p => p.paymentStatus === 'pending_verification') || payments[0] || null,
          };
        })
      );

      res.json({ pendingPayments: paymentsWithApps.filter(p => p.payment !== null) });
    } catch (error) {
      routeLog.error('Pending payments fetch error:', error);
      res.status(500).json({ message: "Failed to fetch pending payments" });
    }
  });

  // Public Routes (Discovery Platform)
  
  // Get approved properties
  app.get("/api/public/properties", async (req, res) => {
    try {
      const properties = await storage.getApplicationsByStatus('approved');
      res.json({ properties });
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch properties" });
    }
  });

  // Analytics Routes (Officers Only)
  
  // Get production portal statistics (scraped from official portal)
  app.get("/api/analytics/production-stats", requireRole("dealing_assistant", "district_tourism_officer", "district_officer", "state_officer", "admin"), async (req, res) => {
    try {
      const stats = await storage.getLatestProductionStats();
      res.json({ stats });
    } catch (error) {
      routeLog.error('Production stats error:', error);
      res.status(500).json({ message: "Failed to fetch production stats" });
    }
  });
  
  // Get analytics dashboard data
  app.get("/api/analytics/dashboard", requireRole("dealing_assistant", "district_tourism_officer", "district_officer", "state_officer", "admin"), async (req, res) => {
    try {
      const userId = req.session.userId!;
      const currentUser = await storage.getUser(userId);

      const allApplications = await storage.getAllApplications();
      const allUsers = await storage.getAllUsers();

      const normalizeStatus = (status: string | null | undefined) =>
        (status ?? "").trim().toLowerCase();

      const shouldScopeByDistrict =
        currentUser &&
        ["dealing_assistant", "district_tourism_officer", "district_officer"].includes(currentUser.role) &&
        typeof currentUser.district === "string" &&
        currentUser.district.length > 0;

      const scopedApplications = shouldScopeByDistrict
        ? allApplications.filter((app) => app.district === currentUser!.district)
        : allApplications;

      const scopedOwners = shouldScopeByDistrict
        ? allUsers.filter((user) => user.role === "property_owner" && user.district === currentUser!.district)
        : allUsers.filter((user) => user.role === "property_owner");

      const byStatusNew = {
        submitted: scopedApplications.filter((app) => normalizeStatus(app.status) === "submitted").length,
        under_scrutiny: scopedApplications.filter((app) => normalizeStatus(app.status) === "under_scrutiny").length,
        forwarded_to_dtdo: scopedApplications.filter((app) => normalizeStatus(app.status) === "forwarded_to_dtdo").length,
        dtdo_review: scopedApplications.filter((app) => normalizeStatus(app.status) === "dtdo_review").length,
        inspection_scheduled: scopedApplications.filter((app) => normalizeStatus(app.status) === "inspection_scheduled").length,
        inspection_under_review: scopedApplications.filter((app) => normalizeStatus(app.status) === "inspection_under_review").length,
        reverted_to_applicant: scopedApplications.filter((app) => normalizeStatus(app.status) === "reverted_to_applicant").length,
        approved: scopedApplications.filter((app) => normalizeStatus(app.status) === "approved").length,
        rejected: scopedApplications.filter((app) => normalizeStatus(app.status) === "rejected").length,
        draft: scopedApplications.filter((app) => normalizeStatus(app.status) === "draft").length,
      } as const;

      const byStatusLegacy = {
        pending: byStatusNew.submitted,
        district_review: byStatusNew.under_scrutiny,
        state_review: byStatusNew.dtdo_review,
        approved: byStatusNew.approved,
        rejected: byStatusNew.rejected,
      };

      const byStatus = { ...byStatusNew, ...byStatusLegacy };

      const total = scopedApplications.length;
      const newApplications = byStatus.submitted;

      const byCategory = {
        diamond: scopedApplications.filter((a) => a.category === 'diamond').length,
        gold: scopedApplications.filter((a) => a.category === 'gold').length,
        silver: scopedApplications.filter((a) => a.category === 'silver').length,
      };

      const districtCounts: Record<string, number> = {};
      scopedApplications.forEach(app => {
        districtCounts[app.district] = (districtCounts[app.district] || 0) + 1;
      });

      const approvedApps = scopedApplications.filter(a => a.status === 'approved' && a.submittedAt && a.stateReviewDate);
      const processingTimes = approvedApps.map(app => {
        const submitted = new Date(app.submittedAt!).getTime();
        const approved = new Date(app.stateReviewDate!).getTime();
        return Math.floor((approved - submitted) / (1000 * 60 * 60 * 24));
      });
      const avgProcessingTime = processingTimes.length > 0
        ? Math.round(processingTimes.reduce((sum, time) => sum + time, 0) / processingTimes.length)
        : 0;

      const recentApplications = [...scopedApplications]
        .sort((a, b) => {
          const dateA = a.submittedAt ? new Date(a.submittedAt).getTime() : 0;
          const dateB = b.submittedAt ? new Date(b.submittedAt).getTime() : 0;
          return dateB - dateA;
        })
        .slice(0, 10);

      res.json({
        overview: {
          total,
          newApplications,
          byStatus,
          byCategory,
          avgProcessingTime,
          totalOwners: scopedOwners.length,
        },
        districts: districtCounts,
        recentApplications,
      });
    } catch (error) {
      routeLog.error('Analytics error:', error);
      res.status(500).json({ message: "Failed to fetch analytics data" });
    }
  });

  // Dev Console Routes (Development Only)
  // Admin seed endpoint - creates full test dataset
  // Use this to populate your database with demo data
  app.post("/admin/seed-database", async (req, res) => {
    try {
      // Check if seed data already exists
      const existingUser = await storage.getUserByMobile("9999999991");
      if (existingUser) {
        return res.json({
          message: "Seed data already exists",
          users: 3,
          properties: 5,
          note: "Database already has test accounts. Use /api/dev/clear-all first if you want to re-seed."
        });
      }

      // Create the 3 standard test users (matching seed-mock-data.ts)
      const owner = await storage.createUser({
        fullName: "Property Owner Demo",
        mobile: "9999999991",
        email: "owner@hptourism.com",
        password: "test123",
        role: "property_owner",
        district: "Shimla",
        aadhaarNumber: "123456789001",
      });

      const districtOfficer = await storage.createUser({
        fullName: "District Officer Shimla",
        mobile: "9999999992",
        email: "district@hptourism.gov.in",
        password: "test123",
        role: "district_officer",
        district: "Shimla",
        aadhaarNumber: "123456789002",
      });

      const stateOfficer = await storage.createUser({
        fullName: "State Tourism Officer",
        mobile: "9999999993",
        email: "state@hptourism.gov.in",
        password: "test123",
        role: "state_officer",
        district: "Shimla",
        aadhaarNumber: "123456789003",
      });

      // Create 5 mock homestay properties (matching seed-mock-data.ts)
      
      // 1. Mountain View Retreat - Diamond - Approved
      await storage.createApplication({
        userId: owner.id,
        propertyName: "Mountain View Retreat",
        category: "diamond",
        totalRooms: 8,
        address: "Naldehra Road, Near Golf Course, Shimla",
        district: "Shimla",
        pincode: "171002",
        latitude: "31.0850",
        longitude: "77.1734",
        ownerName: "Property Owner Demo",
        ownerMobile: "9999999991",
        ownerEmail: "owner@hptourism.com",
        ownerAadhaar: "123456789001",
        amenities: {
          wifi: true,
          parking: true,
          restaurant: true,
          hotWater: true,
          mountainView: true,
          garden: true,
          tv: true,
        },
        rooms: [
          { roomType: "Deluxe", size: 300, count: 4 },
          { roomType: "Suite", size: 450, count: 4 },
        ],
        baseFee: "5000.00",
        perRoomFee: "1000.00",
        gstAmount: "2340.00",
        totalFee: "15340.00",
        status: "approved",
        currentStage: "final",
        districtOfficerId: districtOfficer.id,
        districtReviewDate: new Date(),
        districtNotes: "Excellent property, meets all Diamond category standards",
        stateOfficerId: stateOfficer.id,
        stateReviewDate: new Date(),
        stateNotes: "Approved. Exemplary homestay facility",
        certificateNumber: `HP-CERT-2025-${Date.now()}`,
        certificateIssuedDate: new Date(),
        certificateExpiryDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
        submittedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
        approvedAt: new Date(),
      } as any, { trusted: true });

      // 2. Pine Valley Homestay - Gold - State Review
      await storage.createApplication({
        userId: owner.id,
        propertyName: "Pine Valley Homestay",
        category: "gold",
        totalRooms: 5,
        address: "Kufri Road, Near Himalayan Nature Park, Shimla",
        district: "Shimla",
        pincode: "171012",
        latitude: "31.1048",
        longitude: "77.2659",
        ownerName: "Property Owner Demo",
        ownerMobile: "9999999991",
        ownerEmail: "owner@hptourism.com",
        ownerAadhaar: "123456789001",
        amenities: {
          wifi: true,
          parking: true,
          hotWater: true,
          mountainView: true,
          garden: true,
        },
        rooms: [
          { roomType: "Standard", size: 200, count: 3 },
          { roomType: "Deluxe", size: 280, count: 2 },
        ],
        baseFee: "3000.00",
        perRoomFee: "800.00",
        gstAmount: "1260.00",
        totalFee: "8260.00",
        status: "state_review",
        currentStage: "state",
        districtOfficerId: districtOfficer.id,
        districtReviewDate: new Date(),
        districtNotes: "Good property, forwarded to state level",
        submittedAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
      } as any, { trusted: true });

      // 3. Cedar Wood Cottage - Silver - District Review
      await storage.createApplication({
        userId: owner.id,
        propertyName: "Cedar Wood Cottage",
        category: "silver",
        totalRooms: 3,
        address: "Mashobra Village, Near Reserve Forest, Shimla",
        district: "Shimla",
        pincode: "171007",
        latitude: "31.1207",
        longitude: "77.2291",
        ownerName: "Property Owner Demo",
        ownerMobile: "9999999991",
        ownerEmail: "owner@hptourism.com",
        ownerAadhaar: "123456789001",
        amenities: {
          wifi: true,
          parking: true,
          hotWater: true,
          garden: true,
        },
        rooms: [
          { roomType: "Standard", size: 180, count: 3 },
        ],
        baseFee: "2000.00",
        perRoomFee: "600.00",
        gstAmount: "720.00",
        totalFee: "4720.00",
        status: "district_review",
        currentStage: "district",
        submittedAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
      } as any, { trusted: true });

      // 4. Himalayan Heritage Home - Gold - Approved
      await storage.createApplication({
        userId: owner.id,
        propertyName: "Himalayan Heritage Home",
        category: "gold",
        totalRooms: 6,
        address: "The Mall Road, Near Christ Church, Shimla",
        district: "Shimla",
        pincode: "171001",
        latitude: "31.1048",
        longitude: "77.1734",
        ownerName: "Property Owner Demo",
        ownerMobile: "9999999991",
        ownerEmail: "owner@hptourism.com",
        ownerAadhaar: "123456789001",
        amenities: {
          wifi: true,
          parking: true,
          hotWater: true,
          tv: true,
          laundry: true,
          roomService: true,
        },
        rooms: [
          { roomType: "Standard", size: 220, count: 4 },
          { roomType: "Deluxe", size: 300, count: 2 },
        ],
        baseFee: "3000.00",
        perRoomFee: "800.00",
        gstAmount: "1440.00",
        totalFee: "9440.00",
        status: "approved",
        currentStage: "final",
        districtOfficerId: districtOfficer.id,
        districtReviewDate: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
        districtNotes: "Heritage property, well maintained",
        stateOfficerId: stateOfficer.id,
        stateReviewDate: new Date(),
        stateNotes: "Approved for Gold category",
        certificateNumber: `HP-CERT-2025-${Date.now() + 1}`,
        certificateIssuedDate: new Date(),
        certificateExpiryDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
        submittedAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
        approvedAt: new Date(),
      } as any, { trusted: true });

      // 5. Snowfall Cottage - Silver - Submitted
      await storage.createApplication({
        userId: owner.id,
        propertyName: "Snowfall Cottage",
        category: "silver",
        totalRooms: 4,
        address: "Chharabra Village, Near Wildflower Hall, Shimla",
        district: "Shimla",
        pincode: "171012",
        latitude: "31.1207",
        longitude: "77.2659",
        ownerName: "Property Owner Demo",
        ownerMobile: "9999999991",
        ownerEmail: "owner@hptourism.com",
        ownerAadhaar: "123456789001",
        amenities: {
          wifi: true,
          parking: true,
          hotWater: true,
          mountainView: true,
          petFriendly: true,
        },
        rooms: [
          { roomType: "Standard", size: 190, count: 4 },
        ],
        baseFee: "2000.00",
        perRoomFee: "600.00",
        gstAmount: "900.00",
        totalFee: "5900.00",
        status: "submitted",
        currentStage: "district",
        submittedAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000),
      } as any, { trusted: true });

      // 6. Devdar Manor - Diamond - Approved
      await storage.createApplication({
        userId: owner.id,
        propertyName: "Devdar Manor",
        category: "diamond",
        totalRooms: 10,
        address: "Near Ridge, Scandal Point, Shimla",
        district: "Shimla",
        pincode: "171001",
        latitude: "31.1041",
        longitude: "77.1732",
        ownerName: "Property Owner Demo",
        ownerMobile: "9999999991",
        ownerEmail: "owner@hptourism.com",
        ownerAadhaar: "123456789001",
        amenities: {
          wifi: true,
          parking: true,
          restaurant: true,
          hotWater: true,
          mountainView: true,
          garden: true,
          tv: true,
          ac: true,
        },
        rooms: [
          { roomType: "Deluxe", size: 350, count: 6 },
          { roomType: "Suite", size: 500, count: 4 },
        ],
        baseFee: "5000.00",
        perRoomFee: "1000.00",
        gstAmount: "2700.00",
        totalFee: "17700.00",
        status: "approved",
        currentStage: "final",
        districtOfficerId: districtOfficer.id,
        districtReviewDate: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000),
        districtNotes: "Premium property with excellent facilities",
        stateOfficerId: stateOfficer.id,
        stateReviewDate: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
        stateNotes: "Outstanding property. Highly recommended",
        certificateNumber: `HP-CERT-2025-${Date.now() + 2}`,
        certificateIssuedDate: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
        certificateExpiryDate: new Date(Date.now() + 360 * 24 * 60 * 60 * 1000),
        submittedAt: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000),
        approvedAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
      } as any, { trusted: true });

      // 7. Maple Tree Homestay - Gold - Approved
      await storage.createApplication({
        userId: owner.id,
        propertyName: "Maple Tree Homestay",
        category: "gold",
        totalRooms: 7,
        address: "Summer Hill, Near Himachal Pradesh University, Shimla",
        district: "Shimla",
        pincode: "171005",
        latitude: "31.0897",
        longitude: "77.1516",
        ownerName: "Property Owner Demo",
        ownerMobile: "9999999991",
        ownerEmail: "owner@hptourism.com",
        ownerAadhaar: "123456789001",
        amenities: {
          wifi: true,
          parking: true,
          hotWater: true,
          tv: true,
          garden: true,
          mountainView: true,
        },
        rooms: [
          { roomType: "Standard", size: 240, count: 4 },
          { roomType: "Deluxe", size: 320, count: 3 },
        ],
        baseFee: "3000.00",
        perRoomFee: "800.00",
        gstAmount: "1620.00",
        totalFee: "10620.00",
        status: "approved",
        currentStage: "final",
        districtOfficerId: districtOfficer.id,
        districtReviewDate: new Date(Date.now() - 12 * 24 * 60 * 60 * 1000),
        districtNotes: "Well-maintained property in scenic location",
        stateOfficerId: stateOfficer.id,
        stateReviewDate: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
        stateNotes: "Approved for Gold category",
        certificateNumber: `HP-CERT-2025-${Date.now() + 3}`,
        certificateIssuedDate: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
        certificateExpiryDate: new Date(Date.now() + 358 * 24 * 60 * 60 * 1000),
        submittedAt: new Date(Date.now() - 18 * 24 * 60 * 60 * 1000),
        approvedAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
      } as any, { trusted: true });

      // 8. Oak Ridge Villa - Silver - Approved
      await storage.createApplication({
        userId: owner.id,
        propertyName: "Oak Ridge Villa",
        category: "silver",
        totalRooms: 5,
        address: "Sanjauli, Near State Museum, Shimla",
        district: "Shimla",
        pincode: "171006",
        latitude: "31.1125",
        longitude: "77.1914",
        ownerName: "Property Owner Demo",
        ownerMobile: "9999999991",
        ownerEmail: "owner@hptourism.com",
        ownerAadhaar: "123456789001",
        amenities: {
          wifi: true,
          parking: true,
          hotWater: true,
          tv: true,
          garden: true,
        },
        rooms: [
          { roomType: "Standard", size: 200, count: 5 },
        ],
        baseFee: "2000.00",
        perRoomFee: "600.00",
        gstAmount: "900.00",
        totalFee: "5900.00",
        status: "approved",
        currentStage: "final",
        districtOfficerId: districtOfficer.id,
        districtReviewDate: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
        districtNotes: "Clean and comfortable property",
        stateOfficerId: stateOfficer.id,
        stateReviewDate: new Date(Date.now() - 6 * 24 * 60 * 60 * 1000),
        stateNotes: "Approved for Silver category",
        certificateNumber: `HP-CERT-2025-${Date.now() + 4}`,
        certificateIssuedDate: new Date(Date.now() - 6 * 24 * 60 * 60 * 1000),
        certificateExpiryDate: new Date(Date.now() + 359 * 24 * 60 * 60 * 1000),
        submittedAt: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000),
        approvedAt: new Date(Date.now() - 6 * 24 * 60 * 60 * 1000),
      } as any, { trusted: true });

      // 9. Riverside Haven - Gold - District Review
      await storage.createApplication({
        userId: owner.id,
        propertyName: "Riverside Haven",
        category: "gold",
        totalRooms: 6,
        address: "Tara Devi, Near Temple Road, Shimla",
        district: "Shimla",
        pincode: "171009",
        latitude: "31.0383",
        longitude: "77.1291",
        ownerName: "Property Owner Demo",
        ownerMobile: "9999999991",
        ownerEmail: "owner@hptourism.com",
        ownerAadhaar: "123456789001",
        amenities: {
          wifi: true,
          parking: true,
          hotWater: true,
          restaurant: true,
          mountainView: true,
          tv: true,
        },
        rooms: [
          { roomType: "Standard", size: 250, count: 4 },
          { roomType: "Deluxe", size: 320, count: 2 },
        ],
        baseFee: "3000.00",
        perRoomFee: "800.00",
        gstAmount: "1440.00",
        totalFee: "9440.00",
        status: "district_review",
        currentStage: "district",
        submittedAt: new Date(Date.now() - 4 * 24 * 60 * 60 * 1000),
      } as any, { trusted: true });

      // 10. Alpine Chalet - Diamond - State Review
      await storage.createApplication({
        userId: owner.id,
        propertyName: "Alpine Chalet",
        category: "diamond",
        totalRooms: 9,
        address: "Lakkar Bazaar, Near Ice Skating Rink, Shimla",
        district: "Shimla",
        pincode: "171001",
        latitude: "31.1023",
        longitude: "77.1691",
        ownerName: "Property Owner Demo",
        ownerMobile: "9999999991",
        ownerEmail: "owner@hptourism.com",
        ownerAadhaar: "123456789001",
        amenities: {
          wifi: true,
          parking: true,
          restaurant: true,
          hotWater: true,
          mountainView: true,
          garden: true,
          tv: true,
          ac: true,
        },
        rooms: [
          { roomType: "Deluxe", size: 330, count: 5 },
          { roomType: "Suite", size: 480, count: 4 },
        ],
        baseFee: "5000.00",
        perRoomFee: "1000.00",
        gstAmount: "2520.00",
        totalFee: "16520.00",
        status: "state_review",
        currentStage: "state",
        districtOfficerId: districtOfficer.id,
        districtReviewDate: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
        districtNotes: "Luxury property with all modern amenities. Forwarded to state",
        submittedAt: new Date(Date.now() - 6 * 24 * 60 * 60 * 1000),
      } as any, { trusted: true });

      res.json({
        success: true,
        message: "✅ Database seeded successfully with 10 properties!",
        users: 3,
        properties: 10,
        approved: 5,
        inReview: 5,
        testAccounts: {
          propertyOwner: { mobile: "9999999991", password: "test123" },
          districtOfficer: { mobile: "9999999992", password: "test123" },
          stateOfficer: { mobile: "9999999993", password: "test123" }
        }
      });
    } catch (error: any) {
      routeLog.error("Seed error:", error);
      res.status(500).json({ 
        success: false,
        message: "Failed to seed database", 
        error: error.message 
      });
    }
  });

  if (process.env.NODE_ENV === "development") {
    // Get storage stats
    app.get("/api/dev/stats", async (req, res) => {
      const stats = await storage.getStats();
      res.json(stats);
    });
    
    // Get all users (for testing)
    app.get("/api/dev/users", async (req, res) => {
      const users = await storage.getAllUsers();
      // Remove passwords from response
      const usersWithoutPasswords = users.map(({ password, ...user }) => user);
      res.json({ users: usersWithoutPasswords });
    });

    // Clear all data
    app.post("/api/dev/clear-all", async (req, res) => {
      await storage.clearAll();
      res.json({ message: "All data cleared successfully" });
    });

    // Seed sample data (old endpoint for backward compatibility)
    app.post("/api/dev/seed", async (req, res) => {
      try {
        // Create sample users
        const owner = await storage.createUser({
          fullName: "Demo Property Owner",
          mobile: "9876543210",
          password: "test123",
          role: "property_owner",
          district: "Shimla",
        });

        const districtOfficer = await storage.createUser({
          fullName: "District Officer Shimla",
          mobile: "9876543211",
          password: "test123",
          role: "district_officer",
          district: "Shimla",
        });

        const stateOfficer = await storage.createUser({
          fullName: "State Tourism Officer",
          mobile: "9876543212",
          password: "test123",
          role: "state_officer",
        });

        // Create sample applications (trusted server code can set status)
        const app1 = await storage.createApplication({
          userId: owner.id,
          propertyName: "Mountain View Homestay",
          address: "Near Mall Road, Shimla",
          district: "Shimla",
          pincode: "171001",
          ownerName: owner.fullName,
          ownerMobile: owner.mobile,
          ownerEmail: `demo${Date.now()}@example.com`,
          ownerAadhaar: "123456789012",
          totalRooms: 5,
          category: "gold",
          baseFee: "3000",
          perRoomFee: "300",
          gstAmount: "1080",
          totalFee: "7080",
          status: "approved",
          submittedAt: new Date(),
          districtOfficerId: districtOfficer.id,
          districtReviewDate: new Date(),
          districtNotes: "Excellent property. All criteria met.",
          stateOfficerId: stateOfficer.id,
          stateReviewDate: new Date(),
          stateNotes: "Approved for tourism operations.",
          certificateNumber: "HP-HM-2025-001",
        } as any, { trusted: true });

        const app2 = await storage.createApplication({
          userId: owner.id,
          propertyName: "Valley Retreat",
          address: "Lower Bazaar, Shimla",
          district: "Shimla",
          pincode: "171003",
          ownerName: owner.fullName,
          ownerMobile: owner.mobile,
          ownerEmail: `demo${Date.now() + 1}@example.com`,
          ownerAadhaar: "123456789012",
          totalRooms: 3,
          category: "silver",
          baseFee: "2000",
          perRoomFee: "200",
          gstAmount: "792",
          totalFee: "3392",
          amenities: {
            wifi: true,
            parking: true,
            mountainView: true,
            hotWater: true,
          },
          status: "approved",
          submittedAt: new Date(),
          districtOfficerId: districtOfficer.id,
          districtReviewDate: new Date(),
          districtNotes: "Good property. Meets all requirements.",
          stateOfficerId: stateOfficer.id,
          stateReviewDate: new Date(),
          stateNotes: "Approved for tourism operations.",
          certificateNumber: "HP-HM-2025-002",
        } as any, { trusted: true });

        res.json({
          message: "Sample data created",
          users: 3,
          applications: 2,
        });
      } catch (error) {
        res.status(500).json({ message: "Failed to seed data" });
      }
    });
  }

  // ============================================
  // Admin Routes - User Management
  // ============================================
  
  // Get all users (admin only)
  app.get("/api/admin/users", requireRole('admin', 'super_admin'), async (req, res) => {
    try {
      const users = await storage.getAllUsers();
      res.json({ users });
    } catch (error) {
      routeLog.error("Failed to fetch users:", error);
      res.status(500).json({ message: "Failed to fetch users" });
    }
  });

  // Update user (admin only)
  app.patch("/api/admin/users/:id", requireRole('admin', 'super_admin'), async (req, res) => {
    try {
      const { id } = req.params;
      const { 
        role, isActive, fullName, email, district, password,
        firstName, lastName, username, alternatePhone,
        designation, department, employeeId, officeAddress, officePhone
      } = req.body;
      
      // Fetch target user first to check their role
      const currentUser = await storage.getUser(req.session.userId!);
      const targetUser = await storage.getUser(id);
      if (!targetUser) {
        return res.status(404).json({ message: "User not found" });
      }
      
      // Whitelist only safe fields for admin updates
      const updates: Partial<User> = {};
      
      // Basic profile fields
      if (fullName !== undefined && fullName !== null && fullName.trim()) {
        updates.fullName = fullName.trim();
      }
      
      // Name fields (for staff users)
      if (firstName !== undefined && firstName !== null) {
        updates.firstName = firstName.trim() || null;
      }
      if (lastName !== undefined && lastName !== null) {
        updates.lastName = lastName.trim() || null;
      }
      if (username !== undefined && username !== null) {
        updates.username = username.trim() || null;
      }
      
      // Contact fields
      if (email !== undefined && email !== null) {
        updates.email = email.trim() || null;
      }
      if (alternatePhone !== undefined && alternatePhone !== null) {
        updates.alternatePhone = alternatePhone.trim() || null;
      }
      
      // Official fields (for staff users)
      if (designation !== undefined && designation !== null) {
        updates.designation = designation.trim() || null;
      }
      if (department !== undefined && department !== null) {
        updates.department = department.trim() || null;
      }
      if (employeeId !== undefined && employeeId !== null) {
        updates.employeeId = employeeId.trim() || null;
      }
      if (district !== undefined && district !== null) {
        updates.district = district.trim() || null;
      }
      if (officeAddress !== undefined && officeAddress !== null) {
        updates.officeAddress = officeAddress.trim() || null;
      }
      if (officePhone !== undefined && officePhone !== null) {
        updates.officePhone = officePhone.trim() || null;
      }
      
      // Hash password if provided
      if (password !== undefined && password !== null && password.trim()) {
        const hashedPassword = await bcrypt.hash(password.trim(), 10);
        updates.password = hashedPassword;
      }
      
      // Role updates with validation
      if (role !== undefined) {
        // Validate role is one of the allowed values
        const allowedRoles = ['property_owner', 'dealing_assistant', 'district_tourism_officer', 'district_officer', 'state_officer', 'admin'];
        if (!allowedRoles.includes(role)) {
          return res.status(400).json({ message: "Invalid role" });
        }
        updates.role = role;
      }
      
      // Active status updates
      if (isActive !== undefined) {
        updates.isActive = isActive;
      }
      
      // Prevent updates if no valid fields provided
      if (Object.keys(updates).length === 0) {
        return res.status(400).json({ message: "No valid fields to update" });
      }
      
      // Prevent admins from changing their own role or deactivating themselves
      if (currentUser && id === currentUser.id) {
        if (role && role !== currentUser.role) {
          return res.status(400).json({ message: "Cannot change your own role" });
        }
        if (isActive === false) {
          return res.status(400).json({ message: "Cannot deactivate your own account" });
        }
      }

      // Prevent any admin from changing another admin's role or deactivating them
      if (targetUser.role === 'admin' && (!currentUser || id !== currentUser.id)) {
        if (role && role !== targetUser.role) {
          return res.status(403).json({ message: "Cannot change another admin's role" });
        }
        if (isActive === false) {
          return res.status(403).json({ message: "Cannot deactivate another admin" });
        }
      }
      
      const updatedUser = await storage.updateUser(id, updates);
      if (!updatedUser) {
        return res.status(404).json({ message: "User not found" });
      }
      
      res.json({ user: updatedUser });
    } catch (error) {
      routeLog.error("Failed to update user:", error);
      res.status(500).json({ message: "Failed to update user" });
    }
  });

  // Toggle user status (admin only)
  app.patch("/api/admin/users/:id/status", requireRole('admin', 'super_admin'), async (req, res) => {
    try {
      const { id } = req.params;
      const { isActive } = req.body;
      
      // Prevent admins from deactivating themselves
      const currentUser = await storage.getUser(req.session.userId!);
      if (currentUser && id === currentUser.id && isActive === false) {
        return res.status(400).json({ message: "Cannot deactivate your own account" });
      }
      
      // Prevent deactivating other admin users
      const user = await storage.getUser(id);
      if (!user) {
        return res.status(404).json({ message: "User not found" });
      }
      
      if (user.role === 'admin' && !isActive && (!currentUser || user.id !== currentUser.id)) {
        return res.status(400).json({ message: "Cannot deactivate other admin users" });
      }
      
      const updatedUser = await storage.updateUser(id, { isActive });
      res.json({ user: updatedUser });
    } catch (error) {
      routeLog.error("Failed to update user status:", error);
      res.status(500).json({ message: "Failed to update user status" });
    }
  });

  // Create new user (admin only)
  app.post("/api/admin/users", requireRole('admin', 'super_admin'), async (req, res) => {
    try {
      const { 
        mobile, fullName, role, district, password,
        firstName, lastName, username, email, alternatePhone,
        designation, department, employeeId, officeAddress, officePhone
      } = req.body;

      // Validate required fields based on role
      if (role !== 'property_owner') {
        // Staff users require firstName, lastName, mobile, and password
        if (!mobile || !firstName || !lastName || !password) {
          return res.status(400).json({ 
            message: "Mobile, first name, last name, and password are required for staff users" 
          });
        }
      } else {
        // Property owners require fullName, mobile, and password
        if (!mobile || !fullName || !password) {
          return res.status(400).json({ 
            message: "Mobile, full name, and password are required" 
          });
        }
      }

      // Validate mobile format
      if (!/^[6-9]\d{9}$/.test(mobile)) {
        return res.status(400).json({ message: "Invalid mobile number format" });
      }

      // Validate role
      const allowedRoles = [
        'property_owner', 
        'dealing_assistant', 
        'district_tourism_officer',
        'district_officer', 
        'state_officer', 
        'admin'
      ];
      if (!allowedRoles.includes(role)) {
        return res.status(400).json({ message: "Invalid role" });
      }

      // Check if mobile already exists
      const existingUser = await db
        .select()
        .from(users)
        .where(eq(users.mobile, mobile))
        .limit(1);

      if (existingUser.length > 0) {
        return res.status(400).json({ 
          message: "A user with this mobile number already exists" 
        });
      }

      // Hash password
      const hashedPassword = await bcrypt.hash(password, 10);

      // Prepare user data with comprehensive profile fields
      const userData: any = {
        mobile,
        fullName: fullName || `${firstName} ${lastName}`, // Auto-generate for staff
        role,
        district: district?.trim() || null,
        password: hashedPassword,
        isActive: true,
      };

      // Add comprehensive profile fields for staff users
      if (role !== 'property_owner') {
        userData.firstName = firstName?.trim() || null;
        userData.lastName = lastName?.trim() || null;
        userData.username = username?.trim() || null;
        userData.email = email?.trim() || null;
        userData.alternatePhone = alternatePhone?.trim() || null;
        userData.designation = designation?.trim() || null;
        userData.department = department?.trim() || null;
        userData.employeeId = employeeId?.trim() || null;
        userData.officeAddress = officeAddress?.trim() || null;
        userData.officePhone = officePhone?.trim() || null;
      }

      // Create user
      const [newUser] = await db
        .insert(users)
        .values(userData)
        .returning();

      routeLog.info(`[admin] Created new user: ${userData.fullName} (${role}) - ${mobile}`);

      res.json({ 
        user: newUser,
        message: "User created successfully" 
      });
    } catch (error) {
      routeLog.error("Failed to create user:", error);
      res.status(500).json({ message: "Failed to create user" });
    }
  });

  // ============================================
  // Admin RC - Legacy Queue Management
  // ============================================
  const legacySelection = {
    application: homestayApplications,
    owner: {
      id: users.id,
      fullName: users.fullName,
      mobile: users.mobile,
      email: users.email,
      district: users.district,
    },
  };

  const legacyApplicationUpdateSchema = z.object({
    propertyName: z.string().min(3),
    category: z.enum(LEGACY_CATEGORY_OPTIONS),
    locationType: z.enum(LEGACY_LOCATION_TYPES),
    status: z.enum(LEGACY_STATUS_OPTIONS),
    projectType: z.string().min(2),
    propertyOwnership: z.enum(LEGACY_PROPERTY_OWNERSHIP),
    address: z.string().min(3),
    district: z.string().min(3),
    tehsil: z.string().min(3),
    block: z.string().nullable().optional(),
    gramPanchayat: z.string().nullable().optional(),
    pincode: z.string().min(4),
    ownerName: z.string().min(3),
    ownerMobile: z.string().min(6),
    ownerEmail: z.string().email().nullable().optional(),
    ownerAadhaar: z.string().min(6),
    ownerGender: z.enum(LEGACY_OWNER_GENDERS),
    propertyArea: z.number().positive(),
    singleBedRooms: z.number().int().min(0).nullable().optional(),
    singleBedRoomRate: z.number().min(0).nullable().optional(),
    doubleBedRooms: z.number().int().min(0).nullable().optional(),
    doubleBedRoomRate: z.number().min(0).nullable().optional(),
    familySuites: z.number().int().min(0).nullable().optional(),
    familySuiteRate: z.number().min(0).nullable().optional(),
    attachedWashrooms: z.number().int().min(0).nullable().optional(),
    distanceAirport: z.number().min(0).nullable().optional(),
    distanceRailway: z.number().min(0).nullable().optional(),
    distanceCityCenter: z.number().min(0).nullable().optional(),
    distanceShopping: z.number().min(0).nullable().optional(),
    distanceBusStand: z.number().min(0).nullable().optional(),
    certificateNumber: z.string().max(100).nullable().optional(),
    certificateIssuedDate: z.string().datetime().nullable().optional(),
    certificateExpiryDate: z.string().datetime().nullable().optional(),
    serviceNotes: z.string().nullable().optional(),
    guardianName: z.string().nullable().optional(),
  });

  const legacyOrderBy = sql`COALESCE(${homestayApplications.updatedAt}, ${homestayApplications.createdAt}, NOW())`;

  app.get("/api/admin-rc/applications", requireRole(...ADMIN_RC_ALLOWED_ROLES), async (_req, res) => {
    try {
      const rows = await db
        .select(legacySelection)
        .from(homestayApplications)
        .leftJoin(users, eq(users.id, homestayApplications.userId))
        .where(like(homestayApplications.applicationNumber, `${LEGACY_RC_PREFIX}%`))
        .orderBy(desc(legacyOrderBy));

      const applications = rows.map((row) => ({
        application: row.application,
        owner: row.owner?.id ? row.owner : null,
      }));

      res.json({ applications });
    } catch (error) {
      routeLog.error("[admin-rc] Failed to fetch legacy applications:", error);
      res.status(500).json({ message: "Failed to load legacy applications" });
    }
  });

  app.get("/api/admin-rc/applications/:id", requireRole(...ADMIN_RC_ALLOWED_ROLES), async (req, res) => {
    try {
      const { id } = req.params;
      const [record] = await db
        .select(legacySelection)
        .from(homestayApplications)
        .leftJoin(users, eq(users.id, homestayApplications.userId))
        .where(
          and(
            eq(homestayApplications.id, id),
            like(homestayApplications.applicationNumber, `${LEGACY_RC_PREFIX}%`)
          )
        )
        .limit(1);

      if (!record) {
        return res.status(404).json({ message: "Legacy application not found" });
      }

      const docList = await db
        .select()
        .from(documents)
        .where(eq(documents.applicationId, id));

      res.json({
        application: record.application,
        owner: record.owner?.id ? record.owner : null,
        documents: docList,
      });
    } catch (error) {
      routeLog.error("[admin-rc] Failed to fetch application:", error);
      res.status(500).json({ message: "Failed to load application" });
    }
  });

  app.patch("/api/admin-rc/applications/:id", requireRole(...ADMIN_RC_ALLOWED_ROLES), async (req, res) => {
    try {
      const { id } = req.params;
      const [existing] = await db
        .select(legacySelection)
        .from(homestayApplications)
        .leftJoin(users, eq(users.id, homestayApplications.userId))
        .where(
          and(
            eq(homestayApplications.id, id),
            like(homestayApplications.applicationNumber, `${LEGACY_RC_PREFIX}%`)
          )
        )
        .limit(1);

      if (!existing) {
        return res.status(404).json({ message: "Legacy application not found" });
      }

      const payload = legacyApplicationUpdateSchema.parse(req.body ?? {});

      const resolveNumeric = (
        incoming: number | null | undefined,
        fallback: number | null | undefined,
        { allowNull = true }: { allowNull?: boolean } = {}
      ): number | null | undefined => {
        const normalized = numberOrNull(incoming);
        if (normalized !== undefined) {
          if (normalized === null && !allowNull) {
            return typeof fallback === "number" ? fallback : toNumberFromUnknown(fallback) ?? null;
          }
          return normalized;
        }
        if (typeof fallback === "number") {
          return fallback;
        }
        return toNumberFromUnknown(fallback);
      };

      const resolvedPropertyArea =
        resolveNumeric(payload.propertyArea, toNumberFromUnknown(existing.application.propertyArea), { allowNull: false }) ?? 0;

      const resolvedSingleRooms = resolveNumeric(payload.singleBedRooms, existing.application.singleBedRooms);
      const resolvedDoubleRooms = resolveNumeric(payload.doubleBedRooms, existing.application.doubleBedRooms);
      const resolvedFamilySuites = resolveNumeric(payload.familySuites, existing.application.familySuites);
      const totalRooms =
        (resolvedSingleRooms ?? 0) + (resolvedDoubleRooms ?? 0) + (resolvedFamilySuites ?? 0);

      const updatePayload: Record<string, unknown> = {
        propertyName: trimRequiredString(payload.propertyName),
        category: payload.category,
        locationType: payload.locationType,
        status: payload.status,
        projectType: payload.projectType,
        propertyOwnership: payload.propertyOwnership,
        address: trimRequiredString(payload.address),
        district: trimRequiredString(payload.district),
        tehsil: trimRequiredString(payload.tehsil),
        block: trimOptionalString(payload.block) ?? null,
        gramPanchayat: trimOptionalString(payload.gramPanchayat) ?? null,
        pincode: trimRequiredString(payload.pincode),
        ownerName: trimRequiredString(payload.ownerName),
        ownerMobile: trimRequiredString(payload.ownerMobile),
        ownerEmail: trimOptionalString(payload.ownerEmail) ?? null,
        guardianName: trimOptionalString(payload.guardianName) ?? null,
        ownerAadhaar: trimRequiredString(payload.ownerAadhaar),
        ownerGender: payload.ownerGender,
        propertyArea: resolvedPropertyArea,
        singleBedRooms: resolvedSingleRooms ?? 0,
        doubleBedRooms: resolvedDoubleRooms ?? 0,
        familySuites: resolvedFamilySuites ?? 0,
        singleBedRoomRate: resolveNumeric(payload.singleBedRoomRate, toNumberFromUnknown(existing.application.singleBedRoomRate)),
        doubleBedRoomRate: resolveNumeric(payload.doubleBedRoomRate, toNumberFromUnknown(existing.application.doubleBedRoomRate)),
        familySuiteRate: resolveNumeric(payload.familySuiteRate, toNumberFromUnknown(existing.application.familySuiteRate)),
        attachedWashrooms: resolveNumeric(payload.attachedWashrooms, existing.application.attachedWashrooms),
        distanceAirport: resolveNumeric(payload.distanceAirport, toNumberFromUnknown(existing.application.distanceAirport)),
        distanceRailway: resolveNumeric(payload.distanceRailway, toNumberFromUnknown(existing.application.distanceRailway)),
        distanceCityCenter: resolveNumeric(payload.distanceCityCenter, toNumberFromUnknown(existing.application.distanceCityCenter)),
        distanceShopping: resolveNumeric(payload.distanceShopping, toNumberFromUnknown(existing.application.distanceShopping)),
        distanceBusStand: resolveNumeric(payload.distanceBusStand, toNumberFromUnknown(existing.application.distanceBusStand)),
        certificateNumber: trimOptionalString(payload.certificateNumber) ?? null,
        certificateIssuedDate: parseIsoDateOrNull(payload.certificateIssuedDate),
        certificateExpiryDate: parseIsoDateOrNull(payload.certificateExpiryDate),
        serviceNotes: trimOptionalString(payload.serviceNotes) ?? null,
        totalRooms,
        updatedAt: new Date(),
      };

      const currentServiceContext =
        (existing.application.serviceContext && typeof existing.application.serviceContext === "object"
          ? { ...existing.application.serviceContext }
          : {}) as Record<string, unknown>;

      if (payload.guardianName !== undefined) {
        currentServiceContext.legacyGuardianName = trimOptionalString(payload.guardianName) ?? null;
      }

      updatePayload.serviceContext = currentServiceContext;

      await db
        .update(homestayApplications)
        .set(updatePayload)
        .where(eq(homestayApplications.id, id));

      if (existing.owner?.id) {
        const ownerUpdates: Record<string, unknown> = {};
        if (payload.ownerName) {
          ownerUpdates.fullName = trimRequiredString(payload.ownerName);
        }
        if (payload.ownerMobile) {
          ownerUpdates.mobile = trimRequiredString(payload.ownerMobile);
        }
        if (payload.ownerEmail !== undefined) {
          ownerUpdates.email = trimOptionalString(payload.ownerEmail) ?? null;
        }
        if (payload.district) {
          ownerUpdates.district = trimRequiredString(payload.district);
        }
        if (Object.keys(ownerUpdates).length > 0) {
          ownerUpdates.updatedAt = new Date();
          await db.update(users).set(ownerUpdates).where(eq(users.id, existing.owner.id));
        }
      }

      const [updated] = await db
        .select(legacySelection)
        .from(homestayApplications)
        .leftJoin(users, eq(users.id, homestayApplications.userId))
        .where(eq(homestayApplications.id, id))
        .limit(1);

      const docList = await db
        .select()
        .from(documents)
        .where(eq(documents.applicationId, id));

      res.json({
        application: updated?.application,
        owner: updated?.owner?.id ? updated.owner : null,
        documents: docList,
      });
    } catch (error) {
      routeLog.error("[admin-rc] Failed to update legacy application:", error);
      res.status(500).json({ message: "Failed to update legacy application" });
    }
  });

  // RESET DATABASE - Clear all test data (admin only)
  app.post("/api/admin/reset-db", requireRole('admin', 'super_admin'), async (req, res) => {
    try {
      const { 
        preserveDdoCodes = false,
        preservePropertyOwners = false,
        preserveDistrictOfficers = false,
        preserveStateOfficers = false,
        preserveLgdData = false
      } = req.body;
      routeLog.info("[admin] Starting database reset...", { 
        preserveDdoCodes,
        preservePropertyOwners,
        preserveDistrictOfficers,
        preserveStateOfficers,
        preserveLgdData
      });
      
      // Helper function to safely delete from a table (handles missing tables)
      const safeDelete = async (table: any, tableName: string) => {
        try {
          await db.delete(table);
          routeLog.info(`[admin] ✓ Deleted all ${tableName}`);
        } catch (error: any) {
          if (error.code === '42P01') { // Table doesn't exist
            routeLog.info(`[admin] ⊙ Skipped ${tableName} (table doesn't exist yet)`);
          } else {
            throw error; // Re-throw other errors
          }
        }
      };
      
      // Delete in correct order to respect foreign key constraints
      // Child tables first, then parent tables
      
      // 1. Inspection Reports (references inspectionOrders, homestayApplications)
      await safeDelete(inspectionReports, 'inspection reports');
      
      // 2. Inspection Orders (references homestayApplications, users)
      await safeDelete(inspectionOrders, 'inspection orders');
      
      // 3. Certificates (references homestayApplications)
      await safeDelete(certificates, 'certificates');
      
      // 4. Clarifications (references homestayApplications)
      await safeDelete(clarifications, 'clarifications');
      
      // 5. Objections (references homestayApplications)
      await safeDelete(objections, 'objections');
      
      // 6. Application Actions (references homestayApplications)
      await safeDelete(applicationActions, 'application actions');
      
      // 7. Reviews (references homestayApplications)
      await safeDelete(reviews, 'reviews');
      
      // 8. HimKosh Transactions (references payments)
      await safeDelete(himkoshTransactions, 'HimKosh transactions');
      
      // 9. Payments (references homestayApplications)
      await safeDelete(payments, 'payments');
      
      // 10. Documents (references homestayApplications)
      await safeDelete(documents, 'documents');
      
      // 11. Homestay Applications (references users)
      await safeDelete(homestayApplications, 'homestay applications');
      
      // 12. Notifications (references users)
      await safeDelete(notifications, 'notifications');
      
      // 13. Audit Logs (references users)
      await safeDelete(auditLogs, 'audit logs');
      
      // 14. Production Stats (no foreign keys)
      await safeDelete(productionStats, 'production stats');
      
      // 15. DDO Codes (optional - configuration data, not test data)
      let ddoCodesStatus = "preserved (configuration data)";
      if (!preserveDdoCodes) {
        await db.delete(ddoCodes);
        ddoCodesStatus = "deleted";
        routeLog.info(`[admin] ✓ Deleted all DDO codes`);
      } else {
        routeLog.info(`[admin] ⊙ Preserved DDO codes (configuration data)`);
      }
      
      // 15b. System Settings (always preserved - configuration data)
      routeLog.info(`[admin] ⊙ Preserved system settings (configuration data)`);
      
      // 15c. LGD Master Data (optional - configuration data for Himachal Pradesh hierarchy)
      let lgdDataStatus = "preserved (configuration data)";
      if (!preserveLgdData) {
        // Delete LGD tables in reverse hierarchy (child to parent)
        await db.delete(lgdUrbanBodies);
        await db.delete(lgdGramPanchayats);
        await db.delete(lgdBlocks);
        await db.delete(lgdTehsils);
        await db.delete(lgdDistricts);
        lgdDataStatus = "deleted";
        routeLog.info(`[admin] ✓ Deleted all LGD master data`);
      } else {
        routeLog.info(`[admin] ⊙ Preserved LGD master data (configuration data)`);
      }
      
      // 16. Build list of roles to preserve
      const rolesToPreserve: string[] = ['admin', 'super_admin', 'admin_rc']; // Always preserve console admins
      
      if (preservePropertyOwners) {
        rolesToPreserve.push('property_owner');
      }
      
      if (preserveDistrictOfficers) {
        rolesToPreserve.push('dealing_assistant', 'district_tourism_officer', 'district_officer');
      }
      
      if (preserveStateOfficers) {
        rolesToPreserve.push('state_officer');
      }
      
      routeLog.info(`[admin] Roles to preserve:`, rolesToPreserve);
      
      // Delete user profiles for users whose roles are NOT in rolesToPreserve
      // Use a subquery to delete profiles based on user role
      const deletedProfiles = await db.delete(userProfiles)
        .where(
          sql`${userProfiles.userId} IN (SELECT id FROM ${users} WHERE ${notInArray(users.role, rolesToPreserve)})`
        )
        .returning();
      
      routeLog.info(`[admin] ✓ Deleted ${deletedProfiles.length} user profiles for non-preserved roles`);
      
      // 17. Users (delete based on preservation settings)
      const deletedUsers = await db.delete(users)
        .where(
          notInArray(users.role, rolesToPreserve)
        )
        .returning();
      
      const preservedUsers = await db.select().from(users);
      
      // Count preserved users by role
      const preservedCounts = preservedUsers.reduce((acc, user) => {
        acc[user.role] = (acc[user.role] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);
      
      routeLog.info(`[admin] ✓ Deleted ${deletedUsers.length} users (preserved ${preservedUsers.length} accounts)`);
      
      // TODO: Delete uploaded files from object storage
      // This would require listing and deleting files from GCS bucket
      // For now, we'll just clear database records
      
      routeLog.info("[admin] ✅ Database reset complete");
      
      res.json({ 
        message: "Database reset successful", 
        deleted: {
          inspectionReports: "all",
          inspectionOrders: "all",
          certificates: "all",
          clarifications: "all",
          objections: "all",
          applicationActions: "all",
          reviews: "all",
          himkoshTransactions: "all",
          payments: "all",
          documents: "all",
          applications: "all",
          notifications: "all",
          auditLogs: "all",
          productionStats: "all",
          ddoCodes: ddoCodesStatus,
          userProfiles: `${deletedProfiles.length} deleted, ${preservedUsers.length} preserved`,
          users: `${deletedUsers.length} deleted`
        },
        preserved: {
          totalUsers: preservedUsers.length,
          byRole: preservedCounts,
          ddoCodes: preserveDdoCodes,
          propertyOwners: preservePropertyOwners,
          districtOfficers: preserveDistrictOfficers,
          stateOfficers: preserveStateOfficers,
          lgdData: preserveLgdData,
          systemSettings: "always preserved"
        }
      });
    } catch (error) {
      routeLog.error("[admin] ❌ Database reset failed:", error);
      res.status(500).json({ 
        message: "Failed to reset database",
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  // ========================================
  // SUPER ADMIN CONSOLE ROUTES
  // ========================================

  // Get dashboard statistics for super admin
  app.get("/api/admin/dashboard/stats", requireRole('super_admin'), async (req, res) => {
    try {
      // Get all applications
      const allApplications = await db.select().from(homestayApplications);
      
      // Count by status
      const statusCounts = allApplications.reduce((acc, app) => {
        const statusKey = app.status ?? 'unknown';
        acc[statusKey] = (acc[statusKey] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);

      // Get all users
      const allUsers = await db.select().from(users);
      
      // Count by role
      const propertyOwners = allUsers.filter(u => u.role === 'property_owner').length;
      const officers = allUsers.filter(u => ['dealing_assistant', 'district_tourism_officer', 'state_officer'].includes(u.role)).length;
      const admins = allUsers.filter(u => ['admin', 'super_admin'].includes(u.role)).length;

      // Get inspections
      const [allInspectionOrders, allInspectionReports] = await Promise.all([
        db.select().from(inspectionOrders),
        db.select().from(inspectionReports),
      ]);

      // Get payments
      const allPayments = await db.select().from(payments);
      const completedPayments = allPayments.filter(p => p.paymentStatus === 'completed');
      const totalAmount = completedPayments.reduce((sum, p) => sum + Number(p.amount || 0), 0);

      res.json({
        applications: {
          total: allApplications.length,
          pending: statusCounts['submitted'] || 0,
          underReview: statusCounts['under_review'] || 0,
          approved: statusCounts['approved'] || 0,
          rejected: statusCounts['rejected'] || 0,
          draft: statusCounts['draft'] || 0,
        },
        users: {
          total: allUsers.length,
          propertyOwners,
          officers,
          admins,
        },
        inspections: {
          scheduled: allInspectionOrders.length,
          completed: allInspectionReports.length,
          pending: allInspectionOrders.length - allInspectionReports.length,
        },
        payments: {
          total: allPayments.length,
          completed: completedPayments.length,
          pending: allPayments.length - completedPayments.length,
          totalAmount,
        },
      });
    } catch (error) {
      routeLog.error("[admin] Failed to fetch dashboard stats:", error);
      res.status(500).json({ message: "Failed to fetch dashboard statistics" });
    }
  });

  // Get system statistics
  app.get("/api/admin/stats", requireRole('super_admin'), async (req, res) => {
    try {
      const environment = process.env.NODE_ENV || 'development';
      const [superConsoleSetting] = await db
        .select()
        .from(systemSettings)
        .where(eq(systemSettings.settingKey, 'admin_super_console_enabled'))
        .limit(1);

      let superConsoleOverride = false;
      if (superConsoleSetting) {
        const value = superConsoleSetting.settingValue as any;
        if (typeof value === 'boolean') {
          superConsoleOverride = value;
        } else if (value && typeof value === 'object') {
          if ('enabled' in value) {
            superConsoleOverride = Boolean(value.enabled);
          }
        } else if (typeof value === 'string') {
          superConsoleOverride = value === 'true';
        }
      }

      const resetEnabled = superConsoleOverride || environment === 'development' || environment === 'test';

      // Get counts
      const [
        applicationsCount,
        usersCount,
        documentsCount,
        paymentsCount
      ] = await Promise.all([
        db.select().from(homestayApplications).then(r => r.length),
        db.select().from(users).then(r => r.length),
        db.select().from(documents).then(r => r.length),
        db.select().from(payments).then(r => r.length),
      ]);

      // Get application status breakdown
      const applications = await db.select().from(homestayApplications);
      const byStatus = applications.reduce((acc, app) => {
        const statusKey = app.status ?? 'unknown';
        acc[statusKey] = (acc[statusKey] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);

      // Get user role breakdown
      const allUsers = await db.select().from(users);
      const byRole = allUsers.reduce((acc, user) => {
        acc[user.role] = (acc[user.role] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);

      // Calculate database size (approximate)
      const dbSize = "N/A"; // PostgreSQL specific query needed
      const tables = 10; // Approximate

      res.json({
        database: {
          size: dbSize,
          tables,
        },
        applications: {
          total: applicationsCount,
          byStatus,
        },
        users: {
          total: usersCount,
          byRole,
        },
        files: {
          total: documentsCount,
          totalSize: "N/A", // Would need to calculate from storage
        },
        environment,
        resetEnabled,
        superConsoleOverride,
      });
    } catch (error) {
      routeLog.error("[admin] Failed to fetch stats:", error);
      res.status(500).json({ message: "Failed to fetch system statistics" });
    }
  });

  app.get("/api/admin/settings/super-console", requireRole('super_admin'), async (_req, res) => {
    try {
      const [setting] = await db
        .select()
        .from(systemSettings)
        .where(eq(systemSettings.settingKey, 'admin_super_console_enabled'))
        .limit(1);

      let enabled = false;
      if (setting) {
        const value = setting.settingValue as any;
        if (typeof value === 'boolean') {
          enabled = value;
        } else if (value && typeof value === 'object' && 'enabled' in value) {
          enabled = Boolean(value.enabled);
        } else if (typeof value === 'string') {
          enabled = value === 'true';
        }
      }

      res.json({ enabled, environment: process.env.NODE_ENV || 'development' });
    } catch (error) {
      routeLog.error('[admin] Failed to fetch super console setting:', error);
      res.status(500).json({ message: 'Failed to fetch super console setting' });
    }
  });

  app.post("/api/admin/settings/super-console/toggle", requireRole('super_admin'), async (req, res) => {
    try {
      const { enabled } = req.body;
      const userId = req.session.userId || null;

      if (typeof enabled !== 'boolean') {
        return res.status(400).json({ message: 'enabled must be a boolean' });
      }

      const [existingSetting] = await db
        .select()
        .from(systemSettings)
        .where(eq(systemSettings.settingKey, 'admin_super_console_enabled'))
        .limit(1);

      if (existingSetting) {
        const [updated] = await db
          .update(systemSettings)
          .set({
            settingValue: { enabled },
            description: existingSetting.description || 'Controls whether Super Admin Console is available in production environments',
            category: existingSetting.category || 'security',
            updatedBy: userId,
            updatedAt: new Date(),
          })
          .where(eq(systemSettings.settingKey, 'admin_super_console_enabled'))
          .returning();

        routeLog.info(`[admin] Super console override ${enabled ? 'enabled' : 'disabled'}`);
        res.json(updated);
      } else {
        const [created] = await db
          .insert(systemSettings)
          .values({
            settingKey: 'admin_super_console_enabled',
            settingValue: { enabled },
            description: 'Controls whether Super Admin Console is available in production environments',
            category: 'security',
            updatedBy: userId,
          })
          .returning();

        routeLog.info(`[admin] Super console override ${enabled ? 'enabled' : 'disabled'}`);
        res.json(created);
      }
    } catch (error) {
      routeLog.error('[admin] Failed to toggle super console:', error);
      res.status(500).json({ message: 'Failed to toggle super console' });
    }
  });

  // ========================================
  // SYSTEM SETTINGS ROUTES (Admin/Super Admin)
  // ========================================

  // Get a specific system setting by key
  app.get("/api/admin/settings/:key", requireRole('admin', 'super_admin'), async (req, res) => {
    try {
      const { key } = req.params;
      
      const [setting] = await db
        .select()
        .from(systemSettings)
        .where(eq(systemSettings.settingKey, key))
        .limit(1);
      
      if (!setting) {
        return res.status(404).json({ message: "Setting not found" });
      }
      
      res.json(setting);
    } catch (error) {
      logger.error({ err: error, route: req.path, key: req.params?.key }, "[admin] Failed to fetch setting");
      res.status(500).json({ message: "Failed to fetch setting" });
    }
  });

  // Update or create a system setting
  app.put("/api/admin/settings/:key", requireRole('admin', 'super_admin'), async (req, res) => {
    try {
      const { key } = req.params;
      const { settingValue, description } = req.body;
      const userId = req.session.userId || null;
      
      if (!settingValue) {
        return res.status(400).json({ message: "Setting value is required" });
      }
      
      // Check if setting exists
      const [existingSetting] = await db
        .select()
        .from(systemSettings)
        .where(eq(systemSettings.settingKey, key))
        .limit(1);
      
      if (existingSetting) {
        // Update existing setting
        const [updated] = await db
          .update(systemSettings)
          .set({
            settingValue,
            description: description || existingSetting.description,
            updatedBy: userId,
            updatedAt: new Date(),
          })
          .where(eq(systemSettings.settingKey, key))
          .returning();
        
        logger.info({ settingKey: key, userId }, "[admin] Updated setting");
        res.json(updated);
      } else {
        // Create new setting
        const [created] = await db
          .insert(systemSettings)
          .values({
            settingKey: key,
            settingValue,
            description: description || '',
            category: key.startsWith('payment_') ? 'payment' : 'general',
            updatedBy: userId,
          })
          .returning();
        
        logger.info({ settingKey: key, userId }, "[admin] Created setting");
        res.json(created);
      }
    } catch (error) {
      logger.error({ err: error, route: req.path, key: req.params?.key }, "[admin] Failed to update setting");
      res.status(500).json({ message: "Failed to update setting" });
    }
  });

  // Get test payment mode status (specific endpoint for convenience)
  app.get("/api/admin/settings/payment/test-mode", async (req, res) => {
    try {
      if (!req.session.userId) {
        return res.status(401).json({ message: "Authentication required" });
      }
      const user = await storage.getUser(req.session.userId);
      const role = user?.role?.trim();
      if (!user || !role || (role !== "admin" && role !== "super_admin")) {
        logger.warn(
          { userId: user?.id ?? null, role: user?.role ?? null, route: req.path },
          "[auth] Admin/Super guard failed",
        );
        return res.status(403).json({ message: "Insufficient permissions" });
      }
      logger.info(
        { userId: user.id, role, route: req.path, method: req.method },
        "[admin] Guard granted payment test-mode fetch",
      );

      const [setting] = await db
        .select()
        .from(systemSettings)
        .where(eq(systemSettings.settingKey, 'payment_test_mode'))
        .limit(1);
      
      if (!setting) {
        // Default: test mode disabled
        res.json({ enabled: false, isDefault: true });
      } else {
        const value = setting.settingValue as { enabled: boolean };
        res.json({ enabled: value.enabled, isDefault: false });
      }
    } catch (error) {
      logger.error({ err: error, route: req.path }, "[admin] Failed to fetch test payment mode");
      res.status(500).json({ message: "Failed to fetch test payment mode" });
    }
  });

  // Toggle test payment mode
  app.post("/api/admin/settings/payment/test-mode/toggle", async (req, res) => {
    try {
      if (!req.session.userId) {
        return res.status(401).json({ message: "Authentication required" });
      }
      const user = await storage.getUser(req.session.userId);
      const role = user?.role?.trim();
      if (!user || !role || (role !== "admin" && role !== "super_admin")) {
        logger.warn(
          { userId: user?.id ?? null, role: user?.role ?? null, route: req.path },
          "[auth] Admin/Super guard failed",
        );
        return res.status(403).json({ message: "Insufficient permissions" });
      }

      const { enabled } = req.body;
      const userId = user.id;
      logger.info(
        { userId, role, enabled },
        "[admin] Requested test-mode toggle",
      );
      
      if (typeof enabled !== 'boolean') {
        return res.status(400).json({ message: "enabled must be a boolean" });
      }
      
      // Check if setting exists
      const [existingSetting] = await db
        .select()
        .from(systemSettings)
        .where(eq(systemSettings.settingKey, 'payment_test_mode'))
        .limit(1);
      
      if (existingSetting) {
        // Update existing
        const [updated] = await db
          .update(systemSettings)
          .set({
            settingValue: { enabled },
            updatedBy: userId,
            updatedAt: new Date(),
          })
          .where(eq(systemSettings.settingKey, 'payment_test_mode'))
          .returning();
        
        logger.info({ userId, enabled }, "[admin] Test payment mode updated");
        res.json(updated);
      } else {
        // Create new
        const [created] = await db
          .insert(systemSettings)
          .values({
            settingKey: 'payment_test_mode',
            settingValue: { enabled },
            description: 'When enabled, payment requests send ₹1 to gateway instead of actual amount (for testing)',
            category: 'payment',
            updatedBy: userId,
          })
          .returning();
        
        logger.info({ userId, enabled }, "[admin] Test payment mode created");
        res.json(created);
      }
    } catch (error) {
      logger.error({ err: error, route: req.path }, "[admin] Failed to toggle test payment mode");
      res.status(500).json({ message: "Failed to toggle test payment mode" });
    }
  });

  app.get("/api/admin/payments/himkosh", requireRole('admin', 'super_admin'), async (req, res) => {
    try {
      const { config: effectiveConfig, overrides, record } = await resolveHimkoshGatewayConfig();
      res.json({
        effective: effectiveConfig,
        overrides: sanitizeHimkoshGatewaySetting(overrides),
        source: record ? "database" : "env",
        updatedAt: record?.updatedAt,
        updatedBy: record?.updatedBy,
      });
    } catch (error) {
      logger.error({ err: error, route: req.path }, "[admin] Failed to fetch HimKosh config");
      res.status(500).json({ message: "Failed to fetch HimKosh config" });
    }
  });

  app.put("/api/admin/payments/himkosh", requireRole('admin', 'super_admin'), async (req, res) => {
    try {
      const userId = req.session?.userId ?? null;
      const payload: HimkoshGatewaySettingValue = {
        merchantCode: trimHimkoshString(req.body?.merchantCode),
        deptId: trimHimkoshString(req.body?.deptId),
        serviceCode: trimHimkoshString(req.body?.serviceCode),
        ddo: trimHimkoshString(req.body?.ddo),
        head1: trimHimkoshString(req.body?.head1),
        head2: trimHimkoshString(req.body?.head2),
        head2Amount: parseOptionalHimkoshNumber(req.body?.head2Amount),
        returnUrl: trimHimkoshString(req.body?.returnUrl),
        allowFallback: req.body?.allowFallback !== false,
      };

      if (!payload.merchantCode || !payload.deptId || !payload.serviceCode || !payload.ddo || !payload.head1) {
        return res.status(400).json({
          message: "Merchant code, Dept ID, Service code, DDO, and Head of Account are required",
        });
      }

      const existing = await getSystemSettingRecord(HIMKOSH_GATEWAY_SETTING_KEY);
      if (existing) {
        await db
          .update(systemSettings)
          .set({
            settingValue: payload,
            updatedBy: userId,
            updatedAt: new Date(),
            description: "HimKosh gateway configuration",
            category: "payment",
          })
          .where(eq(systemSettings.settingKey, HIMKOSH_GATEWAY_SETTING_KEY));
      } else {
        await db.insert(systemSettings).values({
          settingKey: HIMKOSH_GATEWAY_SETTING_KEY,
          settingValue: payload,
          description: "HimKosh gateway configuration",
          category: "payment",
          updatedBy: userId,
        });
      }

      logger.info({ userId }, "[admin] Updated HimKosh gateway config");
      res.json({ success: true });
    } catch (error) {
      logger.error({ err: error, route: req.path }, "[admin] Failed to update HimKosh config");
      res.status(500).json({ message: "Failed to update HimKosh config" });
    }
  });

  app.delete("/api/admin/payments/himkosh", requireRole('admin', 'super_admin'), async (req, res) => {
    try {
      const existing = await getSystemSettingRecord(HIMKOSH_GATEWAY_SETTING_KEY);
      if (!existing) {
        return res.status(404).json({ message: "No HimKosh override found" });
      }
      await db.delete(systemSettings).where(eq(systemSettings.settingKey, HIMKOSH_GATEWAY_SETTING_KEY));
      logger.info({ settingKey: HIMKOSH_GATEWAY_SETTING_KEY, userId: req.session?.userId ?? null }, "[admin] Cleared HimKosh gateway config override");
      res.json({ success: true });
    } catch (error) {
      logger.error({ err: error, route: req.path }, "[admin] Failed to clear HimKosh config");
      res.status(500).json({ message: "Failed to clear HimKosh config" });
    }
  });

  app.get("/api/admin/payments/himkosh/ddo-codes", requireRole('admin', 'super_admin'), async (_req, res) => {
    try {
      const codes = await fetchAllDdoCodes();
      res.json({ codes });
    } catch (error) {
      logger.error({ err: error }, "[admin] Failed to load DDO codes");
      res.status(500).json({ message: "Failed to load DDO codes" });
    }
  });

  app.post("/api/admin/payments/himkosh/transactions/clear", requireRole('admin', 'super_admin'), async (req, res) => {
    try {
      const rawConfirm = typeof req.body?.confirmationText === "string" ? req.body.confirmationText : "";
      const normalized = rawConfirm.trim().toUpperCase();
      if (normalized !== "CLEAR HIMKOSH LOG") {
        return res.status(400).json({ message: "Type CLEAR HIMKOSH LOG to confirm" });
      }

      const deleted = await db.delete(himkoshTransactions).returning({ id: himkoshTransactions.id });
      logger.warn(
        { userId: req.session?.userId ?? null, deleted: deleted.length },
        "[admin] Cleared HimKosh transaction log",
      );

      res.json({ success: true, deleted: deleted.length });
    } catch (error) {
      logger.error({ err: error }, "[admin] Failed to clear HimKosh transactions");
      res.status(500).json({ message: "Failed to clear HimKosh transactions" });
    }
  });

  app.post("/api/admin/payments/himkosh/ddo-test", requireRole('admin', 'super_admin'), async (req, res) => {
    try {
      const rawDistrict = typeof req.body?.district === "string" ? req.body.district.trim() : "";
      const rawTehsil = typeof req.body?.tehsil === "string" ? req.body.tehsil.trim() : "";
      const manualDdo = trimHimkoshString(req.body?.manualDdo);
      const tenderBy =
        typeof req.body?.tenderBy === "string" && req.body.tenderBy.trim().length
          ? req.body.tenderBy.trim()
          : "Test Applicant";
      const requestedAmount = Number(req.body?.amount ?? 1);
      const totalAmount = Number.isFinite(requestedAmount) && requestedAmount > 0 ? Math.round(requestedAmount) : 1;

      const { config } = await resolveHimkoshGatewayConfig();
      const head1 = config.heads?.registrationFee;
      if (!config.merchantCode || !config.deptId || !config.serviceCode || !head1) {
        return res.status(400).json({ message: "HimKosh gateway is not fully configured" });
      }

      const routedDistrict =
        deriveDistrictRoutingLabel(rawDistrict || undefined, rawTehsil || undefined) ?? (rawDistrict || null);
      const mapped = routedDistrict ? await resolveDistrictDdo(routedDistrict) : undefined;
      const fallbackDdo = config.ddo;

      const ddoToUse = manualDdo || mapped?.ddoCode || fallbackDdo;
      if (!ddoToUse) {
        return res.status(400).json({ message: "No DDO code available. Provide a manual override to test." });
      }

      const now = new Date();
      const periodDate = `${String(now.getDate()).padStart(2, "0")}-${String(now.getMonth() + 1).padStart(2, "0")}-${now.getFullYear()}`;
      const deptRefNo = `TEST-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(
        now.getDate(),
      ).padStart(2, "0")}-${now.getTime().toString().slice(-4)}`;
      const appRefNo = `HPT${now.getTime()}`.slice(0, 20);

      const payloadParams = {
        deptId: config.deptId,
        deptRefNo,
        totalAmount,
        tenderBy,
        appRefNo,
        head1,
        amount1: totalAmount,
        head2: config.heads?.secondaryHead || undefined,
        amount2: config.heads?.secondaryHeadAmount ?? undefined,
        ddo: ddoToUse,
        periodFrom: periodDate,
        periodTo: periodDate,
        serviceCode: config.serviceCode,
        returnUrl: config.returnUrl,
      };

      const { coreString, fullString } = buildRequestString(payloadParams);
      const checksum = HimKoshCrypto.generateChecksum(coreString);
      const payloadWithChecksum = `${fullString}|checkSum=${checksum}`;
      const encrypted = await adminHimkoshCrypto.encrypt(payloadWithChecksum);

      res.json({
        success: true,
        requestedDistrict: rawDistrict || null,
        requestedTehsil: rawTehsil || null,
        routedDistrict,
        mapping: mapped
          ? {
              district: mapped.district,
              ddoCode: mapped.ddoCode,
              treasuryCode: mapped.treasuryCode,
            }
          : null,
        ddoUsed: ddoToUse,
        ddoSource: manualDdo ? "manual_override" : mapped ? "district_mapping" : "default_config",
        payload: {
          params: payloadParams,
          coreString,
          fullString,
          checksum,
          encrypted,
          paymentUrl: `${config.paymentUrl}?encdata=${encodeURIComponent(encrypted)}&merchant_code=${config.merchantCode}`,
        },
      });
    } catch (error) {
      logger.error({ err: error }, "[admin] Failed to run HimKosh DDO test");
      res.status(500).json({ message: "Failed to run HimKosh DDO test" });
    }
  });

  // Captcha settings
  app.get("/api/admin/settings/auth/captcha", requireRole('admin', 'super_admin'), async (_req, res) => {
    try {
      const enabled = await getCaptchaSetting();
      res.json({ enabled });
    } catch (error) {
      routeLog.error("[admin] Failed to fetch captcha setting:", error);
      res.status(500).json({ message: "Failed to fetch captcha setting" });
    }
  });

  app.post("/api/admin/settings/auth/captcha/toggle", requireRole('admin', 'super_admin'), async (req, res) => {
    try {
      const { enabled } = req.body;
      if (typeof enabled !== "boolean") {
        return res.status(400).json({ message: "enabled must be a boolean" });
      }

      const userId = req.session.userId || null;
      const [existingSetting] = await db
        .select()
        .from(systemSettings)
        .where(eq(systemSettings.settingKey, CAPTCHA_SETTING_KEY))
        .limit(1);

      if (existingSetting) {
        await db
          .update(systemSettings)
          .set({
            settingValue: { enabled },
            updatedBy: userId,
            updatedAt: new Date(),
          })
          .where(eq(systemSettings.settingKey, CAPTCHA_SETTING_KEY));
      } else {
        await db.insert(systemSettings).values({
          settingKey: CAPTCHA_SETTING_KEY,
          settingValue: { enabled },
          description: "Toggle login captcha requirement for testing",
          category: "security",
          updatedBy: userId,
        });
      }

      updateCaptchaSettingCache(enabled);
      routeLog.info(`[admin] Captcha requirement ${enabled ? "enabled" : "disabled"}`);
      res.json({ enabled });
    } catch (error) {
      routeLog.error("[admin] Failed to toggle captcha setting:", error);
      res.status(500).json({ message: "Failed to update captcha setting" });
    }
  });

  app.get("/api/admin/db/config", requireRole('super_admin'), async (_req, res) => {
    try {
      const stored = await getDbConnectionSettings();
      const fallback = stored ?? parseDatabaseUrlFromEnv();
      if (!fallback) {
        return res.json({
          settings: null,
          hasPassword: false,
          metadata: {},
          source: "none",
        });
      }

      const { password, ...settings } = fallback;
      res.json({
        settings,
        hasPassword: Boolean(stored?.password ?? password),
        metadata: {
          lastAppliedAt: stored?.lastAppliedAt ?? null,
          lastVerifiedAt: stored?.lastVerifiedAt ?? null,
          lastVerificationResult: stored?.lastVerificationResult ?? null,
          lastVerificationMessage: stored?.lastVerificationMessage ?? null,
        },
        source: stored ? "stored" : "env",
      });
    } catch (error) {
      routeLog.error("[admin] Failed to fetch DB config:", error);
      res.status(500).json({ message: "Failed to fetch database configuration" });
    }
  });

  app.post("/api/admin/db/config/test", requireRole('super_admin'), async (req, res) => {
    let tempPool: PgPool | null = null;
    try {
      const stored = await getDbConnectionSettings();
      const fallback = stored ?? parseDatabaseUrlFromEnv();
      const input = req.body?.settings ?? {};
      const host = typeof input.host === "string" && input.host.trim() ? input.host.trim() : fallback?.host;
      const database = typeof input.database === "string" && input.database.trim()
        ? input.database.trim()
        : fallback?.database;
      const user = typeof input.user === "string" && input.user.trim() ? input.user.trim() : fallback?.user;
      const passwordInput = typeof input.password === "string" ? input.password.trim() : undefined;
      const password = passwordInput || fallback?.password;
      const portValue = input.port ?? fallback?.port ?? 5432;
      const port = Number(portValue);

      if (!host || !database || !user || !password || Number.isNaN(port) || port <= 0) {
        return res.status(400).json({ message: "Host, port, database, user, and password are required" });
      }

      tempPool = new PgPool({
        host,
        port,
        database,
        user,
        password,
        max: 1,
        connectionTimeoutMillis: 5000,
      });
      const startedAt = Date.now();
      const result = await tempPool.query("SELECT version() AS version, NOW() AS server_time");
      await tempPool.end();
      tempPool = null;

      if (stored) {
        await saveDbConnectionSettings(
          {
            ...stored,
            lastVerifiedAt: new Date().toISOString(),
            lastVerificationResult: "success",
            lastVerificationMessage: null,
          },
          req.session.userId ?? null,
        );
      }

      const row = result.rows[0] ?? {};
      res.json({
        success: true,
        version: row.version ?? "",
        serverTime: row.server_time ?? null,
        latencyMs: Date.now() - startedAt,
      });
    } catch (error) {
      if (tempPool) {
        await tempPool.end();
      }
      const message = error instanceof Error ? error.message : String(error);
      const stored = await getDbConnectionSettings();
      if (stored) {
        await saveDbConnectionSettings(
          {
            ...stored,
            lastVerifiedAt: new Date().toISOString(),
            lastVerificationResult: "failure",
            lastVerificationMessage: message,
          },
          req.session.userId ?? null,
        );
      }
      res.status(400).json({ message });
    }
  });

  app.put("/api/admin/db/config", requireRole('super_admin'), async (req, res) => {
    try {
      const existing = await getDbConnectionSettings();
      const host = typeof req.body?.host === "string" ? req.body.host.trim() : "";
      const database = typeof req.body?.database === "string" ? req.body.database.trim() : "";
      const user = typeof req.body?.user === "string" ? req.body.user.trim() : "";
      const portInput = req.body?.port ?? existing?.port ?? 5432;
      const port = Number(portInput);
      const passwordInput = typeof req.body?.password === "string" ? req.body.password.trim() : "";
      const password = passwordInput || existing?.password;
      const applyEnv = Boolean(req.body?.applyEnv);

      if (!host || !database || !user || !password || Number.isNaN(port) || port <= 0) {
        return res.status(400).json({ message: "Host, port, database, user, and password are required" });
      }

      const nextValue: DbConnectionSettingValue = {
        host,
        port,
        database,
        user,
        password,
        lastAppliedAt: applyEnv ? new Date().toISOString() : existing?.lastAppliedAt ?? null,
        lastVerifiedAt: existing?.lastVerifiedAt ?? null,
        lastVerificationResult: existing?.lastVerificationResult ?? null,
        lastVerificationMessage: existing?.lastVerificationMessage ?? null,
      };

      await saveDbConnectionSettings(nextValue, req.session.userId ?? null);
      if (applyEnv) {
        updateDbEnvFiles(nextValue);
      }

      res.json({
        success: true,
        applied: applyEnv,
        message: applyEnv
          ? "Configuration saved and environment files updated. Restart the service to apply changes."
          : "Configuration saved.",
      });
    } catch (error) {
      routeLog.error("[admin] Failed to update DB config:", error);
      res.status(500).json({ message: "Failed to update database configuration" });
    }
  });

  // Communications settings
  app.get("/api/admin/communications", requireRole('admin', 'super_admin'), async (_req, res) => {
    try {
      const emailRecord = await getSystemSettingRecord(EMAIL_GATEWAY_SETTING_KEY);
      const smsRecord = await getSystemSettingRecord(SMS_GATEWAY_SETTING_KEY);
      const emailSettings = formatGatewaySetting(emailRecord, sanitizeEmailGateway);
      const smsSettings = formatGatewaySetting(smsRecord, sanitizeSmsGateway);
      routeLog.info("[comm-settings] sms provider:", smsSettings?.provider, {
        nic: smsSettings?.nic ? { passwordSet: smsSettings.nic.passwordSet } : null,
        twilio: smsSettings?.twilio ? { authTokenSet: smsSettings.twilio.authTokenSet } : null,
      });
      res.json({
        email: emailSettings,
        sms: smsSettings,
      });
    } catch (error) {
      routeLog.error("[admin] Failed to fetch communications settings:", error);
      res.status(500).json({ message: "Failed to fetch communications settings" });
    }
  });

  app.put("/api/admin/communications/email", requireRole('admin', 'super_admin'), async (req, res) => {
    try {
      const providerInput: EmailGatewayProvider = emailProviders.includes(req.body?.provider)
        ? req.body.provider
        : "custom";
      const userId = req.session.userId || null;
      const existing = await getSystemSettingRecord(EMAIL_GATEWAY_SETTING_KEY);
      const existingValue: EmailGatewaySettingValue =
        (existing?.settingValue as EmailGatewaySettingValue) ?? {};
      const legacyProfile = extractLegacyEmailProfile(existingValue);

      const buildProfile = (
        payload: any,
        fallback?: EmailGatewaySecretSettings,
      ): EmailGatewaySecretSettings | undefined => {
        if (!payload) {
          return fallback;
        }
        const host = trimOptionalString(payload.host) ?? fallback?.host ?? undefined;
        const fromEmail = trimOptionalString(payload.fromEmail) ?? fallback?.fromEmail ?? undefined;
        const username = trimOptionalString(payload.username) ?? fallback?.username ?? undefined;
        const passwordInput = trimOptionalString(payload.password);
        const port =
          payload.port !== undefined && payload.port !== null
            ? Number(payload.port) || 25
            : fallback?.port ?? 25;

        const next: EmailGatewaySecretSettings = {
          host,
          port,
          username,
          fromEmail,
          password: passwordInput ? passwordInput : fallback?.password,
        };

        if (!next.host && !next.fromEmail && !next.username && !next.password) {
          return undefined;
        }
        return next;
      };

      const nextValue: EmailGatewaySettingValue = {
        provider: providerInput,
        custom: buildProfile(req.body?.custom ?? req.body, existingValue.custom ?? legacyProfile),
        nic: buildProfile(req.body?.nic, existingValue.nic),
        sendgrid: buildProfile(req.body?.sendgrid, existingValue.sendgrid),
      };

      const activeProfile = getEmailProfileFromValue(
        { ...existingValue, ...nextValue },
        providerInput,
      );

      if (!activeProfile?.host || !activeProfile?.fromEmail) {
        return res.status(400).json({ message: "SMTP host and from email are required" });
      }

      if (!activeProfile.password) {
        return res.status(400).json({ message: "SMTP password is required" });
      }

      if (existing) {
        await db
          .update(systemSettings)
          .set({
            settingValue: nextValue,
            updatedAt: new Date(),
            updatedBy: userId,
            description: "SMTP gateway configuration",
            category: "communications",
          })
          .where(eq(systemSettings.settingKey, EMAIL_GATEWAY_SETTING_KEY));
      } else {
        await db.insert(systemSettings).values({
          settingKey: EMAIL_GATEWAY_SETTING_KEY,
          settingValue: nextValue,
          description: "SMTP gateway configuration",
          category: "communications",
          updatedBy: userId,
        });
      }

      routeLog.info("[admin] Updated SMTP gateway settings");
      res.json({ success: true });
    } catch (error) {
      routeLog.error("[admin] Failed to update SMTP config:", error);
      res.status(500).json({ message: "Failed to update SMTP settings" });
    }
  });

  app.put("/api/admin/communications/sms", requireRole('admin', 'super_admin'), async (req, res) => {
    try {
      const providerInput =
        req.body?.provider === "twilio"
          ? "twilio"
          : req.body?.provider === "nic_v2"
            ? "nic_v2"
            : "nic";
      const userId = req.session.userId || null;
      const existing = await getSystemSettingRecord(SMS_GATEWAY_SETTING_KEY);
      const existingValue: SmsGatewaySettingValue = (existing?.settingValue as SmsGatewaySettingValue) ?? {};

      const nicPayload = req.body?.nic ?? req.body;
      const nicV2Payload = req.body?.nicV2 ?? req.body;
      const twilioPayload = req.body?.twilio ?? req.body;

      const nextValue: SmsGatewaySettingValue = {
        provider: providerInput,
        nic: existingValue.nic,
        nicV2: existingValue.nicV2,
        twilio: existingValue.twilio,
      };

      if (providerInput === "nic") {
        const username = trimOptionalString(nicPayload?.username) ?? undefined;
        const senderId = trimOptionalString(nicPayload?.senderId) ?? undefined;
        const departmentKey = trimOptionalString(nicPayload?.departmentKey) ?? undefined;
        const templateId = trimOptionalString(nicPayload?.templateId) ?? undefined;
        const postUrl = trimOptionalString(nicPayload?.postUrl) ?? undefined;
        const passwordInput = trimOptionalString(nicPayload?.password) ?? undefined;

        if (!username || !senderId || !departmentKey || !templateId || !postUrl) {
          return res.status(400).json({ message: "All NIC SMS fields are required" });
        }

        const resolvedNicPassword = passwordInput || existingValue.nic?.password;

        if (!resolvedNicPassword) {
          return res.status(400).json({ message: "SMS password is required" });
        }

        const nicConfig: NicSmsGatewaySettings = {
          username: username!,
          senderId: senderId!,
          departmentKey: departmentKey!,
          templateId: templateId!,
          postUrl: postUrl!,
          password: resolvedNicPassword,
        };

        nextValue.nic = nicConfig;
      } else if (providerInput === "nic_v2") {
        const username = trimOptionalString(nicV2Payload?.username) ?? undefined;
        const senderId = trimOptionalString(nicV2Payload?.senderId) ?? undefined;
        const templateId = trimOptionalString(nicV2Payload?.templateId) ?? undefined;
        const key = trimOptionalString(nicV2Payload?.key) ?? undefined;
        const postUrl = trimOptionalString(nicV2Payload?.postUrl) ?? undefined;
        const passwordInput = trimOptionalString(nicV2Payload?.password) ?? undefined;

        if (!username || !senderId || !templateId || !key) {
          return res.status(400).json({ message: "All NIC V2 fields are required" });
        }

        const resolvedPassword = passwordInput || existingValue.nicV2?.password;
        if (!resolvedPassword) {
          return res.status(400).json({ message: "NIC V2 password is required" });
        }

        const nicV2Config: SmsGatewayV2Settings = {
          username,
          senderId,
          templateId,
          key,
          postUrl: postUrl || existingValue.nicV2?.postUrl || "https://msdgweb.mgov.gov.in/esms/sendsmsrequestDLT",
          password: resolvedPassword,
        };
        nextValue.nicV2 = nicV2Config;
      } else {
        const accountSid = trimOptionalString(twilioPayload?.accountSid) ?? undefined;
        const fromNumber = trimOptionalString(twilioPayload?.fromNumber) ?? undefined;
        const messagingServiceSid = trimOptionalString(twilioPayload?.messagingServiceSid) ?? undefined;
        const authTokenInput = trimOptionalString(twilioPayload?.authToken) ?? undefined;

        if (!accountSid) {
          return res.status(400).json({ message: "Twilio Account SID is required" });
        }
        if (!fromNumber && !messagingServiceSid) {
          return res.status(400).json({ message: "Provide a From Number or Messaging Service SID" });
        }

        const resolvedAuthToken = authTokenInput || existingValue.twilio?.authToken;

        if (!resolvedAuthToken) {
          return res.status(400).json({ message: "Twilio auth token is required" });
        }

        const twilioConfig: TwilioSmsGatewaySecretSettings = {
          accountSid: accountSid!,
          fromNumber: fromNumber || undefined,
          messagingServiceSid: messagingServiceSid || undefined,
          authToken: resolvedAuthToken,
        };

        nextValue.twilio = twilioConfig;
      }

      if (existing) {
        await db
          .update(systemSettings)
          .set({
            settingValue: nextValue,
            updatedAt: new Date(),
            updatedBy: userId,
            description: "SMS gateway configuration",
            category: "communications",
          })
          .where(eq(systemSettings.settingKey, SMS_GATEWAY_SETTING_KEY));
      } else {
        await db.insert(systemSettings).values({
          settingKey: SMS_GATEWAY_SETTING_KEY,
          settingValue: nextValue,
          description: "SMS gateway configuration",
          category: "communications",
          updatedBy: userId,
        });
      }

      routeLog.info("[admin] Updated SMS gateway settings");
      res.json({ success: true });
    } catch (error) {
      routeLog.error("[admin] Failed to update SMS config:", error);
      res.status(500).json({ message: "Failed to update SMS settings" });
    }
  });

  app.post("/api/admin/communications/email/test", requireRole('admin', 'super_admin'), async (req, res) => {
    try {
      const record = await getSystemSettingRecord(EMAIL_GATEWAY_SETTING_KEY);
      if (!record) {
        return res.status(400).json({ message: "SMTP settings not configured" });
      }

      const config = (record.settingValue as EmailGatewaySettingValue) ?? {};
      const provider: EmailGatewayProvider = config.provider ?? "custom";
      const profile = getEmailProfileFromValue(config, provider) ?? extractLegacyEmailProfile(config);
      if (!profile?.host || !profile?.fromEmail || !profile?.password) {
        return res.status(400).json({ message: "SMTP settings incomplete" });
      }

      const to = trimOptionalString(req.body?.to) ?? profile.fromEmail;
      const subject = trimOptionalString(req.body?.subject) ?? DEFAULT_EMAIL_SUBJECT;
      const body = trimOptionalString(req.body?.body) ?? DEFAULT_EMAIL_BODY;

      const result = await sendTestEmail(
        {
          host: profile.host,
          port: Number(profile.port) || 25,
          username: profile.username,
          password: profile.password,
          fromEmail: profile.fromEmail,
        },
        {
          to,
          subject,
          body,
        },
      );

      res.json({ success: true, log: result.log });
    } catch (error: any) {
      routeLog.error("[admin] SMTP test failed:", error);
      res.status(500).json({ message: error?.message || "Failed to send test email" });
    }
  });

  app.post("/api/admin/communications/sms/test", requireRole('admin', 'super_admin'), async (req, res) => {
    try {
      const record = await getSystemSettingRecord(SMS_GATEWAY_SETTING_KEY);
      if (!record) {
        return res.status(400).json({ message: "SMS settings not configured" });
      }

      const config = record.settingValue as SmsGatewaySettingValue;
      const provider: SmsGatewayProvider = config.provider ?? "nic";
      routeLog.info("[sms-test] provider:", provider);

      const mobile = trimOptionalString(req.body?.mobile);
      const message =
        trimOptionalString(req.body?.message) ?? DEFAULT_SMS_BODY.replace("{{OTP}}", "123456");
      if (!mobile) {
        return res.status(400).json({ message: "Mobile number is required" });
      }

      if (provider === "twilio") {
        const twilioConfig =
          config.twilio ??
          ({
            accountSid: (config as any).accountSid,
            authToken: (config as any).authToken,
            fromNumber: (config as any).fromNumber,
            messagingServiceSid: (config as any).messagingServiceSid,
          } as TwilioSmsGatewaySecretSettings);

        if (
          !twilioConfig ||
          !twilioConfig.accountSid ||
          !twilioConfig.authToken ||
          (!twilioConfig.fromNumber && !twilioConfig.messagingServiceSid)
        ) {
          return res.status(400).json({ message: "Twilio settings incomplete" });
        }

        const result = await sendTwilioSms(
          {
            accountSid: twilioConfig.accountSid,
            authToken: twilioConfig.authToken,
            fromNumber: twilioConfig.fromNumber,
            messagingServiceSid: twilioConfig.messagingServiceSid,
          },
          { mobile, message },
        );

        return res.json({ success: result.ok, response: result.body, status: result.status });
      }

      if (provider === "nic_v2") {
        const nicV2Config =
          config.nicV2 ??
          ({
            username: (config as any).username,
            password: (config as any).password,
            senderId: (config as any).senderId,
            templateId: (config as any).templateId,
            key: (config as any).key,
            postUrl: (config as any).postUrl,
          } as SmsGatewayV2Settings);

        if (!nicV2Config || !nicV2Config.password) {
          return res.status(400).json({ message: "NIC V2 password missing in settings" });
        }
        const result = await sendNicV2Sms(
          {
            username: nicV2Config.username,
            password: nicV2Config.password,
            senderId: nicV2Config.senderId,
            templateId: nicV2Config.templateId,
            key: nicV2Config.key,
            postUrl: nicV2Config.postUrl,
          },
          { mobile, message },
        );

        return res.json({ success: result.ok, response: result.body, status: result.status });
      }

      const nicConfig =
        config.nic ??
        ({
          username: (config as any).username,
          password: (config as any).password,
          senderId: (config as any).senderId,
          departmentKey: (config as any).departmentKey,
          templateId: (config as any).templateId,
          postUrl: (config as any).postUrl,
        } as NicSmsGatewaySettings);

      if (!nicConfig || !nicConfig.password) {
        return res.status(400).json({ message: "SMS password missing in settings" });
      }

      const result = await sendTestSms(
        {
          username: nicConfig.username,
          password: nicConfig.password,
          senderId: nicConfig.senderId,
          departmentKey: nicConfig.departmentKey,
          templateId: nicConfig.templateId,
          postUrl: nicConfig.postUrl,
        },
        { mobile, message },
      );

      res.json({ success: result.ok, response: result.body, status: result.status });
    } catch (error: any) {
      routeLog.error("[admin] SMS test failed:", error);
      res.status(500).json({ message: error?.message || "Failed to send test SMS" });
    }
  });

  app.get("/api/admin/notifications", requireRole('admin', 'super_admin'), async (_req, res) => {
    try {
      const record = await getSystemSettingRecord(NOTIFICATION_RULES_SETTING_KEY);
      const payload = buildNotificationResponse(record);
      res.json(payload);
    } catch (error) {
      routeLog.error("[admin] Failed to load notification rules:", error);
      res.status(500).json({ message: "Failed to load notification settings" });
    }
  });

  app.put("/api/admin/notifications", requireRole('admin', 'super_admin'), async (req, res) => {
    try {
      const eventsInput = Array.isArray(req.body?.events) ? req.body.events : [];
      const ruleMap = new Map<NotificationEventId, NotificationRuleValue>();
      for (const event of eventsInput) {
        if (!event?.id) continue;
        const definition = notificationDefinitionMap.get(event.id as NotificationEventId);
        if (!definition) continue;
        const smsTemplate =
          trimOptionalString(event.smsTemplate) ?? definition.defaultSmsTemplate;
        const emailSubject =
          trimOptionalString(event.emailSubject) ?? definition.defaultEmailSubject;
        const emailBody =
          trimOptionalString(event.emailBody) ?? definition.defaultEmailBody;
        ruleMap.set(definition.id, {
          id: definition.id,
          smsEnabled: Boolean(event.smsEnabled),
          smsTemplate,
          emailEnabled: Boolean(event.emailEnabled),
          emailSubject,
          emailBody,
        });
      }

      const nextValue: NotificationSettingsValue = {
        rules: Array.from(ruleMap.values()),
      };
      const userId = req.session.userId || null;
      const existing = await getSystemSettingRecord(NOTIFICATION_RULES_SETTING_KEY);

      if (existing) {
        await db
          .update(systemSettings)
          .set({
            settingValue: nextValue,
            updatedAt: new Date(),
            updatedBy: userId,
            description: "Workflow notification templates",
            category: "notification",
          })
          .where(eq(systemSettings.settingKey, NOTIFICATION_RULES_SETTING_KEY));
      } else {
        await db.insert(systemSettings).values({
          settingKey: NOTIFICATION_RULES_SETTING_KEY,
          settingValue: nextValue,
          description: "Workflow notification templates",
          category: "notification",
          updatedBy: userId,
        });
      }

      res.json({ success: true });
    } catch (error) {
      routeLog.error("[admin] Failed to save notification rules:", error);
      res.status(500).json({ message: "Failed to save notification settings" });
    }
  });

  // ========================================
  // DATABASE CONSOLE ROUTES (Admin/Super Admin)
  // ========================================

  // Execute SQL query (for development/testing)
  app.post("/api/admin/db-console/execute", requireRole('admin', 'super_admin'), async (req, res) => {
    try {
      const { query: sqlQuery } = req.body;
      
      if (!sqlQuery || typeof sqlQuery !== 'string') {
        return res.status(400).json({ message: "SQL query is required" });
      }

      // Check environment - only allow in development
      const environment = process.env.NODE_ENV || 'development';
      if (environment === 'production') {
        return res.status(403).json({ 
          message: "Database console is disabled in production for security" 
        });
      }

      const trimmedQuery = sqlQuery.trim().toLowerCase();
      
      // Detect query type
      const isSelect = trimmedQuery.startsWith('select');
      const isShow = trimmedQuery.startsWith('show');
      const isDescribe = trimmedQuery.startsWith('describe') || trimmedQuery.startsWith('\\d');
      const isExplain = trimmedQuery.startsWith('explain');
      const isReadOnly = isSelect || isShow || isDescribe || isExplain;

      routeLog.info(`[db-console] Executing ${isReadOnly ? 'READ' : 'WRITE'} query:`, sqlQuery.substring(0, 100));

      // Execute the query
      const result = await db.execute(sql.raw(sqlQuery));
      
      // Extract rows from the result
      // db.execute returns an object with rows property for Neon driver
      let rows: any[] = [];
      if (Array.isArray(result)) {
        rows = result;
      } else if (result && (result as any).rows) {
        rows = (result as any).rows;
      } else if (result) {
        // If result is the rows directly
        rows = [result];
      }
      
      // Format response
      const response = {
        success: true,
        type: isReadOnly ? 'read' : 'write',
        rowCount: rows.length,
        data: rows,
        query: sqlQuery
      };

      routeLog.info(`[db-console] Query returned ${rows.length} row(s)`);
      res.json(response);
    } catch (error) {
      routeLog.error("[db-console] Query execution failed:", error);
      res.status(500).json({ 
        success: false,
        message: "Query execution failed",
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  // Get list of all tables
  app.get("/api/admin/db-console/tables", requireRole('admin', 'super_admin'), async (req, res) => {
    try {
      const environment = process.env.NODE_ENV || 'development';
      if (environment === 'production') {
        return res.status(403).json({ 
          message: "Database console is disabled in production" 
        });
      }

      // Query to get all tables
      const result = await db.execute(sql`
        SELECT table_name, 
               pg_size_pretty(pg_total_relation_size(quote_ident(table_name))) as size
        FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_type = 'BASE TABLE'
        ORDER BY table_name
      `);

      res.json({ tables: result });
    } catch (error) {
      routeLog.error("[db-console] Failed to fetch tables:", error);
      res.status(500).json({ message: "Failed to fetch tables" });
    }
  });

  // Get table schema/structure
  app.get("/api/admin/db-console/table/:tableName/schema", requireRole('admin', 'super_admin'), async (req, res) => {
    try {
      const { tableName } = req.params;
      
      const environment = process.env.NODE_ENV || 'development';
      if (environment === 'production') {
        return res.status(403).json({ 
          message: "Database console is disabled in production" 
        });
      }

      // Get column information
      const result = await db.execute(sql.raw(`
        SELECT 
          column_name,
          data_type,
          character_maximum_length,
          is_nullable,
          column_default
        FROM information_schema.columns
        WHERE table_schema = 'public' 
        AND table_name = '${tableName}'
        ORDER BY ordinal_position
      `));

      res.json({ schema: result });
    } catch (error) {
      routeLog.error("[db-console] Failed to fetch table schema:", error);
      res.status(500).json({ message: "Failed to fetch table schema" });
    }
  });

  // Reset operations
  app.post("/api/admin/reset/:operation", requireRole('super_admin'), async (req, res) => {
    try {
      const { operation } = req.params;
      const { confirmationText, reason } = req.body;

      // Check environment
      const environment = process.env.NODE_ENV || 'development';
      if (environment === 'production') {
        return res.status(403).json({ 
          message: "Reset operations are disabled in production" 
        });
      }

      // Validate confirmation
      const requiredText = operation === 'full' ? 'RESET' : 'DELETE';
      if (confirmationText !== requiredText) {
        return res.status(400).json({ 
          message: `Confirmation text must be "${requiredText}"` 
        });
      }

      if (!reason || reason.length < 10) {
        return res.status(400).json({ 
          message: "Reason must be at least 10 characters" 
        });
      }

      routeLog.info(`[super-admin] Reset operation: ${operation}, reason: ${reason}`);

      let deletedCounts: any = {};

      switch (operation) {
        case 'full':
          // Delete everything except super_admin accounts
          await db.delete(certificates);
          await db.delete(clarifications);
          await db.delete(objections);
          await db.delete(inspectionReports);
          await db.delete(inspectionOrders);
          await db.delete(documents);
          await db.delete(payments);
          await db.delete(homestayApplications);
          await db.delete(productionStats);
          await db.delete(users).where(ne(users.role, 'super_admin'));
          deletedCounts = { all: "All data except super_admin accounts" };
          break;

        case 'applications':
          await db.delete(certificates);
          await db.delete(clarifications);
          await db.delete(objections);
          await db.delete(inspectionReports);
          await db.delete(inspectionOrders);
          await db.delete(documents);
          await db.delete(payments);
          const deletedApps = await db.delete(homestayApplications);
          deletedCounts = { applications: "all" };
          break;

        case 'users':
          const deletedUsers = await db.delete(users).where(ne(users.role, 'super_admin'));
          deletedCounts = { users: "All non-super_admin users" };
          break;

        case 'files':
          const deletedDocs = await db.delete(documents);
          deletedCounts = { documents: "all" };
          // TODO: Delete from object storage
          break;

        case 'timeline':
          // Timeline table not yet implemented
          deletedCounts = { timeline: "not yet implemented" };
          break;

        case 'inspections':
          await db.delete(inspectionReports);
          await db.delete(inspectionOrders);
          deletedCounts = { inspections: "all orders and reports" };
          break;

        case 'objections':
          await db.delete(clarifications);
          await db.delete(objections);
          deletedCounts = { objections: "all objections and clarifications" };
          break;

        case 'payments':
          await db.delete(payments);
          deletedCounts = { payments: "all" };
          break;

        default:
          return res.status(400).json({ message: "Invalid operation" });
      }

      res.json({
        success: true,
        message: `Reset operation '${operation}' completed successfully`,
        deletedCounts,
      });
    } catch (error) {
      routeLog.error("[super-admin] Reset failed:", error);
      res.status(500).json({ message: "Reset operation failed" });
    }
  });

  // Seed test data
  app.post("/api/admin/seed/:type", requireRole('super_admin'), async (req, res) => {
    try {
      const { type } = req.params;
      const { count = 10, scenario } = req.body;

      routeLog.info(`[super-admin] Seeding data: ${type}, count: ${count}, scenario: ${scenario}`);

      // Get current user
      const currentUser = await storage.getUser(req.session.userId!);
      if (!currentUser) {
        return res.status(401).json({ message: "User not found" });
      }

      switch (type) {
        case 'applications':
          // Generate test applications
          const createdApps = [];
          for (let i = 0; i < count; i++) {
            const nightlyRate = 2000 + (i * 150);
            const app = await storage.createApplication({
              userId: currentUser.id,
              propertyName: `Test Property ${i + 1}`,
              category: ['diamond', 'gold', 'silver'][i % 3] as any,
              totalRooms: 4,
              address: `Test Address ${i + 1}, Shimla`,
              district: 'Shimla',
              pincode: '171001',
              locationType: 'mc',
              ownerName: `Test Owner ${i + 1}`,
              ownerMobile: `98${String(765000000 + i)}`,
              ownerEmail: `test${i + 1}@example.com`,
              ownerAadhaar: `${(100000000000 + i).toString().slice(-12)}`,
              proposedRoomRate: nightlyRate,
              projectType: 'new_project',
              propertyArea: 1200,
              singleBedRooms: 2,
              doubleBedRooms: 1,
              familySuites: 1,
              attachedWashrooms: 4,
              amenities: {
                wifi: true,
                parking: i % 2 === 0,
                restaurant: i % 3 === 0,
              },
              baseFee: (4000 + i * 250).toString(),
              totalFee: (6000 + i * 300).toString(),
              status: 'draft',
              currentPage: 1,
              maxStepReached: 1,
            } as any);
            createdApps.push(app);
          }
          return res.json({
            success: true,
            message: `Created ${createdApps.length} test applications`,
          });

        case 'users':
          // Generate test users for all roles
          const testUsers = [];
          const roles = ['property_owner', 'dealing_assistant', 'district_tourism_officer', 'state_officer'];
          for (const role of roles) {
            const user = await storage.createUser({
              fullName: `Test ${role.replace(/_/g, ' ')}`,
              mobile: `9${role.length}${String(Math.floor(Math.random() * 100000000)).padStart(8, '0')}`,
              email: `test.${role}@example.com`,
              password: 'Test@123',
              role: role as any,
              district: role.includes('district') ? 'shimla' : undefined,
            });
            testUsers.push(user);
          }
          return res.json({
            success: true,
            message: `Created ${testUsers.length} test users (all roles)`,
          });

        case 'scenario':
          // Load predefined scenario
          // TODO: Implement scenario loading
          return res.json({
            success: true,
            message: `Scenario '${scenario}' loaded (not yet implemented)`,
          });

        default:
          return res.status(400).json({ message: "Invalid seed type" });
      }
    } catch (error) {
      routeLog.error("[super-admin] Seed failed:", error);
      res.status(500).json({ message: "Failed to generate test data" });
    }
  });

  // LGD Master Data Import Endpoint
  app.post("/api/admin/lgd/import", requireRole('admin', 'super_admin'), async (req, res) => {
    try {
      const { csvData, dataType } = req.body;
      
      if (!csvData || !dataType) {
        return res.status(400).json({ message: "Missing csvData or dataType" });
      }

      // Parse CSV (simple parsing - assumes well-formed CSV)
      const lines = csvData.trim().split('\n');
      const headers = lines[0].split(',');
      
      let inserted = {
        districts: 0,
        tehsils: 0,
        blocks: 0,
        gramPanchayats: 0,
        urbanBodies: 0,
      };

      if (dataType === 'villages') {
        // File 2: Villages/Gram Panchayats with hierarchy
        // Headers: stateCode,stateNameEnglish,districtCode,districtNameEnglish,subdistrictCode,subdistrictNameEnglish,villageCode,villageNameEnglish,pincode
        
        type DistrictEntry = { lgdCode: string; districtName: string };
        type TehsilEntry = { lgdCode: string; tehsilName: string; districtCode: string };
        type VillageEntry = { lgdCode: string; gramPanchayatName: string; tehsilCode: string; districtCode: string; pincode: string | null };

        const districtMap = new Map<string, DistrictEntry>();
        const tehsilMap = new Map<string, TehsilEntry>();
        const villages: VillageEntry[] = [];

        // Parse all rows
        for (let i = 1; i < lines.length; i++) {
          const values = lines[i].split(',');
          if (values.length < 9 || values[0] !== '2') continue; // Only HP data (stateCode = 2)

          const districtCode = values[2];
          const districtName = values[3];
          const tehsilCode = values[4];
          const tehsilName = values[5];
          const villageCode = values[6];
          const villageName = values[7];
          const pincode = values[8];

          // Collect unique districts
          districtMap.set(districtCode, { lgdCode: districtCode, districtName });

          // Collect unique tehsils
          const tehsilKey = `${districtCode}-${tehsilCode}`;
          tehsilMap.set(tehsilKey, {
            lgdCode: tehsilCode,
            tehsilName,
            districtCode,
          });

          // Collect villages
          villages.push({
            lgdCode: villageCode,
            gramPanchayatName: villageName,
            tehsilCode,
            districtCode,
            pincode: pincode || null,
          });
        }

        // Insert districts
        for (const [, data] of Array.from(districtMap.entries())) {
          await db.insert(lgdDistricts)
            .values({
              lgdCode: data.lgdCode,
              districtName: data.districtName,
              isActive: true,
            })
            .onConflictDoNothing();
          inserted.districts++;
        }

        const existingDistricts = await db.select().from(lgdDistricts);
        const districtIdMap = new Map<string, string>();
        existingDistricts.forEach((district) => {
          if (district.lgdCode) {
            districtIdMap.set(district.lgdCode, district.id);
          }
          districtIdMap.set(district.districtName, district.id);
        });

        // Insert tehsils
        for (const [, data] of Array.from(tehsilMap.entries())) {
          const districtId = districtIdMap.get(data.districtCode);
          if (districtId) {
            await db.insert(lgdTehsils)
              .values({
                lgdCode: data.lgdCode,
                tehsilName: data.tehsilName,
                districtId,
                isActive: true,
              })
              .onConflictDoNothing();
            inserted.tehsils++;
          }
        }

        // Insert gram panchayats (villages)
        for (const village of villages) {
          const districtId = districtIdMap.get(village.districtCode);
          if (!districtId) continue;

          await db.insert(lgdGramPanchayats)
            .values({
              lgdCode: village.lgdCode,
              gramPanchayatName: village.gramPanchayatName,
              districtId,
              blockId: null,
              isActive: true,
            })
            .onConflictDoNothing();
          inserted.gramPanchayats++;
        }

      } else if (dataType === 'urbanBodies') {
        // File 1: Urban Bodies (municipalities, town panchayats)
        // Headers: stateCode,stateNameEnglish,localBodyCode,localBodyNameEnglish,localBodyTypeName,pincode

        const [defaultDistrict] = await db.select().from(lgdDistricts).limit(1);

        for (let i = 1; i < lines.length; i++) {
          const values = lines[i].split(',');
          if (values.length < 6 || values[0] !== '2') continue; // Only HP data

          const bodyCode = values[2];
          const bodyName = values[3];
          const bodyType = values[4];
          const pincode = values[5];

          if (!defaultDistrict) {
            routeLog.warn("[LGD] No districts available; skipping urban body import");
            break;
          }

          const normalizedType: 'mc' | 'tcp' | 'np' = (() => {
            const value = bodyType?.toLowerCase() || '';
            if (value.includes('corporation')) return 'mc';
            if (value.includes('council') || value.includes('tcp')) return 'tcp';
            return 'np';
          })();

          await db.insert(lgdUrbanBodies)
            .values({
              lgdCode: bodyCode,
              urbanBodyName: bodyName,
              bodyType: normalizedType,
              districtId: defaultDistrict.id,
              numberOfWards: null,
              isActive: true,
            })
            .onConflictDoNothing();
          inserted.urbanBodies++;
        }
      } else {
        return res.status(400).json({ message: "Invalid dataType. Must be 'villages' or 'urbanBodies'" });
      }

      res.json({
        success: true,
        message: `Successfully imported LGD data (${dataType})`,
        inserted,
      });

    } catch (error) {
      routeLog.error("[admin] LGD import failed:", error);
      res.status(500).json({ message: "Failed to import LGD data", error: String(error) });
    }
  });

  // HimKosh Payment Gateway Routes
  app.use("/api/himkosh", himkoshRoutes);
  routeLog.info('[himkosh] Payment gateway routes registered');

  // Start production stats scraper (runs on boot and hourly)
  startScraperScheduler();
  routeLog.info('[scraper] Production stats scraper initialized');

  const httpServer = createServer(app);
  return httpServer;
}
const fetchApplicationWithOwner = async (applicationId: string) => {
  const [row] = await db
    .select({
      application: homestayApplications,
      ownerName: users.fullName,
      ownerMobile: users.mobile,
      ownerEmail: users.email,
    })
    .from(homestayApplications)
    .leftJoin(users, eq(users.id, homestayApplications.userId))
    .where(eq(homestayApplications.id, applicationId))
    .limit(1);

  if (!row?.application) {
    return null;
  }

  const owner =
    row.ownerName || row.ownerMobile || row.ownerEmail
      ? {
          fullName: row.ownerName,
          mobile: row.ownerMobile,
          email: row.ownerEmail,
        }
      : null;

  return {
    application: row.application,
    owner,
  };
};
