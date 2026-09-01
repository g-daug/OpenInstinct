import { defineTool } from "eve/tools";
import { z } from "zod";
import { requireFollowUpOwner } from "@/agent/lib/follow-ups/owner";
import { createFollowUp } from "@/db/services/follow-ups";
import { FOLLOW_UP_RECURRENCES } from "@/db/services/follow-up-recurrence";

export default defineTool({
  description:
    "Create a proactive iMessage follow-up for the authenticated user. Confirm the user's IANA time zone and exact first run time before calling. A scheduled prompt may read connected data and report findings, but it is not permission for a future purchase, message to another person, deletion, or other consequential action.",
  inputSchema: z.object({
    firstRunAt: z.iso.datetime({ offset: true }),
    prompt: z.string().trim().min(1).max(4_000),
    recurrence: z.enum(FOLLOW_UP_RECURRENCES).default("once"),
    timezone: z.string().trim().min(1).max(100),
  }),
  async execute(input, ctx) {
    return {
      created: true,
      followUp: await createFollowUp(requireFollowUpOwner(ctx), input),
    };
  },
});
