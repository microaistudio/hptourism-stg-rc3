import { eq } from "drizzle-orm";
import { db } from "../../db";
import { systemSettings } from "@shared/schema";
import { logger } from "../../logger";

const CAPTCHA_SETTING_KEY = "auth_captcha_enabled";
const CAPTCHA_CACHE_TTL = 5 * 60 * 1000;
const CAPTCHA_FORCE_DISABLE = (() => {
  const raw =
    typeof process.env.CAPTCHA_FORCE_DISABLE === "string"
      ? process.env.CAPTCHA_FORCE_DISABLE.trim().toLowerCase()
      : null;
  if (raw === "true") {
    return true;
  }
  if (raw === "false") {
    return false;
  }
  return process.env.PORT === "4000";
})();

const captchaLog = logger.child({ module: "captcha-settings" });

captchaLog.info("[captcha] configuration", {
  port: process.env.PORT,
  forcedFlag: process.env.CAPTCHA_FORCE_DISABLE,
  computedForceDisable: CAPTCHA_FORCE_DISABLE,
});

const captchaSettingCache: { fetchedAt: number; enabled: boolean } = {
  fetchedAt: 0,
  enabled: true,
};

export const shouldBypassCaptcha = (hostHeader?: string | null): boolean => {
  if (CAPTCHA_FORCE_DISABLE) {
    return true;
  }
  const normalizedHost = (hostHeader || "").toLowerCase();
  return normalizedHost.includes("hptourism.osipl.dev");
};

export const updateCaptchaSettingCache = (enabled: boolean) => {
  captchaSettingCache.enabled = enabled;
  captchaSettingCache.fetchedAt = Date.now();
};

export const getCaptchaSetting = async () => {
  if (CAPTCHA_FORCE_DISABLE) {
    const wasEnabled = captchaSettingCache.enabled !== false;
    updateCaptchaSettingCache(false);
    if (wasEnabled) {
      captchaLog.info("[captcha] Force-disabled via configuration/port override");
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

export { CAPTCHA_SETTING_KEY };
