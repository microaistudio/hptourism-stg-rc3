import { db } from "./db";
import { applicationActions } from "@shared/schema";

export type LogApplicationActionPayload = {
  applicationId: string;
  actorId?: string | null;
  action: string;
  previousStatus?: string | null;
  newStatus?: string | null;
  feedback?: string | null;
};

export async function logApplicationAction({
  applicationId,
  actorId,
  action,
  previousStatus,
  newStatus,
  feedback,
}: LogApplicationActionPayload) {
  if (!actorId) {
    console.warn("[timeline] Skipping log due to missing actor", {
      applicationId,
      action,
    });
    return;
  }

  try {
    await db.insert(applicationActions).values({
      applicationId,
      officerId: actorId,
      action,
      previousStatus: previousStatus ?? null,
      newStatus: newStatus ?? null,
      feedback: feedback ?? null,
    });
  } catch (error) {
    console.error("[timeline] Failed to log application action:", error);
  }
}
