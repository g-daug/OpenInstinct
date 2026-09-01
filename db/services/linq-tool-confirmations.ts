import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { db, linqToolConfirmations } from "@/db";
import { getInstallationSecrets } from "@/lib/installation-secrets";

export type LinqConfirmedAction = "create_calendar_event" | "send_email";

const confirmationLifetimeMs = 10 * 60 * 1000;

export async function createLinqToolConfirmation(input: {
  readonly action: LinqConfirmedAction;
  readonly payloadJson: string;
  readonly principalId: string;
  readonly sessionId: string;
}) {
  const id = randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + confirmationLifetimeMs);
  await db.insert(linqToolConfirmations).values({
    action: input.action,
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    id,
    payloadHash: hashPayload(input.payloadJson),
    principalId: input.principalId,
    sessionId: input.sessionId,
  });

  return {
    confirmationId: await signConfirmation(id, expiresAt.getTime()),
    expiresAt: expiresAt.toISOString(),
  };
}

export async function consumeLinqToolConfirmation(input: {
  readonly action: LinqConfirmedAction;
  readonly confirmationId: string;
  readonly payloadJson: string;
  readonly principalId: string;
  readonly sessionId: string;
}) {
  const parsed = await verifyConfirmation(input.confirmationId);
  if (!parsed || parsed.expiresAt <= Date.now()) {
    throw new Error(
      "This Linq confirmation is invalid or expired. Prepare the action again."
    );
  }

  const consumedAt = new Date().toISOString();
  const rows = await db
    .update(linqToolConfirmations)
    .set({ consumedAt })
    .where(
      and(
        eq(linqToolConfirmations.id, parsed.id),
        eq(linqToolConfirmations.sessionId, input.sessionId),
        eq(linqToolConfirmations.principalId, input.principalId),
        eq(linqToolConfirmations.action, input.action),
        eq(linqToolConfirmations.payloadHash, hashPayload(input.payloadJson)),
        gt(linqToolConfirmations.expiresAt, consumedAt),
        isNull(linqToolConfirmations.consumedAt)
      )
    )
    .returning({ id: linqToolConfirmations.id });
  if (rows.length === 0) {
    throw new Error(
      "This Linq confirmation was already used or does not match the proposed action. Prepare the action again."
    );
  }
}

function hashPayload(payloadJson: string) {
  return createHash("sha256").update(payloadJson).digest("hex");
}

async function signConfirmation(id: string, expiresAt: number) {
  const value = `${id}.${String(expiresAt)}`;
  return `${value}.${await signature(value)}`;
}

async function verifyConfirmation(value: string) {
  const parts = value.split(".");
  if (parts.length !== 3) return;
  const [id, expiresAtValue, suppliedSignature] = parts;
  if (!id || !expiresAtValue || !suppliedSignature) return;
  const expiresAt = Number(expiresAtValue);
  if (!Number.isSafeInteger(expiresAt)) return;
  const expectedSignature = await signature(`${id}.${expiresAtValue}`);
  const expected = Buffer.from(expectedSignature);
  const supplied = Buffer.from(suppliedSignature);
  if (
    expected.length !== supplied.length ||
    !timingSafeEqual(expected, supplied)
  ) {
    return;
  }
  return { expiresAt, id };
}

async function signature(value: string) {
  const { secretEncryptionKey } = await getInstallationSecrets();
  return createHmac("sha256", Buffer.from(secretEncryptionKey, "base64"))
    .update(`linq-tool-confirmation:v1:${value}`)
    .digest("base64url");
}
