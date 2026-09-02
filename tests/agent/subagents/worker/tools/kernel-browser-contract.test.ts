/* oxlint-disable typescript/no-unsafe-type-assertion -- Kernel's page type has private members beyond the AsyncIterable contract consumed by the browser tool. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ConflictError } from "@onkernel/sdk";
import type { readActiveBrowserAuthCheckpointForBrowserSession } from "@/db/services/browser-auth-checkpoints";
import type {
  createBrowserSession,
  deleteBrowserSession,
  listBrowserSessions,
  readBrowserSession,
  withBrowserProfileWriteLock,
} from "@/db/services/browsers";
import type { recordBrowserTraceDomains } from "@/db/services/browser-traces";
import type { requireWorkerScope } from "@/agent/subagents/worker/lib/access";
import type { requireOwnedBrowserSession } from "@/agent/subagents/worker/lib/owned-browser";
import type * as TraceDomainsModule from "@/agent/subagents/worker/lib/trace/domains";
import type { harvestBrowserTraceDomains } from "@/agent/subagents/worker/lib/trace/domains";
import { kernel } from "@/lib/kernel";
import { toolContextFor } from "@/tests/helpers/tool-context";
import manageBrowsers, {
  kernelProfileNameForScope,
} from "@/agent/subagents/worker/tools/manage_browsers";

const serviceMocks = vi.hoisted(() => ({
  createBrowserSession: vi.fn<typeof createBrowserSession>(),
  deleteBrowserSession: vi.fn<typeof deleteBrowserSession>(),
  harvestBrowserTraceDomains: vi.fn<typeof harvestBrowserTraceDomains>(),
  listBrowserSessions: vi.fn<typeof listBrowserSessions>(),
  readActiveBrowserAuthCheckpointForBrowserSession:
    vi.fn<typeof readActiveBrowserAuthCheckpointForBrowserSession>(),
  readBrowserSession: vi.fn<typeof readBrowserSession>(),
  recordBrowserTraceDomains: vi.fn<typeof recordBrowserTraceDomains>(),
  requireOwnedBrowserSession: vi.fn<typeof requireOwnedBrowserSession>(),
  requireWorkerScope: vi.fn<typeof requireWorkerScope>(),
  withBrowserProfileWriteLock: vi.fn<typeof withBrowserProfileWriteLock>(),
}));

vi.mock("@/db/services/browser-auth-checkpoints", () => ({
  readActiveBrowserAuthCheckpointForBrowserSession:
    serviceMocks.readActiveBrowserAuthCheckpointForBrowserSession,
}));

vi.mock("@/db/services/browsers", () => ({
  createBrowserSession: serviceMocks.createBrowserSession,
  deleteBrowserSession: serviceMocks.deleteBrowserSession,
  listBrowserSessions: serviceMocks.listBrowserSessions,
  readBrowserSession: serviceMocks.readBrowserSession,
  withBrowserProfileWriteLock: serviceMocks.withBrowserProfileWriteLock,
}));
vi.mock("@/db/services/browser-traces", () => ({
  recordBrowserTraceDomains: serviceMocks.recordBrowserTraceDomains,
}));
vi.mock("@/agent/subagents/worker/lib/access", () => ({
  requireWorkerScope: serviceMocks.requireWorkerScope,
}));
vi.mock("@/agent/subagents/worker/lib/owned-browser", () => ({
  requireOwnedBrowserSession: serviceMocks.requireOwnedBrowserSession,
}));
vi.mock(
  "@/agent/subagents/worker/lib/trace/domains",
  async (importOriginal) => ({
    ...(await importOriginal<typeof TraceDomainsModule>()),
    harvestBrowserTraceDomains: serviceMocks.harvestBrowserTraceDomains,
  })
);

const mocks = {
  createBrowser: vi.spyOn(kernel.browsers, "create"),
  createProfile: vi.spyOn(kernel.profiles, "create"),
  createBrowserSession: serviceMocks.createBrowserSession,
  deleteBrowser: vi.spyOn(kernel.browsers, "deleteByID"),
  deleteBrowserSession: serviceMocks.deleteBrowserSession,
  harvestBrowserTraceDomains: serviceMocks.harvestBrowserTraceDomains,
  listBrowserSessions: serviceMocks.listBrowserSessions,
  listKernelBrowsers: vi.spyOn(kernel.browsers, "list"),
  readBrowserSession: serviceMocks.requireOwnedBrowserSession,
  readStoredBrowserSession: serviceMocks.readBrowserSession,
  readActiveBrowserAuthCheckpointForBrowserSession:
    serviceMocks.readActiveBrowserAuthCheckpointForBrowserSession,
  recordBrowserTraceDomains: serviceMocks.recordBrowserTraceDomains,
  retrieveBrowser: vi.spyOn(kernel.browsers, "retrieve"),
  retrieveProfile: vi.spyOn(kernel.profiles, "retrieve"),
  requireWorkerScope: serviceMocks.requireWorkerScope,
  withBrowserProfileWriteLock: serviceMocks.withBrowserProfileWriteLock,
  updateProfile: vi.spyOn(kernel.profiles, "update"),
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireWorkerScope.mockResolvedValue({
    userId: "user-1",
    workspaceId: "workspace-1",
  });
  mocks.retrieveProfile.mockResolvedValue({
    created_at: "2026-08-27T00:00:00.000Z",
    id: "profile-1",
    name: "opaque-profile",
  });
  mocks.createProfile.mockResolvedValue({
    created_at: "2026-09-02T00:00:00.000Z",
    id: "profile-recovered",
    name: "opaque-profile",
  });
  mocks.updateProfile.mockResolvedValue({
    created_at: "2026-08-27T00:00:00.000Z",
    id: "profile-1",
    name: "opaque-profile-stale",
  });
  mocks.listKernelBrowsers.mockReturnValue(kernelBrowserPage([]));
  mocks.createBrowser.mockResolvedValue({
    browser_live_view_url: "https://live.kernel.test/browser-1",
    cdp_ws_url: "wss://kernel.test/cdp",
    created_at: "2026-08-27T00:00:00.000Z",
    headless: false,
    memory: "2GiB",
    profile: {
      created_at: "2026-08-27T00:00:00.000Z",
      id: "profile-1",
    },
    profile_save_changes: false,
    region: "us-east",
    session_id: "browser-1",
    stealth: true,
    timeout_seconds: 900,
    webdriver_ws_url: "wss://kernel.test/webdriver",
  });
  mocks.deleteBrowser.mockResolvedValue();
  mocks.createBrowserSession.mockResolvedValue();
  mocks.deleteBrowserSession.mockResolvedValue(true);
  mocks.harvestBrowserTraceDomains.mockResolvedValue();
  mocks.listBrowserSessions.mockResolvedValue([]);
  mocks.readActiveBrowserAuthCheckpointForBrowserSession.mockResolvedValue(
    undefined
  );
  mocks.readStoredBrowserSession.mockResolvedValue(undefined);
  mocks.readBrowserSession.mockResolvedValue({
    createdAt: "2026-08-27T00:00:00.000Z",
    sessionId: "browser-1",
    workerSessionId: "worker-session-1",
  });
  mocks.recordBrowserTraceDomains.mockResolvedValue();
  mocks.withBrowserProfileWriteLock.mockImplementation(
    async (_scope, operation) => operation()
  );
});

const workerContext = toolContextFor({ sessionId: "worker-session-1" });

describe("Kernel browser contract", () => {
  it("keeps agent-created browsers alive for at least 15 minutes", () => {
    const inputSchema = manageBrowsers.inputSchema;
    if (!(inputSchema instanceof z.ZodType)) {
      throw new Error("manage_browsers must use a Zod input schema.");
    }

    expect(
      inputSchema.safeParse({
        action: "create",
        timeout_seconds: 120,
      }).success
    ).toBe(false);
    expect(
      inputSchema.safeParse({
        action: "create",
        timeout_seconds: 900,
      }).success
    ).toBe(true);
  });

  it("starts a read-only persistent-profile browser at the target URL", async () => {
    const result = await manageBrowsers.execute(
      { action: "create", start_url: "https://example.com/checkout" },
      workerContext
    );

    expect(result).toMatchObject({
      browser: {
        browser_live_view_url: "https://live.kernel.test/browser-1",
      },
    });
    expect(mocks.createBrowser).toHaveBeenCalledExactlyOnceWith(
      {
        profile: { id: "profile-1", save_changes: false },
        start_url: "https://example.com/checkout",
        stealth: true,
        telemetry: { browser: { page: { enabled: true } }, enabled: true },
        timeout_seconds: 900,
        viewport: undefined,
      },
      { signal: workerContext.abortSignal }
    );
    expect(mocks.createBrowserSession).toHaveBeenCalledExactlyOnceWith(
      { userId: "user-1", workspaceId: "workspace-1" },
      {
        createdAt: "2026-08-27T00:00:00.000Z",
        sessionId: "browser-1",
        workerSessionId: "worker-session-1",
      }
    );
    expect(mocks.recordBrowserTraceDomains).toHaveBeenCalledExactlyOnceWith(
      { userId: "user-1", workspaceId: "workspace-1" },
      "worker-session-1",
      ["example.com"]
    );
    expect(mocks.withBrowserProfileWriteLock).not.toHaveBeenCalled();
  });

  it("harvests visited domains from Kernel telemetry before deleting a browser", async () => {
    mocks.readBrowserSession.mockResolvedValue({
      createdAt: "2026-08-27T00:00:00.000Z",
      sessionId: "browser-1",
      workerSessionId: "worker-session-9",
    });

    const result = await manageBrowsers.execute(
      { action: "delete", session_id: "browser-1" },
      workerContext
    );

    expect(result).toBe("Browser session deleted successfully");
    expect(mocks.harvestBrowserTraceDomains).toHaveBeenCalledExactlyOnceWith(
      { userId: "user-1", workspaceId: "workspace-1" },
      "worker-session-9",
      { createdAt: "2026-08-27T00:00:00.000Z", sessionId: "browser-1" },
      expect.any(AbortSignal)
    );
    expect(
      mocks.harvestBrowserTraceDomains.mock.invocationCallOrder[0]
    ).toBeLessThan(mocks.deleteBrowser.mock.invocationCallOrder[0] ?? 0);
  });

  it("allows only one writable profile browser", async () => {
    mocks.listKernelBrowsers.mockReturnValue(
      kernelBrowserPage([
        {
          profile: { id: "profile-1" },
          profile_save_changes: true,
          session_id: "browser-active",
        },
      ])
    );
    await expect(
      manageBrowsers.execute(
        { action: "create", save_changes: true },
        toolContextFor()
      )
    ).rejects.toThrow(/browser-active.*saving login state/i);
    expect(mocks.withBrowserProfileWriteLock).toHaveBeenCalledOnce();
    expect(mocks.createBrowser).not.toHaveBeenCalled();
  });

  it("clears an old profile writer that has no active authentication checkpoint", async () => {
    const staleCreatedAt = new Date(Date.now() - 11 * 60 * 1000).toISOString();
    mocks.listKernelBrowsers.mockReturnValue(
      kernelBrowserPage([
        {
          created_at: staleCreatedAt,
          profile: { id: "profile-1" },
          profile_save_changes: true,
          session_id: "browser-stale",
        },
      ])
    );
    mocks.readStoredBrowserSession.mockResolvedValue({
      createdAt: staleCreatedAt,
      sessionId: "browser-stale",
      workerSessionId: "worker-stale",
    });

    const result = await manageBrowsers.execute(
      { action: "create", save_changes: true },
      workerContext
    );

    expect(result).toMatchObject({
      browser: { session_id: "browser-1", status: "active" },
    });
    expect(mocks.deleteBrowser).toHaveBeenCalledExactlyOnceWith(
      "browser-stale",
      { signal: workerContext.abortSignal }
    );
    expect(mocks.deleteBrowserSession).toHaveBeenCalledExactlyOnceWith(
      { userId: "user-1", workspaceId: "workspace-1" },
      "browser-stale"
    );
  });

  it("preserves an old profile writer with an active authentication checkpoint", async () => {
    mocks.listKernelBrowsers.mockReturnValue(
      kernelBrowserPage([
        {
          created_at: new Date(Date.now() - 11 * 60 * 1000).toISOString(),
          profile: { id: "profile-1" },
          profile_save_changes: true,
          session_id: "browser-paused",
        },
      ])
    );
    mocks.readActiveBrowserAuthCheckpointForBrowserSession.mockResolvedValue({
      id: "checkpoint-1",
    });

    await expect(
      manageBrowsers.execute(
        { action: "create", save_changes: true },
        workerContext
      )
    ).rejects.toThrow(/browser-paused.*saving login state/i);
    expect(mocks.deleteBrowser).not.toHaveBeenCalled();
  });

  it("waits for an invisible profile write lease to finish", async () => {
    mocks.createBrowser.mockRejectedValueOnce(
      new ConflictError(
        409,
        { message: "The browser profile is locked" },
        undefined,
        new Headers()
      )
    );

    const result = await manageBrowsers.execute(
      { action: "create", save_changes: true },
      workerContext
    );

    expect(result).toMatchObject({
      browser: { session_id: "browser-1", status: "active" },
    });
    expect(mocks.createBrowser).toHaveBeenCalledTimes(2);
    expect(mocks.listKernelBrowsers).toHaveBeenCalledTimes(2);
    expect(mocks.createBrowserSession).toHaveBeenCalledOnce();
  });

  it("preserves and replaces a profile whose invisible write lease never clears", async () => {
    const conflict = new ConflictError(
      409,
      { message: "The browser profile is locked" },
      undefined,
      new Headers()
    );
    for (let attempt = 0; attempt < 7; attempt += 1) {
      mocks.createBrowser.mockRejectedValueOnce(conflict);
    }

    const result = await manageBrowsers.execute(
      { action: "create", save_changes: true },
      workerContext
    );

    expect(result).toMatchObject({
      browser: { session_id: "browser-1", status: "active" },
    });
    expect(mocks.updateProfile).toHaveBeenCalledOnce();
    expect(mocks.createProfile).toHaveBeenCalledExactlyOnceWith(
      { name: "opaque-profile" },
      { signal: workerContext.abortSignal }
    );
    expect(mocks.createBrowser).toHaveBeenLastCalledWith(
      expect.objectContaining({
        profile: { id: "profile-recovered", save_changes: true },
      }),
      { signal: workerContext.abortSignal }
    );
  }, 15_000);

  it("prunes stale owned records when Kernel reports a missing browser", async () => {
    mocks.listBrowserSessions.mockResolvedValue([
      {
        createdAt: "2026-08-27T00:00:00.000Z",
        sessionId: "stale-browser",
      },
    ]);
    mocks.retrieveBrowser.mockRejectedValue({ status: 404 });

    const result = await manageBrowsers.execute(
      { action: "list" },
      toolContextFor()
    );

    expect(result).toEqual({ has_more: false, items: [], next_offset: null });
    expect(mocks.deleteBrowserSession).toHaveBeenCalledExactlyOnceWith(
      { userId: "user-1", workspaceId: "workspace-1" },
      "stale-browser"
    );
  });

  it("derives opaque, stable, user-specific profile names", () => {
    const scope = {
      userId: "+15555550123",
      workspaceId: "shared-workspace",
    };
    const profileName = kernelProfileNameForScope(scope);

    expect(profileName).toBe(kernelProfileNameForScope(scope));
    expect(profileName).toMatch(/^openinstinct-[a-f0-9]{40}$/);
    expect(profileName).not.toContain("15555550123");
    expect(profileName).not.toBe(
      kernelProfileNameForScope({ ...scope, userId: "+15555550124" })
    );
  });
});

function asyncItems<T>(items: readonly T[]): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      yield* items;
    },
  };
}

function kernelBrowserPage(items: readonly unknown[]) {
  // SAFETY: manage_browsers consumes only the SDK page's AsyncIterable contract.
  return asyncItems(items) as ReturnType<typeof kernel.browsers.list>;
}
