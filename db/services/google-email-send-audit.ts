import { randomUUID } from "node:crypto";
import { desc, eq, sql } from "drizzle-orm";
import { db, googleEmailSendAuditEvents, user } from "@/db";
import type { AccessScope } from "@/lib/access-scope";
import {
  type GoogleAccountMode,
  sharedGoogleWorkspaceAccess,
} from "@/lib/google-workspace";

export async function beginGoogleEmailSendAudit(input: {
  readonly account: GoogleAccountMode;
  readonly bcc: readonly string[];
  readonly cc: readonly string[];
  readonly requestKey: string;
  readonly scope: AccessScope;
  readonly sessionId: string;
  readonly subject: string;
  readonly to: readonly string[];
}) {
  const now = new Date().toISOString();
  await db
    .insert(googleEmailSendAuditEvents)
    .values({
      createdAt: now,
      emailSubject: input.subject,
      googleAccount: input.account,
      id: randomUUID(),
      recipients: JSON.stringify({
        bcc: input.bcc,
        cc: input.cc,
        to: input.to,
      }),
      requestedByUserId: input.scope.userId,
      requestKey: input.requestKey,
      sessionId: input.sessionId,
      status: "pending",
      workspaceId: input.scope.workspaceId,
    })
    .onConflictDoNothing({
      target: googleEmailSendAuditEvents.requestKey,
    });
}

export async function completeGoogleEmailSendAudit(
  requestKey: string,
  result: {
    readonly messageId?: null | string;
    readonly threadId?: null | string;
  }
) {
  await db
    .update(googleEmailSendAuditEvents)
    .set({
      completedAt: new Date().toISOString(),
      error: null,
      gmailMessageId: result.messageId ?? null,
      gmailThreadId: result.threadId ?? null,
      status: "sent",
    })
    .where(eq(googleEmailSendAuditEvents.requestKey, requestKey));
}

export async function failGoogleEmailSendAudit(
  requestKey: string,
  cause: unknown
) {
  const message = cause instanceof Error ? cause.message : String(cause);
  await db
    .update(googleEmailSendAuditEvents)
    .set({
      completedAt: new Date().toISOString(),
      error: message.slice(0, 2_000),
      status: "failed",
    })
    .where(eq(googleEmailSendAuditEvents.requestKey, requestKey));
}

export function listGoogleEmailSendAuditEvents(userId: string, limit = 25) {
  if (sharedGoogleWorkspaceAccess(userId) !== "admin") {
    throw new Error(
      "Only the dedicated mailbox administrator can view email audit records."
    );
  }
  return db
    .select({
      createdAt: googleEmailSendAuditEvents.createdAt,
      emailSubject: googleEmailSendAuditEvents.emailSubject,
      googleAccount: googleEmailSendAuditEvents.googleAccount,
      id: googleEmailSendAuditEvents.id,
      recipients: googleEmailSendAuditEvents.recipients,
      requesterEmail: user.email,
      requesterName: user.name,
      requestedByUserId: googleEmailSendAuditEvents.requestedByUserId,
      status: googleEmailSendAuditEvents.status,
    })
    .from(googleEmailSendAuditEvents)
    .leftJoin(
      user,
      eq(
        googleEmailSendAuditEvents.requestedByUserId,
        sql<string>`'better-auth:' || ${user.id}`
      )
    )
    .orderBy(desc(googleEmailSendAuditEvents.createdAt))
    .limit(Math.min(Math.max(limit, 1), 100));
}
