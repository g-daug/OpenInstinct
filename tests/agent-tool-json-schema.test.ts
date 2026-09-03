import { describe, expect, it } from "vitest";
import { z } from "zod";

import captureBrowserImage from "@/agent/subagents/worker/tools/capture_browser_image";
import manageAuthCheckpoint from "@/agent/subagents/worker/tools/manage_auth_checkpoint";
import browserAuthResume from "@/agent/tools/browser_auth_resume";
import googleWorkspaceRead from "@/agent/tools/google_workspace_read";
import googleWorkspaceWrite from "@/agent/tools/google_workspace_write";
import manageDroppedThreadMonitor from "@/agent/tools/manage_dropped_thread_monitor";
import reviewDroppedThreadMonitor from "@/agent/tools/review_dropped_thread_monitor";

const tools = [
  ["browser_auth_resume", browserAuthResume],
  ["capture_browser_image", captureBrowserImage],
  ["google_workspace_read", googleWorkspaceRead],
  ["google_workspace_write", googleWorkspaceWrite],
  ["manage_auth_checkpoint", manageAuthCheckpoint],
  ["manage_dropped_thread_monitor", manageDroppedThreadMonitor],
  ["review_dropped_thread_monitor", reviewDroppedThreadMonitor],
] as const;

describe("agent tool JSON schemas", () => {
  it.each(tools)("publishes an object type for %s", (_name, tool) => {
    const { inputSchema } = tool;
    if (!(inputSchema instanceof z.ZodType)) {
      throw new Error("Expected the tool input schema to be a Zod schema.");
    }
    expect(z.toJSONSchema(inputSchema)).toMatchObject({
      type: "object",
    });
  });
});
