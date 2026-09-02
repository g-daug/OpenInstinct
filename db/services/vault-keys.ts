import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { AccessScope } from "@/lib/access-scope";
import { db, vaultEncryptionKeys } from "@/db";
import { ensureScope } from "@/db/services/scope";
import { getInstallationSecrets } from "@/lib/installation-secrets";

const wrappedKeySchema = z.object({
  encryptedKey: z.string(),
  version: z.number().int().positive(),
});

export async function readActiveVaultDataKey(scope: AccessScope) {
  await ensureScope(scope);
  const existing = await readLatestWrappedKey(scope);
  if (existing) return unwrapStoredKey(scope, existing);

  const version = 1;
  const { secretEncryptionKey } = await getInstallationSecrets();
  const encryptedKey = wrapDataKey(
    scope,
    version,
    randomBytes(32),
    secretEncryptionKey
  );
  await db
    .insert(vaultEncryptionKeys)
    .values({
      createdAt: new Date().toISOString(),
      encryptedKey,
      version,
      workspaceId: scope.workspaceId,
    })
    .onConflictDoNothing({
      target: [vaultEncryptionKeys.workspaceId, vaultEncryptionKeys.version],
    });

  const stored = await readLatestWrappedKey(scope);
  if (!stored) throw new Error("The workspace vault key is unavailable.");
  return unwrapStoredKey(scope, stored);
}

export async function readVaultDataKey(scope: AccessScope, version: number) {
  const rows = await db
    .select({
      encryptedKey: vaultEncryptionKeys.encryptedKey,
      version: vaultEncryptionKeys.version,
    })
    .from(vaultEncryptionKeys)
    .where(
      and(
        eq(vaultEncryptionKeys.workspaceId, scope.workspaceId),
        eq(vaultEncryptionKeys.version, version)
      )
    )
    .limit(1);
  const stored = wrappedKeySchema.optional().parse(rows[0]);
  if (!stored) {
    throw new Error(
      `Vault encryption key version ${String(version)} is unavailable.`
    );
  }
  return unwrapStoredKey(scope, stored);
}

async function readLatestWrappedKey(scope: AccessScope) {
  const rows = await db
    .select({
      encryptedKey: vaultEncryptionKeys.encryptedKey,
      version: vaultEncryptionKeys.version,
    })
    .from(vaultEncryptionKeys)
    .where(eq(vaultEncryptionKeys.workspaceId, scope.workspaceId))
    .orderBy(desc(vaultEncryptionKeys.version))
    .limit(1);
  return wrappedKeySchema.optional().parse(rows[0]);
}

async function unwrapStoredKey(
  scope: AccessScope,
  stored: z.infer<typeof wrappedKeySchema>
) {
  const { secretEncryptionKey } = await getInstallationSecrets();
  return unwrapDataKey(
    scope,
    stored.version,
    stored.encryptedKey,
    secretEncryptionKey
  );
}

function wrapDataKey(
  scope: AccessScope,
  version: number,
  dataKey: Buffer,
  installationKey: string
) {
  const iv = randomBytes(12);
  const cipher = createCipheriv(
    "aes-256-gcm",
    deriveKeyWrappingKey(installationKey),
    iv
  );
  cipher.setAAD(vaultKeyAad(scope, version));
  const ciphertext = Buffer.concat([cipher.update(dataKey), cipher.final()]);
  return [
    "wk1",
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

function unwrapDataKey(
  scope: AccessScope,
  version: number,
  value: string,
  installationKey: string
) {
  const parts = value.split(".");
  const [format, encodedIv, encodedTag, encodedCiphertext] = parts;
  if (
    parts.length !== 4 ||
    format !== "wk1" ||
    !encodedIv ||
    !encodedTag ||
    !encodedCiphertext
  ) {
    throw new Error(
      "The stored workspace vault key uses an unsupported format."
    );
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    deriveKeyWrappingKey(installationKey),
    Buffer.from(encodedIv, "base64url")
  );
  decipher.setAAD(vaultKeyAad(scope, version));
  decipher.setAuthTag(Buffer.from(encodedTag, "base64url"));
  const dataKey = Buffer.concat([
    decipher.update(Buffer.from(encodedCiphertext, "base64url")),
    decipher.final(),
  ]);
  if (dataKey.byteLength !== 32) {
    throw new Error("The stored workspace vault key is invalid.");
  }
  return { key: dataKey, version };
}

function deriveKeyWrappingKey(installationKey: string) {
  return Buffer.from(
    hkdfSync(
      "sha256",
      Buffer.from(installationKey, "base64"),
      Buffer.from("openinstinct:vault:key-wrapping:v1"),
      Buffer.from("aes-256-gcm"),
      32
    )
  );
}

function vaultKeyAad(scope: AccessScope, version: number) {
  return Buffer.from(
    `${scope.workspaceId}\u0000vault-key\u0000${String(version)}`
  );
}
