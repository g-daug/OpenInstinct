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
import { createEmailReplyWatch } from "@/db/services/email-reply-watches";
import {
  beginGoogleEmailSendAudit,
  completeGoogleEmailSendAudit,
  failGoogleEmailSendAudit,
} from "@/db/services/google-email-send-audit";
import { scopeFromPrincipal } from "@/lib/access-scope";
import { GOOGLE_ACCOUNT_MODES } from "@/lib/google-workspace";

const inputSchema = z
  .discriminatedUnion("action", [
    z.object({
      action: z.literal("update_email"),
      messageIds: z.array(z.string().min(1).max(200)).min(1).max(100),
      update: z.enum(GMAIL_UPDATE_ACTIONS),
    }),
    gmailSendSchema.extend({
      action: z.literal("send_email"),
      confirmationId: z.string().min(1).max(500).optional(),
      sender: z
        .enum(GOOGLE_ACCOUNT_MODES)
        .default("dedicated")
        .describe(
          "Use dedicated by default. Use personal only when the user explicitly asks to send from their personal Google account."
        ),
    }),
    calendarEventSchema.extend({
      action: z.literal("create_calendar_event"),
      confirmationId: z.string().min(1).max(500).optional(),
    }),
  ])
  .meta({ type: "object" });

type GoogleWorkspaceWriteAction = z.infer<typeof inputSchema>["action"];
const linqSessionAttributesSchema = z.object({
  linqThreadId: z.string(),
  phoneNumber: z.string().optional(),
});

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
    "Change Google Workspace. Email is sent from Lever's dedicated mailbox by default; use the personal sender only when the user explicitly asks for their personal Google account. Reversible Gmail label updates act on exact message IDs. Sending email or creating a confirmed calendar event requires user approval. This tool cannot delete mail, change account settings, or edit contacts.",
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
        const caller = ctx.session.auth.current ?? ctx.session.auth.initiator;
        if (!caller)
          throw new Error("Sending email requires a signed-in user.");
        const scope = scopeFromPrincipal(caller);
        const requestKey = `${ctx.session.id}:${ctx.callId}`;
        await beginGoogleEmailSendAudit({
          account: input.sender,
          bcc: input.bcc,
          cc: input.cc,
          requestKey,
          scope,
          sessionId: ctx.session.id,
          subject: input.subject,
          to: input.to,
        });
        let sent: Awaited<ReturnType<typeof sendGmail>>;
        try {
          sent = await sendGmail(ctx, input, input.sender);
        } catch (error) {
          await failGoogleEmailSendAudit(requestKey, error).catch(
            (cause: unknown) => {
              console.warn("[google-email-audit] failed to record send error", {
                error: cause instanceof Error ? cause.message : String(cause),
                requestKey,
              });
            }
          );
          throw error;
        }
        const auditRecorded = await completeGoogleEmailSendAudit(requestKey, {
          messageId: sent.id,
          threadId: sent.threadId,
        })
          .then(() => true)
          .catch((cause: unknown) => {
            console.warn(
              "[google-email-audit] failed to complete send record",
              {
                error: cause instanceof Error ? cause.message : String(cause),
                requestKey,
              }
            );
            return false;
          });
        const replyMonitoring = await createReplyWatchAfterLinqSend(
          input.subject,
          input.sender,
          sent,
          ctx
        );
        return {
          action: input.action,
          auditRecorded,
          messageId: sent.id,
          replyMonitoring,
          sender: input.sender,
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

async function createReplyWatchAfterLinqSend(
  emailSubject: string,
  googleAccount: (typeof GOOGLE_ACCOUNT_MODES)[number],
  sent: { readonly id?: null | string; readonly threadId?: null | string },
  ctx: ToolContext
) {
  if (!sent.id || !sent.threadId) return false;
  const caller = ctx.session.auth.current ?? ctx.session.auth.initiator;
  if (!caller) return false;
  const attributes = linqSessionAttributesSchema.safeParse(caller.attributes);
  if (!attributes.success) return false;
  await createEmailReplyWatch(
    {
      auth: caller,
      linqThreadId: attributes.data.linqThreadId,
      phoneNumber: attributes.data.phoneNumber,
      scope: scopeFromPrincipal(caller),
    },
    {
      emailSubject,
      gmailThreadId: sent.threadId,
      googleAccount,
      sentMessageId: sent.id,
    }
  );
  return true;
}

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
