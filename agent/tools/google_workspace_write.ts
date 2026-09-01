import { defineTool, type ToolContext } from "eve/tools";
import type { SessionAuthContext } from "eve/context";
import { z } from "zod";
import {
  calendarEventSchema,
  createCalendarEvent,
} from "@/agent/lib/google-workspace/calendar";
import {
  GMAIL_UPDATE_ACTIONS,
  gmailSendSchema,
  sendGmail,
  updateGmail,
} from "@/agent/lib/google-workspace/gmail";
import {
  consumeLinqToolConfirmation,
  createLinqToolConfirmation,
  type LinqConfirmedAction,
} from "@/db/services/linq-tool-confirmations";

const inputSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("update_email"),
    messageIds: z.array(z.string().min(1).max(200)).min(1).max(100),
    update: z.enum(GMAIL_UPDATE_ACTIONS),
  }),
  gmailSendSchema.extend({
    action: z.literal("send_email"),
    confirmationId: z.string().min(1).max(500).optional(),
  }),
  calendarEventSchema.extend({
    action: z.literal("create_calendar_event"),
    confirmationId: z.string().min(1).max(500).optional(),
  }),
]);

type GoogleWorkspaceWriteAction = z.infer<typeof inputSchema>["action"];
const linqSessionAttributesSchema = z.object({ linqThreadId: z.string() });

export function googleWorkspaceWriteApproval(
  action: GoogleWorkspaceWriteAction | undefined
) {
  return action === "update_email" ? "not-applicable" : "user-approval";
}

export function googleWorkspaceWriteApprovalForSession(
  action: GoogleWorkspaceWriteAction | undefined,
  attributes: SessionAuthContext["attributes"] | undefined
) {
  if (linqSessionAttributesSchema.safeParse(attributes).success) {
    return "not-applicable";
  }
  return googleWorkspaceWriteApproval(action);
}

export default defineTool({
  approval: ({ session, toolInput }) =>
    googleWorkspaceWriteApprovalForSession(
      toolInput?.action,
      (session.auth.current ?? session.auth.initiator)?.attributes
    ),
  description:
    "Change the authenticated user's Google Workspace. Reversible Gmail label updates act on exact message IDs. Sending email or creating a confirmed calendar event requires user approval. This tool cannot delete mail, change account settings, or edit contacts.",
  inputSchema,
  async execute(input, ctx) {
    switch (input.action) {
      case "update_email": {
        const updated = await updateGmail(ctx, input.messageIds, input.update);
        return {
          action: input.action,
          update: updated.action,
          updatedCount: updated.updatedCount,
        };
      }
      case "send_email": {
        const confirmation = await confirmLinqWrite(input, ctx);
        if (confirmation) return confirmation;
        const sent = await sendGmail(ctx, input);
        return {
          action: input.action,
          messageId: sent.id,
          sent: true,
          threadId: sent.threadId,
        };
      }
      case "create_calendar_event": {
        const confirmation = await confirmLinqWrite(input, ctx);
        if (confirmation) return confirmation;
        return {
          action: input.action,
          created: true,
          event: await createCalendarEvent(ctx, input),
        };
      }
    }
  },
});

async function confirmLinqWrite(
  input: Extract<z.infer<typeof inputSchema>, { action: LinqConfirmedAction }>,
  ctx: ToolContext
) {
  const caller = ctx.session.auth.current ?? ctx.session.auth.initiator;
  if (
    !caller ||
    !linqSessionAttributesSchema.safeParse(caller.attributes).success
  ) {
    if (input.confirmationId) {
      throw new Error("Linq confirmation IDs can only be used from Linq.");
    }
    return;
  }
  const { confirmationId, ...payload } = input;
  const payloadJson = JSON.stringify(payload);
  if (!confirmationId) {
    const confirmation = await createLinqToolConfirmation({
      action: input.action,
      payloadJson,
      principalId: caller.principalId,
      sessionId: ctx.session.id,
    });
    return {
      action: input.action,
      confirmationId: confirmation.confirmationId,
      confirmationRequired: true,
      expiresAt: confirmation.expiresAt,
      instructions:
        "Ask the sender to reply Approve or Cancel. On Approve, call this tool once with the identical action details and this confirmationId. On Cancel, do not call it again.",
    };
  }
  await consumeLinqToolConfirmation({
    action: input.action,
    confirmationId,
    payloadJson,
    principalId: caller.principalId,
    sessionId: ctx.session.id,
  });
}
