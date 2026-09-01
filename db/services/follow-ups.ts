import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull, lte, or } from "drizzle-orm";
import type { SessionAuthContext } from "eve/context";
import type { AccessScope } from "@/lib/access-scope";
import { db, followUps } from "@/db";
import {
  assertTimeZone,
  followUpRecurrenceSchema,
  nextFollowUpRun,
  type FollowUpRecurrence,
} from "./follow-up-recurrence";

export interface FollowUpOwner {
  readonly auth: SessionAuthContext;
  readonly linqThreadId: string;
  readonly phoneNumber?: string;
  readonly scope: AccessScope;
}

export interface ClaimedFollowUp {
  readonly auth: SessionAuthContext;
  readonly id: string;
  readonly leaseToken: string;
  readonly linqThreadId: string;
  readonly nextRunAt: string;
  readonly prompt: string;
  readonly recurrence: FollowUpRecurrence;
  readonly timezone: string;
}

export async function createFollowUp(
  owner: FollowUpOwner,
  input: {
    readonly firstRunAt: string;
    readonly prompt: string;
    readonly recurrence: FollowUpRecurrence;
    readonly timezone: string;
  }
) {
  assertTimeZone(input.timezone);
  const firstRunAt = new Date(input.firstRunAt);
  if (Number.isNaN(firstRunAt.getTime())) throw new Error("Invalid run time.");
  if (firstRunAt.getTime() < Date.now() - 30_000) {
    throw new Error("The first follow-up time must be in the future.");
  }

  const now = new Date().toISOString();
  const id = randomUUID();
  await db.insert(followUps).values({
    authenticator: owner.auth.authenticator,
    createdAt: now,
    createdByUserId: owner.scope.userId,
    id,
    issuer: owner.auth.issuer ?? null,
    linqThreadId: owner.linqThreadId,
    nextRunAt: firstRunAt.toISOString(),
    phoneNumber: owner.phoneNumber,
    prompt: input.prompt,
    recurrence: input.recurrence,
    subject: owner.auth.subject ?? null,
    timezone: input.timezone,
    updatedAt: now,
    workspaceId: owner.scope.workspaceId,
  });
  return readFollowUp(owner.scope, id);
}

export async function listFollowUps(
  scope: AccessScope,
  includeCancelled = false
) {
  const rows = await db
    .select()
    .from(followUps)
    .where(
      and(
        eq(followUps.workspaceId, scope.workspaceId),
        includeCancelled ? undefined : eq(followUps.enabled, true)
      )
    )
    .orderBy(asc(followUps.nextRunAt));
  return rows.map(publicFollowUp);
}

export async function updateFollowUp(
  scope: AccessScope,
  id: string,
  patch: {
    readonly enabled?: boolean;
    readonly nextRunAt?: string;
    readonly prompt?: string;
    readonly recurrence?: FollowUpRecurrence;
    readonly timezone?: string;
  }
) {
  if (patch.timezone !== undefined) assertTimeZone(patch.timezone);
  const nextRunAt =
    patch.nextRunAt === undefined ? undefined : new Date(patch.nextRunAt);
  if (nextRunAt && Number.isNaN(nextRunAt.getTime())) {
    throw new Error("Invalid run time.");
  }

  const values = {
    ...patch,
    lastError: null,
    updatedAt: new Date().toISOString(),
  };
  if (nextRunAt) values.nextRunAt = nextRunAt.toISOString();

  const rows = await db
    .update(followUps)
    .set(values)
    .where(
      and(eq(followUps.workspaceId, scope.workspaceId), eq(followUps.id, id))
    )
    .returning();
  return rows[0] ? publicFollowUp(rows[0]) : undefined;
}

export async function cancelFollowUp(scope: AccessScope, id: string) {
  const rows = await db
    .update(followUps)
    .set({
      enabled: false,
      leaseExpiresAt: null,
      leaseToken: null,
      updatedAt: new Date().toISOString(),
    })
    .where(
      and(eq(followUps.workspaceId, scope.workspaceId), eq(followUps.id, id))
    )
    .returning({ id: followUps.id });
  return rows.length > 0;
}

export async function claimDueFollowUps({
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
    const rows = await transaction
      .select()
      .from(followUps)
      .where(
        and(
          eq(followUps.enabled, true),
          lte(followUps.nextRunAt, nowIso),
          or(
            isNull(followUps.leaseToken),
            lte(followUps.leaseExpiresAt, nowIso)
          )
        )
      )
      .orderBy(asc(followUps.nextRunAt))
      .limit(limit)
      .for("update", { skipLocked: true });
    if (rows.length === 0) return [];

    const leaseToken = randomUUID();
    await transaction
      .update(followUps)
      .set({
        leaseExpiresAt: new Date(now.getTime() + leaseForMs).toISOString(),
        leaseToken,
        updatedAt: nowIso,
      })
      .where(
        inArray(
          followUps.id,
          rows.map((row) => row.id)
        )
      );

    return rows.map((row) => claimedFollowUp(row, leaseToken));
  });
}

export async function completeFollowUp(
  job: ClaimedFollowUp,
  completedAt: Date
) {
  const recurring = job.recurrence !== "once";
  const nextRunAt = recurring
    ? nextFollowUpRun({
        after: completedAt,
        currentRunAt: job.nextRunAt,
        recurrence: job.recurrence,
        timezone: job.timezone,
      })
    : job.nextRunAt;
  await db
    .update(followUps)
    .set({
      enabled: recurring,
      lastError: null,
      lastRunAt: completedAt.toISOString(),
      leaseExpiresAt: null,
      leaseToken: null,
      nextRunAt,
      updatedAt: completedAt.toISOString(),
    })
    .where(
      and(eq(followUps.id, job.id), eq(followUps.leaseToken, job.leaseToken))
    );
}

export async function releaseFollowUp(
  job: ClaimedFollowUp,
  failure: { readonly error: Error; readonly retryAt: Date }
) {
  await db
    .update(followUps)
    .set({
      lastError: failure.error.message.slice(0, 2_000),
      leaseExpiresAt: null,
      leaseToken: null,
      nextRunAt: failure.retryAt.toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .where(
      and(eq(followUps.id, job.id), eq(followUps.leaseToken, job.leaseToken))
    );
}

async function readFollowUp(scope: AccessScope, id: string) {
  const rows = await db
    .select()
    .from(followUps)
    .where(
      and(eq(followUps.workspaceId, scope.workspaceId), eq(followUps.id, id))
    )
    .limit(1);
  return rows[0] ? publicFollowUp(rows[0]) : undefined;
}

function publicFollowUp(row: typeof followUps.$inferSelect) {
  return {
    enabled: row.enabled,
    id: row.id,
    lastError: row.lastError,
    lastRunAt: row.lastRunAt,
    nextRunAt: row.nextRunAt,
    prompt: row.prompt,
    recurrence: followUpRecurrenceSchema.parse(row.recurrence),
    timezone: row.timezone,
  };
}

function claimedFollowUp(
  row: typeof followUps.$inferSelect,
  leaseToken: string
): ClaimedFollowUp {
  const attributes = {
    linqThreadId: row.linqThreadId,
    workspaceId: row.workspaceId,
  };
  if (row.phoneNumber) {
    Object.assign(attributes, { phoneNumber: row.phoneNumber });
  }
  const auth: SessionAuthContext = {
    attributes,
    authenticator: row.authenticator,
    principalId: row.createdByUserId,
    principalType: "user",
  };
  if (row.issuer) Object.assign(auth, { issuer: row.issuer });
  if (row.subject) Object.assign(auth, { subject: row.subject });

  return {
    auth,
    id: row.id,
    leaseToken,
    linqThreadId: row.linqThreadId,
    nextRunAt: row.nextRunAt,
    prompt: row.prompt,
    recurrence: followUpRecurrenceSchema.parse(row.recurrence),
    timezone: row.timezone,
  };
}
