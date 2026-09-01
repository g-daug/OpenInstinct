import { defineTool } from "eve/tools";
import { z } from "zod";
import { requireFollowUpScope } from "@/agent/lib/follow-ups/owner";
import { updateFollowUp } from "@/db/services/follow-ups";
import { FOLLOW_UP_RECURRENCES } from "@/db/services/follow-up-recurrence";

export default defineTool({
  description:
    "Change, pause, or resume one exact follow-up belonging to the authenticated user. List follow-ups first when the target is ambiguous.",
  inputSchema: z.object({
    enabled: z.boolean().optional(),
    id: z.uuid(),
    nextRunAt: z.iso.datetime({ offset: true }).optional(),
    prompt: z.string().trim().min(1).max(4_000).optional(),
    recurrence: z.enum(FOLLOW_UP_RECURRENCES).optional(),
    timezone: z.string().trim().min(1).max(100).optional(),
  }),
  async execute({ id, ...patch }, ctx) {
    const followUp = await updateFollowUp(requireFollowUpScope(ctx), id, patch);
    if (!followUp) throw new Error("Follow-up not found.");
    return { followUp, updated: true };
  },
});
