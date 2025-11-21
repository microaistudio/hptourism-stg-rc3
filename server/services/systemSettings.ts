import { eq } from "drizzle-orm";
import { db } from "../db";
import { systemSettings, type SystemSetting } from "@shared/schema";

export async function getSystemSettingRecord(key: string): Promise<SystemSetting | null> {
  const [record] = await db
    .select()
    .from(systemSettings)
    .where(eq(systemSettings.settingKey, key))
    .limit(1);
  return record ?? null;
}
