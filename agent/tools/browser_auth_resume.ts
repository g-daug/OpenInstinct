import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  bindBrowserAuthCheckpointAgent,
  finishBrowserAuthCheckpoint,
  markBrowserAuthCheckpointResuming,
  readBrowserAuthCheckpoint,
  readPendingBrowserAuthCheckpoint,
} from "@/db/services/browser-auth-checkpoints";
import { scopeFromPrincipal } from "@/lib/access-scope";

const inputSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("pending") }),
  z.object({
    action: z.literal("bind"),
    checkpoint_id: z.uuid(),
    worker_agent_id: z.string().trim().min(1).max(200),
  }),
  z.object({ action: z.literal("resume"), checkpoint_id: z.uuid() }),
  z.object({ action: z.literal("cancel"), checkpoint_id: z.uuid() }),
]);

export default defineTool({
  description:
    "Safely inspect, resume, or cancel the current user's pending browser-authentication checkpoint. Use pending when a message may answer an OTP or other authentication request. Use resume when the user supplied the requested transient input, confirmed the requested action, reports that a code never arrived, or asks to use another verification method; then call the worker with the returned worker_agent_id. Never store the user's code or include it in this tool.",
  inputSchema,
  async execute(input, context) {
    const caller =
      context.session.auth.current ?? context.session.auth.initiator;
    if (caller?.principalType !== "user") {
      throw new Error("An authenticated user is required.");
    }
    const scope = scopeFromPrincipal(caller);

    if (input.action === "pending") {
      const checkpoint = await readPendingBrowserAuthCheckpoint(
        scope,
        context.session.id
      );
      return checkpoint ? publicCheckpoint(checkpoint) : null;
    }

    if (input.action === "bind") {
      const checkpoint = await bindBrowserAuthCheckpointAgent(
        scope,
        input.checkpoint_id,
        context.session.id,
        input.worker_agent_id
      );
      if (!checkpoint) {
        throw new Error(
          "Authentication checkpoint not found for this conversation."
        );
      }
      return publicCheckpoint(checkpoint);
    }

    const checkpoint = await readBrowserAuthCheckpoint(
      scope,
      input.checkpoint_id
    );
    if (!checkpoint || checkpoint.rootSessionId !== context.session.id) {
      throw new Error(
        "Authentication checkpoint not found for this conversation."
      );
    }

    if (input.action === "cancel") {
      const cancelled = await finishBrowserAuthCheckpoint(
        scope,
        checkpoint.id,
        "cancelled"
      );
      if (!cancelled)
        throw new Error("Authentication checkpoint is no longer active.");
      return { checkpoint_id: cancelled.id, status: cancelled.status };
    }

    if (!checkpoint.workerAgentId) {
      throw new Error(
        "Authentication checkpoint is missing its resumable worker."
      );
    }

    const resuming = await markBrowserAuthCheckpointResuming(
      scope,
      checkpoint.id
    );
    if (!resuming) {
      throw new Error(
        "Authentication checkpoint is expired or already resumed."
      );
    }
    return {
      ...publicCheckpoint(resuming),
      worker_agent_id: resuming.workerAgentId,
    };
  },
});

function publicCheckpoint(
  checkpoint: NonNullable<Awaited<ReturnType<typeof readBrowserAuthCheckpoint>>>
) {
  return {
    challenge_type: checkpoint.challengeType,
    checkpoint_id: checkpoint.id,
    expires_at: checkpoint.expiresAt,
    origin: checkpoint.origin,
    prompt: checkpoint.prompt,
    status: checkpoint.status,
  };
}
