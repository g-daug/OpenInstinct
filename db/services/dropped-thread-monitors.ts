import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull, lte, or } from "drizzle-orm";
import type { SessionAuthContext } from "eve/context";
import type { AccessScope } from "@/lib/access-scope";
import { db, droppedThreadFindings, droppedThreadMonitors } from "@/db";
import { assertTimeZone, nextDailyRunAt } from "./follow-up-recurrence";

const DEFAULT_REPEAT_AFTER_MS = 7 * 24 * 60 * 60_000;

export interface DroppedThreadMonitorOwner {
  readonly auth: SessionAuthContext;
  readonly linqThreadId: string;
  readonly phoneNumber?: string;
  readonly scope: AccessScope;
}

export interface ClaimedDroppedThreadMonitor {
  readonly auth: SessionAuthContext;
  readonly id: string;
  readonly leaseToken: string;
  readonly linqThreadId: string;
  readonly localHour: number;
  readonly localMinute: number;
  readonly lookbackDays: number;
  readonly minimumAgeHours: number;
  readonly nextRunAt: string;
  readonly timezone: string;
}

export async function saveDroppedThreadMonitor(
  owner: DroppedThreadMonitorOwner,
  input: {
    readonly localHour: number;
    readonly localMinute: number;
    readonly lookbackDays: number;
    readonly minimumAgeHours: number;
    readonly timezone: string;
  },
  now = new Date()
) {
  validateSettings(input);
  const nowIso = now.toISOString();
  const nextRunAt = nextDailyRunAt({
    after: now,
    hour: input.localHour,
    minute: input.localMinute,
    timezone: input.timezone,
  });
  const values = {
    authenticator: owner.auth.authenticator,
    createdByUserId: owner.scope.userId,
    enabled: true,
    issuer: owner.auth.issuer ?? null,
    lastError: null,
    leaseExpiresAt: null,
    leaseToken: null,
    linqThreadId: owner.linqThreadId,
    localHour: input.localHour,
    localMinute: input.localMinute,
    lookbackDays: input.lookbackDays,
    minimumAgeHours: input.minimumAgeHours,
    nextRunAt,
    phoneNumber: owner.phoneNumber,
    subject: owner.auth.subject ?? null,
    timezone: input.timezone,
    updatedAt: nowIso,
    workspaceId: owner.scope.workspaceId,
  };
  const rows = await db
    .insert(droppedThreadMonitors)
    .values({
      ...values,
      createdAt: nowIso,
      id: randomUUID(),
    })
    .onConflictDoUpdate({
      target: [
        droppedThreadMonitors.workspaceId,
        droppedThreadMonitors.createdByUserId,
      ],
      set: values,
    })
    .returning();
  return rows[0] ? publicMonitor(rows[0]) : undefined;
}

export async function readDroppedThreadMonitor(scope: AccessScope) {
  const rows = await db
    .select()
    .from(droppedThreadMonitors)
    .where(
      and(
        eq(droppedThreadMonitors.workspaceId, scope.workspaceId),
        eq(droppedThreadMonitors.createdByUserId, scope.userId)
      )
    )
    .limit(1);
  return rows[0] ? publicMonitor(rows[0]) : undefined;
}

export async function disableDroppedThreadMonitor(scope: AccessScope) {
  const rows = await db
    .update(droppedThreadMonitors)
    .set({
      enabled: false,
      leaseExpiresAt: null,
      leaseToken: null,
      updatedAt: new Date().toISOString(),
    })
    .where(
      and(
        eq(droppedThreadMonitors.workspaceId, scope.workspaceId),
        eq(droppedThreadMonitors.createdByUserId, scope.userId)
      )
    )
    .returning({ id: droppedThreadMonitors.id });
  return rows.length > 0;
}

export async function claimDueDroppedThreadMonitors({
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
      .from(droppedThreadMonitors)
      .where(
        and(
          eq(droppedThreadMonitors.enabled, true),
          lte(droppedThreadMonitors.nextRunAt, nowIso),
          or(
            isNull(droppedThreadMonitors.leaseToken),
            lte(droppedThreadMonitors.leaseExpiresAt, nowIso)
          )
        )
      )
      .orderBy(asc(droppedThreadMonitors.nextRunAt))
      .limit(limit)
      .for("update", { skipLocked: true });
    if (rows.length === 0) return [];

    const leaseToken = randomUUID();
    await transaction
      .update(droppedThreadMonitors)
      .set({
        leaseExpiresAt: new Date(now.getTime() + leaseForMs).toISOString(),
        leaseToken,
        updatedAt: nowIso,
      })
      .where(
        inArray(
          droppedThreadMonitors.id,
          rows.map((row) => row.id)
        )
      );

    return rows.map((row) => claimedMonitor(row, leaseToken));
  });
}

export async function completeDroppedThreadMonitor(
  monitor: ClaimedDroppedThreadMonitor,
  completedAt: Date
) {
  await db
    .update(droppedThreadMonitors)
    .set({
      lastError: null,
      lastRunAt: completedAt.toISOString(),
      leaseExpiresAt: null,
      leaseToken: null,
      nextRunAt: nextDailyRunAt({
        after: completedAt,
        hour: monitor.localHour,
        minute: monitor.localMinute,
        timezone: monitor.timezone,
      }),
      updatedAt: completedAt.toISOString(),
    })
    .where(
      and(
        eq(droppedThreadMonitors.id, monitor.id),
        eq(droppedThreadMonitors.leaseToken, monitor.leaseToken)
      )
    );
}

export async function releaseDroppedThreadMonitor(
  monitor: ClaimedDroppedThreadMonitor,
  failure: { readonly error: Error; readonly retryAt: Date }
) {
  await db
    .update(droppedThreadMonitors)
    .set({
      lastError: failure.error.message.slice(0, 2_000),
      leaseExpiresAt: null,
      leaseToken: null,
      nextRunAt: failure.retryAt.toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .where(
      and(
        eq(droppedThreadMonitors.id, monitor.id),
        eq(droppedThreadMonitors.leaseToken, monitor.leaseToken)
      )
    );
}

export async function claimDroppedThreadFindingsForNotification({
  detectedAt,
  monitorId,
  repeatAfterMs = DEFAULT_REPEAT_AFTER_MS,
  sourceThreadIds,
}: {
  readonly detectedAt: Date;
  readonly monitorId: string;
  readonly repeatAfterMs?: number;
  readonly sourceThreadIds: readonly string[];
}) {
  const uniqueIds = [
    ...new Set(sourceThreadIds.map((id) => id.trim()).filter(Boolean)),
  ];
  if (uniqueIds.length === 0) return [];
  if (uniqueIds.length > 50) {
    throw new Error("A monitor run can review at most 50 email threads.");
  }
  if (repeatAfterMs < 0) throw new Error("Invalid notification interval.");

  return db.transaction(async (transaction) => {
    const rows = await transaction
      .select()
      .from(droppedThreadFindings)
      .where(
        and(
          eq(droppedThreadFindings.monitorId, monitorId),
          inArray(droppedThreadFindings.sourceThreadId, uniqueIds)
        )
      )
      .for("update");
    const bySource = new Map(rows.map((row) => [row.sourceThreadId, row]));
    const eligible = uniqueIds.filter((sourceThreadId) => {
      const row = bySource.get(sourceThreadId);
      return row ? shouldNotifyFinding(row, detectedAt, repeatAfterMs) : true;
    });
    const detectedAtIso = detectedAt.toISOString();

    if (rows.length > 0) {
      await transaction
        .update(droppedThreadFindings)
        .set({ lastDetectedAt: detectedAtIso, updatedAt: detectedAtIso })
        .where(
          inArray(
            droppedThreadFindings.id,
            rows.map((row) => row.id)
          )
        );
    }

    const existingEligible = eligible.flatMap((sourceThreadId) => {
      const row = bySource.get(sourceThreadId);
      return row ? [row.id] : [];
    });
    if (existingEligible.length > 0) {
      await transaction
        .update(droppedThreadFindings)
        .set({
          dismissedAt: null,
          lastNotifiedAt: detectedAtIso,
          resolvedAt: null,
          snoozedUntil: null,
          state: "open",
          updatedAt: detectedAtIso,
        })
        .where(inArray(droppedThreadFindings.id, existingEligible));
    }

    const newEligible = eligible.filter(
      (sourceThreadId) => !bySource.has(sourceThreadId)
    );
    if (newEligible.length > 0) {
      await transaction.insert(droppedThreadFindings).values(
        newEligible.map((sourceThreadId) => ({
          createdAt: detectedAtIso,
          firstDetectedAt: detectedAtIso,
          id: randomUUID(),
          lastDetectedAt: detectedAtIso,
          lastNotifiedAt: detectedAtIso,
          monitorId,
          sourceThreadId,
          state: "open",
          updatedAt: detectedAtIso,
        }))
      );
    }

    return eligible;
  });
}

export async function snoozeDroppedThreadFinding(
  scope: AccessScope,
  sourceThreadId: string,
  snoozedUntil: Date
) {
  if (snoozedUntil.getTime() <= Date.now()) {
    throw new Error("The snooze time must be in the future.");
  }
  return updateFindingState(scope, sourceThreadId, {
    dismissedAt: null,
    resolvedAt: null,
    snoozedUntil: snoozedUntil.toISOString(),
    state: "snoozed",
  });
}

export async function dismissDroppedThreadFinding(
  scope: AccessScope,
  sourceThreadId: string
) {
  const now = new Date().toISOString();
  return updateFindingState(scope, sourceThreadId, {
    dismissedAt: now,
    resolvedAt: null,
    snoozedUntil: null,
    state: "dismissed",
  });
}

export async function listDroppedThreadFindings(scope: AccessScope) {
  const monitor = await readOwnedMonitorRow(scope);
  if (!monitor) return [];
  const rows = await db
    .select()
    .from(droppedThreadFindings)
    .where(eq(droppedThreadFindings.monitorId, monitor.id))
    .orderBy(
      asc(droppedThreadFindings.firstDetectedAt),
      asc(droppedThreadFindings.sourceThreadId)
    );
  return rows.map((row) => ({
    firstDetectedAt: row.firstDetectedAt,
    lastDetectedAt: row.lastDetectedAt,
    lastNotifiedAt: row.lastNotifiedAt,
    snoozedUntil: row.snoozedUntil,
    sourceThreadId: row.sourceThreadId,
    state: row.state,
  }));
}

async function updateFindingState(
  scope: AccessScope,
  sourceThreadId: string,
  state: {
    readonly dismissedAt: string | null;
    readonly resolvedAt: string | null;
    readonly snoozedUntil: string | null;
    readonly state: "dismissed" | "snoozed";
  }
) {
  const monitor = await readOwnedMonitorRow(scope);
  if (!monitor) return false;
  const rows = await db
    .update(droppedThreadFindings)
    .set({ ...state, updatedAt: new Date().toISOString() })
    .where(
      and(
        eq(droppedThreadFindings.monitorId, monitor.id),
        eq(droppedThreadFindings.sourceThreadId, sourceThreadId)
      )
    )
    .returning({ id: droppedThreadFindings.id });
  return rows.length > 0;
}

async function readOwnedMonitorRow(scope: AccessScope) {
  const rows = await db
    .select()
    .from(droppedThreadMonitors)
    .where(
      and(
        eq(droppedThreadMonitors.workspaceId, scope.workspaceId),
        eq(droppedThreadMonitors.createdByUserId, scope.userId)
      )
    )
    .limit(1);
  return rows[0];
}

function validateSettings(input: {
  readonly localHour: number;
  readonly localMinute: number;
  readonly lookbackDays: number;
  readonly minimumAgeHours: number;
  readonly timezone: string;
}) {
  assertTimeZone(input.timezone);
  nextDailyRunAt({
    after: new Date(),
    hour: input.localHour,
    minute: input.localMinute,
    timezone: input.timezone,
  });
  if (
    !Number.isInteger(input.lookbackDays) ||
    input.lookbackDays < 1 ||
    input.lookbackDays > 90
  ) {
    throw new Error("The email lookback must be between 1 and 90 days.");
  }
  if (
    !Number.isInteger(input.minimumAgeHours) ||
    input.minimumAgeHours < 1 ||
    input.minimumAgeHours > 720
  ) {
    throw new Error("The minimum thread age must be between 1 and 720 hours.");
  }
}

function shouldNotifyFinding(
  row: typeof droppedThreadFindings.$inferSelect,
  now: Date,
  repeatAfterMs: number
) {
  if (row.state === "dismissed" || row.state === "resolved") return false;
  if (row.state === "snoozed") {
    return !row.snoozedUntil || row.snoozedUntil <= now.toISOString();
  }
  if (!row.lastNotifiedAt) return true;
  return (
    new Date(row.lastNotifiedAt).getTime() <= now.getTime() - repeatAfterMs
  );
}

function publicMonitor(row: typeof droppedThreadMonitors.$inferSelect) {
  return {
    enabled: row.enabled,
    id: row.id,
    lastError: row.lastError,
    lastRunAt: row.lastRunAt,
    localHour: row.localHour,
    localMinute: row.localMinute,
    lookbackDays: row.lookbackDays,
    minimumAgeHours: row.minimumAgeHours,
    nextRunAt: row.nextRunAt,
    timezone: row.timezone,
  };
}

function claimedMonitor(
  row: typeof droppedThreadMonitors.$inferSelect,
  leaseToken: string
): ClaimedDroppedThreadMonitor {
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
  return {
    auth,
    id: row.id,
    leaseToken,
    linqThreadId: row.linqThreadId,
    localHour: row.localHour,
    localMinute: row.localMinute,
    lookbackDays: row.lookbackDays,
    minimumAgeHours: row.minimumAgeHours,
    nextRunAt: row.nextRunAt,
    timezone: row.timezone,
  };
}
