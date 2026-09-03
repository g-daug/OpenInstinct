import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Database from "@/db";
import * as schema from "../schema";

const databases: PGlite[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  vi.resetModules();
  await Promise.all(databases.splice(0).map((database) => database.close()));
});

describe("Google email send audit", () => {
  it("records the requester, sender account, recipients, and Gmail result", async () => {
    const client = new PGlite();
    databases.push(client);
    await applyMigration(client, "0000_fluffy_the_spike.sql");
    await applyMigration(client, "0009_fine_magik.sql");
    await applyMigration(client, "0013_eager_pepper_potts.sql");
    const pgliteDatabase = drizzle(client, { schema });
    // SAFETY: The test swaps only the database driver while retaining the shared Drizzle schema.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- PGlite implements the query-builder surface used by this service.
    vi.spyOn(Database, "db", "get").mockReturnValue(pgliteDatabase as never);

    const scopeService = await import("@/db/services/scope");
    const audit = await import("@/db/services/google-email-send-audit");
    const scope = { userId: "alice", workspaceId: "workspace:alice" };
    await scopeService.ensureScope(scope);

    const request = {
      account: "dedicated" as const,
      bcc: ["audit@example.com"],
      cc: [],
      requestKey: "session-1:call-1",
      scope,
      sessionId: "session-1",
      subject: "Project update",
      to: ["recipient@example.com"],
    };
    await audit.beginGoogleEmailSendAudit(request);
    await audit.beginGoogleEmailSendAudit(request);
    await audit.completeGoogleEmailSendAudit(request.requestKey, {
      messageId: "gmail-message-1",
      threadId: "gmail-thread-1",
    });

    const rows = await pgliteDatabase
      .select()
      .from(schema.googleEmailSendAuditEvents);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      emailSubject: "Project update",
      gmailMessageId: "gmail-message-1",
      gmailThreadId: "gmail-thread-1",
      googleAccount: "dedicated",
      requestedByUserId: "alice",
      sessionId: "session-1",
      status: "sent",
      workspaceId: "workspace:alice",
    });
    expect(JSON.parse(rows[0]?.recipients ?? "")).toEqual({
      bcc: ["audit@example.com"],
      cc: [],
      to: ["recipient@example.com"],
    });
  });
});

async function applyMigration(database: PGlite, name: string) {
  const migration = await readFile(
    new URL(`../migrations/${name}`, import.meta.url),
    "utf8"
  );
  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.trim()) await database.exec(statement);
  }
}
