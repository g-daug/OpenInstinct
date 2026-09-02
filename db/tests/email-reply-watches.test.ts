import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
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

describe("email reply watches", () => {
  it("isolates requesters, leases checks, and notifies only once", async () => {
    const client = new PGlite();
    databases.push(client);
    await applyMigration(client, "0000_fluffy_the_spike.sql");
    await applyMigration(client, "0009_fine_magik.sql");
    const pgliteDatabase = drizzle(client, { schema });
    // SAFETY: The test swaps only the database driver while retaining the shared Drizzle schema.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- PGlite implements the query-builder surface used by this service.
    vi.spyOn(Database, "db", "get").mockReturnValue(pgliteDatabase as never);

    const scope = await import("@/db/services/scope");
    const watches = await import("@/db/services/email-reply-watches");
    const alice = { userId: "alice", workspaceId: "workspace:alice" };
    const bob = { userId: "bob", workspaceId: "workspace:bob" };
    await scope.ensureScope(alice);
    await scope.ensureScope(bob);
    const now = new Date("2026-09-02T15:00:00.000Z");

    const aliceWatch = await watches.createEmailReplyWatch(
      owner(alice, "linq:alice"),
      {
        emailSubject: "Dinner tonight",
        gmailThreadId: "gmail-thread",
        sentMessageId: "gmail-sent-alice",
      },
      now
    );
    const bobWatch = await watches.createEmailReplyWatch(
      owner(bob, "linq:bob"),
      {
        emailSubject: "Dinner tonight",
        gmailThreadId: "gmail-thread",
        sentMessageId: "gmail-sent-bob",
      },
      now
    );
    expect(aliceWatch).toMatchObject({
      nextCheckAt: "2026-09-02T15:01:00.000Z",
      state: "active",
    });
    expect(bobWatch).toMatchObject({ state: "active" });

    const claimed = await watches.claimDueEmailReplyWatches({
      leaseForMs: 300_000,
      limit: 10,
      now: new Date("2026-09-02T15:01:30.000Z"),
    });
    expect(claimed).toHaveLength(2);
    const aliceJob = claimed.find(
      (job) => job.auth.principalId === alice.userId
    );
    const bobJob = claimed.find((job) => job.auth.principalId === bob.userId);
    if (!aliceJob || !bobJob) throw new Error("Expected both leased watches.");
    expect(aliceJob).toMatchObject({
      gmailThreadId: "gmail-thread",
      linqThreadId: "linq:alice",
      sentMessageId: "gmail-sent-alice",
    });

    await watches.recordEmailReplyDetection(aliceJob, {
      detectedAt: new Date("2026-09-02T15:01:40.000Z"),
      replyMessageId: "gmail-reply-alice",
    });
    await watches.completeEmailReplyWatchPoll(
      aliceJob,
      new Date("2026-09-02T15:01:45.000Z")
    );
    await watches.completeEmailReplyWatchPoll(
      bobJob,
      new Date("2026-09-02T15:01:45.000Z")
    );

    const rows = await pgliteDatabase.select().from(schema.emailReplyWatches);
    expect(
      rows.find((row) => row.createdByUserId === alice.userId)
    ).toMatchObject({
      notifiedAt: "2026-09-02T15:01:45.000Z",
      replyMessageId: "gmail-reply-alice",
      state: "notified",
    });
    expect(
      rows.find((row) => row.createdByUserId === bob.userId)
    ).toMatchObject({
      nextCheckAt: "2026-09-02T15:03:45.000Z",
      notifiedAt: null,
      state: "active",
    });

    await expect(
      watches.claimDueEmailReplyWatches({
        leaseForMs: 300_000,
        limit: 10,
        now: new Date("2026-09-02T15:03:46.000Z"),
      })
    ).resolves.toEqual([expect.objectContaining({ linqThreadId: "linq:bob" })]);

    await watches.createEmailReplyWatch(
      owner(alice, "linq:alice"),
      {
        emailSubject: "Updated dinner",
        gmailThreadId: "gmail-thread",
        sentMessageId: "gmail-sent-alice-2",
      },
      new Date("2026-09-02T16:00:00.000Z")
    );
    const [reset] = await pgliteDatabase
      .select()
      .from(schema.emailReplyWatches)
      .where(eq(schema.emailReplyWatches.createdByUserId, alice.userId));
    expect(reset).toMatchObject({
      emailSubject: "Updated dinner",
      notifiedAt: null,
      replyMessageId: null,
      sentMessageId: "gmail-sent-alice-2",
      state: "active",
    });
  });
});

function owner(
  scope: { readonly userId: string; readonly workspaceId: string },
  linqThreadId: string
) {
  return {
    auth: {
      attributes: { linqThreadId, workspaceId: scope.workspaceId },
      authenticator: "linq-message",
      issuer: "linq",
      principalId: scope.userId,
      principalType: "user" as const,
      subject: `${scope.userId}-subject`,
    },
    linqThreadId,
    scope,
  };
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
