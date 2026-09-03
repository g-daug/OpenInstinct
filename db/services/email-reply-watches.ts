import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull, lte, ne, or } from "drizzle-orm";
import type { SessionAuthContext } from "eve/context";
import type { AccessScope } from "@/lib/access-scope";
import { db, emailReplyWatches } from "@/db";

const FIRST_CHECK_DELAY_MS = 60_000;
const POLL_INTERVAL_MS = 2 * 60_000;
const RETRY_DELAY_MS = 5 * 60_000;
const WATCH_DURATION_MS = 30 * 24 * 60 * 60_000;

export interface EmailReplyWatchOwner {
  readonly auth: SessionAuthContext;
  readonly linqThreadId: string;
  readonly phoneNumber?: string;
  readonly scope: AccessScope;
}

export interface ClaimedEmailReplyWatch {
  readonly auth: SessionAuthContext;
  readonly createdByUserId: string;
  readonly emailSubject: string;
  readonly gmailThreadId: string;
  readonly id: string;
  readonly leaseToken: string;
  readonly linqThreadId: string;
  readonly lastError: null | string;
  readonly phoneNumber?: string;
  readonly sentAt: string;
  readonly sentMessageId: string;
}

export async function createEmailReplyWatch(
  owner: EmailReplyWatchOwner,
  input: {
    readonly emailSubject: string;
    readonly gmailThreadId: string;
    readonly sentMessageId: string;
  },
  now = new Date()
) {
  const nowIso = now.toISOString();
  const values = {
    authenticator: owner.auth.authenticator,
    createdByUserId: owner.scope.userId,
    emailSubject: input.emailSubject,
    expiresAt: new Date(now.getTime() + WATCH_DURATION_MS).toISOString(),
    gmailThreadId: input.gmailThreadId,
    issuer: owner.auth.issuer ?? null,
    lastCheckedAt: null,
    lastError: null,
    leaseExpiresAt: null,
    leaseToken: null,
    linqThreadId: owner.linqThreadId,
    nextCheckAt: new Date(now.getTime() + FIRST_CHECK_DELAY_MS).toISOString(),
    notifiedAt: null,
    phoneNumber: owner.phoneNumber,
    replyDetectedAt: null,
    replyMessageId: null,
    sentAt: nowIso,
    sentMessageId: input.sentMessageId,
    state: "active",
    subject: owner.auth.subject ?? null,
    updatedAt: nowIso,
    workspaceId: owner.scope.workspaceId,
  };
  const rows = await db
    .insert(emailReplyWatches)
    .values({ ...values, createdAt: nowIso, id: randomUUID() })
    .onConflictDoUpdate({
      target: [
        emailReplyWatches.workspaceId,
        emailReplyWatches.createdByUserId,
        emailReplyWatches.linqThreadId,
        emailReplyWatches.gmailThreadId,
      ],
      set: values,
    })
    .returning();
  return rows[0] ? publicWatch(rows[0]) : undefined;
}

export async function claimDueEmailReplyWatches({
  leaseForMs,
  limit,
  now,
}: {
  readonly leaseForMs: number;
  readonly limit: number;
  readonly now: Date;
}) {
  return db.transaction(async (transaction) => {
    const nowIso = now.toISOString();
    await transaction
      .update(emailReplyWatches)
      .set({
        leaseExpiresAt: null,
        leaseToken: null,
        state: "expired",
        updatedAt: nowIso,
      })
      .where(
        and(
          eq(emailReplyWatches.state, "active"),
          lte(emailReplyWatches.expiresAt, nowIso)
        )
      );

    const rows = await transaction
      .select()
      .from(emailReplyWatches)
      .where(
        and(
          eq(emailReplyWatches.state, "active"),
          lte(emailReplyWatches.nextCheckAt, nowIso),
          or(
            isNull(emailReplyWatches.leaseToken),
            lte(emailReplyWatches.leaseExpiresAt, nowIso)
          )
        )
      )
      .orderBy(asc(emailReplyWatches.nextCheckAt))
      .limit(limit)
      .for("update", { skipLocked: true });
    if (rows.length === 0) return [];

    const leaseToken = randomUUID();
    await transaction
      .update(emailReplyWatches)
      .set({
        leaseExpiresAt: new Date(now.getTime() + leaseForMs).toISOString(),
        leaseToken,
        updatedAt: nowIso,
      })
      .where(
        inArray(
          emailReplyWatches.id,
          rows.map((row) => row.id)
        )
      );
    return rows.map((row) => claimedWatch(row, leaseToken));
  });
}

export async function recordEmailReplyDetection(
  job: ClaimedEmailReplyWatch,
  input: { readonly detectedAt: Date; readonly replyMessageId: string }
) {
  const rows = await db
    .update(emailReplyWatches)
    .set({
      replyDetectedAt: input.detectedAt.toISOString(),
      replyMessageId: input.replyMessageId,
      updatedAt: input.detectedAt.toISOString(),
    })
    .where(
      and(
        eq(emailReplyWatches.id, job.id),
        eq(emailReplyWatches.leaseToken, job.leaseToken),
        eq(emailReplyWatches.state, "active")
      )
    )
    .returning({ id: emailReplyWatches.id });
  return rows.length > 0;
}

export async function completeEmailReplyWatchPoll(
  job: ClaimedEmailReplyWatch,
  checkedAt: Date
) {
  await db.transaction(async (transaction) => {
    const rows = await transaction
      .select({ replyMessageId: emailReplyWatches.replyMessageId })
      .from(emailReplyWatches)
      .where(
        and(
          eq(emailReplyWatches.id, job.id),
          eq(emailReplyWatches.leaseToken, job.leaseToken),
          eq(emailReplyWatches.state, "active")
        )
      )
      .limit(1)
      .for("update");
    const row = rows[0];
    if (!row) return;

    const replied = row.replyMessageId !== null;
    await transaction
      .update(emailReplyWatches)
      .set({
        lastCheckedAt: checkedAt.toISOString(),
        lastError: null,
        leaseExpiresAt: null,
        leaseToken: null,
        nextCheckAt: replied
          ? checkedAt.toISOString()
          : new Date(checkedAt.getTime() + POLL_INTERVAL_MS).toISOString(),
        notifiedAt: replied ? checkedAt.toISOString() : null,
        state: replied ? "notified" : "active",
        updatedAt: checkedAt.toISOString(),
      })
      .where(
        and(
          eq(emailReplyWatches.id, job.id),
          eq(emailReplyWatches.leaseToken, job.leaseToken)
        )
      );
  });
}

export async function releaseEmailReplyWatch(
  job: ClaimedEmailReplyWatch,
  error: Error,
  now = new Date()
) {
  await db
    .update(emailReplyWatches)
    .set({
      lastError: error.message.slice(0, 2_000),
      leaseExpiresAt: null,
      leaseToken: null,
      nextCheckAt: new Date(now.getTime() + RETRY_DELAY_MS).toISOString(),
      updatedAt: now.toISOString(),
    })
    .where(
      and(
        eq(emailReplyWatches.id, job.id),
        eq(emailReplyWatches.leaseToken, job.leaseToken),
        eq(emailReplyWatches.state, "active")
      )
    );
}

export async function reserveEmailReplyWatchReauthorizationNotice(
  job: ClaimedEmailReplyWatch,
  noticeMarker: string,
  now = new Date()
) {
  const rows = await db
    .update(emailReplyWatches)
    .set({
      lastError: noticeMarker,
      leaseExpiresAt: null,
      leaseToken: null,
      nextCheckAt: new Date(now.getTime() + RETRY_DELAY_MS).toISOString(),
      updatedAt: now.toISOString(),
    })
    .where(
      and(
        eq(emailReplyWatches.id, job.id),
        eq(emailReplyWatches.leaseToken, job.leaseToken),
        eq(emailReplyWatches.state, "active"),
        or(
          isNull(emailReplyWatches.lastError),
          ne(emailReplyWatches.lastError, noticeMarker)
        )
      )
    )
    .returning({ id: emailReplyWatches.id });
  return rows.length > 0;
}

function publicWatch(row: typeof emailReplyWatches.$inferSelect) {
  return {
    emailSubject: row.emailSubject,
    expiresAt: row.expiresAt,
    id: row.id,
    nextCheckAt: row.nextCheckAt,
    state: row.state,
  };
}

function claimedWatch(
  row: typeof emailReplyWatches.$inferSelect,
  leaseToken: string
): ClaimedEmailReplyWatch {
  const attributes = {
    linqThreadId: row.linqThreadId,
    workspaceId: row.workspaceId,
  };
  if (row.phoneNumber)
    Object.assign(attributes, { phoneNumber: row.phoneNumber });
  const auth: SessionAuthContext = {
    attributes,
    authenticator: row.authenticator,
    principalId: row.createdByUserId,
    principalType: "user",
  };
  if (row.issuer) Object.assign(auth, { issuer: row.issuer });
  if (row.subject) Object.assign(auth, { subject: row.subject });

  const claimed = {
    auth,
    createdByUserId: row.createdByUserId,
    emailSubject: row.emailSubject,
    gmailThreadId: row.gmailThreadId,
    id: row.id,
    leaseToken,
    linqThreadId: row.linqThreadId,
    lastError: row.lastError,
    sentAt: row.sentAt,
    sentMessageId: row.sentMessageId,
  };
  if (row.phoneNumber) Object.assign(claimed, { phoneNumber: row.phoneNumber });
  return claimed;
}
