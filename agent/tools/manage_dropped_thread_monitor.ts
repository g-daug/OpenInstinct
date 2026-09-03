import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  requireDroppedThreadMonitorOwner,
  requireDroppedThreadMonitorScope,
} from "@/agent/lib/dropped-thread-monitors/owner";
import {
  disableDroppedThreadMonitor,
  dismissDroppedThreadFinding,
  listDroppedThreadFindings,
  readDroppedThreadMonitor,
  saveDroppedThreadMonitor,
  snoozeDroppedThreadFinding,
} from "@/db/services/dropped-thread-monitors";

const validationSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("configure"),
    localHour: z.number().int().min(0).max(23),
    localMinute: z.number().int().min(0).max(59),
    lookbackDays: z.number().int().min(1).max(90).default(14),
    minimumAgeHours: z.number().int().min(1).max(720).default(48),
    timezone: z.string().trim().min(1).max(100),
  }),
  z.object({ action: z.literal("status") }),
  z.object({ action: z.literal("disable") }),
  z.object({
    action: z.literal("snooze"),
    snoozedUntil: z.iso.datetime({ offset: true }),
    sourceThreadId: z.string().trim().min(1).max(200),
  }),
  z.object({
    action: z.literal("dismiss"),
    sourceThreadId: z.string().trim().min(1).max(200),
  }),
]);
const inputSchema = z
  .object({
    action: z.enum(["configure", "status", "disable", "snooze", "dismiss"]),
    localHour: z.number().int().min(0).max(23).optional(),
    localMinute: z.number().int().min(0).max(59).optional(),
    lookbackDays: z.number().int().min(1).max(90).optional(),
    minimumAgeHours: z.number().int().min(1).max(720).optional(),
    snoozedUntil: z.iso.datetime({ offset: true }).optional(),
    sourceThreadId: z.string().trim().min(1).max(200).optional(),
    timezone: z.string().trim().min(1).max(100).optional(),
  })
  .pipe(validationSchema);

export default defineTool({
  description:
    "Configure or manage the authenticated user's proactive Gmail dropped-thread monitor. Configure only after confirming an exact daily local clock time and IANA timezone. Status returns private Gmail thread IDs for internal follow-up management; never show those IDs to the user.",
  inputSchema,
  async execute(input, ctx) {
    switch (input.action) {
      case "configure":
        return {
          action: input.action,
          monitor: await saveDroppedThreadMonitor(
            requireDroppedThreadMonitorOwner(ctx),
            input
          ),
        };
      case "status": {
        const scope = requireDroppedThreadMonitorScope(ctx);
        return {
          action: input.action,
          findings: await listDroppedThreadFindings(scope),
          monitor: await readDroppedThreadMonitor(scope),
        };
      }
      case "disable": {
        const disabled = await disableDroppedThreadMonitor(
          requireDroppedThreadMonitorScope(ctx)
        );
        if (!disabled) throw new Error("Dropped-thread monitor not found.");
        return { action: input.action, disabled: true };
      }
      case "snooze": {
        const snoozed = await snoozeDroppedThreadFinding(
          requireDroppedThreadMonitorScope(ctx),
          input.sourceThreadId,
          new Date(input.snoozedUntil)
        );
        if (!snoozed) throw new Error("Dropped email thread not found.");
        return {
          action: input.action,
          snoozed: true,
          snoozedUntil: input.snoozedUntil,
        };
      }
      case "dismiss": {
        const dismissed = await dismissDroppedThreadFinding(
          requireDroppedThreadMonitorScope(ctx),
          input.sourceThreadId
        );
        if (!dismissed) throw new Error("Dropped email thread not found.");
        return { action: input.action, dismissed: true };
      }
    }
  },
});
