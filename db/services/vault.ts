import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import {
  loginAccountHint,
  parsePaymentCardSecret,
  parseLoginVaultPayload,
  paymentCardBrand,
  vaultItemKindSchema,
  type VaultCreateItem,
} from "@/lib/vault";
import type { AccessScope } from "@/lib/access-scope";
import { db, vaultAuditEvents, vaultItems } from "@/db";
import {
  deleteEncryptedSecret,
  readEncryptedSecret,
  writeEncryptedSecret,
} from "@/db/services/secrets";
import { ensureScope } from "@/db/services/scope";
import {
  readActiveVaultDataKey,
  readVaultDataKey,
} from "@/db/services/vault-keys";
import { getInstallationSecrets } from "@/lib/installation-secrets";

const vaultSecretAccessSchema = z.object({
  origin: z.url().max(500),
  purpose: z.enum(["availability_check", "autofill"]),
});

type VaultSecretAccess = z.infer<typeof vaultSecretAccessSchema>;

const vaultRecordSchema = z.object({
  account: z.string(),
  createdAt: z.string(),
  id: z.string(),
  kind: vaultItemKindSchema,
  label: z.string(),
  updatedAt: z.string(),
});

type VaultRecord = z.infer<typeof vaultRecordSchema>;

const selection = {
  account: vaultItems.account,
  createdAt: vaultItems.createdAt,
  id: vaultItems.id,
  kind: vaultItems.kind,
  label: vaultItems.label,
  updatedAt: vaultItems.updatedAt,
};

async function createVaultRecord(scope: AccessScope, record: VaultRecord) {
  await db.insert(vaultItems).values({
    ...record,
    workspaceId: scope.workspaceId,
  });
}

export async function listVaultItems(scope: AccessScope) {
  return vaultRecordSchema
    .array()
    .parse(
      await db
        .select(selection)
        .from(vaultItems)
        .where(eq(vaultItems.workspaceId, scope.workspaceId))
        .orderBy(desc(vaultItems.updatedAt))
    );
}

export async function readVaultItems(scope: AccessScope) {
  await ensureScope(scope);
  const records = await listVaultItems(scope);
  return Promise.all(
    records.map(async (record) => ({
      ...record,
      hasSecret: await hasVaultSecret(scope, record.id),
    }))
  );
}

export async function readVaultItem(scope: AccessScope, id: string) {
  const rows = await db
    .select(selection)
    .from(vaultItems)
    .where(
      and(eq(vaultItems.workspaceId, scope.workspaceId), eq(vaultItems.id, id))
    )
    .limit(1);
  return vaultRecordSchema.optional().parse(rows[0]);
}

export async function deleteVaultItem(scope: AccessScope, id: string) {
  const rows = await db
    .delete(vaultItems)
    .where(
      and(eq(vaultItems.workspaceId, scope.workspaceId), eq(vaultItems.id, id))
    )
    .returning({ id: vaultItems.id });
  if (rows.length === 0) return false;
  await deleteEncryptedSecret(scope, id);
  return true;
}

export async function saveVaultItem(
  scope: AccessScope,
  input: VaultCreateItem
) {
  await ensureScope(scope);
  const id = randomUUID();
  const now = new Date().toISOString();
  await writeVaultSecret(scope, id, input.secret);

  try {
    await createVaultRecord(scope, {
      account: vaultAccountHint(input),
      createdAt: now,
      id,
      kind: input.kind,
      label: input.label,
      updatedAt: now,
    });
  } catch (error) {
    await deleteEncryptedSecret(scope, id);
    throw error;
  }
}

export async function readVaultSecret(
  scope: AccessScope,
  id: string,
  access: VaultSecretAccess
) {
  const encrypted = await readEncryptedSecret(scope, id);
  if (!encrypted) return undefined;
  const parsedAccess = vaultSecretAccessSchema.parse(access);
  const secret = await decryptVaultSecret(scope, id, encrypted);
  await recordVaultSecretAccess(scope, id, parsedAccess);
  return secret;
}

export async function hasVaultSecret(scope: AccessScope, id: string) {
  return (await readEncryptedSecret(scope, id)) !== undefined;
}

async function writeVaultSecret(scope: AccessScope, id: string, value: string) {
  const dataKey = await readActiveVaultDataKey(scope);
  await writeEncryptedSecret(
    scope,
    id,
    encryptVaultSecret(scope, id, value, dataKey)
  );
}

function vaultAccountHint(input: VaultCreateItem) {
  switch (input.kind) {
    case "login": {
      const payload = parseLoginVaultPayload(input.secret);
      if (!payload)
        throw new Error("The saved login is incomplete or invalid.");
      return loginAccountHint(
        payload.identifier,
        "origin" in payload ? payload.origin : undefined
      );
    }
    case "payment": {
      const card = parsePaymentCardSecret(input.secret);
      return `${paymentCardBrand(card.number)} · •••• ${card.number.slice(-4)}`;
    }
    case "address":
    case "contact":
      return "";
  }
}

function encryptVaultSecret(
  scope: AccessScope,
  id: string,
  value: string,
  dataKey: { readonly key: Buffer; readonly version: number }
) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", dataKey.key, iv);
  cipher.setAAD(vaultSecretAad(scope, id, dataKey.version));
  const ciphertext = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  return [
    "v2",
    String(dataKey.version),
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

async function decryptVaultSecret(
  scope: AccessScope,
  id: string,
  value: string
) {
  if (value.startsWith("v1.")) {
    const { secretEncryptionKey } = await getInstallationSecrets();
    const plaintext = decryptLegacyVaultSecret(
      scope,
      id,
      value,
      secretEncryptionKey
    );
    await writeVaultSecret(scope, id, plaintext);
    return plaintext;
  }

  const parts = value.split(".");
  const [format, encodedVersion, encodedIv, encodedTag, encodedCiphertext] =
    parts;
  const keyVersion = Number(encodedVersion);
  if (
    parts.length !== 5 ||
    format !== "v2" ||
    !Number.isSafeInteger(keyVersion) ||
    keyVersion < 1 ||
    !encodedIv ||
    !encodedTag ||
    !encodedCiphertext
  ) {
    throw new Error("The stored secret uses an unsupported format.");
  }

  const dataKey = await readVaultDataKey(scope, keyVersion);
  const decipher = createDecipheriv(
    "aes-256-gcm",
    dataKey.key,
    Buffer.from(encodedIv, "base64url")
  );
  decipher.setAAD(vaultSecretAad(scope, id, keyVersion));
  decipher.setAuthTag(Buffer.from(encodedTag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encodedCiphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

function decryptLegacyVaultSecret(
  scope: AccessScope,
  id: string,
  value: string,
  secretEncryptionKey: string
) {
  const parts = value.split(".");
  const [format, encodedIv, encodedTag, encodedCiphertext] = parts;
  if (
    parts.length !== 4 ||
    format !== "v1" ||
    !encodedIv ||
    !encodedTag ||
    !encodedCiphertext
  ) {
    throw new Error("The stored secret uses an unsupported format.");
  }

  const decipher = createDecipheriv(
    "aes-256-gcm",
    Buffer.from(secretEncryptionKey, "base64"),
    Buffer.from(encodedIv, "base64url")
  );
  decipher.setAAD(vaultSecretAad(scope, id));
  decipher.setAuthTag(Buffer.from(encodedTag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encodedCiphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

async function recordVaultSecretAccess(
  scope: AccessScope,
  vaultItemId: string,
  access: VaultSecretAccess
) {
  const origin = new URL(access.origin).origin;
  await db.insert(vaultAuditEvents).values({
    action: "secret_accessed",
    createdAt: new Date().toISOString(),
    id: randomUUID(),
    origin,
    purpose: access.purpose,
    userId: scope.userId,
    vaultItemId,
    workspaceId: scope.workspaceId,
  });
}

function vaultSecretAad(scope: AccessScope, id: string, keyVersion?: number) {
  const suffix = keyVersion ? `\u0000v2\u0000${String(keyVersion)}` : "";
  return Buffer.from(`${scope.workspaceId}\u0000vault\u0000${id}${suffix}`);
}
