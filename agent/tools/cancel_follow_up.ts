import { defineTool } from "eve/tools";
import { z } from "zod";
import { requireFollowUpScope } from "@/agent/lib/follow-ups/owner";
import { cancelFollowUp } from "@/db/services/follow-ups";

export default defineTool({
  description:
    "Cancel one exact follow-up belonging to the authenticated user. This is a reversible soft cancellation; it does not delete history. List follow-ups first when the target is ambiguous.",
  inputSchema: z.object({ id: z.uuid() }),
  async execute({ id }, ctx) {
    const cancelled = await cancelFollowUp(requireFollowUpScope(ctx), id);
    if (!cancelled) throw new Error("Follow-up not found.");
    return { cancelled: true, id };
  },
});
