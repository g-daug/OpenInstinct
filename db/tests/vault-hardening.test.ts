import { createCipheriv, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Database from "@/db";
import type { AccessScope } from "@/lib/access-scope";
import { serializeLoginVaultPayload } from "@/lib/vault";
import * as schema from "../schema";
import { vaultAuditEvents, vaultEncryptionKeys } from "../schema";

const databases: PGlite[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  vi.resetModules();
  await Promise.all(databases.splice(0).map((database) => database.close()));
});

describe("vault hardening", () => {
  it("isolates workspace data keys, audits access, and upgrades legacy ciphertext", async () => {
    const client = new PGlite();
    databases.push(client);
    await applyMigration(client, "0000_fluffy_the_spike.sql");
    await applyMigration(client, "0012_regular_blur.sql");

    const pgliteDatabase = drizzle(client, { schema });
    // SAFETY: PGlite implements the query-builder surface exercised by these services despite using a different Drizzle driver.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- This test swaps only the driver while retaining the shared Drizzle schema and query-builder contract.
    vi.spyOn(Database, "db", "get").mockReturnValue(pgliteDatabase as never);

    const [scopeService, secrets, vault] = await Promise.all([
      import("@/db/services/scope"),
      import("@/db/services/secrets"),
      import("@/db/services/vault"),
    ]);
    const alice = { userId: "alice", workspaceId: "workspace:alice" };
    const bob = { userId: "bob", workspaceId: "workspace:bob" };
    await scopeService.ensureScope(alice);
    await scopeService.ensureScope(bob);

    await vault.saveVaultItem(alice, login("alice@example.com"));
    await vault.saveVaultItem(bob, login("bob@example.com"));
    const [aliceItem] = await vault.listVaultItems(alice);
    const [bobItem] = await vault.listVaultItems(bob);
    if (!aliceItem || !bobItem) throw new Error("Expected saved vault items.");

    const keys = await pgliteDatabase
      .select()
      .from(vaultEncryptionKeys)
      .orderBy(vaultEncryptionKeys.workspaceId);
    expect(keys).toHaveLength(2);
    expect(keys.map(({ encryptedKey }) => encryptedKey)).toEqual([
      expect.stringMatching(/^wk1\./u),
      expect.stringMatching(/^wk1\./u),
    ]);
    expect(keys[0]?.encryptedKey).not.toBe(keys[1]?.encryptedKey);

    const aliceCiphertext = await encryptedValue(
      client,
      alice.workspaceId,
      aliceItem.id
    );
    expect(aliceCiphertext).toMatch(/^v2\.1\./u);
    expect(aliceCiphertext).not.toContain("correct horse");

    await expect(
      vault.readVaultSecret(alice, aliceItem.id, {
        origin: "https://example.com/login?source=test",
        purpose: "autofill",
      })
    ).resolves.toContain("correct horse");

    await secrets.writeEncryptedSecret(bob, aliceItem.id, aliceCiphertext);
    await expect(
      vault.readVaultSecret(bob, aliceItem.id, {
        origin: "https://example.com",
        purpose: "autofill",
      })
    ).rejects.toThrow(/authenticate/u);

    const legacySecret = "legacy correct horse";
    await secrets.writeEncryptedSecret(
      alice,
      aliceItem.id,
      encryptLegacySecret(alice, aliceItem.id, legacySecret)
    );
    await expect(
      vault.readVaultSecret(alice, aliceItem.id, {
        origin: "https://example.com/account",
        purpose: "availability_check",
      })
    ).resolves.toBe(legacySecret);
    const upgradedCiphertext = await encryptedValue(
      client,
      alice.workspaceId,
      aliceItem.id
    );
    expect(upgradedCiphertext).toMatch(/^v2\.1\./u);
    await secrets.writeEncryptedSecret(
      alice,
      aliceItem.id,
      `${upgradedCiphertext}.unexpected`
    );
    await expect(
      vault.readVaultSecret(alice, aliceItem.id, {
        origin: "https://example.com",
        purpose: "autofill",
      })
    ).rejects.toThrow("unsupported format");

    const auditEvents = await pgliteDatabase
      .select()
      .from(vaultAuditEvents)
      .orderBy(vaultAuditEvents.createdAt);
    expect(auditEvents).toHaveLength(2);
    expect(auditEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          origin: "https://example.com",
          purpose: "autofill",
          userId: alice.userId,
          vaultItemId: aliceItem.id,
          workspaceId: alice.workspaceId,
        }),
        expect.objectContaining({
          origin: "https://example.com",
          purpose: "availability_check",
          userId: alice.userId,
          vaultItemId: aliceItem.id,
          workspaceId: alice.workspaceId,
        }),
      ])
    );
  });
});

function login(identifier: string) {
  return {
    account: identifier,
    kind: "login" as const,
    label: identifier,
    secret: serializeLoginVaultPayload({
      authentication: { password: "correct horse", type: "password" },
      identifier: { type: "email", value: identifier },
      kind: "login",
      origin: "https://example.com",
      version: 2,
    }),
  };
}

async function encryptedValue(
  database: PGlite,
  workspaceId: string,
  id: string
) {
  const result = await database.query<{ encryptedValue: string }>(
    `SELECT encrypted_value AS "encryptedValue"
     FROM encrypted_secrets
     WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, id]
  );
  const match = result.rows[0];
  if (!match) throw new Error(`Expected encrypted secret ${id}.`);
  return match.encryptedValue;
}

function encryptLegacySecret(
  scope: AccessScope,
  id: string,
  plaintext: string
) {
  const iv = randomBytes(12);
  const key = Buffer.alloc(32, 1);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(`${scope.workspaceId}\u0000vault\u0000${id}`));
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  return [
    "v1",
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

async function applyMigration(database: PGlite, name: string) {
  const migration = await readFile(
    new URL(`../migrations/${name}`, import.meta.url),
    "utf8"
  );
  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.trim()) await database.exec(statement);
  }
}
