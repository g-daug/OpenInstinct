import { describe, expect, it } from "vitest";
import { z } from "zod";

import captureBrowserImage from "@/agent/subagents/worker/tools/capture_browser_image";
import manageAuthCheckpoint from "@/agent/subagents/worker/tools/manage_auth_checkpoint";
import browserAuthResume from "@/agent/tools/browser_auth_resume";
import cancelFollowUp from "@/agent/tools/cancel_follow_up";
import createFollowUp from "@/agent/tools/create_follow_up";
import googleWorkspaceRead from "@/agent/tools/google_workspace_read";
import googleWorkspaceWrite from "@/agent/tools/google_workspace_write";
import linearRead from "@/agent/tools/linear_read";
import listFollowUps from "@/agent/tools/list_follow_ups";
import manageDroppedThreadMonitor from "@/agent/tools/manage_dropped_thread_monitor";
import requestVaultImport from "@/agent/tools/request_vault_import";
import requestVaultSetup from "@/agent/tools/request_vault_setup";
import reviewDroppedThreadMonitor from "@/agent/tools/review_dropped_thread_monitor";
import updateFollowUp from "@/agent/tools/update_follow_up";

const tools = [
  ["browser_auth_resume", browserAuthResume],
  ["cancel_follow_up", cancelFollowUp],
  ["capture_browser_image", captureBrowserImage],
  ["create_follow_up", createFollowUp],
  ["google_workspace_read", googleWorkspaceRead],
  ["google_workspace_write", googleWorkspaceWrite],
  ["linear_read", linearRead],
  ["list_follow_ups", listFollowUps],
  ["manage_auth_checkpoint", manageAuthCheckpoint],
  ["manage_dropped_thread_monitor", manageDroppedThreadMonitor],
  ["request_vault_import", requestVaultImport],
  ["request_vault_setup", requestVaultSetup],
  ["review_dropped_thread_monitor", reviewDroppedThreadMonitor],
  ["update_follow_up", updateFollowUp],
] as const;

describe("agent tool JSON schemas", () => {
  it.each(tools)("publishes an object type for %s", (_name, tool) => {
    const { inputSchema } = tool;
    if (!(inputSchema instanceof z.ZodType)) {
      throw new Error("Expected the tool input schema to be a Zod schema.");
    }
    const jsonSchema = z.toJSONSchema(inputSchema, { io: "input" });
    expect(jsonSchema).toMatchObject({
      type: "object",
    });
    expect(jsonSchema).not.toHaveProperty("allOf");
    expect(jsonSchema).not.toHaveProperty("anyOf");
    expect(jsonSchema).not.toHaveProperty("oneOf");
  });
});
