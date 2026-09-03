import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  browserAuthChallengeTypes,
  createBrowserAuthCheckpoint,
  finishBrowserAuthCheckpoint,
  readBrowserAuthCheckpoint,
} from "@/db/services/browser-auth-checkpoints";
import { deleteBrowserSession } from "@/db/services/browsers";
import { requireWorkerScope } from "@/agent/subagents/worker/lib/access";
import { requireOwnedBrowserSession } from "@/agent/subagents/worker/lib/owned-browser";
import { harvestBrowserTraceDomains } from "@/agent/subagents/worker/lib/trace/domains";
import { kernel } from "@/lib/kernel";

const inputSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("pause"),
    browser_session_id: z.string().trim().min(1),
    challenge_type: z.enum(browserAuthChallengeTypes),
    expires_in_seconds: z.number().int().min(60).max(3600).default(1800),
    origin: z.url(),
  }),
  z.object({
    action: z.enum(["complete", "fail"]),
    checkpoint_id: z.uuid(),
  }),
]);

export default defineTool({
  description:
    "Persist or finish a browser authentication checkpoint. Pause immediately before returning an OTP, push, passkey, CAPTCHA, login-setup, approval, or other authentication blocker. Checkpoints remain active for 30 minutes by default. The tool creates a safe prompt and never accepts secret-bearing text. Complete or fail the checkpoint when the resumed browser task reaches a terminal state.",
  inputSchema,
  async execute(input, context) {
    const scope = await requireWorkerScope(context);
    const parent = context.session.parent;
    if (!parent)
      throw new Error("Authentication checkpoints require a parent session.");

    if (input.action === "pause") {
      const browser = await requireOwnedBrowserSession(
        scope,
        input.browser_session_id
      );
      const origin = new URL(input.origin).origin;
      if (origin !== input.origin) {
        throw new Error(
          "Authentication checkpoint origin must not include a path."
        );
      }
      if (input.challenge_type === "vault_login") {
        await closeBrowserForVaultSetup(
          scope,
          browser,
          context.session.id,
          context.abortSignal
        );
      }
      const checkpoint = await createBrowserAuthCheckpoint(scope, {
        browserSessionId: input.browser_session_id,
        challengeType: input.challenge_type,
        expiresAt: new Date(Date.now() + input.expires_in_seconds * 1000),
        origin,
        prompt: authPrompt(input.challenge_type, origin),
        rootSessionId: parent.rootSessionId,
        workerSessionId: context.session.id,
      });
      return {
        browser_disposition:
          input.challenge_type === "vault_login" ? "closed" : "preserved",
        checkpoint_id: checkpoint.id,
        expires_at: checkpoint.expiresAt,
        instructions:
          input.challenge_type === "vault_login"
            ? "Return failure through final_output with blocker.type browser_authentication and this checkpoint_id. The browser was closed to release the profile lock. After resumption, create a fresh writable browser at the saved origin and continue."
            : "Return failure through final_output with blocker.type browser_authentication and this checkpoint_id. Keep the browser open.",
      };
    }

    const checkpoint = await readBrowserAuthCheckpoint(
      scope,
      input.checkpoint_id
    );
    if (!checkpoint || checkpoint.workerSessionId !== context.session.id) {
      throw new Error("Authentication checkpoint not found for this worker.");
    }
    const finished = await finishBrowserAuthCheckpoint(
      scope,
      checkpoint.id,
      input.action === "complete" ? "completed" : "failed"
    );
    if (!finished) {
      throw new Error("Authentication checkpoint is no longer active.");
    }
    return { checkpoint_id: finished.id, status: finished.status };
  },
});

async function closeBrowserForVaultSetup(
  scope: Awaited<ReturnType<typeof requireWorkerScope>>,
  browser: Awaited<ReturnType<typeof requireOwnedBrowserSession>>,
  fallbackWorkerSessionId: string,
  signal?: AbortSignal
) {
  await harvestBrowserTraceDomains(
    scope,
    browser.workerSessionId ?? fallbackWorkerSessionId,
    { createdAt: browser.createdAt, sessionId: browser.sessionId },
    signal
  ).catch(() => undefined);
  await kernel.browsers
    .deleteByID(browser.sessionId, { signal })
    .catch((cause: unknown) => {
      if (!z.object({ status: z.literal(404) }).safeParse(cause).success) {
        throw cause;
      }
    });
  await deleteBrowserSession(scope, browser.sessionId);
}

function authPrompt(
  challengeType: (typeof browserAuthChallengeTypes)[number],
  origin: string
) {
  switch (challengeType) {
    case "otp_sms":
    case "otp_email":
    case "totp":
      return `Send the one-time code requested by ${origin}.`;
    case "push":
      return `Approve the sign-in notification from ${origin}, then say done.`;
    case "passkey":
      return `Complete the passkey prompt for ${origin}, then say done.`;
    case "captcha":
      return `Complete the verification challenge for ${origin}, then say done.`;
    case "vault_login":
      return `Add a saved login for ${origin}, then say done.`;
    case "approval":
      return `Confirm whether Lever should continue at ${origin}.`;
    case "other":
      return `Complete the requested sign-in step at ${origin}, then say done.`;
  }
}
