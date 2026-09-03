import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, lt } from "drizzle-orm";
import { browserAuthCheckpoints, db } from "@/db";
import type { AccessScope } from "@/lib/access-scope";

export const browserAuthChallengeTypes = [
  "otp_sms",
  "otp_email",
  "totp",
  "push",
  "passkey",
  "captcha",
  "vault_login",
  "approval",
  "other",
] as const;

type BrowserAuthChallengeType = (typeof browserAuthChallengeTypes)[number];

const activeStatuses = ["pending", "resuming"] as const;
type TerminalStatus = "cancelled" | "completed" | "failed";

interface CreateBrowserAuthCheckpointInput {
  readonly browserSessionId: string;
  readonly challengeType: BrowserAuthChallengeType;
  readonly expiresAt: Date;
  readonly origin: string;
  readonly prompt: string;
  readonly rootSessionId: string;
  readonly workerSessionId: string;
}

export async function createBrowserAuthCheckpoint(
  scope: AccessScope,
  input: CreateBrowserAuthCheckpointInput
) {
  const now = new Date().toISOString();
  return db.transaction(async (transaction) => {
    await transaction
      .update(browserAuthCheckpoints)
      .set({ status: "cancelled", updatedAt: now })
      .where(
        and(
          eq(browserAuthCheckpoints.workspaceId, scope.workspaceId),
          eq(browserAuthCheckpoints.createdByUserId, scope.userId),
          eq(browserAuthCheckpoints.rootSessionId, input.rootSessionId),
          inArray(browserAuthCheckpoints.status, [...activeStatuses])
        )
      );
    const [checkpoint] = await transaction
      .insert(browserAuthCheckpoints)
      .values({
        ...input,
        createdAt: now,
        createdByUserId: scope.userId,
        expiresAt: input.expiresAt.toISOString(),
        id: randomUUID(),
        status: "pending",
        updatedAt: now,
        workspaceId: scope.workspaceId,
      })
      .returning();
    if (!checkpoint)
      throw new Error("Failed to save authentication checkpoint.");
    return checkpoint;
  });
}

export async function readBrowserAuthCheckpoint(
  scope: AccessScope,
  checkpointId: string
) {
  await expireBrowserAuthCheckpoints(scope);
  const [checkpoint] = await db
    .select()
    .from(browserAuthCheckpoints)
    .where(
      and(
        eq(browserAuthCheckpoints.id, checkpointId),
        eq(browserAuthCheckpoints.workspaceId, scope.workspaceId),
        eq(browserAuthCheckpoints.createdByUserId, scope.userId)
      )
    )
    .limit(1);
  return checkpoint;
}

export async function readPendingBrowserAuthCheckpoint(
  scope: AccessScope,
  rootSessionId: string
) {
  await expireBrowserAuthCheckpoints(scope);
  const [checkpoint] = await db
    .select()
    .from(browserAuthCheckpoints)
    .where(
      and(
        eq(browserAuthCheckpoints.workspaceId, scope.workspaceId),
        eq(browserAuthCheckpoints.createdByUserId, scope.userId),
        eq(browserAuthCheckpoints.rootSessionId, rootSessionId),
        inArray(browserAuthCheckpoints.status, [...activeStatuses])
      )
    )
    .orderBy(desc(browserAuthCheckpoints.updatedAt))
    .limit(1);
  return checkpoint;
}

export async function readActiveBrowserAuthCheckpointForBrowserSession(
  scope: AccessScope,
  browserSessionId: string
) {
  await expireBrowserAuthCheckpoints(scope);
  const [checkpoint] = await db
    .select({
      challengeType: browserAuthCheckpoints.challengeType,
      expiresAt: browserAuthCheckpoints.expiresAt,
      id: browserAuthCheckpoints.id,
      origin: browserAuthCheckpoints.origin,
    })
    .from(browserAuthCheckpoints)
    .where(
      and(
        eq(browserAuthCheckpoints.workspaceId, scope.workspaceId),
        eq(browserAuthCheckpoints.createdByUserId, scope.userId),
        eq(browserAuthCheckpoints.browserSessionId, browserSessionId),
        inArray(browserAuthCheckpoints.status, [...activeStatuses])
      )
    )
    .orderBy(desc(browserAuthCheckpoints.updatedAt))
    .limit(1);
  return checkpoint;
}

export async function markBrowserAuthCheckpointResuming(
  scope: AccessScope,
  checkpointId: string
) {
  await expireBrowserAuthCheckpoints(scope);
  const now = new Date().toISOString();
  const [checkpoint] = await db
    .update(browserAuthCheckpoints)
    .set({ status: "resuming", updatedAt: now })
    .where(
      and(
        eq(browserAuthCheckpoints.id, checkpointId),
        eq(browserAuthCheckpoints.workspaceId, scope.workspaceId),
        eq(browserAuthCheckpoints.createdByUserId, scope.userId),
        inArray(browserAuthCheckpoints.status, [...activeStatuses])
      )
    )
    .returning();
  return checkpoint;
}

export async function bindBrowserAuthCheckpointAgent(
  scope: AccessScope,
  checkpointId: string,
  rootSessionId: string,
  workerAgentId: string
) {
  const [checkpoint] = await db
    .update(browserAuthCheckpoints)
    .set({ workerAgentId, updatedAt: new Date().toISOString() })
    .where(
      and(
        eq(browserAuthCheckpoints.id, checkpointId),
        eq(browserAuthCheckpoints.workspaceId, scope.workspaceId),
        eq(browserAuthCheckpoints.createdByUserId, scope.userId),
        eq(browserAuthCheckpoints.rootSessionId, rootSessionId),
        eq(browserAuthCheckpoints.status, "pending")
      )
    )
    .returning();
  return checkpoint;
}

export async function finishBrowserAuthCheckpoint(
  scope: AccessScope,
  checkpointId: string,
  status: TerminalStatus
) {
  const [checkpoint] = await db
    .update(browserAuthCheckpoints)
    .set({ status, updatedAt: new Date().toISOString() })
    .where(
      and(
        eq(browserAuthCheckpoints.id, checkpointId),
        eq(browserAuthCheckpoints.workspaceId, scope.workspaceId),
        eq(browserAuthCheckpoints.createdByUserId, scope.userId),
        inArray(browserAuthCheckpoints.status, [...activeStatuses])
      )
    )
    .returning();
  return checkpoint;
}

async function expireBrowserAuthCheckpoints(scope: AccessScope) {
  const now = new Date().toISOString();
  await db
    .update(browserAuthCheckpoints)
    .set({ status: "expired", updatedAt: now })
    .where(
      and(
        eq(browserAuthCheckpoints.workspaceId, scope.workspaceId),
        eq(browserAuthCheckpoints.createdByUserId, scope.userId),
        inArray(browserAuthCheckpoints.status, [...activeStatuses]),
        lt(browserAuthCheckpoints.expiresAt, now)
      )
    );
}
