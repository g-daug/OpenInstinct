/* oxlint-disable typescript/no-unsafe-type-assertion -- Kernel's SDK response type is broader than the delete result exercised by this focused tool test. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  createBrowserAuthCheckpoint,
  finishBrowserAuthCheckpoint,
  readBrowserAuthCheckpoint,
} from "@/db/services/browser-auth-checkpoints";
import type { deleteBrowserSession } from "@/db/services/browsers";
import type { requireWorkerScope } from "@/agent/subagents/worker/lib/access";
import type { requireOwnedBrowserSession } from "@/agent/subagents/worker/lib/owned-browser";
import type { harvestBrowserTraceDomains } from "@/agent/subagents/worker/lib/trace/domains";
import { kernel } from "@/lib/kernel";
import { toolContextFor } from "@/tests/helpers/tool-context";
import manageAuthCheckpoint from "@/agent/subagents/worker/tools/manage_auth_checkpoint";

const serviceMocks = vi.hoisted(() => ({
  createBrowserAuthCheckpoint: vi.fn<typeof createBrowserAuthCheckpoint>(),
  deleteBrowserSession: vi.fn<typeof deleteBrowserSession>(),
  finishBrowserAuthCheckpoint: vi.fn<typeof finishBrowserAuthCheckpoint>(),
  harvestBrowserTraceDomains: vi.fn<typeof harvestBrowserTraceDomains>(),
  readBrowserAuthCheckpoint: vi.fn<typeof readBrowserAuthCheckpoint>(),
  requireOwnedBrowserSession: vi.fn<typeof requireOwnedBrowserSession>(),
  requireWorkerScope: vi.fn<typeof requireWorkerScope>(),
}));

vi.mock("@/db/services/browser-auth-checkpoints", async (importOriginal) => ({
  ...(await importOriginal()),
  createBrowserAuthCheckpoint: serviceMocks.createBrowserAuthCheckpoint,
  finishBrowserAuthCheckpoint: serviceMocks.finishBrowserAuthCheckpoint,
  readBrowserAuthCheckpoint: serviceMocks.readBrowserAuthCheckpoint,
}));
vi.mock("@/db/services/browsers", () => ({
  deleteBrowserSession: serviceMocks.deleteBrowserSession,
}));
vi.mock("@/agent/subagents/worker/lib/access", () => ({
  requireWorkerScope: serviceMocks.requireWorkerScope,
}));
vi.mock("@/agent/subagents/worker/lib/owned-browser", () => ({
  requireOwnedBrowserSession: serviceMocks.requireOwnedBrowserSession,
}));
vi.mock("@/agent/subagents/worker/lib/trace/domains", () => ({
  harvestBrowserTraceDomains: serviceMocks.harvestBrowserTraceDomains,
}));

const deleteBrowser = vi.spyOn(kernel.browsers, "deleteByID");
const checkpointId = "0d01e667-d128-4bb7-a248-1ae21db72f4f";

beforeEach(() => {
  vi.clearAllMocks();
  serviceMocks.requireWorkerScope.mockResolvedValue({
    userId: "user-1",
    workspaceId: "workspace-1",
  });
  serviceMocks.requireOwnedBrowserSession.mockResolvedValue({
    createdAt: "2026-09-02T19:00:00.000Z",
    sessionId: "browser-1",
    workerSessionId: "worker-1",
  });
  serviceMocks.harvestBrowserTraceDomains.mockResolvedValue();
  deleteBrowser.mockResolvedValue();
  serviceMocks.deleteBrowserSession.mockResolvedValue(true);
  serviceMocks.createBrowserAuthCheckpoint.mockResolvedValue({
    browserSessionId: "browser-1",
    challengeType: "vault_login",
    createdAt: "2026-09-02T19:00:00.000Z",
    createdByUserId: "user-1",
    expiresAt: "2026-09-02T19:15:00.000Z",
    id: checkpointId,
    origin: "https://app.slack.com",
    prompt: "Add a saved login for https://app.slack.com, then say done.",
    rootSessionId: "root-1",
    status: "pending",
    updatedAt: "2026-09-02T19:00:00.000Z",
    workerAgentId: null,
    workerSessionId: "worker-1",
    workspaceId: "workspace-1",
  });
});

describe("browser authentication checkpoints", () => {
  it("closes a writable browser before pausing for vault login setup", async () => {
    const context = toolContextFor({
      parentSessionId: "root-1",
      sessionId: "worker-1",
    });
    const result = await manageAuthCheckpoint.execute(
      {
        action: "pause",
        browser_session_id: "browser-1",
        challenge_type: "vault_login",
        expires_in_seconds: 900,
        origin: "https://app.slack.com",
      },
      context
    );

    expect(result).toMatchObject({
      browser_disposition: "closed",
      checkpoint_id: checkpointId,
    });
    expect(deleteBrowser).toHaveBeenCalledExactlyOnceWith("browser-1", {
      signal: context.abortSignal,
    });
    expect(serviceMocks.deleteBrowserSession).toHaveBeenCalledExactlyOnceWith(
      { userId: "user-1", workspaceId: "workspace-1" },
      "browser-1"
    );
    expect(deleteBrowser.mock.invocationCallOrder[0]).toBeLessThan(
      serviceMocks.createBrowserAuthCheckpoint.mock.invocationCallOrder[0] ??
        Infinity
    );
  });

  it("preserves the browser for a transient one-time-code challenge", async () => {
    serviceMocks.createBrowserAuthCheckpoint.mockResolvedValueOnce({
      browserSessionId: "browser-1",
      challengeType: "otp_sms",
      createdAt: "2026-09-02T19:00:00.000Z",
      createdByUserId: "user-1",
      expiresAt: "2026-09-02T19:15:00.000Z",
      id: checkpointId,
      origin: "https://app.slack.com",
      prompt: "Send the one-time code requested by https://app.slack.com.",
      rootSessionId: "root-1",
      status: "pending",
      updatedAt: "2026-09-02T19:00:00.000Z",
      workerAgentId: null,
      workerSessionId: "worker-1",
      workspaceId: "workspace-1",
    });
    const result = await manageAuthCheckpoint.execute(
      {
        action: "pause",
        browser_session_id: "browser-1",
        challenge_type: "otp_sms",
        expires_in_seconds: 900,
        origin: "https://app.slack.com",
      },
      toolContextFor({ parentSessionId: "root-1", sessionId: "worker-1" })
    );

    expect(result).toMatchObject({ browser_disposition: "preserved" });
    expect(deleteBrowser).not.toHaveBeenCalled();
    expect(serviceMocks.deleteBrowserSession).not.toHaveBeenCalled();
  });
});
