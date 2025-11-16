import type { Express, Request, Response, NextFunction } from "express";
import { createServer, type Server } from "http";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import { pool, db } from "./db";
import { storage } from "./storage";
import { logApplicationAction } from "./audit";
import {
  insertUserSchema,
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
  insertUserProfileSchema,
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
  loginOtpChallenges,
  passwordResetChallenges,
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
import { isLegacyApplication as isLegacyApplicationRecord } from "@shared/legacy";
import express from "express";
import { randomUUID, randomInt } from "crypto";
import path from "path";
import fs from "fs";
import fsPromises from "fs/promises";
import { z } from "zod";
import bcrypt from "bcrypt";
import { eq, desc, ne, notInArray, and, or, sql, gte, lte, like, ilike, inArray, type AnyColumn } from "drizzle-orm";
import { startScraperScheduler } from "./scraper";
import { ObjectStorageService, OBJECT_STORAGE_MODE, LOCAL_OBJECT_DIR, LOCAL_MAX_UPLOAD_BYTES } from "./objectStorage";
import { differenceInCalendarDays, format, subDays } from "date-fns";
import {
  DEFAULT_EMAIL_BODY,
  DEFAULT_EMAIL_SUBJECT,
  DEFAULT_SMS_BODY,
  sendTestEmail,
  sendTestSms,
  sendTwilioSms,
  type EmailGatewaySettings,
  type SmsGatewaySettings,
  type TwilioGatewaySettings,
} from "./services/communications";
import himkoshRoutes from "./himkosh/routes";
import { MAX_ROOMS_ALLOWED, MAX_BEDS_ALLOWED, validateCategorySelection } from "@shared/fee-calculator";
import type { CategoryType } from "@shared/fee-calculator";
import {
  lookupStaffAccountByIdentifier,
  lookupStaffAccountByMobile,
  getManifestDerivedUsername,
  getDistrictStaffManifest,
} from "@shared/districtStaffManifest";
import "./staffManifestSync";

const CORRECTION_CONSENT_TEXT =
  "I confirm that every issue highlighted by DA/DTDO has been fully addressed. I understand that my application may be rejected if the corrections remain unsatisfactory.";

// Extend express-session types
declare module 'express-session' {
  interface SessionData {
    userId: string;
    captchaAnswer?: string | null;
    captchaIssuedAt?: number | null;
  }
}

// Auth middleware
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.session.userId) {
    return res.status(401).json({ message: "Authentication required" });
  }
  next();
}

// Role-based middleware
export function requireRole(...roles: string[]) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!req.session.userId) {
      return res.status(401).json({ message: "Authentication required" });
    }
    
    const user = await storage.getUser(req.session.userId);
    if (!user || !roles.includes(user.role)) {
      return res.status(403).json({ message: "Insufficient permissions" });
    }
    
    next();
  };
}

const TIMELINE_PRIVILEGED_ROLES = new Set([
  "admin",
  "super_admin",
  "state_officer",
  "admin_rc",
  "district_tourism_officer",
]);

const TIMELINE_DISTRICT_ROLES = new Set([
  "dealing_assistant",
  "district_officer",
]);

const normalizeDistrictValue = (value?: string | null) => {
  if (!value) return "";
  return value
    .toLowerCase()
    .replace(/division|district|dist\.|dist|office/g, "")
    .replace(/[-,]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
};

const districtMatches = (userDistrictRaw?: string | null, applicationDistrictRaw?: string | null) => {
  const userDistrict = normalizeDistrictValue(userDistrictRaw);
  const applicationDistrict = normalizeDistrictValue(applicationDistrictRaw);
  if (!userDistrict || !applicationDistrict) {
    return false;
  }
  return (
    userDistrict === applicationDistrict ||
    userDistrict.includes(applicationDistrict) ||
    applicationDistrict.includes(userDistrict)
  );
};

const canViewApplicationTimeline = (user: User | null, application: HomestayApplication | null) => {
  if (!user || !application) {
    return false;
  }

  if (user.role === "property_owner") {
    return user.id === application.userId;
  }

  // Other authenticated roles can view timelines
  return true;
};

const summarizeTimelineActor = (user?: User | null) => {
  if (!user) {
    return null;
  }

  const displayName = user.fullName || user.username || user.mobile || "Officer";
  return {
    id: user.id,
    name: displayName,
    role: user.role,
    designation: user.designation ?? null,
    district: user.district ?? null,
  };
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

const formatUserForResponse = (user: User) => {
  const { password, ...userWithoutPassword } = user;
  const derivedUsername = getManifestDerivedUsername(
    userWithoutPassword.mobile,
    userWithoutPassword.username ?? undefined,
  );
  return {
    ...userWithoutPassword,
    username: derivedUsername ?? userWithoutPassword.username ?? null,
  };
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

const LEGACY_RC_PREFIX = "LEGACY-";
const ADMIN_RC_ALLOWED_ROLES = ['admin_rc', 'admin', 'super_admin'] as const;
const LEGACY_CATEGORY_OPTIONS = ['diamond', 'gold', 'silver'] as const;
const LEGACY_LOCATION_TYPES = ['mc', 'tcp', 'gp'] as const;
const LEGACY_PROPERTY_OWNERSHIP = ['owned', 'leased'] as const;
const LEGACY_OWNER_GENDERS = ['male', 'female', 'other'] as const;
const LEGACY_STATUS_OPTIONS = [
  'draft',
  'legacy_rc_review',
  'submitted',
  'under_scrutiny',
  'forwarded_to_dtdo',
  'dtdo_review',
  'inspection_scheduled',
  'inspection_under_review',
  'verified_for_payment',
  'payment_pending',
  'approved',
  'rejected',
] as const;

const trimOptionalString = (value: string | null | undefined) => {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
};

const trimRequiredString = (value: string) => {
  const trimmed = value.trim();
  return trimmed;
};

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

const EMAIL_GATEWAY_SETTING_KEY = "comm_email_gateway";
const SMS_GATEWAY_SETTING_KEY = "comm_sms_gateway";

type EmailGatewayProvider = "custom" | "nic" | "sendgrid";

type EmailGatewaySecretSettings = {
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  fromEmail?: string;
};

type EmailGatewaySettingValue = {
  provider?: EmailGatewayProvider;
  custom?: EmailGatewaySecretSettings;
  nic?: EmailGatewaySecretSettings;
  sendgrid?: EmailGatewaySecretSettings;
  updatedAt?: string;
  updatedBy?: string | null;
} & Partial<EmailGatewaySecretSettings>;

type SmsGatewayProvider = "nic" | "twilio";

type NicSmsGatewaySettings = SmsGatewaySettings & {
  password?: string;
};

type TwilioSmsGatewaySettings = TwilioGatewaySettings & {
  authToken?: string;
};

type SmsGatewaySettingValue = {
  provider?: SmsGatewayProvider;
  nic?: NicSmsGatewaySettings;
  twilio?: TwilioSmsGatewaySettings;
  updatedAt?: string;
  updatedBy?: string | null;
};

const emailProviders: EmailGatewayProvider[] = ["custom", "nic", "sendgrid"];

const extractLegacyEmailProfile = (value?: EmailGatewaySettingValue | null): EmailGatewaySecretSettings | undefined => {
  if (!value) return undefined;
  if (value.custom || value.nic || value.sendgrid) {
    return undefined;
  }
  if (!value.host && !value.fromEmail && !value.username && !value.password) {
    return undefined;
  }
  return {
    host: value.host,
    port: value.port,
    username: value.username,
    password: value.password,
    fromEmail: value.fromEmail,
  };
};

const getEmailProfileFromValue = (
  value: EmailGatewaySettingValue,
  provider: EmailGatewayProvider,
): EmailGatewaySecretSettings | undefined => {
  const legacy = extractLegacyEmailProfile(value);
  if (provider === "custom") {
    return value.custom ?? legacy;
  }
  if (provider === "nic") {
    return value.nic ?? (legacy && value.provider === "nic" ? legacy : undefined);
  }
  if (provider === "sendgrid") {
    return value.sendgrid ?? (legacy && value.provider === "sendgrid" ? legacy : undefined);
  }
  return legacy;
};

const sanitizeEmailGateway = (value?: EmailGatewaySettingValue | null) => {
  if (!value) return null;
  const provider: EmailGatewayProvider = value.provider ?? "custom";
  const legacy = extractLegacyEmailProfile(value);
  const mapProfile = (profile?: EmailGatewaySecretSettings) => {
    if (!profile) return undefined;
    return {
      host: profile.host ?? "",
      port: Number(profile.port) || 25,
      username: profile.username ?? "",
      fromEmail: profile.fromEmail ?? "",
      passwordSet: Boolean(profile.password),
    };
  };
  return {
    provider,
    custom: mapProfile(value.custom ?? (provider === "custom" ? legacy : undefined) ?? legacy),
    nic: mapProfile(value.nic),
    sendgrid: mapProfile(value.sendgrid),
  };
};

const sanitizeSmsGateway = (value?: SmsGatewaySettingValue | null) => {
  if (!value) return null;
  const provider: SmsGatewayProvider = value.provider ?? "nic";
  const nic = value.nic
    ? {
        username: value.nic.username,
        senderId: value.nic.senderId,
        departmentKey: value.nic.departmentKey,
        templateId: value.nic.templateId,
        postUrl: value.nic.postUrl,
        passwordSet: Boolean(value.nic.password),
      }
    : undefined;
  const twilio = value.twilio
    ? {
        accountSid: value.twilio.accountSid,
        fromNumber: value.twilio.fromNumber,
        messagingServiceSid: value.twilio.messagingServiceSid,
        authTokenSet: Boolean(value.twilio.authToken),
      }
    : undefined;
  return {
    provider,
    nic,
    twilio,
  };
};

const getSystemSettingRecord = async (key: string) => {
  const [record] = await db
    .select()
    .from(systemSettings)
    .where(eq(systemSettings.settingKey, key))
    .limit(1);
  return record ?? null;
};

const formatGatewaySetting = <T,>(
  record: SystemSetting | null,
  sanitizer: (value?: any) => T | null,
) => {
  if (!record) {
    return null;
  }
  const sanitized = sanitizer(record.settingValue as unknown);
  if (!sanitized) {
    return null;
  }
  return {
    ...sanitized,
    updatedAt: record.updatedAt,
    updatedBy: record.updatedBy,
  };
};

const NOTIFICATION_RULES_SETTING_KEY = "comm_notification_rules";

type NotificationEventId =
  | "otp"
  | "password_reset"
  | "application_submitted"
  | "forwarded_to_dtdo"
  | "inspection_scheduled"
  | "verified_for_payment"
  | "da_send_back"
  | "dtdo_revert"
  | "dtdo_objection";

type NotificationRuleValue = {
  id: NotificationEventId;
  smsEnabled?: boolean;
  smsTemplate?: string;
  emailEnabled?: boolean;
  emailSubject?: string;
  emailBody?: string;
};

type NotificationSettingsValue = {
  rules?: NotificationRuleValue[];
};

type NotificationEventDefinition = {
  id: NotificationEventId;
  label: string;
  description: string;
  defaultSmsTemplate: string;
  defaultEmailSubject: string;
  defaultEmailBody: string;
  placeholders: string[];
  defaultSmsEnabled?: boolean;
  defaultEmailEnabled?: boolean;
};

const notificationEventDefinitions: NotificationEventDefinition[] = [
  {
    id: "otp",
    label: "OTP verification",
    description: "Sent when an owner requests an OTP to access or confirm submissions.",
    defaultSmsTemplate: DEFAULT_SMS_BODY,
    defaultEmailSubject: "Himachal Tourism OTP",
    defaultEmailBody:
      "Hello {{OWNER_NAME}},\n\n{{OTP}} is your one-time password for Himachal Tourism eServices. It expires in 10 minutes.\n\n- Tourism Department",
    placeholders: ["OWNER_NAME", "OTP"],
    defaultSmsEnabled: true,
    defaultEmailEnabled: true,
  },
  {
    id: "password_reset",
    label: "Password reset",
    description: "Delivers the one-time code owners need to reset their account password.",
    defaultSmsTemplate:
      "{{OTP}} is your password reset code for Himachal Tourism eServices. Enter it in the portal within 10 minutes to set a new password.",
    defaultEmailSubject: "Password reset code",
    defaultEmailBody:
      "Hello {{OWNER_NAME}},\n\nUse the code {{OTP}} to reset your Himachal Tourism eServices password. This code expires in 10 minutes. If you did not request a reset, you can ignore this email.\n\n- Tourism Department",
    placeholders: ["OWNER_NAME", "OTP"],
    defaultSmsEnabled: true,
    defaultEmailEnabled: true,
  },
  {
    id: "application_submitted",
    label: "Application submitted",
    description: "Confirms that an owner successfully submitted a homestay application.",
    defaultSmsTemplate:
      "Your Himachal Tourism application {{APPLICATION_ID}} was submitted successfully. We will update you on the next steps.",
    defaultEmailSubject: "Application {{APPLICATION_ID}} submitted",
    defaultEmailBody:
      "Hello {{OWNER_NAME}},\n\nWe received your homestay application {{APPLICATION_ID}}. We will notify you as it moves through scrutiny and inspection.\n\n- Tourism Department",
    placeholders: ["OWNER_NAME", "APPLICATION_ID"],
  },
  {
    id: "forwarded_to_dtdo",
    label: "Forwarded to DTDO",
    description: "Notifies the owner that scrutiny is complete and the case moved to DTDO.",
    defaultSmsTemplate:
      "Application {{APPLICATION_ID}} has moved to DTDO review for site inspection. Keep your documents handy.",
    defaultEmailSubject: "Application {{APPLICATION_ID}} forwarded for DTDO review",
    defaultEmailBody:
      "Hello {{OWNER_NAME}},\n\nYour application {{APPLICATION_ID}} cleared scrutiny and has been forwarded to the DTDO for field inspection. Please stay available for coordination.\n\n- Tourism Department",
    placeholders: ["OWNER_NAME", "APPLICATION_ID"],
  },
  {
    id: "inspection_scheduled",
    label: "Inspection scheduled",
    description: "Alerts the owner about the scheduled inspection date.",
    defaultSmsTemplate:
      "DTDO scheduled a site inspection for application {{APPLICATION_ID}} on {{INSPECTION_DATE}}. Please ensure availability.",
    defaultEmailSubject: "Site inspection scheduled – Application {{APPLICATION_ID}}",
    defaultEmailBody:
      "Hello {{OWNER_NAME}},\n\nA site inspection for application {{APPLICATION_ID}} is scheduled on {{INSPECTION_DATE}}. Kindly keep the property accessible and documents ready for verification.\n\n- Tourism Department",
    placeholders: ["OWNER_NAME", "APPLICATION_ID", "INSPECTION_DATE"],
  },
  {
    id: "verified_for_payment",
    label: "Verified for payment",
    description: "Informs the owner that the application is cleared for payment and certificate issue.",
    defaultSmsTemplate:
      "Application {{APPLICATION_ID}} is verified for payment. Log in to complete the fee and download your certificate after approval.",
    defaultEmailSubject: "Application {{APPLICATION_ID}} verified for payment",
    defaultEmailBody:
      "Hello {{OWNER_NAME}},\n\nYour application {{APPLICATION_ID}} has been verified for payment. Please sign in to complete the fee so we can issue the certificate.\n\n- Tourism Department",
    placeholders: ["OWNER_NAME", "APPLICATION_ID"],
  },
  {
    id: "da_send_back",
    label: "DA send-back",
    description: "Alerts the owner that the Dealing Assistant sent the application back for corrections.",
    defaultSmsTemplate:
      "Application {{APPLICATION_ID}} needs corrections. DA remarks: {{REMARKS}}. Please update and resubmit.",
    defaultEmailSubject: "Corrections requested – Application {{APPLICATION_ID}}",
    defaultEmailBody:
      "Hello {{OWNER_NAME}},\n\nOur Dealing Assistant reviewed application {{APPLICATION_ID}} and requested corrections.\n\nRemarks:\n{{REMARKS}}\n\nPlease sign in, update the form, and resubmit at the earliest.\n\n- Tourism Department",
    placeholders: ["OWNER_NAME", "APPLICATION_ID", "REMARKS"],
    defaultSmsEnabled: true,
    defaultEmailEnabled: true,
  },
  {
    id: "dtdo_revert",
    label: "DTDO revert",
    description: "Notifies the owner that DTDO returned the application for additional corrections after inspection.",
    defaultSmsTemplate:
      "DTDO returned application {{APPLICATION_ID}} for updates. Remarks: {{REMARKS}}. Please review and resubmit.",
    defaultEmailSubject: "DTDO corrections – Application {{APPLICATION_ID}}",
    defaultEmailBody:
      "Hello {{OWNER_NAME}},\n\nDuring district review we found items that need attention for application {{APPLICATION_ID}}.\n\nRemarks:\n{{REMARKS}}\n\nPlease update the application and resubmit so we can continue processing.\n\n- Tourism Department",
    placeholders: ["OWNER_NAME", "APPLICATION_ID", "REMARKS"],
    defaultSmsEnabled: true,
    defaultEmailEnabled: true,
  },
  {
    id: "dtdo_objection",
    label: "DTDO objection raised",
    description: "Informs the owner that DTDO raised objections after the inspection report.",
    defaultSmsTemplate:
      "Inspection objections raised for application {{APPLICATION_ID}}. Remarks: {{REMARKS}}. Update the application to continue.",
    defaultEmailSubject: "Inspection objections – Application {{APPLICATION_ID}}",
    defaultEmailBody:
      "Hello {{OWNER_NAME}},\n\nAfter reviewing the inspection report for application {{APPLICATION_ID}}, the DTDO raised the following objections:\n\n{{REMARKS}}\n\nPlease sign in, address the feedback, and resubmit. Ignoring objections may lead to rejection.\n\n- Tourism Department",
    placeholders: ["OWNER_NAME", "APPLICATION_ID", "REMARKS"],
    defaultSmsEnabled: true,
    defaultEmailEnabled: true,
  },
];

const notificationDefinitionMap = new Map(
  notificationEventDefinitions.map((definition) => [definition.id, definition]),
);

type NotificationTriggerOptions = {
  application?: HomestayApplication | null;
  applicationId?: string;
  owner?: User | null;
  recipientMobile?: string | null;
  recipientEmail?: string | null;
  recipientName?: string | null;
  otp?: string;
  extras?: Record<string, string | undefined>;
};

const buildNotificationResponse = (record: SystemSetting | null) => {
  const value: NotificationSettingsValue | undefined =
    (record?.settingValue as NotificationSettingsValue) ?? undefined;
  const storedRules = value?.rules ?? [];
  const ruleMap = new Map(storedRules.map((rule) => [rule.id, rule]));
  return {
    events: notificationEventDefinitions.map((definition) => {
      const stored = ruleMap.get(definition.id);
      return {
        id: definition.id,
        label: definition.label,
        description: definition.description,
        placeholders: definition.placeholders,
        smsEnabled: stored?.smsEnabled ?? definition.defaultSmsEnabled ?? false,
        smsTemplate: stored?.smsTemplate ?? definition.defaultSmsTemplate,
        emailEnabled: stored?.emailEnabled ?? definition.defaultEmailEnabled ?? false,
        emailSubject: stored?.emailSubject ?? definition.defaultEmailSubject,
        emailBody: stored?.emailBody ?? definition.defaultEmailBody,
      };
    }),
    updatedAt: record?.updatedAt ?? null,
    updatedBy: record?.updatedBy ?? null,
  };
};

const renderTemplate = (template: string, variables: Record<string, string>) =>
  template.replace(/{{\s*([^}]+)\s*}}/g, (_, token) => {
    const key = token.trim().toUpperCase();
    return variables[key] ?? "";
  });

const buildTemplateVariables = ({
  application,
  owner,
  recipientName,
  otp,
  extras,
}: {
  application?: HomestayApplication | null;
  owner?: User | null;
  recipientName?: string | null;
  otp?: string;
  extras?: Record<string, string | undefined>;
}) => {
  const inspectionDate =
    extras?.INSPECTION_DATE ??
    (application?.siteInspectionScheduledDate
      ? format(new Date(application.siteInspectionScheduledDate), "dd MMM yyyy")
      : "");

  return {
    APPLICATION_ID: application?.applicationNumber ?? application?.id ?? "",
    OWNER_NAME: recipientName ?? owner?.fullName ?? "",
    OWNER_MOBILE: owner?.mobile ?? "",
    OWNER_EMAIL: owner?.email ?? "",
    STATUS: application?.status ?? "",
    OTP: otp ?? "",
    INSPECTION_DATE: inspectionDate,
    REMARKS: extras?.REMARKS ?? "",
  };
};

const deliverNotificationSms = async (mobile: string, message: string) => {
  try {
    const record = await getSystemSettingRecord(SMS_GATEWAY_SETTING_KEY);
    if (!record) {
      console.warn("[notifications] SMS gateway not configured");
      return;
    }
    const config = (record.settingValue as SmsGatewaySettingValue) ?? {};
    const provider: SmsGatewayProvider = config.provider ?? "nic";
    if (provider === "twilio") {
      const twilioConfig =
        config.twilio ??
        ({
          accountSid: (config as any).accountSid,
          authToken: (config as any).authToken,
          fromNumber: (config as any).fromNumber,
          messagingServiceSid: (config as any).messagingServiceSid,
        } as TwilioSmsGatewaySettings);
      if (
        !twilioConfig ||
        !twilioConfig.accountSid ||
        !twilioConfig.authToken ||
        (!twilioConfig.fromNumber && !twilioConfig.messagingServiceSid)
      ) {
        console.warn("[notifications] Twilio SMS settings incomplete");
        return;
      }
      await sendTwilioSms(
        {
          accountSid: twilioConfig.accountSid,
          authToken: twilioConfig.authToken,
          fromNumber: twilioConfig.fromNumber,
          messagingServiceSid: twilioConfig.messagingServiceSid,
        },
        { mobile, message },
      );
      return;
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
    if (
      !nicConfig ||
      !nicConfig.username ||
      !nicConfig.password ||
      !nicConfig.senderId ||
      !nicConfig.departmentKey ||
      !nicConfig.templateId ||
      !nicConfig.postUrl
    ) {
      console.warn("[notifications] NIC SMS settings incomplete");
      return;
    }
    await sendTestSms(
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
  } catch (error) {
    console.error("[notifications] Failed to send SMS:", error);
  }
};

const deliverNotificationEmail = async (to: string, subject: string, body: string) => {
  try {
    const record = await getSystemSettingRecord(EMAIL_GATEWAY_SETTING_KEY);
    if (!record) {
      console.warn("[notifications] SMTP gateway not configured");
      return;
    }
    const value = (record.settingValue as EmailGatewaySettingValue) ?? {};
    const provider: EmailGatewayProvider = value.provider ?? "custom";
    const profile = getEmailProfileFromValue(value, provider) ?? extractLegacyEmailProfile(value);
    if (!profile?.host || !profile?.fromEmail || !profile?.password) {
      console.warn("[notifications] SMTP settings incomplete");
      return;
    }
    await sendTestEmail(
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
  } catch (error) {
    console.error("[notifications] Failed to send email:", error);
  }
};

const triggerNotification = async (
  eventId: NotificationEventId,
  options: NotificationTriggerOptions = {},
) => {
  const definition = notificationDefinitionMap.get(eventId);
  if (!definition) {
    return;
  }

  const record = await getSystemSettingRecord(NOTIFICATION_RULES_SETTING_KEY);
  const value: NotificationSettingsValue | undefined =
    (record?.settingValue as NotificationSettingsValue) ?? undefined;
  const stored = value?.rules?.find((rule) => rule.id === eventId);
  const smsEnabled = stored?.smsEnabled ?? definition.defaultSmsEnabled ?? false;
  const emailEnabled = stored?.emailEnabled ?? definition.defaultEmailEnabled ?? false;
  const smsActive = smsEnabled;
  const emailActive = emailEnabled;
  if (!smsActive && !emailActive) {
    return;
  }

  let application = options.application ?? null;
  if (!application && options.applicationId) {
    const loadedApplication = await storage.getApplication(options.applicationId);
    application = loadedApplication ?? null;
  }
  let owner = options.owner ?? null;
  if (!owner && application?.userId) {
    const loadedOwner = await storage.getUser(application.userId);
    owner = loadedOwner ?? null;
  }

  const variables = buildTemplateVariables({
    application,
    owner,
    recipientName: options.recipientName,
    otp: options.otp,
    extras: options.extras,
  });
  const targetMobile =
    options.recipientMobile !== undefined ? options.recipientMobile : owner?.mobile ?? null;
  const targetEmail =
    options.recipientEmail !== undefined ? options.recipientEmail : owner?.email ?? null;

  if (smsActive && targetMobile) {
    const smsTemplate = stored?.smsTemplate ?? definition.defaultSmsTemplate;
    const smsMessage = renderTemplate(smsTemplate, variables);
    await deliverNotificationSms(targetMobile, smsMessage);
  }

  if (emailActive && targetEmail) {
    const emailSubjectTemplate = stored?.emailSubject ?? definition.defaultEmailSubject;
    const emailBodyTemplate = stored?.emailBody ?? definition.defaultEmailBody;
    const emailSubject = renderTemplate(emailSubjectTemplate, variables);
    const emailBody = renderTemplate(emailBodyTemplate, variables);
    await deliverNotificationEmail(targetEmail, emailSubject, emailBody);
  }
};

const queueNotification = (
  eventId: NotificationEventId,
  options: NotificationTriggerOptions = {},
) => {
  triggerNotification(eventId, options).catch((error) => {
    console.error(`[notifications] Failed to send ${eventId} notification:`, error);
  });
};

async function createInAppNotification({
  userId,
  applicationId,
  type,
  title,
  message,
}: {
  userId: string;
  applicationId?: string | null;
  type: string;
  title: string;
  message: string;
}) {
  try {
    await db.insert(notifications).values({
      userId,
      applicationId: applicationId ?? null,
      type,
      title,
      message,
      channels: { inapp: true },
    });
  } catch (error) {
    console.error("[notifications] Failed to create notification", { userId, applicationId, type, error });
  }
}

const LOGIN_OTP_CODE_LENGTH = 6;
const LOGIN_OTP_EXPIRY_MINUTES = 10;
const PASSWORD_RESET_EXPIRY_MINUTES = 10;
type PasswordResetChannel = "sms" | "email";

const maskMobileNumber = (mobile?: string | null) => {
  if (!mobile) {
    return "";
  }
  const digits = mobile.replace(/\s+/g, "");
  if (digits.length <= 4) {
    return digits;
  }
  const visible = digits.slice(-4);
  return `${"•".repeat(Math.max(0, digits.length - 4))}${visible}`;
};

const maskEmailAddress = (email?: string | null) => {
  if (!email) {
    return "";
  }
  const [local, domain] = email.split("@");
  if (!domain) {
    return email;
  }
  if (!local || local.length <= 2) {
    return `${local?.[0] ?? ""}***@${domain}`;
  }
  return `${local.slice(0, 1)}***${local.slice(-1)}@${domain}`;
};

const generateLoginOtpCode = () =>
  randomInt(0, 10 ** LOGIN_OTP_CODE_LENGTH)
    .toString()
    .padStart(LOGIN_OTP_CODE_LENGTH, "0");

const getLoginOtpSetting = async () => {
  const record = await getSystemSettingRecord(LOGIN_OTP_SETTING_KEY);
  return normalizeBooleanSetting(record?.settingValue, false);
};

type LoginAuthMode = "password" | "otp";

const createLoginOtpChallenge = async (user: User, channel: PasswordResetChannel) => {
  const otp = generateLoginOtpCode();
  const otpHash = await bcrypt.hash(otp, 10);
  const expiresAt = new Date(Date.now() + LOGIN_OTP_EXPIRY_MINUTES * 60 * 1000);

  await db.delete(loginOtpChallenges).where(eq(loginOtpChallenges.userId, user.id));

  const [challenge] = await db
    .insert(loginOtpChallenges)
    .values({
      userId: user.id,
      otpHash,
      expiresAt,
    })
    .returning();

  queueNotification("otp", {
    owner: user,
    otp,
    recipientMobile: channel === "sms" ? user.mobile ?? null : null,
    recipientEmail: channel === "email" ? user.email ?? null : null,
  });

  return {
    id: challenge.id,
    expiresAt,
    channel,
  };
};

let passwordResetTableReady = false;

const ensurePasswordResetTable = async () => {
  if (passwordResetTableReady) {
    return;
  }
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS password_reset_challenges (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id VARCHAR NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        channel VARCHAR(32) NOT NULL,
        recipient VARCHAR(255),
        otp_hash VARCHAR(255) NOT NULL,
        expires_at TIMESTAMP NOT NULL,
        consumed_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT now()
      )
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS idx_password_reset_challenges_user_id
        ON password_reset_challenges(user_id)
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS idx_password_reset_challenges_expires_at
        ON password_reset_challenges(expires_at)
    `);
    passwordResetTableReady = true;
  } catch (error) {
    console.error("[auth] Failed to ensure password_reset_challenges table", error);
    throw error;
  }
};

const createPasswordResetChallenge = async (user: User, channel: PasswordResetChannel) => {
  await ensurePasswordResetTable();
  const otp = generateLoginOtpCode();
  const otpHash = await bcrypt.hash(otp, 10);
  const expiresAt = new Date(Date.now() + PASSWORD_RESET_EXPIRY_MINUTES * 60 * 1000);

  await db.delete(passwordResetChallenges).where(eq(passwordResetChallenges.userId, user.id));

  const recipient =
    channel === "sms" ? user.mobile ?? null : user.email ?? null;

  const [challenge] = await db
    .insert(passwordResetChallenges)
    .values({
      userId: user.id,
      channel,
      recipient,
      otpHash,
      expiresAt,
    })
    .returning();

  queueNotification("password_reset", {
    owner: user,
    otp,
    recipientMobile: channel === "sms" ? recipient : undefined,
    recipientEmail: channel === "email" ? recipient : undefined,
  });

  return {
    id: challenge.id,
    expiresAt,
  };
};

const findUserByIdentifier = async (rawIdentifier: string): Promise<User | null> => {
  const identifier = rawIdentifier.trim();
  if (!identifier) {
    return null;
  }
  const normalizedMobile = identifier.replace(/\s+/g, "");
  const looksLikeMobile = /^[0-9]{8,15}$/.test(normalizedMobile);
  const normalizedEmail = identifier.toLowerCase();
  const looksLikeEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail);
  const manifestFromIdentifier = lookupStaffAccountByIdentifier(identifier);
  const manifestFromMobile = looksLikeMobile ? lookupStaffAccountByMobile(normalizedMobile) : undefined;

  let user =
    looksLikeMobile
      ? await storage.getUserByMobile(normalizedMobile)
      : looksLikeEmail
        ? await storage.getUserByEmail(normalizedEmail)
        : undefined;

  if (!user && manifestFromMobile && manifestFromMobile.mobile !== normalizedMobile) {
    user = await storage.getUserByMobile(manifestFromMobile.mobile);
  }

  if (!user) {
    user = await storage.getUserByUsername(identifier);
  }

  if (!user && manifestFromIdentifier) {
    user = await storage.getUserByMobile(manifestFromIdentifier.mobile);
  }

  if (!user && looksLikeEmail) {
    user = await storage.getUserByEmail(normalizedEmail);
  }

  return user ?? null;
};

const parseIsoDateOrNull = (value: string | null | undefined) => {
  if (!value) {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const getExistingOwnerIntakeCutoff = async () => {
  const record = await getSystemSettingRecord(EXISTING_RC_MIN_ISSUE_DATE_SETTING_KEY);
  const iso = normalizeIsoDateSetting(record?.settingValue, DEFAULT_EXISTING_RC_MIN_ISSUE_DATE);
  return parseIsoDateOrNull(iso) ?? parseIsoDateOrNull(DEFAULT_EXISTING_RC_MIN_ISSUE_DATE) ?? new Date("2022-01-01");
};

const getLegacyForwardEnabled = async () => {
  const record = await getSystemSettingRecord(LEGACY_DTD0_FORWARD_SETTING_KEY);
  return normalizeBooleanSetting(record?.settingValue, true);
};

const isServiceApplicationKind = (kind?: HomestayApplication["applicationKind"] | null) =>
  Boolean(kind && kind !== "new_registration");

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

  return application || null;
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

const isPgUniqueViolation = (error: unknown, constraint?: string): error is { code: string; constraint?: string } => {
  if (!error || typeof error !== "object") {
    return false;
  }
  const pgErr = error as { code?: string; constraint?: string };
  if (pgErr.code !== "23505") {
    return false;
  }
  if (constraint && pgErr.constraint !== constraint) {
    return false;
  }
  return true;
};

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

const removeUndefined = <T extends Record<string, any>>(obj: T): T =>
  Object.fromEntries(
    Object.entries(obj).filter(([, value]) => value !== undefined),
  ) as T;

const generateCaptcha = () => {
  const first = Math.floor(Math.random() * 9) + 1;
  const second = Math.floor(Math.random() * 9) + 1;
  const operations = [
    { symbol: "+", apply: (a: number, b: number) => a + b },
    { symbol: "-", apply: (a: number, b: number) => a - b },
    { symbol: "×", apply: (a: number, b: number) => a * b },
  ] as const;
  const op = operations[Math.floor(Math.random() * operations.length)];
  return {
    question: `${first} ${op.symbol} ${second}`,
    answer: String(op.apply(first, second)),
  };
};

const normalizeDocumentsForPersistence = (
  docs: Array<{
    id?: string;
    documentType?: string;
    type?: string;
    fileName?: string;
    name?: string;
    filePath?: string;
    fileUrl?: string;
    url?: string;
    fileSize?: number | string;
    mimeType?: string;
    uploadedAt?: string;
    required?: boolean;
  }> | undefined,
) => {
  if (!Array.isArray(docs)) {
    return undefined;
  }

  const normalized = docs
    .map((doc, index) => {
      const documentType = doc.documentType || doc.type || "supporting_document";
      const fileName = doc.fileName || doc.name || `Document ${index + 1}`;
      const filePath = doc.filePath || doc.fileUrl || doc.url;

      if (!filePath || typeof filePath !== "string") {
        return null;
      }

      let fileSize = doc.fileSize;
      if (typeof fileSize === "string") {
        const parsed = Number(fileSize);
        fileSize = Number.isFinite(parsed) ? parsed : undefined;
      }

      const resolvedSize =
        typeof fileSize === "number" && Number.isFinite(fileSize) ? fileSize : 0;

      return {
        id: doc.id && typeof doc.id === "string" ? doc.id : randomUUID(),
        documentType,
        fileName,
        filePath,
        fileSize: resolvedSize,
        mimeType: doc.mimeType && typeof doc.mimeType === "string" && doc.mimeType.length > 0
          ? doc.mimeType
          : "application/octet-stream",
        name: fileName,
        type: documentType,
        url: filePath,
        uploadedAt: doc.uploadedAt,
        required: typeof doc.required === "boolean" ? doc.required : undefined,
      };
    })
    .filter((doc): doc is NonNullable<typeof doc> => Boolean(doc));

  return normalized;
};

const resolveTehsilFields = (
  rawTehsil: unknown,
  rawTehsilOther: unknown,
) => {
  const tehsilString =
    typeof rawTehsil === "string" ? rawTehsil.trim() : "";
  const tehsilOtherString =
    typeof rawTehsilOther === "string" ? rawTehsilOther.trim() : "";

  const isPlaceholder =
    tehsilString.length === 0 ||
    tehsilString.toLowerCase() === "not provided" ||
    tehsilString === "__other" ||
    tehsilString === "__manual";

  const resolvedTehsil =
    !isPlaceholder && tehsilString.length > 0
      ? tehsilString
      : tehsilOtherString.length > 0
        ? tehsilOtherString
        : "Not Provided";

  const resolvedTehsilOther =
    tehsilOtherString.length > 0 ? tehsilOtherString : null;

  return {
    tehsil: resolvedTehsil,
    tehsilOther: resolvedTehsilOther,
  };
};

const BYTES_PER_MB = 1024 * 1024;
const isValidMimeType = (candidate: string) =>
  /^[a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+$/.test(candidate);
const sanitizeDownloadFilename = (name: string) =>
  name.replace(/[^a-zA-Z0-9.\-\_\s]/g, "_");

const normalizeDistrictForMatch = (value?: string | null) => {
  if (!value) return [];
  const cleaned = value
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\b(division|sub-division|subdivision|hq|office|district|development|tourism|ddo|dto|dt|section|unit|range|circle|zone|serving|for|the|at|and)\b/g, " ")
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!cleaned) {
    return [];
  }

  const tokens = cleaned
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length > 2);

  return Array.from(new Set(tokens));
};

const districtsMatch = (officerDistrict?: string | null, targetDistrict?: string | null) => {
  const normalize = (val?: string | null) => (val ?? "").trim().toLowerCase();
  if (!officerDistrict || !targetDistrict) {
    return normalize(officerDistrict) === normalize(targetDistrict);
  }
  if (normalize(officerDistrict) === normalize(targetDistrict)) {
    return true;
  }
  const officerTokens = normalizeDistrictForMatch(officerDistrict);
  const targetTokens = normalizeDistrictForMatch(targetDistrict);
  if (officerTokens.length === 0 || targetTokens.length === 0) {
    return false;
  }
  return officerTokens.some((token) => targetTokens.includes(token));
};

const buildDistrictWhereClause = <T extends AnyColumn>(column: T, officerDistrict: string) => {
  const tokens = normalizeDistrictForMatch(officerDistrict);
  if (tokens.length === 0) {
    return eq(column, officerDistrict);
  }
  return or(
    eq(column, officerDistrict),
    ...tokens.map((token) => ilike(column, `%${token}%`)),
  );
};
type UploadCategoryKey = "documents" | "photos";
type NormalizedDocumentRecord = Exclude<
  ReturnType<typeof normalizeDocumentsForPersistence>,
  undefined
>[number];

const resolveUploadCategory = (
  rawCategory: unknown,
  fileTypeHint?: string | null,
  mimeTypeHint?: string | null,
): UploadCategoryKey => {
  if (typeof rawCategory === "string" && rawCategory.length > 0) {
    const normalized = rawCategory.toLowerCase();
    if (normalized.includes("photo") || normalized === "images" || normalized === "image") {
      return "photos";
    }
    if (normalized.includes("doc") || normalized === "documents" || normalized === "document") {
      return "documents";
    }
  }

  if (typeof fileTypeHint === "string" && fileTypeHint.toLowerCase().includes("photo")) {
    return "photos";
  }
  if (typeof mimeTypeHint === "string" && mimeTypeHint.toLowerCase().startsWith("image/")) {
    return "photos";
  }

  return "documents";
};

const resolveDocumentCategory = (doc: NormalizedDocumentRecord): UploadCategoryKey => {
  const type = doc.documentType?.toLowerCase?.() || doc.type?.toLowerCase?.() || "";
  if (type.includes("photo") || type.includes("image")) {
    return "photos";
  }
  const mime = doc.mimeType?.toLowerCase?.() || "";
  if (mime.startsWith("image/")) {
    return "photos";
  }
  return "documents";
};

const normalizeMime = (mime?: string | null) => {
  if (!mime || typeof mime !== "string") return "";
  return mime.split(";")[0].trim().toLowerCase();
};

const getExtension = (input?: string | null) => {
  if (!input || typeof input !== "string") return "";
  const lastDot = input.lastIndexOf(".");
  if (lastDot === -1 || lastDot === input.length - 1) {
    return "";
  }
  return input.slice(lastDot).toLowerCase();
};

const formatBytes = (bytes: number) => {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const idx = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  const value = bytes / Math.pow(1024, idx);
  return `${value % 1 === 0 ? value : value.toFixed(1)} ${units[idx]}`;
};

const CLOSED_SERVICE_STATUSES = ['approved', 'rejected', 'withdrawn', 'archived'] as const;
const CLOSED_SERVICE_STATUS_LIST = [...CLOSED_SERVICE_STATUSES];
const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;
const MIN_ROOMS_AFTER_DELETE = 1;

type RoomDeltaInput = {
  single?: number;
  double?: number;
  family?: number;
};

type RoomAdjustmentResult = {
  single: number;
  double: number;
  family: number;
  total: number;
  requestedRoomDelta?: number;
  requestedDeletions?: Array<{ roomType: string; count: number }>;
};

const toRoomCount = (value?: number | null) => {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return 0;
  }
  return Math.max(0, Math.floor(value));
};

const extractRoomBreakdown = (application: HomestayApplication): RoomAdjustmentResult => {
  const single = toRoomCount(application.singleBedRooms);
  const double = toRoomCount(application.doubleBedRooms);
  const family = toRoomCount(application.familySuites);
  return {
    single,
    double,
    family,
    total: single + double + family,
  };
};

const computeRoomAdjustment = (
  application: HomestayApplication,
  mode: 'add_rooms' | 'delete_rooms',
  delta?: RoomDeltaInput,
): RoomAdjustmentResult => {
  if (!delta) {
    throw new Error("Room adjustments are required for this service.");
  }

  const base = extractRoomBreakdown(application);
  const deltaSingle = toRoomCount(delta.single);
  const deltaDouble = toRoomCount(delta.double);
  const deltaFamily = toRoomCount(delta.family);
  const totalDelta = deltaSingle + deltaDouble + deltaFamily;

  if (totalDelta === 0) {
    throw new Error("Specify at least one room to add or delete.");
  }

  if (mode === "add_rooms") {
    const targetSingle = base.single + deltaSingle;
    const targetDouble = base.double + deltaDouble;
    const targetFamily = base.family + deltaFamily;
    const targetTotal = targetSingle + targetDouble + targetFamily;

    if (targetTotal > MAX_ROOMS_ALLOWED) {
      throw new Error(`HP Homestay Rules permit a maximum of ${MAX_ROOMS_ALLOWED} rooms. This request would result in ${targetTotal} rooms.`);
    }

    return {
      single: targetSingle,
      double: targetDouble,
      family: targetFamily,
      total: targetTotal,
      requestedRoomDelta: totalDelta,
    };
  }

  if (deltaSingle > base.single || deltaDouble > base.double || deltaFamily > base.family) {
    throw new Error("Cannot delete more rooms than currently exist in that category.");
  }

  const targetSingle = base.single - deltaSingle;
  const targetDouble = base.double - deltaDouble;
  const targetFamily = base.family - deltaFamily;
  const targetTotal = targetSingle + targetDouble + targetFamily;

  if (targetTotal < MIN_ROOMS_AFTER_DELETE) {
    throw new Error(`At least ${MIN_ROOMS_AFTER_DELETE} room must remain after deletion.`);
  }

  const requestedDeletions: Array<{ roomType: string; count: number }> = [];
  if (deltaSingle) requestedDeletions.push({ roomType: "single", count: deltaSingle });
  if (deltaDouble) requestedDeletions.push({ roomType: "double", count: deltaDouble });
  if (deltaFamily) requestedDeletions.push({ roomType: "family", count: deltaFamily });

  return {
    single: targetSingle,
    double: targetDouble,
    family: targetFamily,
    total: targetTotal,
    requestedRoomDelta: -totalDelta,
    requestedDeletions,
  };
};

const buildRenewalWindow = (expiry: Date | null) => {
  if (!expiry) {
    return null;
  }
  const windowStart = new Date(expiry.getTime() - NINETY_DAYS_MS);
  const now = Date.now();
  return {
    windowStart,
    windowEnd: expiry,
    inWindow: now >= windowStart.getTime() && now <= expiry.getTime(),
  };
};

async function getActiveServiceRequest(parentApplicationId: string) {
  if (!parentApplicationId) {
    return null;
  }

  const [active] = await db
    .select({
      id: homestayApplications.id,
      applicationNumber: homestayApplications.applicationNumber,
      applicationKind: homestayApplications.applicationKind,
      status: homestayApplications.status,
      totalRooms: homestayApplications.totalRooms,
      createdAt: homestayApplications.createdAt,
      updatedAt: homestayApplications.updatedAt,
    })
    .from(homestayApplications)
    .where(
      and(
        eq(homestayApplications.parentApplicationId, parentApplicationId),
        notInArray(homestayApplications.status, CLOSED_SERVICE_STATUS_LIST),
      ),
    )
    .orderBy(desc(homestayApplications.createdAt))
    .limit(1);

  return active ?? null;
}

async function buildServiceSummary(application: HomestayApplication) {
  const breakdown = extractRoomBreakdown(application);
  const expiry = application.certificateExpiryDate ? new Date(application.certificateExpiryDate) : null;
  const window = buildRenewalWindow(expiry);
  const activeRequest = await getActiveServiceRequest(application.id);

  return {
    id: application.id,
    applicationNumber: application.applicationNumber,
    propertyName: application.propertyName,
    totalRooms: breakdown.total,
    maxRoomsAllowed: MAX_ROOMS_ALLOWED,
    certificateExpiryDate: expiry ? expiry.toISOString() : null,
    renewalWindowStart: window ? window.windowStart.toISOString() : null,
    renewalWindowEnd: window ? window.windowEnd.toISOString() : null,
    canRenew: window ? window.inWindow : false,
    canAddRooms: breakdown.total < MAX_ROOMS_ALLOWED,
    canDeleteRooms: breakdown.total > MIN_ROOMS_AFTER_DELETE,
    rooms: {
      single: breakdown.single,
      double: breakdown.double,
      family: breakdown.family,
    },
    activeServiceRequest: activeRequest
      ? {
          id: activeRequest.id,
          applicationNumber: activeRequest.applicationNumber,
          applicationKind: activeRequest.applicationKind,
          status: activeRequest.status,
          totalRooms: activeRequest.totalRooms,
          createdAt: activeRequest.createdAt,
        }
      : null,
  };
}

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

const roomDeltaSchema = z
  .object({
    single: z.number().int().min(0).max(MAX_ROOMS_ALLOWED).optional(),
    double: z.number().int().min(0).max(MAX_ROOMS_ALLOWED).optional(),
    family: z.number().int().min(0).max(MAX_ROOMS_ALLOWED).optional(),
  })
  .partial();

const serviceRequestSchema = z.object({
  baseApplicationId: z.string().uuid(),
  serviceType: z.enum(['renewal', 'add_rooms', 'delete_rooms', 'cancel_certificate']),
  note: z.string().max(1000).optional(),
  roomDelta: roomDeltaSchema.optional(),
});

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

const generateLegacyApplicationNumber = (district?: string | null) => {
  const prefix = (district || "LEG")
    .toUpperCase()
    .replace(/[^A-Z]/g, "")
    .slice(0, 3)
    .padEnd(3, "X");
  return `${LEGACY_RC_PREFIX}${prefix}-${Date.now().toString(36).toUpperCase()}`;
};

const CAPTCHA_SETTING_KEY = "auth_captcha_enabled";
const CAPTCHA_CACHE_TTL = 5 * 60 * 1000;
const CAPTCHA_FORCE_DISABLE = (() => {
  const raw = typeof process.env.CAPTCHA_FORCE_DISABLE === "string"
    ? process.env.CAPTCHA_FORCE_DISABLE.trim().toLowerCase()
    : null;
  if (raw === "true") {
    return true;
  }
  if (raw === "false") {
    return false;
  }
  // Auto-disable captcha when running on the RC3 port (4000) to avoid login blockers
  return process.env.PORT === "4000";
})();

console.info(
  "[captcha] configuration",
  JSON.stringify({
    port: process.env.PORT,
    forcedFlag: process.env.CAPTCHA_FORCE_DISABLE,
    computedForceDisable: CAPTCHA_FORCE_DISABLE,
  }),
);
const shouldBypassCaptcha = (hostHeader?: string | null): boolean => {
  if (CAPTCHA_FORCE_DISABLE) {
    return true;
  }
  const normalizedHost = (hostHeader || "").toLowerCase();
  return normalizedHost.includes("hptourism.osipl.dev");
};
const captchaSettingCache: { fetchedAt: number; enabled: boolean } = {
  fetchedAt: 0,
  enabled: true,
};

const updateCaptchaSettingCache = (enabled: boolean) => {
  captchaSettingCache.enabled = enabled;
  captchaSettingCache.fetchedAt = Date.now();
};

const getCaptchaSetting = async () => {
  if (CAPTCHA_FORCE_DISABLE) {
    const wasEnabled = captchaSettingCache.enabled !== false;
    updateCaptchaSettingCache(false);
    if (wasEnabled) {
      console.info("[captcha] Force-disabled via configuration/port override");
    }
    return false;
  }

  const now = Date.now();
  if (now - captchaSettingCache.fetchedAt < CAPTCHA_CACHE_TTL) {
    return captchaSettingCache.enabled;
  }

  const [setting] = await db
    .select()
    .from(systemSettings)
    .where(eq(systemSettings.settingKey, CAPTCHA_SETTING_KEY))
    .limit(1);

  const enabled =
    setting && setting.settingValue
      ? Boolean((setting.settingValue as { enabled?: boolean }).enabled)
      : true;

  updateCaptchaSettingCache(enabled);
  return enabled;
};

const validateDocumentsAgainstPolicy = (
  docs: NormalizedDocumentRecord[] | undefined,
  policy: UploadPolicy,
): string | null => {
  if (!docs || docs.length === 0) {
    return null;
  }

  let totalBytes = 0;

  for (const doc of docs) {
    const category = resolveDocumentCategory(doc);
    const categoryPolicy = policy[category];
    const maxBytes = categoryPolicy.maxFileSizeMB * BYTES_PER_MB;
    const sizeBytes =
      typeof doc.fileSize === "number" && Number.isFinite(doc.fileSize)
        ? doc.fileSize
        : 0;

    if (sizeBytes > maxBytes) {
      return `${doc.fileName} exceeds the ${categoryPolicy.maxFileSizeMB} MB limit`;
    }

    const normalizedMime = normalizeMime(doc.mimeType);
    const mimeAllowed =
      categoryPolicy.allowedMimeTypes.length === 0 ||
      !normalizedMime ||
      normalizedMime === "application/octet-stream" ||
      normalizedMime === "binary/octet-stream" ||
      categoryPolicy.allowedMimeTypes.includes(normalizedMime) ||
      (normalizedMime === "image/jpg" &&
        categoryPolicy.allowedMimeTypes.includes("image/jpeg"));
    if (!mimeAllowed) {
      return `${doc.fileName} has an unsupported file type (${normalizedMime}). Allowed types: ${categoryPolicy.allowedMimeTypes.join(", ")}`;
    }

    const extension =
      getExtension(doc.fileName) || getExtension(doc.filePath) || getExtension(doc.url);
    if (
      categoryPolicy.allowedExtensions.length > 0 &&
      (!extension || !categoryPolicy.allowedExtensions.includes(extension))
    ) {
      return `${doc.fileName} must use one of the following extensions: ${categoryPolicy.allowedExtensions.join(", ")}`;
    }

    totalBytes += sizeBytes;
  }

  const maxTotalBytes = policy.totalPerApplicationMB * BYTES_PER_MB;
  if (totalBytes > maxTotalBytes) {
    return `Total document size ${formatBytes(totalBytes)} exceeds ${policy.totalPerApplicationMB} MB limit per application`;
  }

  return null;
};

const sanitizeDraftForPersistence = (
  validatedData: any,
  draftOwner: User | null | undefined,
) => {
  const normalizedDocuments = normalizeDocumentsForPersistence(
    validatedData.documents,
  );
  const { tehsil: resolvedTehsil, tehsilOther: resolvedTehsilOther } =
    resolveTehsilFields(validatedData.tehsil, validatedData.tehsilOther);
  const fallbackOwner = draftOwner ?? null;
  const fallbackOwnerName = normalizeStringField(
    fallbackOwner?.fullName,
    "Draft Owner",
  );
  const fallbackOwnerMobile = normalizeStringField(
    fallbackOwner?.mobile,
    "0000000000",
  );
  const fallbackOwnerEmail = normalizeStringField(
    fallbackOwner?.email,
    "",
  );

  return {
    ...validatedData,
    propertyName: normalizeStringField(
      validatedData.propertyName,
      "Draft Homestay",
    ),
    category: validatedData.category || "silver",
    locationType: validatedData.locationType || "gp",
    district: normalizeStringField(validatedData.district),
    tehsil: resolvedTehsil,
    tehsilOther: resolvedTehsilOther,
    block: normalizeStringField(validatedData.block),
    blockOther: normalizeStringField(validatedData.blockOther),
    gramPanchayat: normalizeStringField(validatedData.gramPanchayat),
    gramPanchayatOther: normalizeStringField(validatedData.gramPanchayatOther),
    urbanBody: normalizeStringField(validatedData.urbanBody),
    urbanBodyOther: normalizeStringField(validatedData.urbanBodyOther),
    ward: normalizeStringField(validatedData.ward),
    address: normalizeStringField(validatedData.address),
    pincode: normalizeStringField(validatedData.pincode, "", 10),
    telephone: normalizeStringField(validatedData.telephone, "", 20),
    ownerName: normalizeStringField(
      validatedData.ownerName,
      fallbackOwnerName,
    ),
    ownerGender: validatedData.ownerGender || "other",
    ownerMobile: normalizeStringField(
      validatedData.ownerMobile,
      fallbackOwnerMobile,
      15,
    ),
    ownerEmail: normalizeStringField(
      validatedData.ownerEmail,
      fallbackOwnerEmail,
    ),
    ownerAadhaar: normalizeStringField(
      validatedData.ownerAadhaar,
      "000000000000",
      12,
    ),
    propertyOwnership:
      validatedData.propertyOwnership === "leased" ? "leased" : "owned",
    projectType: validatedData.projectType || "new_project",
    propertyArea: coerceNumberField(validatedData.propertyArea),
    singleBedRooms: coerceNumberField(validatedData.singleBedRooms),
    singleBedBeds: coerceNumberField(validatedData.singleBedBeds, 1),
    singleBedRoomSize: coerceNumberField(validatedData.singleBedRoomSize),
    singleBedRoomRate: coerceNumberField(validatedData.singleBedRoomRate),
    doubleBedRooms: coerceNumberField(validatedData.doubleBedRooms),
    doubleBedBeds: coerceNumberField(validatedData.doubleBedBeds, 2),
    doubleBedRoomSize: coerceNumberField(validatedData.doubleBedRoomSize),
    doubleBedRoomRate: coerceNumberField(validatedData.doubleBedRoomRate),
    familySuites: coerceNumberField(validatedData.familySuites),
    familySuiteBeds: coerceNumberField(validatedData.familySuiteBeds, 4),
    familySuiteSize: coerceNumberField(validatedData.familySuiteSize),
    familySuiteRate: coerceNumberField(validatedData.familySuiteRate),
    attachedWashrooms: coerceNumberField(validatedData.attachedWashrooms),
    gstin: normalizeStringField(validatedData.gstin, "", 15),
    selectedCategory:
      validatedData.selectedCategory || validatedData.category || "silver",
    averageRoomRate: coerceNumberField(validatedData.averageRoomRate),
    highestRoomRate: coerceNumberField(validatedData.highestRoomRate),
    lowestRoomRate: coerceNumberField(validatedData.lowestRoomRate),
    certificateValidityYears:
      validatedData.certificateValidityYears ?? 1,
    isPangiSubDivision: validatedData.isPangiSubDivision ?? false,
    distanceAirport: coerceNumberField(validatedData.distanceAirport),
    distanceRailway: coerceNumberField(validatedData.distanceRailway),
    distanceCityCenter: coerceNumberField(validatedData.distanceCityCenter),
    distanceShopping: coerceNumberField(validatedData.distanceShopping),
    distanceBusStand: coerceNumberField(validatedData.distanceBusStand),
    lobbyArea: coerceNumberField(validatedData.lobbyArea),
    diningArea: coerceNumberField(validatedData.diningArea),
    parkingArea: normalizeStringField(validatedData.parkingArea),
    ecoFriendlyFacilities: normalizeStringField(
      validatedData.ecoFriendlyFacilities,
    ),
    differentlyAbledFacilities: normalizeStringField(
      validatedData.differentlyAbledFacilities,
    ),
    fireEquipmentDetails: normalizeStringField(
      validatedData.fireEquipmentDetails,
    ),
    nearestHospital: normalizeStringField(validatedData.nearestHospital),
    baseFee: coerceNumberField(validatedData.baseFee),
    totalBeforeDiscounts: coerceNumberField(validatedData.totalBeforeDiscounts),
    validityDiscount: coerceNumberField(validatedData.validityDiscount),
    femaleOwnerDiscount: coerceNumberField(validatedData.femaleOwnerDiscount),
    pangiDiscount: coerceNumberField(validatedData.pangiDiscount),
    totalDiscount: coerceNumberField(validatedData.totalDiscount),
    totalFee: coerceNumberField(validatedData.totalFee),
    perRoomFee: coerceNumberField(validatedData.perRoomFee),
    gstAmount: coerceNumberField(validatedData.gstAmount),
    documents: normalizedDocuments ?? [],
    currentPage: validatedData.currentPage ?? 1,
    status: "draft" as const,
  };
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
      console.error("[upload-policy] Failed to fetch policy, falling back to defaults:", error);
      return DEFAULT_UPLOAD_POLICY;
    }
  };

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
      console.error("[category-enforcement] Failed to fetch setting, falling back to defaults:", error);
      return DEFAULT_CATEGORY_ENFORCEMENT;
    }
  };

  const getRoomRateBandsSetting = async () => {
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
      console.error("[room-rate-bands] Failed to fetch setting, falling back to defaults:", error);
      return DEFAULT_CATEGORY_RATE_BANDS;
    }
  };

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
      console.error("[room-calc-mode] Failed to fetch setting, falling back to defaults:", error);
      return DEFAULT_ROOM_CALC_MODE;
    }
  };

  if (OBJECT_STORAGE_MODE === "local") {
    const uploadLimitMb = Math.max(1, Math.ceil(LOCAL_MAX_UPLOAD_BYTES / (1024 * 1024)));
    const rawUploadMiddleware = express.raw({ type: "*/*", limit: `${uploadLimitMb}mb` });

    app.put(
      "/api/local-object/upload/:objectId",
      requireAuth,
      rawUploadMiddleware,
      async (req, res) => {
        try {
          if (!Buffer.isBuffer(req.body)) {
            return res.status(400).json({ message: "Upload payload missing" });
          }

          const policy = await getUploadPolicy();
          const objectId = req.params.objectId;
          const fileType = (req.query.type as string) || "document";
          const categoryHint = req.query.category as string | undefined;
          const providedMime =
            (req.query.mime as string | undefined) || req.get("Content-Type") || undefined;
          const providedName = req.query.name as string | undefined;
          const category = resolveUploadCategory(
            categoryHint,
            fileType,
            providedMime || null,
          );
          const categoryPolicy = policy[category];
          const fileBuffer = req.body as Buffer;
          const sizeBytes = fileBuffer.length;
          const maxBytes = categoryPolicy.maxFileSizeMB * BYTES_PER_MB;

          if (sizeBytes > maxBytes) {
            return res.status(400).json({
              message: `File exceeds the ${categoryPolicy.maxFileSizeMB} MB limit`,
            });
          }

          const normalizedMime = normalizeMime(providedMime);
          if (
            categoryPolicy.allowedMimeTypes.length > 0 &&
            normalizedMime &&
            !categoryPolicy.allowedMimeTypes.includes(normalizedMime)
          ) {
            return res.status(400).json({
              message: `Unsupported file type "${normalizedMime}". Allowed types: ${categoryPolicy.allowedMimeTypes.join(", ")}`,
            });
          }

          const extension =
            getExtension(providedName) ||
            getExtension(req.query.extension as string | undefined) ||
            "";
          if (
            categoryPolicy.allowedExtensions.length > 0 &&
            (!extension ||
              !categoryPolicy.allowedExtensions.includes(extension.toLowerCase()))
          ) {
            return res.status(400).json({
              message: `Unsupported file extension. Allowed extensions: ${categoryPolicy.allowedExtensions.join(", ")}`,
            });
          }

          const safeType = fileType.replace(/[^a-zA-Z0-9_-]/g, "");
          const targetDir = path.join(LOCAL_OBJECT_DIR, `${safeType}s`);
          await fsPromises.mkdir(targetDir, { recursive: true });
          const targetPath = path.join(targetDir, objectId);
          await fsPromises.writeFile(targetPath, fileBuffer);

          res.status(200).json({ success: true });
        } catch (error) {
          console.error("Local upload error", error);
          res.status(500).json({ message: "Failed to store uploaded file" });
        }
      }
    );

    app.get(
      "/api/local-object/download/:objectId",
      requireAuth,
      async (req, res) => {
        try {
          const objectId = req.params.objectId;
          const fileType = (req.query.type as string) || "document";
          const safeType = fileType.replace(/[^a-zA-Z0-9_-]/g, "");
          const filePath = path.join(LOCAL_OBJECT_DIR, `${safeType}s`, objectId);

          await fsPromises.access(filePath, fs.constants.R_OK);

          const mimeOverride =
            typeof req.query.mime === "string" && isValidMimeType(req.query.mime)
              ? req.query.mime
              : undefined;
          const filenameOverride =
            typeof req.query.filename === "string" && req.query.filename.trim().length > 0
              ? sanitizeDownloadFilename(req.query.filename.trim())
              : undefined;

          console.log("[object-download] query", req.query, {
            mimeOverride,
            filenameOverride,
            fileType,
            objectId,
          });

          res.setHeader("Content-Type", mimeOverride || "application/octet-stream");
          res.setHeader(
            "Content-Disposition",
            `inline; filename="${filenameOverride || objectId}"`
          );

          const stream = fs.createReadStream(filePath);
          stream.on("error", (err) => {
            console.error("Stream error", err);
            res.destroy(err);
          });
          stream.pipe(res);
        } catch (error) {
          console.error("Local download error", error);
          res.status(404).json({ message: "File not found" });
        }
      }
    );
  }

  // Auth Routes
  
  // Register
  app.post("/api/auth/register", async (req, res) => {
    try {
      // SECURITY: Force role to property_owner BEFORE validation
      // This prevents role escalation attacks via direct API calls
      const rawData = {
        ...req.body,
        role: 'property_owner', // FORCE property_owner role - override any client input
        email: req.body.email || undefined,
        aadhaarNumber: req.body.aadhaarNumber || undefined,
        district: req.body.district || undefined,
      };
      
      const data = insertUserSchema.parse(rawData);
      
      // Check if user already exists
      const existing = await storage.getUserByMobile(data.mobile);
      if (existing) {
        return res.status(400).json({ message: "Mobile number already registered" });
      }
      
      // Hash password before storing
      const hashedPassword = await bcrypt.hash(data.password, 10);
      const user = await storage.createUser({
        ...data,
        password: hashedPassword,
      });
      
      // Auto-login after registration
      req.session.userId = user.id;
      
      // Don't send password back
      const { password, ...userWithoutPassword } = user;
      res.json({ user: userWithoutPassword });
    } catch (error) {
      console.error('[registration] Error during registration:', error);
      if (error instanceof z.ZodError) {
        return res.status(400).json({ message: error.errors[0].message, errors: error.errors });
      }
      
      // Handle duplicate Aadhaar number error
      if (error && typeof error === 'object' && 'code' in error && error.code === '23505') {
        if ('constraint' in error && error.constraint === 'users_aadhaar_number_unique') {
          return res.status(400).json({ 
            message: "This Aadhaar number is already registered. Please login or use a different Aadhaar number." 
          });
        }
      }
      
      res.status(500).json({ message: "Registration failed", error: error instanceof Error ? error.message : String(error) });
    }
  });

  // Captcha for public login
  app.get("/api/auth/captcha", async (req, res) => {
    try {
      if (shouldBypassCaptcha(req.get("host"))) {
        updateCaptchaSettingCache(false);
        req.session.captchaAnswer = null;
        req.session.captchaIssuedAt = null;
        return res.json({ enabled: false });
      }

      const enabled = await getCaptchaSetting();
      if (!enabled) {
        req.session.captchaAnswer = null;
        req.session.captchaIssuedAt = null;
        return res.json({ enabled: false });
      }
      const { question, answer } = generateCaptcha();
      req.session.captchaAnswer = answer;
      req.session.captchaIssuedAt = Date.now();
      res.json({ enabled: true, question, expiresInSeconds: 300 });
    } catch (error) {
      console.error("[auth] Failed to load captcha:", error);
      res.status(500).json({ message: "Captcha unavailable" });
    }
  });

  // Login
  const resolveNotificationChannelState = async (eventId: NotificationEventId) => {
    const definition = notificationDefinitionMap.get(eventId);
    if (!definition) {
      return { smsEnabled: false, emailEnabled: false };
    }
    const record = await getSystemSettingRecord(NOTIFICATION_RULES_SETTING_KEY);
    const value: NotificationSettingsValue | undefined =
      (record?.settingValue as NotificationSettingsValue) ?? undefined;
    const stored = value?.rules?.find((rule) => rule.id === eventId);
    return {
      smsEnabled: stored?.smsEnabled ?? definition.defaultSmsEnabled ?? false,
      emailEnabled: stored?.emailEnabled ?? definition.defaultEmailEnabled ?? false,
    };
  };

  type OtpChannelState = {
    smsEnabled: boolean;
    emailEnabled: boolean;
    anyEnabled: boolean;
  };

  type OtpLoginAvailability = OtpChannelState & {
    allowed: boolean;
  };

  const getOtpChannelState = async (): Promise<OtpChannelState> => {
    const otpChannels = await resolveNotificationChannelState("otp");
    const smsEnabled = Boolean(otpChannels.smsEnabled);
    const emailEnabled = Boolean(otpChannels.emailEnabled);
    return {
      smsEnabled,
      emailEnabled,
      anyEnabled: smsEnabled || emailEnabled,
    };
  };

  const getOtpLoginAvailabilityForUser = async (user: User): Promise<OtpLoginAvailability> => {
    const channelState = await getOtpChannelState();
    const allowed = user.role === "property_owner" && channelState.anyEnabled;
    return {
      ...channelState,
      allowed,
    };
  };

  app.get("/api/auth/login/options", async (_req, res) => {
    try {
      const otpChannels = await getOtpChannelState();
      const otpRequired = otpChannels.anyEnabled ? await getLoginOtpSetting() : false;
      const payload = {
        otpEnabled: otpChannels.anyEnabled,
        smsOtpEnabled: otpChannels.smsEnabled,
        emailOtpEnabled: otpChannels.emailEnabled,
        otpRequired,
      };
      console.info("[auth] login options", payload);
      res.json(payload);
    } catch (error) {
      console.error("[auth] Failed to load login options", error);
      res.status(500).json({ message: "Unable to load login options" });
    }
  });

  app.post("/api/auth/login", async (req, res) => {
    try {
      const authModeRaw = typeof req.body?.authMode === "string" ? req.body.authMode.trim().toLowerCase() : "password";
      const authMode: LoginAuthMode = authModeRaw === "otp" ? "otp" : "password";
      const otpChannelRaw = typeof req.body?.otpChannel === "string" ? req.body.otpChannel.trim().toLowerCase() : "sms";
      const otpChannel: PasswordResetChannel = otpChannelRaw === "email" ? "email" : "sms";
      const password = typeof req.body?.password === "string" ? req.body.password : "";
      const captchaAnswer = typeof req.body?.captchaAnswer === "string" ? req.body.captchaAnswer.trim() : "";
      const rawIdentifier =
        typeof req.body?.identifier === "string" && req.body.identifier.trim().length > 0
          ? req.body.identifier.trim()
          : typeof req.body?.mobile === "string"
            ? req.body.mobile.trim()
            : "";

      if (!rawIdentifier) {
        return res.status(400).json({ message: "Identifier required" });
      }
      if (authMode === "password" && !password) {
        return res.status(400).json({ message: "Password is required" });
      }

      const captchaRequired = shouldBypassCaptcha(req.get("host"))
        ? false
        : await getCaptchaSetting();
      if (captchaRequired) {
        if (!captchaAnswer) {
          return res.status(400).json({ message: "Captcha answer required" });
        }

        const expectedCaptchaAnswer = req.session.captchaAnswer;
        const captchaIssuedAt = req.session.captchaIssuedAt ?? 0;
        const captchaExpired = !captchaIssuedAt || Date.now() - captchaIssuedAt > 5 * 60 * 1000;
        if (!expectedCaptchaAnswer || captchaExpired || captchaAnswer !== expectedCaptchaAnswer) {
          req.session.captchaAnswer = null;
          req.session.captchaIssuedAt = null;
          const message = captchaExpired ? "Captcha expired. Please refresh and try again." : "Invalid captcha answer";
          return res.status(400).json({ message });
        }
      }

      const normalizedMobile = rawIdentifier.replace(/\s+/g, "");
      const looksLikeMobile = /^[0-9]{8,15}$/.test(normalizedMobile);
      const normalizedEmail = rawIdentifier.toLowerCase();
      const looksLikeEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail);
      const manifestFromIdentifier = lookupStaffAccountByIdentifier(rawIdentifier);
      const manifestFromMobile = looksLikeMobile ? lookupStaffAccountByMobile(normalizedMobile) : undefined;

      let user =
        looksLikeMobile
          ? await storage.getUserByMobile(normalizedMobile)
          : looksLikeEmail
            ? await storage.getUserByEmail(normalizedEmail)
            : undefined;

      if (!user && manifestFromMobile && manifestFromMobile.mobile !== normalizedMobile) {
        user = await storage.getUserByMobile(manifestFromMobile.mobile);
      }

      if (!user) {
        user = await storage.getUserByUsername(rawIdentifier);
      }

      if (!user && manifestFromIdentifier) {
        user = await storage.getUserByMobile(manifestFromIdentifier.mobile);
      }

      if (!user && looksLikeEmail) {
        user = await storage.getUserByEmail(normalizedEmail);
      }

      // Backwards compatibility: if both identifier + mobile were sent but the identifier
      // looked like a username, fall back to the explicit mobile flag before failing.
      if (!user && typeof req.body?.mobile === "string") {
        user = await storage.getUserByMobile(req.body.mobile.trim());
      }

      if (!user || (authMode === "password" && !user.password)) {
        return res.status(401).json({ message: "Invalid credentials" });
      }

      if (!user.isActive) {
        return res.status(403).json({ message: "Account deactivated" });
      }

      if (authMode === "otp") {
        const otpAvailability = await getOtpLoginAvailabilityForUser(user);
        if (!otpAvailability.allowed) {
          return res.status(400).json({ message: "OTP login is disabled" });
        }
        if (otpChannel === "sms") {
          if (!otpAvailability.smsEnabled) {
            return res.status(400).json({ message: "SMS OTP is disabled. Switch to email OTP." });
          }
          if (!user.mobile || user.mobile.trim().length < 6) {
            return res.status(400).json({ message: "OTP login unavailable (missing mobile)" });
          }
        } else if (otpChannel === "email") {
          if (!otpAvailability.emailEnabled) {
            return res.status(400).json({ message: "Email OTP is disabled. Switch to SMS OTP." });
          }
          if (!user.email) {
            return res.status(400).json({ message: "OTP login unavailable (missing email)" });
          }
        }
        const challenge = await createLoginOtpChallenge(user, otpChannel);
        req.session.captchaAnswer = null;
        req.session.captchaIssuedAt = null;
        return res.json({
          otpRequired: true,
          challengeId: challenge.id,
          expiresAt: challenge.expiresAt.toISOString(),
          maskedMobile: otpChannel === "sms" ? maskMobileNumber(user.mobile) : undefined,
          maskedEmail: otpChannel === "email" ? maskEmailAddress(user.email) : undefined,
          channel: otpChannel,
        });
      }

      const comparePassword = async (candidate?: typeof user) => {
        if (!candidate || !candidate.password) {
          return false;
        }
        try {
          return await bcrypt.compare(password, candidate.password);
        } catch (error) {
          console.warn("[auth] Failed to compare password hash", {
            userId: candidate.id,
            identifier: rawIdentifier,
            error,
          });
          return false;
        }
      };

      let passwordMatch = await comparePassword(user);

      if (!passwordMatch && manifestFromIdentifier) {
        try {
          const manifestUser = await storage.getUserByMobile(manifestFromIdentifier.mobile);
          if (
            manifestUser &&
            manifestUser.id !== user.id &&
            manifestUser.password &&
            (await comparePassword(manifestUser))
          ) {
            user = manifestUser;
            passwordMatch = true;
            console.info("[auth] Resolved staff login via manifest fallback", {
              identifier: rawIdentifier,
              mobile: manifestFromIdentifier.mobile,
            });
          }
        } catch (fallbackError) {
          console.error("[auth] Manifest fallback failed", fallbackError);
        }
      }

      if (!passwordMatch) {
        return res.status(401).json({ message: "Invalid credentials" });
      }
      
      const manifestAccount =
        manifestFromIdentifier ??
        manifestFromMobile ??
        lookupStaffAccountByMobile(user.mobile);

      if (
        manifestAccount &&
        manifestAccount.username &&
        (!user.username ||
          user.username.toLowerCase() !== manifestAccount.username.toLowerCase())
      ) {
        try {
          const updated = await storage.updateUser(user.id, {
            username: manifestAccount.username,
          });
          if (updated) {
            user = updated;
          }
        } catch (updateError) {
          console.warn("[auth] Failed to backfill staff username", updateError);
        }
      }

      req.session.userId = user.id;
      req.session.captchaAnswer = null;
      req.session.captchaIssuedAt = null;
      
      const userResponse = formatUserForResponse(user);
      res.json({ user: userResponse });
    } catch (error) {
      res.status(500).json({ message: "Login failed" });
    }
  });

  app.post("/api/auth/login/verify-otp", async (req, res) => {
    try {
      const challengeId =
        typeof req.body?.challengeId === "string" ? req.body.challengeId.trim() : "";
      const otp = typeof req.body?.otp === "string" ? req.body.otp.trim() : "";

      if (!challengeId || !otp) {
        return res.status(400).json({ message: "OTP verification failed" });
      }

      const [challenge] = await db
        .select()
        .from(loginOtpChallenges)
        .where(eq(loginOtpChallenges.id, challengeId))
        .limit(1);

      if (!challenge) {
        return res.status(400).json({ message: "OTP expired. Please sign in again." });
      }

      if (challenge.consumedAt) {
        return res.status(400).json({ message: "OTP already used. Please sign in again." });
      }

      const now = new Date();
      if (challenge.expiresAt < now) {
        await db.delete(loginOtpChallenges).where(eq(loginOtpChallenges.id, challengeId));
        return res.status(400).json({ message: "OTP expired. Please sign in again." });
      }

      const user = await storage.getUser(challenge.userId);
      if (!user || !user.isActive) {
        return res.status(400).json({ message: "Account unavailable" });
      }

      const otpMatch = await bcrypt.compare(otp, challenge.otpHash);
      if (!otpMatch) {
        return res.status(400).json({ message: "Incorrect OTP" });
      }

      await db
        .update(loginOtpChallenges)
        .set({ consumedAt: new Date() })
        .where(eq(loginOtpChallenges.id, challengeId));

      req.session.userId = user.id;
      req.session.captchaAnswer = null;
      req.session.captchaIssuedAt = null;

      const userResponse = formatUserForResponse(user);
      res.json({ user: userResponse });
    } catch (error) {
      console.error("[auth] OTP verification failed", error);
      res.status(500).json({ message: "OTP verification failed" });
    }
  });

  const passwordResetRequestSchema = z.object({
    identifier: z.string().min(3, "Enter your registered mobile number, email, or username"),
    channel: z.enum(["sms", "email"]).optional(),
  });

  const passwordResetVerifySchema = z.object({
    challengeId: z.string().min(1, "Challenge id missing"),
    otp: z.string().min(4, "Enter the code sent to you"),
    newPassword: z.string().min(6, "New password must be at least 6 characters"),
  });

  app.post("/api/auth/password-reset/request", async (req, res) => {
    try {
      const { identifier, channel: rawChannel } = passwordResetRequestSchema.parse(req.body ?? {});
      const channel: PasswordResetChannel = rawChannel === "email" ? "email" : "sms";
      const user = await findUserByIdentifier(identifier);
      if (!user) {
        return res.status(404).json({ message: "Account not found" });
      }
      if (!user.isActive) {
        return res.status(403).json({ message: "Account disabled" });
      }

      if (channel === "sms") {
        if (!user.mobile || user.mobile.trim().length < 6) {
          return res.status(400).json({ message: "No mobile number linked to this account" });
        }
      } else if (channel === "email") {
        if (!user.email) {
          return res.status(400).json({ message: "No email linked to this account" });
        }
      }

      const challenge = await createPasswordResetChallenge(user, channel);
      res.json({
        challengeId: challenge.id,
        expiresAt: challenge.expiresAt.toISOString(),
        channel,
        maskedMobile: channel === "sms" ? maskMobileNumber(user.mobile) : undefined,
        maskedEmail: channel === "email" ? maskEmailAddress(user.email) : undefined,
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ message: error.errors[0]?.message || "Invalid request" });
      }
      console.error("[auth] Password reset request failed", error);
      res.status(500).json({ message: "Failed to issue reset code" });
    }
  });

  app.post("/api/auth/password-reset/verify", async (req, res) => {
    try {
      const { challengeId, otp, newPassword } = passwordResetVerifySchema.parse(req.body ?? {});

      await ensurePasswordResetTable();
      const [challenge] = await db
        .select()
        .from(passwordResetChallenges)
        .where(eq(passwordResetChallenges.id, challengeId))
        .limit(1);

      if (!challenge) {
        return res.status(400).json({ message: "Reset code expired. Please start again." });
      }

      if (challenge.consumedAt) {
        return res.status(400).json({ message: "Reset code already used. Please request a new one." });
      }

      const now = new Date();
      if (challenge.expiresAt < now) {
        await db.delete(passwordResetChallenges).where(eq(passwordResetChallenges.id, challengeId));
        return res.status(400).json({ message: "Reset code expired. Please request a new one." });
      }

      const user = await storage.getUser(challenge.userId);
      if (!user || !user.isActive) {
        return res.status(404).json({ message: "Account unavailable" });
      }

      const otpMatch = await bcrypt.compare(otp, challenge.otpHash);
      if (!otpMatch) {
        return res.status(400).json({ message: "Incorrect reset code" });
      }

      const hashedPassword = await bcrypt.hash(newPassword, 10);
      await storage.updateUser(user.id, { password: hashedPassword });
      await db
        .update(passwordResetChallenges)
        .set({ consumedAt: new Date() })
        .where(eq(passwordResetChallenges.id, challengeId));

      res.json({ message: "Password updated successfully" });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ message: error.errors[0]?.message || "Invalid reset request" });
      }
      console.error("[auth] Password reset verify failed", error);
      res.status(500).json({ message: "Failed to update password" });
    }
  });

  // Logout
  app.post("/api/auth/logout", (req, res) => {
    req.session.destroy((err) => {
      if (err) {
        return res.status(500).json({ message: "Logout failed" });
      }
      res.clearCookie("connect.sid");
      res.json({ message: "Logged out successfully" });
    });
  });

  // Get current user
  app.get("/api/auth/me", async (req, res) => {
    if (!req.session.userId) {
      return res.status(401).json({ message: "Not authenticated" });
    }
    
    const user = await storage.getUser(req.session.userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }
    
    const userResponse = formatUserForResponse(user);
    res.json({ user: userResponse });
  });

  // User Profile Routes
  
  // Get user profile
  app.get("/api/profile", requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId!;
      
      const [profile] = await db
        .select()
        .from(userProfiles)
        .where(eq(userProfiles.userId, userId))
        .limit(1);
      
      if (!profile) {
        return res.json(null);
      }
      
      res.json(profile);
    } catch (error) {
      console.error('[profile] Error fetching profile:', error);
      res.status(500).json({ message: "Failed to fetch profile" });
    }
  });
  
  // Create or update user profile
  app.post("/api/profile", requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId!;
      
      // Validate profile data
      const profileData = insertUserProfileSchema.parse(req.body);
      
      // Check if profile already exists
      const [existingProfile] = await db
        .select()
        .from(userProfiles)
        .where(eq(userProfiles.userId, userId))
        .limit(1);
      
      let profile;
      
      if (existingProfile) {
        // Update existing profile
        [profile] = await db
          .update(userProfiles)
          .set({
            ...profileData,
            updatedAt: new Date(),
          })
          .where(eq(userProfiles.userId, userId))
          .returning();
      } else {
        // Create new profile
        [profile] = await db
          .insert(userProfiles)
          .values({
            ...profileData,
            userId,
          })
          .returning();
      }

      const normalizedEmail =
        typeof profileData.email === "string" && profileData.email.trim().length > 0
          ? profileData.email.trim()
          : null;
      const normalizedAadhaar =
        typeof profileData.aadhaarNumber === "string" && profileData.aadhaarNumber.trim().length > 0
          ? profileData.aadhaarNumber.trim()
          : null;

      await db
        .update(users)
        .set({
          fullName: profileData.fullName,
          mobile: profileData.mobile,
          email: normalizedEmail,
          aadhaarNumber: normalizedAadhaar ?? null,
          district: profileData.district || null,
          updatedAt: new Date(),
        })
        .where(eq(users.id, userId));
      
      res.json({ 
        profile, 
        message: existingProfile ? "Profile updated successfully" : "Profile created successfully" 
      });
    } catch (error) {
      console.error('[profile] Error saving profile:', error);
      if (error instanceof z.ZodError) {
        return res.status(400).json({ 
          message: error.errors[0].message, 
          errors: error.errors 
        });
      }
      res.status(500).json({ message: "Failed to save profile" });
    }
  });

  // Homestay Application Routes
  
  // File Upload - Get presigned upload URL
  app.get("/api/upload-url", requireAuth, async (req, res) => {
    try {
      const fileType = (req.query.fileType as string) || "document";
      const fileName = (req.query.fileName as string) || "";
      const fileSizeRaw = req.query.fileSize as string | undefined;
      const mimeType = (req.query.mimeType as string | undefined) || undefined;
      const categoryHint = req.query.category as string | undefined;
      const policy = await getUploadPolicy();
      const category = resolveUploadCategory(
        categoryHint,
        fileType,
        mimeType || null,
      );
      const categoryPolicy = policy[category];

      const sizeBytes = Number(fileSizeRaw);
      if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
        return res.status(400).json({
          message: "File size is required for validation",
        });
      }

      const maxBytes = categoryPolicy.maxFileSizeMB * BYTES_PER_MB;
      if (sizeBytes > maxBytes) {
        return res.status(400).json({
          message: `File exceeds the ${categoryPolicy.maxFileSizeMB} MB limit`,
        });
      }

      const normalizedMime = normalizeMime(mimeType);
      if (
        categoryPolicy.allowedMimeTypes.length > 0 &&
        normalizedMime &&
        !categoryPolicy.allowedMimeTypes.includes(normalizedMime)
      ) {
        return res.status(400).json({
          message: `Unsupported file type "${normalizedMime}". Allowed types: ${categoryPolicy.allowedMimeTypes.join(", ")}`,
        });
      }

      const extension = getExtension(fileName);
      if (
        categoryPolicy.allowedExtensions.length > 0 &&
        (!extension || !categoryPolicy.allowedExtensions.includes(extension))
      ) {
        return res.status(400).json({
          message: `Unsupported file extension. Allowed extensions: ${categoryPolicy.allowedExtensions.join(", ")}`,
        });
      }

      const objectStorageService = new ObjectStorageService();
      const { uploadUrl, filePath } = await objectStorageService.prepareUpload(fileType);
      res.json({ uploadUrl, filePath });
    } catch (error) {
      console.error("Error getting upload URL:", error);
      res.status(500).json({ message: "Failed to get upload URL" });
    }
  });

  // File View - Get presigned view URL and redirect
  app.get("/api/object-storage/view", requireAuth, async (req, res) => {
    try {
      const filePath = req.query.path as string;
      if (!filePath) {
        return res.status(400).json({ message: "File path is required" });
      }
      
      const mimeOverride =
        typeof req.query.mime === "string" && isValidMimeType(req.query.mime)
          ? req.query.mime
          : undefined;
      const filenameOverride =
        typeof req.query.filename === "string" && req.query.filename.trim().length > 0
          ? sanitizeDownloadFilename(req.query.filename.trim())
          : undefined;

      if (OBJECT_STORAGE_MODE === "local") {
        const localUrl = new URL(`http://placeholder${filePath}`);
        const objectId = localUrl.pathname.split("/").pop();
        if (!objectId) {
          return res.status(400).json({ message: "Invalid file path" });
        }
        const fileTypeParam = localUrl.searchParams.get("type") || "document";
        const safeType = fileTypeParam.replace(/[^a-zA-Z0-9_-]/g, "");
        const diskPath = path.join(LOCAL_OBJECT_DIR, `${safeType}s`, objectId);

        try {
          await fsPromises.access(diskPath, fs.constants.R_OK);
        } catch {
          return res.status(404).json({ message: "File not found" });
        }

        const stream = fs.createReadStream(diskPath);
        stream.on("error", (err) => {
          console.error("[object-storage:view] stream error", err);
          res.destroy(err);
        });

        res.setHeader("Content-Type", mimeOverride || "application/octet-stream");
        res.setHeader(
          "Content-Disposition",
          `inline; filename="${filenameOverride || objectId}"`
        );

        stream.pipe(res);
        return;
      }

      const objectStorageService = new ObjectStorageService();
      const viewURL = await objectStorageService.getViewURL(filePath, {
        mimeType: mimeOverride,
        fileName: filenameOverride,
        forceInline: true,
      });

      // Redirect to the signed URL (GCS / external storage)
      res.redirect(viewURL);
    } catch (error) {
      console.error("Error getting view URL:", error);
      res.status(500).json({ message: "Failed to get view URL" });
    }
  });

  app.get("/api/settings/upload-policy", requireAuth, async (_req, res) => {
    try {
      const policy = await getUploadPolicy();
      res.json(policy);
    } catch (error) {
      console.error("[upload-policy] Failed to fetch policy:", error);
      res.status(500).json({ message: "Failed to fetch upload policy" });
    }
  });

  app.get("/api/settings/category-enforcement", requireAuth, async (_req, res) => {
    try {
      const setting = await getCategoryEnforcementSetting();
      res.json(setting);
    } catch (error) {
      console.error("[category-enforcement] Failed to fetch setting:", error);
      res.status(500).json({ message: "Failed to fetch category enforcement setting" });
    }
  });

  app.get("/api/settings/room-rate-bands", requireAuth, async (_req, res) => {
    try {
      const setting = await getRoomRateBandsSetting();
      res.json(setting);
    } catch (error) {
      console.error("[room-rate-bands] Failed to fetch setting:", error);
      res.status(500).json({ message: "Failed to fetch rate band setting" });
    }
  });

  app.get("/api/settings/room-calc-mode", requireAuth, async (_req, res) => {
    try {
      const setting = await getRoomCalcModeSetting();
      res.json(setting);
    } catch (error) {
      console.error("[room-calc-mode] Failed to fetch setting:", error);
      res.status(500).json({ message: "Failed to fetch room configuration mode" });
    }
  });
  
  // Save application as draft (partial data allowed)
  app.post("/api/applications/draft", requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId!;
      
      // For drafts, accept any partial data - validation is minimal
      const draftSchema = z.object({
        propertyName: z.string().optional(),
        category: z.enum(['diamond', 'gold', 'silver']).optional(),
        address: z.string().optional(),
        district: z.string().optional(),
        pincode: z.string().optional(),
        locationType: z.enum(['mc', 'tcp', 'gp']).optional(),
        telephone: z.string().optional(),
        ownerName: z.string().optional(),
        ownerMobile: z.string().optional(),
        ownerEmail: z.string().optional(),
        ownerAadhaar: z.string().optional(),
        proposedRoomRate: z.coerce.number().optional(),
        singleBedRoomRate: z.coerce.number().optional(),
        doubleBedRoomRate: z.coerce.number().optional(),
        familySuiteRate: z.coerce.number().optional(),
        projectType: z.enum(['new_rooms', 'new_project']).optional(),
        propertyArea: z.coerce.number().optional(),
        singleBedRooms: z.coerce.number().optional(),
        singleBedBeds: z.coerce.number().optional(),
        singleBedRoomSize: z.coerce.number().optional(),
        doubleBedRooms: z.coerce.number().optional(),
        doubleBedBeds: z.coerce.number().optional(),
        doubleBedRoomSize: z.coerce.number().optional(),
        familySuites: z.coerce.number().optional(),
        familySuiteBeds: z.coerce.number().optional(),
        familySuiteSize: z.coerce.number().optional(),
        attachedWashrooms: z.coerce.number().optional(),
        gstin: z.string().optional(),
        distanceAirport: z.coerce.number().optional(),
        distanceRailway: z.coerce.number().optional(),
        distanceCityCenter: z.coerce.number().optional(),
        distanceShopping: z.coerce.number().optional(),
        distanceBusStand: z.coerce.number().optional(),
        lobbyArea: z.coerce.number().optional(),
        diningArea: z.coerce.number().optional(),
        parkingArea: z.string().optional(),
        ecoFriendlyFacilities: z.string().optional(),
        differentlyAbledFacilities: z.string().optional(),
        fireEquipmentDetails: z.string().optional(),
        nearestHospital: z.string().optional(),
        amenities: z.any().optional(),
        // 2025 Fee Structure - handle NaN for incomplete drafts
        baseFee: z.preprocess(preprocessNumericInput, z.coerce.number().optional()),
        totalBeforeDiscounts: z.preprocess(preprocessNumericInput, z.coerce.number().optional()),
        validityDiscount: z.preprocess(preprocessNumericInput, z.coerce.number().optional()),
        femaleOwnerDiscount: z.preprocess(preprocessNumericInput, z.coerce.number().optional()),
        pangiDiscount: z.preprocess(preprocessNumericInput, z.coerce.number().optional()),
        totalDiscount: z.preprocess(preprocessNumericInput, z.coerce.number().optional()),
        totalFee: z.preprocess(preprocessNumericInput, z.coerce.number().optional()),
        // Legacy fields
        perRoomFee: z.preprocess(preprocessNumericInput, z.coerce.number().optional()),
        gstAmount: z.preprocess(preprocessNumericInput, z.coerce.number().optional()),
        // 2025 Fields
        certificateValidityYears: z.coerce.number().optional(),
        isPangiSubDivision: z.boolean().optional(),
        ownerGender: z.enum(['male', 'female', 'other']).optional(),
        latitude: z.string().optional(),
        longitude: z.string().optional(),
        currentPage: z.coerce.number().optional(), // Track which page user was on
        documents: z.array(z.any()).optional(),
      }).passthrough();
      
      // Guardrail: only one active application per owner (HP Tourism Rules 2025)
      const existingApps = await storage.getApplicationsByUser(userId);
      if (existingApps.length > 0) {
        const existing = existingApps[0];
        if (existing.status === "draft") {
          return res.json({
            application: existing,
            message: "Existing draft loaded",
          });
        }
        return res.status(409).json({
          message: "Only one homestay application is permitted per owner account (HP Tourism Rules 2025). Please continue the existing application.",
          existingApplicationId: existing.id,
          status: existing.status,
        });
      }

      const user = await storage.getUser(userId);
      if (!user) {
        return res.status(401).json({ message: "Authentication required" });
      }

      const validatedData = draftSchema.parse(req.body);
      const sanitizedDraft = sanitizeDraftForPersistence(validatedData, user);
      const policy = await getUploadPolicy();
      const draftDocsError = validateDocumentsAgainstPolicy(
        sanitizedDraft.documents as NormalizedDocumentRecord[] | undefined,
        policy,
      );
      if (draftDocsError) {
        return res.status(400).json({ message: draftDocsError });
      }
      
      // Create draft application
      const application = await storage.createApplication({
        ...sanitizedDraft,
        userId,
        status: 'draft', // Explicitly set as draft
      } as any);

      res.json({ 
        application, 
        message: "Draft saved successfully. You can continue editing anytime." 
      });
    } catch (error) {
      console.error("Draft save error:", error);
      res.status(500).json({ message: "Failed to save draft" });
    }
  });

  // Update existing draft
  app.patch("/api/applications/:id/draft", requireAuth, async (req, res) => {
    try {
      const { id } = req.params;
      const userId = req.session.userId!;

      // Check if application exists and belongs to user
      const existing = await storage.getApplication(id);
      if (!existing) {
        return res.status(404).json({ message: "Application not found" });
      }
      if (existing.userId !== userId) {
        return res.status(403).json({ message: "Not authorized to update this application" });
      }
      if (existing.status !== 'draft') {
        return res.status(400).json({ message: "Can only update draft applications" });
      }

      // Same minimal validation as create draft
      const draftSchema = z.object({
        propertyName: z.string().optional(),
        category: z.enum(['diamond', 'gold', 'silver']).optional(),
        address: z.string().optional(),
        district: z.string().optional(),
        pincode: z.string().optional(),
        locationType: z.enum(['mc', 'tcp', 'gp']).optional(),
        telephone: z.string().optional(),
        ownerName: z.string().optional(),
        ownerMobile: z.string().optional(),
        ownerEmail: z.string().optional(),
        ownerAadhaar: z.string().optional(),
        proposedRoomRate: z.coerce.number().optional(),
        singleBedRoomRate: z.coerce.number().optional(),
        doubleBedRoomRate: z.coerce.number().optional(),
        familySuiteRate: z.coerce.number().optional(),
        projectType: z.enum(['new_rooms', 'new_project']).optional(),
        propertyArea: z.coerce.number().optional(),
        singleBedRooms: z.coerce.number().optional(),
        singleBedBeds: z.coerce.number().optional(),
        singleBedRoomSize: z.coerce.number().optional(),
        doubleBedRooms: z.coerce.number().optional(),
        doubleBedBeds: z.coerce.number().optional(),
        doubleBedRoomSize: z.coerce.number().optional(),
        familySuites: z.coerce.number().optional(),
        familySuiteBeds: z.coerce.number().optional(),
        familySuiteSize: z.coerce.number().optional(),
        attachedWashrooms: z.coerce.number().optional(),
        gstin: z.string().optional(),
        distanceAirport: z.coerce.number().optional(),
        distanceRailway: z.coerce.number().optional(),
        distanceCityCenter: z.coerce.number().optional(),
        distanceShopping: z.coerce.number().optional(),
        distanceBusStand: z.coerce.number().optional(),
        lobbyArea: z.coerce.number().optional(),
        diningArea: z.coerce.number().optional(),
        parkingArea: z.string().optional(),
        ecoFriendlyFacilities: z.string().optional(),
        differentlyAbledFacilities: z.string().optional(),
        fireEquipmentDetails: z.string().optional(),
        nearestHospital: z.string().optional(),
        amenities: z.any().optional(),
        // 2025 Fee Structure - handle NaN for incomplete drafts
        baseFee: z.preprocess(preprocessNumericInput, z.coerce.number().optional()),
        totalBeforeDiscounts: z.preprocess(preprocessNumericInput, z.coerce.number().optional()),
        validityDiscount: z.preprocess(preprocessNumericInput, z.coerce.number().optional()),
        femaleOwnerDiscount: z.preprocess(preprocessNumericInput, z.coerce.number().optional()),
        pangiDiscount: z.preprocess(preprocessNumericInput, z.coerce.number().optional()),
        totalDiscount: z.preprocess(preprocessNumericInput, z.coerce.number().optional()),
        totalFee: z.preprocess(preprocessNumericInput, z.coerce.number().optional()),
        // Legacy fields
        perRoomFee: z.preprocess(preprocessNumericInput, z.coerce.number().optional()),
        gstAmount: z.preprocess(preprocessNumericInput, z.coerce.number().optional()),
        // 2025 Fields
        certificateValidityYears: z.coerce.number().optional(),
        isPangiSubDivision: z.boolean().optional(),
        ownerGender: z.enum(['male', 'female', 'other']).optional(),
        latitude: z.string().optional(),
        longitude: z.string().optional(),
        currentPage: z.coerce.number().optional(), // Track which page user was on
        documents: z.array(z.any()).optional(),
      }).passthrough();
      
      const validatedData = draftSchema.parse(req.body);
      const user = await storage.getUser(userId);
      if (!user) {
        return res.status(401).json({ message: "Authentication required" });
      }
      const sanitizedDraft = sanitizeDraftForPersistence(validatedData, user);
      const policy = await getUploadPolicy();
      const draftDocsError = validateDocumentsAgainstPolicy(
        sanitizedDraft.documents as NormalizedDocumentRecord[] | undefined,
        policy,
      );
      if (draftDocsError) {
        return res.status(400).json({ message: draftDocsError });
      }
      
      // Calculate totalRooms if room data exists
      const totalRooms = (sanitizedDraft.singleBedRooms || 0) + 
                        (sanitizedDraft.doubleBedRooms || 0) + 
                        (sanitizedDraft.familySuites || 0);

      // Update draft application
      const updated = await storage.updateApplication(id, {
        ...sanitizedDraft,
        totalRooms: totalRooms || existing.totalRooms,
      } as any);

      res.json({ 
        application: updated, 
        message: "Draft updated successfully" 
      });
    } catch (error) {
      console.error("Draft update error:", error);
      res.status(500).json({ message: "Failed to update draft" });
    }
  });
  
  // Create application (final submission)
  app.post("/api/applications", requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId!;
      
      // Security: Whitelist only owner-submittable fields (ANNEXURE-I compliant)
      // Note: Using default (non-strict) mode to allow form to send extra fields
      // that will be ignored. Only whitelisted fields are extracted below.
      const ownerSubmittableSchema = z.object({
        // Basic property info
        propertyName: z.string(),
        category: z.enum(['diamond', 'gold', 'silver']),
        address: z.string(),
        district: z.string(),
        pincode: z.string(),
        locationType: z.enum(['mc', 'tcp', 'gp']),
        telephone: z.string().optional(),
        block: z.string().optional(),
        blockOther: z.string().optional(),
        gramPanchayat: z.string().optional(),
        gramPanchayatOther: z.string().optional(),
        urbanBody: z.string().optional(),
        urbanBodyOther: z.string().optional(),
        ward: z.string().optional(),
        
        // Owner info
        ownerName: z.string(),
        ownerMobile: z.string(),
        ownerEmail: z.string().optional(),
        ownerAadhaar: z.string(),
        propertyOwnership: z.enum(['owned', 'leased']).optional(),
        
        // Room & category details
        proposedRoomRate: z.coerce.number().min(0),
        singleBedRoomRate: z.coerce.number().min(0).optional(),
        doubleBedRoomRate: z.coerce.number().min(0).optional(),
        familySuiteRate: z.coerce.number().min(0).optional(),
        projectType: z.enum(['new_rooms', 'new_project']),
        propertyArea: z.coerce.number().min(0),
        singleBedRooms: z.coerce.number().min(0).optional(),
        singleBedBeds: z.coerce.number().min(0).optional(),
        singleBedRoomSize: z.coerce.number().min(0).optional(),
        doubleBedRooms: z.coerce.number().min(0).optional(),
        doubleBedBeds: z.coerce.number().min(0).optional(),
        doubleBedRoomSize: z.coerce.number().min(0).optional(),
        familySuites: z.coerce.number().min(0).optional(),
        familySuiteBeds: z.coerce.number().min(0).optional(),
        familySuiteSize: z.coerce.number().min(0).optional(),
        attachedWashrooms: z.coerce.number().min(0),
        gstin: z
          .string()
          .regex(/^[0-9A-Z]{15}$/, "GSTIN must be 15 uppercase alphanumeric characters")
          .optional(),
        
        // Distances (in km)
        distanceAirport: z.coerce.number().optional(),
        distanceRailway: z.coerce.number().optional(),
        distanceCityCenter: z.coerce.number().optional(),
        distanceShopping: z.coerce.number().optional(),
        distanceBusStand: z.coerce.number().optional(),
        
        // Public areas
        lobbyArea: z.coerce.number().optional(),
        diningArea: z.coerce.number().optional(),
        parkingArea: z.string().optional(),
        
        // Additional facilities
        ecoFriendlyFacilities: z.string().optional(),
        differentlyAbledFacilities: z.string().optional(),
        fireEquipmentDetails: z.string().optional(),
        nearestHospital: z.string().optional(),
        
        // Amenities
        amenities: z.any().optional(),
        
        // 2025 Fee Structure
        baseFee: z.coerce.number(),
        totalBeforeDiscounts: z.coerce.number().optional(),
        validityDiscount: z.coerce.number().optional(),
        femaleOwnerDiscount: z.coerce.number().optional(),
        pangiDiscount: z.coerce.number().optional(),
        totalDiscount: z.coerce.number().optional(),
        totalFee: z.coerce.number(),
        // Legacy fields
        perRoomFee: z.coerce.number().optional(),
        gstAmount: z.coerce.number().optional(),
        
        // 2025 Fields
        certificateValidityYears: z.coerce.number().optional(),
        isPangiSubDivision: z.boolean().optional(),
        ownerGender: z.enum(['male', 'female', 'other']).optional(),
        tehsil: z.string().optional().nullable(),
        tehsilOther: z.string().optional(),
        
        // Coordinates (optional)
        latitude: z.string().optional(),
        longitude: z.string().optional(),
        
        // ANNEXURE-II documents with metadata
        documents: z.array(
          z.preprocess(
            (value) => {
              if (!value || typeof value !== 'object') {
                return value;
              }
              const doc = { ...(value as Record<string, unknown>) };
              doc.filePath =
                typeof doc.filePath === 'string' && doc.filePath.length > 0
                  ? doc.filePath
                  : typeof doc.fileUrl === 'string' && doc.fileUrl.length > 0
                    ? doc.fileUrl
                    : typeof doc.url === 'string' && doc.url.length > 0
                      ? doc.url
                      : `missing://${randomUUID()}`;
              doc.documentType =
                typeof doc.documentType === 'string' && doc.documentType.length > 0
                  ? doc.documentType
                  : typeof doc.type === 'string' && doc.type.length > 0
                    ? doc.type
                    : 'supporting_document';
              doc.fileName =
                typeof doc.fileName === 'string' && doc.fileName.length > 0
                  ? doc.fileName
                  : typeof doc.name === 'string' && doc.name.length > 0
                    ? doc.name
                    : `${doc.documentType}.pdf`;
              if (doc.fileSize === undefined && typeof doc.size !== 'undefined') {
                doc.fileSize = doc.size;
              }
              if (typeof doc.fileSize !== 'number' || !Number.isFinite(doc.fileSize)) {
                doc.fileSize = 0;
              }
              doc.mimeType =
                typeof doc.mimeType === 'string' && doc.mimeType.length > 0
                  ? doc.mimeType
                  : typeof doc.type === 'string' && doc.type.length > 0
                    ? doc.type
                    : 'application/octet-stream';
              return doc;
            },
            z.object({
              filePath: z.string().min(1, "Document file path is required"),
              fileName: z.string().min(1, "Document file name is required"),
              fileSize: z.coerce.number().nonnegative().optional(),
              mimeType: z.string().optional(),
              documentType: z.string(),
            })
          )
        ).optional(),
      });
      
      // Validate and extract only whitelisted fields
      const validatedData = ownerSubmittableSchema.parse(req.body);
      
      // Calculate totalRooms from individual room counts
      const totalRooms = (validatedData.singleBedRooms || 0) + 
                        (validatedData.doubleBedRooms || 0) + 
                        (validatedData.familySuites || 0);
      if (totalRooms <= 0) {
        return res.status(400).json({
          message: "Please configure at least one room before submitting the application.",
        });
      }
      const singleBedsPerRoom = validatedData.singleBedBeds ?? ((validatedData.singleBedRooms || 0) > 0 ? 1 : 0);
      const doubleBedsPerRoom = validatedData.doubleBedBeds ?? ((validatedData.doubleBedRooms || 0) > 0 ? 2 : 0);
      const suiteBedsPerRoom = validatedData.familySuiteBeds ?? ((validatedData.familySuites || 0) > 0 ? 4 : 0);
      const totalBeds =
        (validatedData.singleBedRooms || 0) * singleBedsPerRoom +
        (validatedData.doubleBedRooms || 0) * doubleBedsPerRoom +
        (validatedData.familySuites || 0) * suiteBedsPerRoom;
      if (totalRooms > MAX_ROOMS_ALLOWED) {
        return res.status(400).json({
          message: `HP Homestay Rules 2025 permit a maximum of ${MAX_ROOMS_ALLOWED} rooms.`,
        });
      }
      if (totalBeds > MAX_BEDS_ALLOWED) {
        return res.status(400).json({
          message: `Total beds cannot exceed ${MAX_BEDS_ALLOWED} across all room types. Please adjust the bed counts.`,
        });
      }
      if (totalRooms > 0 && (validatedData.attachedWashrooms || 0) < totalRooms) {
        return res.status(400).json({
          message: "Every room must have its own washroom. Increase attached washrooms to at least the total number of rooms.",
        });
      }

      // 2025 Compliance: Validate per-room-type rates (HP Homestay Rules 2025 - Form-A Certificate Requirement)
      // For FINAL SUBMISSION, per-room-type rates are MANDATORY for all room types with count > 0
      // This enforces ANNEXURE-I compliance for new 2025 applications
      if ((validatedData.singleBedRooms || 0) > 0 && !validatedData.singleBedRoomRate) {
        return res.status(400).json({ 
          message: "Per-room-type rates are mandatory. Single bed room rate is required (HP Homestay Rules 2025 - ANNEXURE-I Form-A Certificate Requirement)" 
        });
      }
      if ((validatedData.doubleBedRooms || 0) > 0 && !validatedData.doubleBedRoomRate) {
        return res.status(400).json({ 
          message: "Per-room-type rates are mandatory. Double bed room rate is required (HP Homestay Rules 2025 - ANNEXURE-I Form-A Certificate Requirement)" 
        });
      }
      if ((validatedData.familySuites || 0) > 0 && !validatedData.familySuiteRate) {
        return res.status(400).json({ 
          message: "Per-room-type rates are mandatory. Family suite rate is required (HP Homestay Rules 2025 - ANNEXURE-I Form-A Certificate Requirement)" 
        });
      }

      const roomRateBands = await getRoomRateBandsSetting();
      const highestRoomRate = Math.max(
        validatedData.singleBedRoomRate || 0,
        validatedData.doubleBedRoomRate || 0,
        validatedData.familySuiteRate || 0,
        validatedData.proposedRoomRate || 0,
      );
      const categoryValidation = validateCategorySelection(
        validatedData.category as CategoryType,
        totalRooms,
        highestRoomRate,
        roomRateBands,
      );
      if (!categoryValidation.isValid) {
        return res.status(400).json({
          message:
            categoryValidation.errors[0] ||
            "The selected category does not match the nightly tariffs. Update the rates or choose a higher category.",
        });
      }

      const existingApps = await storage.getApplicationsByUser(userId);
      const existingApp = existingApps[0];

      if (existingApp && existingApp.status !== 'draft') {
        return res.status(409).json({
          message: `You already have an application (${existingApp.applicationNumber}) in status "${existingApp.status}". Amendments are required instead of creating a new application.`,
          existingApplicationId: existingApp.id,
          status: existingApp.status,
        });
      }

      const rawTehsilInput = validatedData.tehsil;
      const rawTehsilOtherInput = validatedData.tehsilOther;
      const {
        tehsil: resolvedTehsilValue,
        tehsilOther: resolvedTehsilOther,
      } = resolveTehsilFields(rawTehsilInput, rawTehsilOtherInput);

      console.log('[applications:create] incoming address', {
        district: validatedData.district,
        tehsil: validatedData.tehsil,
        tehsilOther: validatedData.tehsilOther,
        resolvedTehsilValue,
        resolvedTehsilOther,
        block: validatedData.block,
        gramPanchayat: validatedData.gramPanchayat,
        urbanBody: validatedData.urbanBody,
      });

      console.log('[applications:create] tehsil normalization', {
        district: validatedData.district,
        tehsilValueRaw: typeof rawTehsilInput === 'string' ? rawTehsilInput : null,
        tehsilOtherValueRaw: typeof rawTehsilOtherInput === 'string' ? rawTehsilOtherInput : null,
        resolvedTehsilValue,
        resolvedTehsilOther,
      });

      const applicationPayload: any = removeUndefined({
        propertyName: validatedData.propertyName,
        category: validatedData.category,
        totalRooms,
        address: validatedData.address,
        district: validatedData.district,
        block: validatedData.block || null,
        blockOther: validatedData.blockOther || null,
        gramPanchayat: validatedData.gramPanchayat || null,
        gramPanchayatOther: validatedData.gramPanchayatOther || null,
        urbanBody: validatedData.urbanBody || null,
        urbanBodyOther: validatedData.urbanBodyOther || null,
        ward: validatedData.ward || null,
        pincode: validatedData.pincode,
        locationType: validatedData.locationType,
        telephone: validatedData.telephone || null,
        tehsil: resolvedTehsilValue,
        tehsilOther: resolvedTehsilOther || null,
        ownerName: validatedData.ownerName,
        propertyOwnership: validatedData.propertyOwnership || null,
        ownerMobile: validatedData.ownerMobile,
        ownerEmail: validatedData.ownerEmail || null,
        ownerAadhaar: validatedData.ownerAadhaar,
        proposedRoomRate: validatedData.proposedRoomRate,
        singleBedRoomRate: validatedData.singleBedRoomRate,
        doubleBedRoomRate: validatedData.doubleBedRoomRate,
        familySuiteRate: validatedData.familySuiteRate,
        projectType: validatedData.projectType,
        propertyArea: validatedData.propertyArea,
        singleBedRooms: validatedData.singleBedRooms,
        singleBedBeds: validatedData.singleBedBeds,
        singleBedRoomSize: validatedData.singleBedRoomSize,
        doubleBedRooms: validatedData.doubleBedRooms,
        doubleBedBeds: validatedData.doubleBedBeds,
        doubleBedRoomSize: validatedData.doubleBedRoomSize,
        familySuites: validatedData.familySuites,
        familySuiteBeds: validatedData.familySuiteBeds,
        familySuiteSize: validatedData.familySuiteSize,
        attachedWashrooms: validatedData.attachedWashrooms,
        gstin: validatedData.gstin || null,
        distanceAirport: validatedData.distanceAirport,
        distanceRailway: validatedData.distanceRailway,
        distanceCityCenter: validatedData.distanceCityCenter,
        distanceShopping: validatedData.distanceShopping,
        distanceBusStand: validatedData.distanceBusStand,
        lobbyArea: validatedData.lobbyArea,
        diningArea: validatedData.diningArea,
        parkingArea: validatedData.parkingArea || null,
        ecoFriendlyFacilities: validatedData.ecoFriendlyFacilities || null,
        differentlyAbledFacilities: validatedData.differentlyAbledFacilities || null,
        fireEquipmentDetails: validatedData.fireEquipmentDetails || null,
        nearestHospital: validatedData.nearestHospital || null,
        amenities: validatedData.amenities,
        baseFee: typeof validatedData.baseFee === 'string' ? Number(validatedData.baseFee) : validatedData.baseFee,
        totalBeforeDiscounts: typeof validatedData.totalBeforeDiscounts === 'string' ? Number(validatedData.totalBeforeDiscounts) : validatedData.totalBeforeDiscounts ?? null,
        validityDiscount: typeof validatedData.validityDiscount === 'string' ? Number(validatedData.validityDiscount) : validatedData.validityDiscount ?? null,
        femaleOwnerDiscount: typeof validatedData.femaleOwnerDiscount === 'string' ? Number(validatedData.femaleOwnerDiscount) : validatedData.femaleOwnerDiscount ?? null,
        pangiDiscount: typeof validatedData.pangiDiscount === 'string' ? Number(validatedData.pangiDiscount) : validatedData.pangiDiscount ?? null,
        totalDiscount: typeof validatedData.totalDiscount === 'string' ? Number(validatedData.totalDiscount) : validatedData.totalDiscount ?? null,
        totalFee: typeof validatedData.totalFee === 'string' ? Number(validatedData.totalFee) : validatedData.totalFee,
        perRoomFee: typeof validatedData.perRoomFee === 'string' ? Number(validatedData.perRoomFee) : validatedData.perRoomFee ?? null,
        gstAmount: typeof validatedData.gstAmount === 'string' ? Number(validatedData.gstAmount) : validatedData.gstAmount ?? null,
        certificateValidityYears: validatedData.certificateValidityYears,
        isPangiSubDivision: validatedData.isPangiSubDivision ?? false,
        ownerGender: validatedData.ownerGender || null,
        latitude: validatedData.latitude || null,
        longitude: validatedData.longitude || null,
        userId,
      });

      const normalizedDocuments = normalizeDocumentsForPersistence(validatedData.documents);
      const submissionPolicy = await getUploadPolicy();
      const submissionDocsError = validateDocumentsAgainstPolicy(
        normalizedDocuments as NormalizedDocumentRecord[] | undefined,
        submissionPolicy,
      );
      if (submissionDocsError) {
        return res.status(400).json({ message: submissionDocsError });
      }
      if (normalizedDocuments) {
        applicationPayload.documents = normalizedDocuments;
      }

      let application;
      const submissionMeta = {
        status: 'submitted' as const,
        submittedAt: new Date(),
      };

      if (existingApp) {
        application = await storage.updateApplication(
          existingApp.id,
          removeUndefined({
            ...applicationPayload,
            ...submissionMeta,
          }) as any,
        );

        if (!application) {
          throw new Error("Failed to update existing application");
        }
      } else {
        application = await storage.createApplication(
          {
            ...applicationPayload,
            ...submissionMeta,
          } as any,
          { trusted: true },
        );
      }

      if (normalizedDocuments && normalizedDocuments.length > 0) {
        await storage.deleteDocumentsByApplication(application.id);
        for (const doc of normalizedDocuments) {
          await storage.createDocument({
            applicationId: application.id,
            documentType: doc.documentType,
            fileName: doc.fileName,
            filePath: doc.filePath,
            fileSize: doc.fileSize,
            mimeType: doc.mimeType,
          });
        }
      }
      const ownerForNotification = await storage.getUser(application.userId);
      queueNotification("application_submitted", {
        application,
        owner: ownerForNotification ?? null,
      });
      await logApplicationAction({
        applicationId: application.id,
        actorId: userId,
        action: "owner_submitted",
        previousStatus: existingApp?.status ?? null,
        newStatus: "submitted",
        feedback: existingApp ? "Existing application finalized and submitted." : "New application submitted.",
      });

      res.json({ application });
    } catch (error) {
      if (error instanceof z.ZodError) {
        console.error("Validation error:", error.errors);
        return res.status(400).json({ message: error.errors[0].message });
      }
      console.error("Application creation error:", error);
      res.status(500).json({ message: "Failed to create application" });
    }
  });

  // Get user's applications
  app.get("/api/service-center", requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId!;
      const user = await storage.getUser(userId);
      if (!user) {
        return res.status(401).json({ message: "User not found" });
      }

      if (!['property_owner', 'admin', 'super_admin'].includes(user.role)) {
        return res.status(403).json({ message: "Service Center is currently available for property owners." });
      }

      const baseApplications =
        user.role === 'property_owner'
          ? (await storage.getApplicationsByUser(userId)).filter((app) => app.status === 'approved')
          : (await storage.getAllApplications()).filter((app) => app.status === 'approved');

      const summaries = await Promise.all(baseApplications.map((app) => buildServiceSummary(app)));
      res.json({ applications: summaries });
    } catch (error) {
      console.error("[service-center] Failed to fetch eligibility list", error);
      res.status(500).json({ message: "Failed to load service center data" });
    }
  });

  app.post("/api/service-center", requireAuth, async (req, res) => {
    try {
      const parsed = serviceRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: "Invalid request", errors: parsed.error.flatten() });
      }

      const { baseApplicationId, serviceType, note, roomDelta } = parsed.data;
      const userId = req.session.userId!;
      const user = await storage.getUser(userId);
      if (!user) {
        return res.status(401).json({ message: "User not found" });
      }

      if (user.role !== 'property_owner') {
        return res.status(403).json({ message: "Only property owners can initiate service requests." });
      }

      const baseApplication = await storage.getApplication(baseApplicationId);
      if (!baseApplication || baseApplication.userId !== userId) {
        return res.status(404).json({ message: "Application not found." });
      }

      if (baseApplication.status !== 'approved') {
        return res.status(400).json({ message: "Only approved applications can be renewed or amended." });
      }

      const activeService = await getActiveServiceRequest(baseApplication.id);
      if (activeService) {
        return res.status(409).json({
          message: "Another service request is already in progress for this application.",
          activeRequest: activeService,
        });
      }

      const expiryDate = baseApplication.certificateExpiryDate ? new Date(baseApplication.certificateExpiryDate) : null;
      const renewalWindow = buildRenewalWindow(expiryDate);

      if (serviceType === 'renewal') {
        if (!expiryDate) {
          return res.status(400).json({ message: "This application does not have an active certificate yet." });
        }
        if (!renewalWindow?.inWindow) {
          return res.status(400).json({
            message: "Renewal is allowed only within 90 days of certificate expiry.",
            windowStart: renewalWindow?.windowStart.toISOString(),
            windowEnd: renewalWindow?.windowEnd.toISOString(),
          });
        }
      }

      let targetRooms = extractRoomBreakdown(baseApplication);
      if (serviceType === 'add_rooms' || serviceType === 'delete_rooms') {
        targetRooms = computeRoomAdjustment(baseApplication, serviceType, roomDelta);
      }

      const trimmedNote = typeof note === "string" ? note.trim() : undefined;
      const serviceNotes = trimmedNote && trimmedNote.length > 0 ? trimmedNote : null;

      const serviceContextRaw: ApplicationServiceContext = removeUndefined({
        requestedRooms: {
          single: targetRooms.single,
          double: targetRooms.double,
          family: targetRooms.family,
          total: targetRooms.total,
        },
        requestedRoomDelta: targetRooms.requestedRoomDelta,
        requestedDeletions: targetRooms.requestedDeletions,
        renewalWindow: renewalWindow
          ? {
              start: renewalWindow.windowStart.toISOString(),
              end: renewalWindow.windowEnd.toISOString(),
            }
          : undefined,
        requiresPayment: !['delete_rooms', 'cancel_certificate'].includes(serviceType),
        inheritsCertificateExpiry: expiryDate ? expiryDate.toISOString() : undefined,
        note: serviceNotes ?? undefined,
      }) as ApplicationServiceContext;

      const serviceContext = Object.keys(serviceContextRaw).length > 0 ? serviceContextRaw : null;

      const {
        id: _ignoreId,
        applicationNumber: _ignoreNumber,
        createdAt: _ignoreCreated,
        updatedAt: _ignoreUpdated,
        parentApplicationId: _parentId,
        parentApplicationNumber: _parentNumber,
        parentCertificateNumber: _parentCert,
        inheritedCertificateValidUpto: _inheritValid,
        serviceContext: _previousContext,
        serviceNotes: _previousNotes,
        serviceRequestedAt: _previousRequested,
        certificateNumber: _certificateNumber,
        certificateIssuedDate: _certificateIssued,
        certificateExpiryDate: _certificateExpiry,
        submittedAt: _submitted,
        approvedAt: _approved,
        ...cloneSeed
      } = baseApplication;

      const baseClone = cloneSeed as unknown as InsertHomestayApplication;

      const servicePayload: InsertHomestayApplication = {
        ...baseClone,
        userId: baseApplication.userId,
        status: 'draft',
        currentStage: null,
        currentPage: 1,
        districtOfficerId: null,
        districtReviewDate: null,
        districtNotes: null,
        daId: null,
        daReviewDate: null,
        daForwardedDate: null,
        stateOfficerId: null,
        stateReviewDate: null,
        stateNotes: null,
        dtdoId: null,
        dtdoReviewDate: null,
        dtdoRemarks: null,
        rejectionReason: null,
        clarificationRequested: null,
        siteInspectionScheduledDate: null,
        siteInspectionCompletedDate: null,
        siteInspectionOfficerId: null,
        siteInspectionNotes: null,
        siteInspectionOutcome: null,
        siteInspectionFindings: null,
        certificateNumber: null,
        certificateIssuedDate: null,
        certificateExpiryDate: null,
        submittedAt: null,
        approvedAt: null,
        applicationKind: serviceType,
        parentApplicationId: baseApplication.id,
        parentApplicationNumber: baseApplication.applicationNumber ?? undefined,
        parentCertificateNumber: baseApplication.certificateNumber ?? undefined,
        inheritedCertificateValidUpto: baseApplication.certificateExpiryDate ?? undefined,
        serviceRequestedAt: new Date(),
        serviceNotes: serviceNotes ?? undefined,
        serviceContext: serviceContext ?? undefined,
        totalRooms: targetRooms.total,
        singleBedRooms: targetRooms.single,
        doubleBedRooms: targetRooms.double,
        familySuites: targetRooms.family,
        attachedWashrooms: Math.max(targetRooms.total, toRoomCount(baseApplication.attachedWashrooms)),
      };

      const created = await storage.createApplication(servicePayload);
      const summary = await buildServiceSummary(baseApplication);

      res.status(201).json({
        message: "Service request created.",
        serviceRequest: {
          id: created.id,
          applicationNumber: created.applicationNumber,
          applicationKind: created.applicationKind,
          status: created.status,
        },
        nextUrl: `/applications/new?draft=${created.id}`,
        summary,
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ message: "Invalid request", errors: error.flatten() });
      }
      if (error instanceof Error && error.message.toLowerCase().includes("room")) {
        return res.status(400).json({ message: error.message });
      }
      console.error("[service-center] Failed to create request", error);
      res.status(500).json({ message: "Failed to create service request" });
    }
  });

  app.get("/api/existing-owners/settings", requireAuth, async (_req, res) => {
    try {
      const cutoff = await getExistingOwnerIntakeCutoff();
      res.json({
        minIssueDate: cutoff.toISOString(),
      });
    } catch (error) {
      console.error("[existing-owners] Failed to load intake settings:", error);
      res.status(500).json({ message: "Unable to load onboarding settings" });
    }
  });

  app.get("/api/existing-owners/active", requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId!;
      const application = await findActiveExistingOwnerRequest(userId);
      res.json({
        application,
      });
    } catch (error) {
      console.error("[existing-owners] Failed to load active onboarding request:", error);
      res.status(500).json({ message: "Unable to load active onboarding request" });
    }
  });

  app.post("/api/existing-owners", requireAuth, async (req, res) => {
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
      const applicationNumber = generateLegacyApplicationNumber(payload.district);
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
          district: trimRequiredString(payload.district),
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
        await db.insert(documents).values(certificateDocuments);
      }
      if (identityProofDocuments.length > 0) {
        await db.insert(documents).values(identityProofDocuments);
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
      console.error("[existing-owners] Failed to capture onboarding request:", error);
      if (isPgUniqueViolation(error, "homestay_applications_certificate_number_key")) {
        const certificateNumber =
          typeof req.body?.rcNumber === "string" ? req.body.rcNumber : undefined;
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

  app.get("/api/applications", requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId!;
      const user = await storage.getUser(userId);
      
      let applications: Awaited<ReturnType<typeof storage.getApplicationsByUser>> = [];
      if (user?.role === 'property_owner') {
        applications = await storage.getApplicationsByUser(userId);
      } else if (user?.role === 'district_officer' && user.district) {
        applications = await storage.getApplicationsByDistrict(user.district);
      } else if (user?.role === 'state_officer' || user?.role === 'admin') {
        applications = await storage.getApplicationsByStatus('state_review');
      }

      let latestCorrectionMap: Map<
        string,
        { createdAt: Date | null; feedback: string | null }
      > | null = null;

      if (applications.length > 0) {
        const applicationIds = applications.map((app) => app.id);
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

      const enrichedApplications =
        latestCorrectionMap && latestCorrectionMap.size > 0
          ? applications.map((application) => ({
              ...application,
              latestCorrection: latestCorrectionMap?.get(application.id) ?? null,
            }))
          : applications;
      
      res.json({ applications: enrichedApplications });
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch applications" });
    }
  });

  // Get ALL applications for workflow monitoring (officers only)
  // RBAC: District officers/DA/DTDO see only their district, State officers see all
  app.get("/api/applications/all", requireRole('dealing_assistant', 'district_tourism_officer', 'district_officer', 'state_officer', 'admin'), async (req, res) => {
    try {
      const userId = req.session.userId!;
      const user = await storage.getUser(userId);
      
      if (!user) {
        return res.status(401).json({ message: "User not found" });
      }
      
      let applications: HomestayApplication[] = [];
      
      // District officers, DA, DTDO: Only see applications from their assigned district
      if (user.role === 'district_officer' || user.role === 'dealing_assistant' || user.role === 'district_tourism_officer') {
        if (!user.district) {
          return res.status(400).json({ message: "District role must have an assigned district" });
        }
        // Get all applications in their district (not just pending)
        applications = await db.select().from(homestayApplications)
          .where(eq(homestayApplications.district, user.district))
          .orderBy(desc(homestayApplications.createdAt));
      }
      // State officers and admins: See all applications
      else if (user.role === 'state_officer' || user.role === 'admin') {
        applications = await storage.getAllApplications();
      }
      
      res.json(applications);
    } catch (error) {
      console.error('[workflow-monitoring] Error fetching all applications:', error);
      res.status(500).json({ message: "Failed to fetch applications for monitoring" });
    }
  });

  app.post("/api/applications/search", requireRole('dealing_assistant', 'district_tourism_officer', 'district_officer', 'state_officer', 'admin'), async (req, res) => {
    try {
      const {
        applicationNumber,
        ownerMobile,
        ownerAadhaar,
        month,
        year,
        fromDate,
        toDate,
        status,
        recentLimit,
      } = (req.body ?? {}) as Record<string, string | undefined>;

      const userId = req.session.userId!;
      const user = await storage.getUser(userId);

      if (!user) {
        return res.status(401).json({ message: "User not found" });
      }

      const QUICK_VIEW_LIMITS = new Set([10, 20, 50]);
      let recentLimitValue: number | undefined;
      if (typeof recentLimit === "string" && recentLimit.trim()) {
        const parsed = Number(recentLimit);
        if (Number.isFinite(parsed) && QUICK_VIEW_LIMITS.has(parsed)) {
          recentLimitValue = parsed;
        }
      }

      const searchConditions: any[] = [];

      if (typeof applicationNumber === "string" && applicationNumber.trim()) {
        searchConditions.push(eq(homestayApplications.applicationNumber, applicationNumber.trim()));
      }

      if (typeof ownerMobile === "string" && ownerMobile.trim()) {
        searchConditions.push(eq(homestayApplications.ownerMobile, ownerMobile.trim()));
      }

      if (typeof ownerAadhaar === "string" && ownerAadhaar.trim()) {
        searchConditions.push(eq(homestayApplications.ownerAadhaar, ownerAadhaar.trim()));
      }

      if (typeof status === "string" && status.trim() && status.trim().toLowerCase() !== "all") {
        searchConditions.push(eq(homestayApplications.status, status.trim()));
      }

      let rangeStart: Date | undefined;
      let rangeEnd: Date | undefined;

      if (fromDate || toDate) {
        if (fromDate) {
          const parsed = new Date(fromDate);
          if (!Number.isNaN(parsed.getTime())) {
            rangeStart = parsed;
          }
        }
        if (toDate) {
          const parsed = new Date(toDate);
          if (!Number.isNaN(parsed.getTime())) {
            parsed.setHours(23, 59, 59, 999);
            rangeEnd = parsed;
          }
        }
      } else if (month && year) {
        const monthNum = Number(month);
        const yearNum = Number(year);
        if (
          Number.isInteger(monthNum) &&
          Number.isInteger(yearNum) &&
          monthNum >= 1 &&
          monthNum <= 12
        ) {
          rangeStart = new Date(yearNum, monthNum - 1, 1);
          rangeEnd = new Date(yearNum, monthNum, 0, 23, 59, 59, 999);
        }
      }

      if (rangeStart) {
        searchConditions.push(gte(homestayApplications.createdAt, rangeStart));
      }
      if (rangeEnd) {
        searchConditions.push(lte(homestayApplications.createdAt, rangeEnd));
      }

      if (searchConditions.length === 0 && !recentLimitValue) {
        return res.status(400).json({
          message: "Provide at least one search filter (application number, phone, Aadhaar, date range, or quick view limit).",
        });
      }

      const filters = [...searchConditions];

      if (
        user.role === 'district_officer' ||
        user.role === 'district_tourism_officer' ||
        user.role === 'dealing_assistant'
      ) {
        if (!user.district) {
          return res.status(400).json({ message: "Your profile is missing district information." });
        }
        const districtCondition = buildDistrictWhereClause(homestayApplications.district, user.district);
        filters.push(districtCondition);
      }

      const whereClause =
        filters.length === 1 ? filters[0] : and(...filters);

      const results = await db
        .select()
        .from(homestayApplications)
        .where(whereClause)
        .orderBy(desc(homestayApplications.createdAt))
        .limit(recentLimitValue ?? 200);

      res.json({ results });
    } catch (error) {
      console.error('[application-search] Error searching applications:', error);
      res.status(500).json({ message: "Failed to search applications" });
    }
  });

  // Get single application
  app.get("/api/applications/:id", requireAuth, async (req, res) => {
    try {
      const application = await storage.getApplication(req.params.id);
      if (!application) {
        return res.status(404).json({ message: "Application not found" });
      }
      
      // Check permissions
      const userId = req.session.userId!;
      const currentUser = await storage.getUser(userId);
      if (!currentUser) {
        return res.status(401).json({ message: "User not found" });
      }
      
      if (currentUser.role === 'property_owner' && application.userId !== userId) {
        return res.status(403).json({ message: "Access denied" });
      }
      
      res.json({ application });
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch application" });
    }
  });

  // Update application (for resubmission after corrections)
  app.patch("/api/applications/:id", requireAuth, async (req, res) => {
    try {
      const { id } = req.params;
      const userId = req.session.userId!;
      
      const application = await storage.getApplication(id);
      if (!application) {
        return res.status(404).json({ message: "Application not found" });
      }
      
      // Only property owner can update their own application
      if (application.userId !== userId) {
        return res.status(403).json({ message: "Access denied" });
      }
      
      // Can only update if sent back for corrections or reverted to applicant by DA/DTDO or objections raised post-inspection
      if (
        application.status !== 'sent_back_for_corrections' &&
        application.status !== 'reverted_to_applicant' &&
        application.status !== 'reverted_by_dtdo' &&
        application.status !== 'objection_raised'
      ) {
        return res.status(400).json({ message: "Application can only be updated when sent back for corrections" });
      }
      
      // Comprehensive update schema with proper validation matching insert schema
      // All fields optional since owner may only update specific fields
      const updateSchema = z.object({
        // Property Details
        propertyName: z.string().min(3, "Property name must be at least 3 characters").optional(),
        category: z.enum(['diamond', 'gold', 'silver']).optional(),
        locationType: z.enum(['mc', 'tcp', 'gp']).optional(),
        // totalRooms is derived from room counts, should not be directly updated
        
        // LGD Hierarchical Address
        district: z.string().min(2, "District is required").optional(),
        districtOther: z.string().optional().or(z.literal('')),
        tehsil: z.string().optional(),
        tehsilOther: z.string().optional().or(z.literal('')),
        block: z.string().optional().or(z.literal('')),
        blockOther: z.string().optional().or(z.literal('')),
        gramPanchayat: z.string().optional().or(z.literal('')),
        gramPanchayatOther: z.string().optional().or(z.literal('')),
        urbanBody: z.string().optional().or(z.literal('')),
        urbanBodyOther: z.string().optional().or(z.literal('')),
        ward: z.string().optional().or(z.literal('')),
        
        // Address Details
        address: z.string().min(10, "Address must be at least 10 characters").optional(),
        pincode: z.string().regex(/^[1-9]\d{5}$/, "Invalid pincode").optional(),
        telephone: z.string().optional().or(z.literal('')),
        latitude: z.string().optional().or(z.literal('')),
        longitude: z.string().optional().or(z.literal('')),
        
        // Owner Details
        ownerName: z.string().min(3, "Name must be at least 3 characters").optional(),
        ownerGender: z.enum(['male', 'female', 'other']).optional(),
        ownerMobile: z.string().regex(/^[6-9]\d{9}$/, "Invalid mobile number").optional(),
        ownerEmail: z.string().email("Invalid email").optional().or(z.literal('')),
        ownerAadhaar: z.string().regex(/^\d{12}$/, "Invalid Aadhaar number").optional(),
        propertyOwnership: z.enum(['owned', 'leased']).optional(),
        
        // Room & Category Details
        projectType: z.enum(['new_rooms', 'new_project']).optional(),
        propertyArea: z.coerce.number().min(0, "Property area cannot be negative").optional(),
        
        // Per Room Type Details (2025 Rules)
        singleBedRooms: z.coerce.number().int().min(0).optional(),
        singleBedBeds: z.coerce.number().int().min(0).optional(),
        singleBedRoomSize: z.coerce.number().min(0).optional(),
        singleBedRoomRate: z.coerce.number().min(0, "Rate cannot be negative").optional(),
        doubleBedRooms: z.coerce.number().int().min(0).optional(),
        doubleBedBeds: z.coerce.number().int().min(0).optional(),
        doubleBedRoomSize: z.coerce.number().min(0).optional(),
        doubleBedRoomRate: z.coerce.number().min(0, "Rate cannot be negative").optional(),
        familySuites: z.coerce.number().int().min(0).max(3).optional(),
        familySuiteBeds: z.coerce.number().int().min(0).optional(),
        familySuiteSize: z.coerce.number().min(0).optional(),
        familySuiteRate: z.coerce.number().min(0, "Rate cannot be negative").optional(),
        
        attachedWashrooms: z.coerce.number().int().min(0).optional(),
        gstin: z.string().optional().or(z.literal('')),
        
        // Certificate Validity & Discounts
        certificateValidityYears: z.coerce.number().int().min(1).max(3).optional(),
        isPangiSubDivision: z.boolean().optional(),
        
        // Distances from key locations (in km)
        distanceAirport: z.coerce.number().min(0).optional(),
        distanceRailway: z.coerce.number().min(0).optional(),
        distanceCityCenter: z.coerce.number().min(0).optional(),
        distanceShopping: z.coerce.number().min(0).optional(),
        distanceBusStand: z.coerce.number().min(0).optional(),
        
        // Public Areas (in sq ft)
        lobbyArea: z.coerce.number().min(0).optional(),
        diningArea: z.coerce.number().min(0).optional(),
        parkingArea: z.string().optional().or(z.literal('')),
        
        // Additional Facilities
        ecoFriendlyFacilities: z.string().optional().or(z.literal('')),
        differentlyAbledFacilities: z.string().optional().or(z.literal('')),
        fireEquipmentDetails: z.string().optional().or(z.literal('')),
        nearestHospital: z.string().optional().or(z.literal('')),
        
        // Amenities (validated JSONB structure)
        amenities: z.object({
          ac: z.boolean().optional(),
          wifi: z.boolean().optional(),
          parking: z.boolean().optional(),
          restaurant: z.boolean().optional(),
          hotWater: z.boolean().optional(),
          tv: z.boolean().optional(),
          laundry: z.boolean().optional(),
          roomService: z.boolean().optional(),
          garden: z.boolean().optional(),
          mountainView: z.boolean().optional(),
          petFriendly: z.boolean().optional(),
        }).optional(),
        
        // Rooms (legacy field - use with caution)
        rooms: z.array(z.object({
          roomType: z.string(),
          size: z.coerce.number(),
          count: z.coerce.number(),
        })).optional(),
        
        // Fee Calculation (calculated fields - typically set by server)
        baseFee: z.coerce.number().optional(),
        totalBeforeDiscounts: z.coerce.number().optional(),
        validityDiscount: z.coerce.number().optional(),
        femaleOwnerDiscount: z.coerce.number().optional(),
        pangiDiscount: z.coerce.number().optional(),
        totalDiscount: z.coerce.number().optional(),
        totalFee: z.coerce.number().optional(),
        
        // Legacy fee fields
        perRoomFee: z.coerce.number().optional(),
        gstAmount: z.coerce.number().optional(),
        
        // Documents (validated JSONB structure)
        documents: z.array(z.object({
          id: z.string().optional(),
          name: z.string().optional(),
          type: z.string().optional(),
          url: z.string().optional(),
          fileName: z.string().optional(),
          filePath: z.string().optional(),
          fileUrl: z.string().optional(),
          documentType: z.string().optional(),
          fileSize: z.preprocess((value) => {
            if (typeof value === "string" && value.trim() !== "") {
              const parsed = Number(value);
              return Number.isNaN(parsed) ? value : parsed;
            }
            return value;
          }, z.number().optional()),
          mimeType: z.string().optional(),
          uploadedAt: z.string().optional(),
          required: z.boolean().optional(),
        })).optional(),
        
        // Legacy document URLs (for backward compatibility)
        ownershipProofUrl: z.string().optional(),
        aadhaarCardUrl: z.string().optional(),
        panCardUrl: z.string().optional(),
        gstCertificateUrl: z.string().optional(),
        propertyPhotosUrls: z.array(z.string()).optional(),
      });
      
      const validatedData = updateSchema.parse(req.body);
      
      // Update the application and change status back to submitted
      // NOTE: Clearing clarificationRequested and dtdoRemarks removes officer feedback
      // from the application record. If audit trail is required, consider logging
      // these to an application_actions table before clearing.
      const decimalFields = [
        'propertyArea',
        'singleBedRoomSize',
        'singleBedRoomRate',
        'doubleBedRoomSize',
        'doubleBedRoomRate',
        'familySuiteSize',
        'familySuiteRate',
        'distanceAirport',
        'distanceRailway',
        'distanceCityCenter',
        'distanceShopping',
        'distanceBusStand',
        'lobbyArea',
        'diningArea',
        'averageRoomRate',
        'highestRoomRate',
        'lowestRoomRate',
        'totalBeforeDiscounts',
        'validityDiscount',
        'femaleOwnerDiscount',
        'pangiDiscount',
        'totalDiscount',
        'totalFee',
        'perRoomFee',
        'gstAmount',
      ] as const;

      const normalizedUpdate: Record<string, unknown> = { ...validatedData };
      if (normalizedUpdate.pincode !== undefined) {
        normalizedUpdate.pincode = normalizeStringField(normalizedUpdate.pincode, application.pincode ?? "", 10);
      }
      if (normalizedUpdate.telephone !== undefined) {
        normalizedUpdate.telephone = normalizeStringField(normalizedUpdate.telephone, application.telephone ?? "", 20);
      }
      if (normalizedUpdate.ownerMobile !== undefined) {
        normalizedUpdate.ownerMobile = normalizeStringField(normalizedUpdate.ownerMobile, application.ownerMobile ?? "", 15);
      }
      if (normalizedUpdate.ownerAadhaar !== undefined) {
        normalizedUpdate.ownerAadhaar = normalizeStringField(normalizedUpdate.ownerAadhaar, application.ownerAadhaar ?? "000000000000", 12);
      }
      if (normalizedUpdate.gstin !== undefined) {
        normalizedUpdate.gstin = normalizeStringField(normalizedUpdate.gstin, application.gstin ?? "", 15);
      }

      const resolveFinalNumber = (incoming: unknown, fallback: unknown) => {
        if (incoming === undefined) {
          const fallbackNumber = toNumberFromUnknown(fallback);
          return typeof fallbackNumber === "number" ? fallbackNumber : 0;
        }
        if (typeof incoming === "number") {
          return incoming;
        }
        const coerced = toNumberFromUnknown(incoming);
        return typeof coerced === "number" ? coerced : 0;
      };

      const finalSingleRooms = resolveFinalNumber(normalizedUpdate.singleBedRooms, application.singleBedRooms);
      const finalDoubleRooms = resolveFinalNumber(normalizedUpdate.doubleBedRooms, application.doubleBedRooms);
      const finalSuiteRooms = resolveFinalNumber(normalizedUpdate.familySuites, application.familySuites);
      const finalSingleRate = resolveFinalNumber(normalizedUpdate.singleBedRoomRate, application.singleBedRoomRate);
      const finalDoubleRate = resolveFinalNumber(normalizedUpdate.doubleBedRoomRate, application.doubleBedRoomRate);
      const finalSuiteRate = resolveFinalNumber(normalizedUpdate.familySuiteRate, application.familySuiteRate);

      if (finalSingleRooms > 0 && finalSingleRate < 100) {
        return res.status(400).json({ message: "Single bed room rate must be at least ₹100 when single rooms are configured." });
      }
      if (finalDoubleRooms > 0 && finalDoubleRate < 100) {
        return res.status(400).json({ message: "Double bed room rate must be at least ₹100 when double rooms are configured." });
      }
      if (finalSuiteRooms > 0 && finalSuiteRate < 100) {
        return res.status(400).json({ message: "Family suite rate must be at least ₹100 when suites are configured." });
      }
      const normalizedDocuments = normalizeDocumentsForPersistence(validatedData.documents);
      const updatePolicy = await getUploadPolicy();
      const updateDocsError = validateDocumentsAgainstPolicy(
        normalizedDocuments as NormalizedDocumentRecord[] | undefined,
        updatePolicy,
      );
      if (updateDocsError) {
        return res.status(400).json({ message: updateDocsError });
      }
      if (normalizedDocuments) {
        normalizedUpdate.documents = normalizedDocuments;
      }
      if (
        Object.prototype.hasOwnProperty.call(normalizedUpdate, "tehsil") ||
        Object.prototype.hasOwnProperty.call(normalizedUpdate, "tehsilOther")
      ) {
        const { tehsil, tehsilOther } = resolveTehsilFields(
          normalizedUpdate.tehsil,
          normalizedUpdate.tehsilOther,
        );
        normalizedUpdate.tehsil = tehsil;
        if (
          Object.prototype.hasOwnProperty.call(normalizedUpdate, "tehsilOther")
        ) {
          normalizedUpdate.tehsilOther = tehsilOther;
        }
      }
      for (const field of decimalFields) {
        const value = normalizedUpdate[field as keyof typeof normalizedUpdate];
        if (typeof value === 'number') {
          normalizedUpdate[field as string] = value.toString();
        }
      }

      // Keep totalRooms in sync whenever room counts change during corrections
      const singleRooms =
        typeof normalizedUpdate.singleBedRooms === "number"
          ? normalizedUpdate.singleBedRooms
          : application.singleBedRooms ?? 0;
      const doubleRooms =
        typeof normalizedUpdate.doubleBedRooms === "number"
          ? normalizedUpdate.doubleBedRooms
          : application.doubleBedRooms ?? 0;
      const familySuites =
        typeof normalizedUpdate.familySuites === "number"
          ? normalizedUpdate.familySuites
          : application.familySuites ?? 0;
      const singleBeds =
        typeof normalizedUpdate.singleBedBeds === "number"
          ? normalizedUpdate.singleBedBeds
          : application.singleBedBeds ?? ((singleRooms || 0) > 0 ? 1 : 0);
      const doubleBeds =
        typeof normalizedUpdate.doubleBedBeds === "number"
          ? normalizedUpdate.doubleBedBeds
          : application.doubleBedBeds ?? ((doubleRooms || 0) > 0 ? 2 : 0);
      const suiteBeds =
        typeof normalizedUpdate.familySuiteBeds === "number"
          ? normalizedUpdate.familySuiteBeds
          : application.familySuiteBeds ?? ((familySuites || 0) > 0 ? 4 : 0);
      const totalRooms = Number(singleRooms || 0) + Number(doubleRooms || 0) + Number(familySuites || 0);
      const totalBeds =
        Number(singleRooms || 0) * Number(singleBeds || 0) +
        Number(doubleRooms || 0) * Number(doubleBeds || 0) +
        Number(familySuites || 0) * Number(suiteBeds || 0);
      if (totalRooms > MAX_ROOMS_ALLOWED) {
        return res.status(400).json({
          message: `HP Homestay Rules 2025 permit a maximum of ${MAX_ROOMS_ALLOWED} rooms.`,
        });
      }
      if (totalBeds > MAX_BEDS_ALLOWED) {
        return res.status(400).json({
          message: `Total beds cannot exceed ${MAX_BEDS_ALLOWED} across all room types.`,
        });
      }
      const updatedAttachedWashrooms =
        typeof normalizedUpdate.attachedWashrooms === "number"
          ? normalizedUpdate.attachedWashrooms
          : application.attachedWashrooms ?? 0;
      if (totalRooms > 0 && Number(updatedAttachedWashrooms || 0) < totalRooms) {
        return res.status(400).json({
          message: "Every room must have its own washroom. Increase attached washrooms to at least the total number of rooms.",
        });
      }
      normalizedUpdate.totalRooms = totalRooms;

      const nextCorrectionCount = (application.correctionSubmissionCount ?? 0) + 1;

      const updatedApplication = await storage.updateApplication(id, {
        ...normalizedUpdate,
        status: 'submitted',
        submittedAt: new Date(),
        clarificationRequested: null, // Clear DA feedback after resubmission
        dtdoRemarks: null, // Clear DTDO feedback after resubmission
        districtNotes: null,
        correctionSubmissionCount: nextCorrectionCount,
      } as Partial<HomestayApplication>);

      await logApplicationAction({
        applicationId: id,
        actorId: userId,
        action: "correction_resubmitted",
        previousStatus: application.status,
        newStatus: "submitted",
        feedback: `${CORRECTION_CONSENT_TEXT} (cycle ${nextCorrectionCount})`,
      });

      if (normalizedDocuments) {
        await storage.deleteDocumentsByApplication(id);
        for (const doc of normalizedDocuments) {
          await storage.createDocument({
            applicationId: id,
            documentType: doc.documentType,
            fileName: doc.fileName,
            filePath: doc.filePath,
            fileSize: doc.fileSize,
            mimeType: doc.mimeType,
          });
        }
      }
      
      res.json({ application: updatedApplication });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ message: error.errors[0].message });
      }
      console.error("Error updating application:", error);
      res.status(500).json({ message: "Failed to update application" });
    }
  });

  // Review application (approve/reject)
  app.post("/api/applications/:id/review", requireAuth, async (req, res) => {
    try {
      const { id } = req.params;
      const { action, comments } = req.body;

      if (!action || !["approve", "reject"].includes(action)) {
        return res.status(400).json({ message: "Invalid action. Must be 'approve' or 'reject'" });
      }

      const user = await storage.getUser(req.session.userId!);
      if (!user) {
        return res.status(401).json({ message: "Unauthorized" });
      }

      // Only officers can review applications
      if (user.role !== "district_officer" && user.role !== "state_officer") {
        return res.status(403).json({ message: "Only officers can review applications" });
      }

      const application = await storage.getApplication(id);
      if (!application) {
        return res.status(404).json({ message: "Application not found" });
      }

      // District officers can only review applications in their district
      if (user.role === "district_officer" && !districtsMatch(user.district, application.district)) {
        return res.status(403).json({ message: "You can only review applications in your district" });
      }

      // Validate application is in correct status for this officer role
      if (user.role === "district_officer" && application.status !== "pending") {
        return res.status(400).json({ message: "This application is not in pending status and cannot be reviewed by district officer" });
      }
      
      if (user.role === "state_officer" && application.status !== "state_review") {
        return res.status(400).json({ message: "This application is not in state review status and cannot be reviewed by state officer" });
      }

      // Prepare update based on officer role and action
      const updateData: Partial<HomestayApplication> = {};

      if (user.role === "district_officer") {
        updateData.districtOfficerId = user.id;
        updateData.districtReviewDate = new Date();
        updateData.districtNotes = comments || null;
        
        if (action === "approve") {
          // District approval moves to state review
          updateData.status = "state_review";
          updateData.currentStage = "state";
        } else {
          // District rejection is final
          updateData.status = "rejected";
          updateData.rejectionReason = comments || "Rejected at district level";
        }
      } else if (user.role === "state_officer") {
        updateData.stateOfficerId = user.id;
        updateData.stateReviewDate = new Date();
        updateData.stateNotes = comments || null;
        
        if (action === "approve") {
          // State approval is final approval
          updateData.status = "approved";
          updateData.approvedAt = new Date();
          updateData.currentStage = "final";
        } else {
          // State rejection is final
          updateData.status = "rejected";
          updateData.rejectionReason = comments || "Rejected at state level";
        }
      }

      const updated = await storage.updateApplication(id, updateData);
      res.json({ application: updated });
    } catch (error) {
      res.status(500).json({ message: "Failed to review application" });
    }
  });

  // Officer Actions - Send Back for Corrections
  app.post("/api/applications/:id/send-back", requireRole('district_officer', 'state_officer'), async (req, res) => {
    try {
      const { id } = req.params;
      const { feedback, issuesFound } = req.body;

      if (!feedback || feedback.trim().length < 10) {
        return res.status(400).json({ message: "Feedback is required (minimum 10 characters)" });
      }

      const user = await storage.getUser(req.session.userId!);
      if (!user || (user.role !== "district_officer" && user.role !== "state_officer")) {
        return res.status(403).json({ message: "Only officers can send back applications" });
      }

      const application = await storage.getApplication(id);
      if (!application) {
        return res.status(404).json({ message: "Application not found" });
      }

      // Update application status
      const updated = await storage.updateApplication(id, {
        status: 'sent_back_for_corrections',
        clarificationRequested: feedback,
      });

      res.json({ application: updated, message: "Application sent back to applicant" });
    } catch (error) {
      console.error("Send back error:", error);
      res.status(500).json({ message: "Failed to send back application" });
    }
  });

  // Officer Actions - Move to Site Inspection
  app.post("/api/applications/:id/move-to-inspection", requireRole('district_officer', 'state_officer'), async (req, res) => {
    try {
      const { id } = req.params;
      const { scheduledDate, notes } = req.body;

      const user = await storage.getUser(req.session.userId!);
      if (!user || (user.role !== "district_officer" && user.role !== "state_officer")) {
        return res.status(403).json({ message: "Only officers can schedule inspections" });
      }

      const application = await storage.getApplication(id);
      if (!application) {
        return res.status(404).json({ message: "Application not found" });
      }

      // Update application
      const updated = await storage.updateApplication(id, {
        status: 'site_inspection_scheduled',
        currentStage: 'site_inspection',
        siteInspectionScheduledDate: scheduledDate ? new Date(scheduledDate) : new Date(),
        siteInspectionOfficerId: user.id,
        siteInspectionNotes: notes,
      });
      await logApplicationAction({
        applicationId: id,
        actorId: user.id,
        action: "inspection_scheduled",
        previousStatus: application.status,
        newStatus: "site_inspection_scheduled",
        feedback: notes || undefined,
      });

      const inspectionOwner = await storage.getUser(application.userId);
      const inspectionDate = scheduledDate
        ? format(new Date(scheduledDate), "dd MMM yyyy")
        : updated?.siteInspectionScheduledDate
          ? format(new Date(updated.siteInspectionScheduledDate), "dd MMM yyyy")
          : "";
      queueNotification("inspection_scheduled", {
        application: updated,
        owner: inspectionOwner ?? null,
        extras: {
          INSPECTION_DATE: inspectionDate,
        },
      });

      res.json({ application: updated, message: "Site inspection scheduled" });
    } catch (error) {
      console.error("Move to inspection error:", error);
      res.status(500).json({ message: "Failed to schedule inspection" });
    }
  });

  // Officer Actions - Mark Inspection Complete with Outcome
  app.post("/api/applications/:id/complete-inspection", requireRole('district_officer', 'state_officer'), async (req, res) => {
    try {
      const { id } = req.params;
      const { outcome, findings, notes } = req.body;

      const user = await storage.getUser(req.session.userId!);
      if (!user || (user.role !== "district_officer" && user.role !== "state_officer")) {
        return res.status(403).json({ message: "Only officers can complete inspections" });
      }

      const application = await storage.getApplication(id);
      if (!application) {
        return res.status(404).json({ message: "Application not found" });
      }

      // Validate outcome
      if (!['approved', 'corrections_needed', 'rejected'].includes(outcome)) {
        return res.status(400).json({ message: "Invalid inspection outcome" });
      }

      // Validate that issuesFound is provided for corrections_needed or rejected outcomes
      if ((outcome === 'corrections_needed' || outcome === 'rejected') && 
          !findings?.issuesFound && !notes) {
        return res.status(400).json({ 
          message: "Issues description is required when sending back for corrections or rejecting an application" 
        });
      }

      // Determine next status based on outcome
      let newStatus;
      let clarificationRequested = null;
      
      switch (outcome) {
        case 'approved':
          newStatus = 'payment_pending';
          break;
        case 'corrections_needed':
          newStatus = 'sent_back_for_corrections';
          clarificationRequested = findings?.issuesFound || notes || 'Site inspection found issues that need correction';
          break;
        case 'rejected':
          newStatus = 'rejected';
          break;
        default:
          newStatus = 'inspection_completed';
      }

      // Update application with inspection results and outcome
      const updateData: any = {
        status: newStatus,
        siteInspectionCompletedDate: new Date(),
        siteInspectionOutcome: outcome,
        siteInspectionFindings: findings || {},
        siteInspectionNotes: notes,
      };

      // Add rejection reason or clarification if applicable
      if (outcome === 'rejected') {
        updateData.rejectionReason = findings?.issuesFound || notes || 'Application rejected after site inspection';
      } else if (outcome === 'corrections_needed') {
        updateData.clarificationRequested = clarificationRequested;
      }

      const updated = await storage.updateApplication(id, updateData);
      await logApplicationAction({
        applicationId: id,
        actorId: user.id,
        action: "inspection_completed",
        previousStatus: application.status,
        newStatus: newStatus,
        feedback: notes || clarificationRequested || null,
      });

      res.json({ application: updated, message: "Inspection completed successfully" });
    } catch (error) {
      console.error("Complete inspection error:", error);
      res.status(500).json({ message: "Failed to complete inspection" });
    }
  });

  app.get("/api/applications/:id/timeline", requireAuth, async (req, res) => {
    try {
      const application = await storage.getApplication(req.params.id);
      if (!application) {
        return res.status(404).json({ message: "Application not found" });
      }

      const viewer = await storage.getUser(req.session.userId!);
      if (!canViewApplicationTimeline(viewer ?? null, application)) {
        return res.status(403).json({ message: "You are not allowed to view this timeline" });
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
      console.error("[timeline] Failed to fetch timeline:", error);
      res.status(500).json({ message: "Failed to fetch timeline" });
    }
  });

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
      console.error("[dtdo timeline] Failed to fetch timeline:", error);
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
      console.error("[inspection] Failed to fetch inspection report:", error);
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
      console.error("[staff-profile] Failed to update profile:", error);
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
      console.error("[staff-profile] Failed to change password:", error);
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
      console.error("[da] Failed to fetch applications:", error);
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
      console.error("[da] Failed to fetch application details:", error);
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
      console.error("[da] Failed to start scrutiny:", error);
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
      console.error("[da] Failed to save scrutiny progress:", error);
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
      console.error("[da] Failed to forward to DTDO:", error);
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
      console.error("[da] Failed to send back application:", error);
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
        console.error("[legacy] Failed to verify application:", error);
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
        console.error("[legacy] Failed to load settings", error);
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
      console.error("[dtdo] Failed to fetch applications:", error);
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
      console.error("[dtdo] Failed to fetch application details:", error);
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
      console.error("[dtdo] Failed to accept application:", error);
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
      console.error("[dtdo] Failed to reject application:", error);
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
      console.error("[dtdo] Failed to revert application:", error);
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

      console.log("[dtdo] available-das", {
        officer: user.username,
        district: user.district,
        manifestMatches: manifestEntries.map((entry) => entry.da.username),
        options: das.map((da) => ({ id: da.id, fullName: da.fullName, mobile: da.mobile })),
      });

      res.json({ das });
    } catch (error) {
      console.error("[dtdo] Failed to fetch DAs:", error);
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
      console.log("[dtdo] inspection scheduled", {
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
      console.error("[dtdo] Failed to schedule inspection:", error);
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
      console.error("[owner] Failed to fetch inspection schedule:", error);
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
      console.error("[owner] Failed to acknowledge inspection schedule:", error);
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
      console.error("[dtdo] Failed to fetch inspection report:", error);
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
      console.error("[dtdo] Failed to approve inspection report:", error);
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
      console.error("[dtdo] Failed to reject inspection report:", error);
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
      console.error("[dtdo] Failed to raise objections:", error);
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
      console.log("[da] inspections query", {
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
      console.error("[da] Failed to fetch inspections:", error);
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
      console.error("[da] Failed to fetch inspection details:", error);
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

      await storage.updateApplication(order[0].applicationId, {
        status: "inspection_under_review",
        currentStage: "inspection_completed",
        siteInspectionNotes: reportData.detailedFindings || null,
        siteInspectionOutcome,
        siteInspectionCompletedDate: new Date(),
        inspectionReportId: newReport.id,
        clarificationRequested: null,
        rejectionReason: null,
      });

      await logApplicationAction({
        applicationId: order[0].applicationId,
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
      console.error("[da] Failed to submit inspection report:", error);
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
      
      await storage.updateApplication(payment.applicationId, {
        status: "approved",
        certificateNumber,
        certificateIssuedDate: new Date(),
        certificateExpiryDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000), // 1 year from now
        approvedAt: new Date(),
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
        feedback: `Certificate number ${certificateNumber} issued.`,
      });

      res.json({ 
        message: "Payment confirmed and certificate issued",
        certificateNumber,
        applicationId: payment.applicationId
      });
    } catch (error) {
      console.error('Payment confirmation error:', error);
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
      console.error('Pending payments fetch error:', error);
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
      console.error('Production stats error:', error);
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
      console.error('Analytics error:', error);
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
      console.error("Seed error:", error);
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
  app.get("/api/admin/users", requireRole('admin'), async (req, res) => {
    try {
      const users = await storage.getAllUsers();
      res.json({ users });
    } catch (error) {
      console.error("Failed to fetch users:", error);
      res.status(500).json({ message: "Failed to fetch users" });
    }
  });

  // Update user (admin only)
  app.patch("/api/admin/users/:id", requireRole('admin'), async (req, res) => {
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
      console.error("Failed to update user:", error);
      res.status(500).json({ message: "Failed to update user" });
    }
  });

  // Toggle user status (admin only)
  app.patch("/api/admin/users/:id/status", requireRole('admin'), async (req, res) => {
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
      console.error("Failed to update user status:", error);
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

      console.log(`[admin] Created new user: ${userData.fullName} (${role}) - ${mobile}`);

      res.json({ 
        user: newUser,
        message: "User created successfully" 
      });
    } catch (error) {
      console.error("Failed to create user:", error);
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
      console.error("[admin-rc] Failed to fetch legacy applications:", error);
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
      console.error("[admin-rc] Failed to fetch application:", error);
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
      console.error("[admin-rc] Failed to update legacy application:", error);
      res.status(500).json({ message: "Failed to update legacy application" });
    }
  });

  // RESET DATABASE - Clear all test data (admin only)
  app.post("/api/admin/reset-db", requireRole('admin'), async (req, res) => {
    try {
      const { 
        preserveDdoCodes = false,
        preservePropertyOwners = false,
        preserveDistrictOfficers = false,
        preserveStateOfficers = false,
        preserveLgdData = false
      } = req.body;
      console.log("[admin] Starting database reset...", { 
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
          console.log(`[admin] ✓ Deleted all ${tableName}`);
        } catch (error: any) {
          if (error.code === '42P01') { // Table doesn't exist
            console.log(`[admin] ⊙ Skipped ${tableName} (table doesn't exist yet)`);
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
        console.log(`[admin] ✓ Deleted all DDO codes`);
      } else {
        console.log(`[admin] ⊙ Preserved DDO codes (configuration data)`);
      }
      
      // 15b. System Settings (always preserved - configuration data)
      console.log(`[admin] ⊙ Preserved system settings (configuration data)`);
      
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
        console.log(`[admin] ✓ Deleted all LGD master data`);
      } else {
        console.log(`[admin] ⊙ Preserved LGD master data (configuration data)`);
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
      
      console.log(`[admin] Roles to preserve:`, rolesToPreserve);
      
      // Delete user profiles for users whose roles are NOT in rolesToPreserve
      // Use a subquery to delete profiles based on user role
      const deletedProfiles = await db.delete(userProfiles)
        .where(
          sql`${userProfiles.userId} IN (SELECT id FROM ${users} WHERE ${notInArray(users.role, rolesToPreserve)})`
        )
        .returning();
      
      console.log(`[admin] ✓ Deleted ${deletedProfiles.length} user profiles for non-preserved roles`);
      
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
      
      console.log(`[admin] ✓ Deleted ${deletedUsers.length} users (preserved ${preservedUsers.length} accounts)`);
      
      // TODO: Delete uploaded files from object storage
      // This would require listing and deleting files from GCS bucket
      // For now, we'll just clear database records
      
      console.log("[admin] ✅ Database reset complete");
      
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
      console.error("[admin] ❌ Database reset failed:", error);
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
      console.error("[admin] Failed to fetch dashboard stats:", error);
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
      console.error("[admin] Failed to fetch stats:", error);
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
      console.error('[admin] Failed to fetch super console setting:', error);
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

        console.log(`[admin] Super console override ${enabled ? 'enabled' : 'disabled'}`);
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

        console.log(`[admin] Super console override ${enabled ? 'enabled' : 'disabled'}`);
        res.json(created);
      }
    } catch (error) {
      console.error('[admin] Failed to toggle super console:', error);
      res.status(500).json({ message: 'Failed to toggle super console' });
    }
  });

  // ========================================
  // SYSTEM SETTINGS ROUTES (Admin/Super Admin)
  // ========================================

  // Get a specific system setting by key
  app.get("/api/admin/settings/:key", requireRole('admin'), async (req, res) => {
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
      console.error("[admin] Failed to fetch setting:", error);
      res.status(500).json({ message: "Failed to fetch setting" });
    }
  });

  // Update or create a system setting
  app.put("/api/admin/settings/:key", requireRole('admin'), async (req, res) => {
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
        
        console.log(`[admin] Updated setting: ${key}`);
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
        
        console.log(`[admin] Created setting: ${key}`);
        res.json(created);
      }
    } catch (error) {
      console.error("[admin] Failed to update setting:", error);
      res.status(500).json({ message: "Failed to update setting" });
    }
  });

  // Get test payment mode status (specific endpoint for convenience)
  app.get("/api/admin/settings/payment/test-mode", requireRole('admin'), async (req, res) => {
    try {
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
      console.error("[admin] Failed to fetch test payment mode:", error);
      res.status(500).json({ message: "Failed to fetch test payment mode" });
    }
  });

  // Toggle test payment mode
  app.post("/api/admin/settings/payment/test-mode/toggle", requireRole('admin'), async (req, res) => {
    try {
      const { enabled } = req.body;
      const userId = req.session.userId || null;
      
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
        
        console.log(`[admin] Test payment mode ${enabled ? 'enabled' : 'disabled'}`);
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
        
        console.log(`[admin] Test payment mode ${enabled ? 'enabled' : 'disabled'}`);
        res.json(created);
      }
    } catch (error) {
      console.error("[admin] Failed to toggle test payment mode:", error);
      res.status(500).json({ message: "Failed to toggle test payment mode" });
    }
  });

  // Captcha settings
  app.get("/api/admin/settings/auth/captcha", requireRole('admin'), async (_req, res) => {
    try {
      const enabled = await getCaptchaSetting();
      res.json({ enabled });
    } catch (error) {
      console.error("[admin] Failed to fetch captcha setting:", error);
      res.status(500).json({ message: "Failed to fetch captcha setting" });
    }
  });

  app.post("/api/admin/settings/auth/captcha/toggle", requireRole('admin'), async (req, res) => {
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
      console.log(`[admin] Captcha requirement ${enabled ? "enabled" : "disabled"}`);
      res.json({ enabled });
    } catch (error) {
      console.error("[admin] Failed to toggle captcha setting:", error);
      res.status(500).json({ message: "Failed to update captcha setting" });
    }
  });

  // Communications settings
  app.get("/api/admin/communications", requireRole('admin', 'super_admin'), async (_req, res) => {
    try {
      const emailRecord = await getSystemSettingRecord(EMAIL_GATEWAY_SETTING_KEY);
      const smsRecord = await getSystemSettingRecord(SMS_GATEWAY_SETTING_KEY);
      const emailSettings = formatGatewaySetting(emailRecord, sanitizeEmailGateway);
      const smsSettings = formatGatewaySetting(smsRecord, sanitizeSmsGateway);
      console.log("[comm-settings] sms provider:", smsSettings?.provider, {
        nic: smsSettings?.nic ? { passwordSet: smsSettings.nic.passwordSet } : null,
        twilio: smsSettings?.twilio ? { authTokenSet: smsSettings.twilio.authTokenSet } : null,
      });
      res.json({
        email: emailSettings,
        sms: smsSettings,
      });
    } catch (error) {
      console.error("[admin] Failed to fetch communications settings:", error);
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

      console.log("[admin] Updated SMTP gateway settings");
      res.json({ success: true });
    } catch (error) {
      console.error("[admin] Failed to update SMTP config:", error);
      res.status(500).json({ message: "Failed to update SMTP settings" });
    }
  });

  app.put("/api/admin/communications/sms", requireRole('admin', 'super_admin'), async (req, res) => {
    try {
      const providerInput = req.body?.provider === "twilio" ? "twilio" : "nic";
      const userId = req.session.userId || null;
      const existing = await getSystemSettingRecord(SMS_GATEWAY_SETTING_KEY);
      const existingValue: SmsGatewaySettingValue = (existing?.settingValue as SmsGatewaySettingValue) ?? {};

      const nicPayload = req.body?.nic ?? req.body;
      const twilioPayload = req.body?.twilio ?? req.body;

      const nextValue: SmsGatewaySettingValue = {
        provider: providerInput,
        nic: existingValue.nic,
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

        const twilioConfig: TwilioSmsGatewaySettings = {
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

      console.log("[admin] Updated SMS gateway settings");
      res.json({ success: true });
    } catch (error) {
      console.error("[admin] Failed to update SMS config:", error);
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
      console.error("[admin] SMTP test failed:", error);
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
      console.log("[sms-test] provider:", provider);

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
          } as TwilioSmsGatewaySettings);

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
      console.error("[admin] SMS test failed:", error);
      res.status(500).json({ message: error?.message || "Failed to send test SMS" });
    }
  });

  app.get("/api/admin/notifications", requireRole('admin', 'super_admin'), async (_req, res) => {
    try {
      const record = await getSystemSettingRecord(NOTIFICATION_RULES_SETTING_KEY);
      const payload = buildNotificationResponse(record);
      res.json(payload);
    } catch (error) {
      console.error("[admin] Failed to load notification rules:", error);
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
      console.error("[admin] Failed to save notification rules:", error);
      res.status(500).json({ message: "Failed to save notification settings" });
    }
  });

  // ========================================
  // DATABASE CONSOLE ROUTES (Admin/Super Admin)
  // ========================================

  // Execute SQL query (for development/testing)
  app.post("/api/admin/db-console/execute", requireRole('admin'), async (req, res) => {
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

      console.log(`[db-console] Executing ${isReadOnly ? 'READ' : 'WRITE'} query:`, sqlQuery.substring(0, 100));

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

      console.log(`[db-console] Query returned ${rows.length} row(s)`);
      res.json(response);
    } catch (error) {
      console.error("[db-console] Query execution failed:", error);
      res.status(500).json({ 
        success: false,
        message: "Query execution failed",
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  // Get list of all tables
  app.get("/api/admin/db-console/tables", requireRole('admin'), async (req, res) => {
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
      console.error("[db-console] Failed to fetch tables:", error);
      res.status(500).json({ message: "Failed to fetch tables" });
    }
  });

  // Get table schema/structure
  app.get("/api/admin/db-console/table/:tableName/schema", requireRole('admin'), async (req, res) => {
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
      console.error("[db-console] Failed to fetch table schema:", error);
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

      console.log(`[super-admin] Reset operation: ${operation}, reason: ${reason}`);

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
      console.error("[super-admin] Reset failed:", error);
      res.status(500).json({ message: "Reset operation failed" });
    }
  });

  // Seed test data
  app.post("/api/admin/seed/:type", requireRole('super_admin'), async (req, res) => {
    try {
      const { type } = req.params;
      const { count = 10, scenario } = req.body;

      console.log(`[super-admin] Seeding data: ${type}, count: ${count}, scenario: ${scenario}`);

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
      console.error("[super-admin] Seed failed:", error);
      res.status(500).json({ message: "Failed to generate test data" });
    }
  });

  // LGD Master Data Import Endpoint
  app.post("/api/admin/lgd/import", requireRole('admin'), async (req, res) => {
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
            console.warn("[LGD] No districts available; skipping urban body import");
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
      console.error("[admin] LGD import failed:", error);
      res.status(500).json({ message: "Failed to import LGD data", error: String(error) });
    }
  });

  // HimKosh Payment Gateway Routes
  app.use("/api/himkosh", himkoshRoutes);
  console.log('[himkosh] Payment gateway routes registered');

  // Start production stats scraper (runs on boot and hourly)
  startScraperScheduler();
  console.log('[scraper] Production stats scraper initialized');

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
