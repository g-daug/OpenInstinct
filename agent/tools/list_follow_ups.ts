import { defineTool } from "eve/tools";
import { z } from "zod";
import { requireFollowUpScope } from "@/agent/lib/follow-ups/owner";
import { listFollowUps } from "@/db/services/follow-ups";

export default defineTool({
  description:
    "List the authenticated user's scheduled follow-ups. Use this before changing or cancelling an ambiguous follow-up.",
  inputSchema: z.object({
    includeCancelled: z.boolean().default(false),
  }),
  async execute({ includeCancelled }, ctx) {
    return {
      followUps: await listFollowUps(
        requireFollowUpScope(ctx),
        includeCancelled
      ),
    };
  },
});
