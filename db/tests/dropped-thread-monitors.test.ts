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

describe("dropped-thread monitors", () => {
  it("isolates owners, leases daily runs, and suppresses repeated findings", async () => {
    const client = new PGlite();
    databases.push(client);
    await applyMigration(client, "0000_fluffy_the_spike.sql");
    await applyMigration(client, "0008_groovy_scream.sql");
    const pgliteDatabase = drizzle(client, { schema });
    // SAFETY: The test swaps only the database driver while retaining the shared Drizzle schema.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- PGlite implements the query-builder surface used by this service.
    vi.spyOn(Database, "db", "get").mockReturnValue(pgliteDatabase as never);

    const scope = await import("@/db/services/scope");
    const monitors = await import("@/db/services/dropped-thread-monitors");
    const alice = { userId: "alice", workspaceId: "workspace:alice" };
    const bob = { userId: "bob", workspaceId: "workspace:bob" };
    await scope.ensureScope(alice);
    await scope.ensureScope(bob);

    const saved = await monitors.saveDroppedThreadMonitor(
      {
        auth: {
          attributes: {
            linqThreadId: "linq:alice",
            phoneNumber: "+12025550123",
            workspaceId: alice.workspaceId,
          },
          authenticator: "linq-message",
          issuer: "linq",
          principalId: alice.userId,
          principalType: "user",
          subject: "alice-subject",
        },
        linqThreadId: "linq:alice",
        phoneNumber: "+12025550123",
        scope: alice,
      },
      {
        localHour: 9,
        localMinute: 15,
        lookbackDays: 14,
        minimumAgeHours: 48,
        timezone: "America/Chicago",
      },
      new Date("2026-09-01T12:00:00.000Z")
    );
    expect(saved).toMatchObject({
      enabled: true,
      nextRunAt: "2026-09-01T14:15:00.000Z",
    });
    expect(await monitors.readDroppedThreadMonitor(bob)).toBeUndefined();

    const claimed = await monitors.claimDueDroppedThreadMonitors({
      leaseForMs: 300_000,
      limit: 10,
      now: new Date("2026-09-01T14:16:00.000Z"),
    });
    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({
      linqThreadId: "linq:alice",
      lookbackDays: 14,
      minimumAgeHours: 48,
    });
    if (!claimed[0]) throw new Error("Expected a claimed monitor.");

    const first = await monitors.claimDroppedThreadFindingsForNotification({
      detectedAt: new Date("2026-09-01T14:17:00.000Z"),
      monitorId: claimed[0].id,
      sourceThreadIds: ["gmail-a", "gmail-b", "gmail-a"],
    });
    expect(first).toEqual(["gmail-a", "gmail-b"]);
    await expect(
      monitors.claimDroppedThreadFindingsForNotification({
        detectedAt: new Date("2026-09-01T14:18:00.000Z"),
        monitorId: claimed[0].id,
        sourceThreadIds: ["gmail-a", "gmail-b"],
      })
    ).resolves.toEqual([]);

    const snoozedUntil = new Date(Date.now() + 10 * 24 * 60 * 60_000);
    expect(
      await monitors.snoozeDroppedThreadFinding(alice, "gmail-a", snoozedUntil)
    ).toBe(true);
    expect(await monitors.dismissDroppedThreadFinding(alice, "gmail-b")).toBe(
      true
    );
    expect(await monitors.dismissDroppedThreadFinding(bob, "gmail-a")).toBe(
      false
    );

    const later = await monitors.claimDroppedThreadFindingsForNotification({
      detectedAt: new Date("2026-09-09T14:17:00.000Z"),
      monitorId: claimed[0].id,
      sourceThreadIds: ["gmail-a", "gmail-b", "gmail-c"],
    });
    expect(later).toEqual(["gmail-c"]);
    expect(await monitors.listDroppedThreadFindings(alice)).toEqual([
      expect.objectContaining({ sourceThreadId: "gmail-a", state: "snoozed" }),
      expect.objectContaining({
        sourceThreadId: "gmail-b",
        state: "dismissed",
      }),
      expect.objectContaining({ sourceThreadId: "gmail-c", state: "open" }),
    ]);
    expect(await monitors.listDroppedThreadFindings(bob)).toEqual([]);

    await monitors.completeDroppedThreadMonitor(
      claimed[0],
      new Date("2026-09-01T14:20:00.000Z")
    );
    expect(await monitors.readDroppedThreadMonitor(alice)).toMatchObject({
      lastRunAt: "2026-09-01T14:20:00.000Z",
      nextRunAt: "2026-09-02T14:15:00.000Z",
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
