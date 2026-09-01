import { defineSchedule } from "eve/schedules";
import linq from "../channels/linq-v2";
import {
  claimDueFollowUps,
  completeFollowUp,
  releaseFollowUp,
} from "@/db/services/follow-ups";

export default defineSchedule({
  cron: "* * * * *",
  run({ to, waitUntil }) {
    waitUntil(
      (async () => {
        const jobs = await claimDueFollowUps({
          leaseForMs: 10 * 60_000,
          limit: 25,
          now: new Date(),
        });

        await Promise.all(
          jobs.map(async (job) => {
            try {
              await to(linq, {
                adapterName: "linq",
                threadId: job.linqThreadId,
              }).send(
                [
                  `Run scheduled follow-up ${job.id}.`,
                  `It was due at ${job.nextRunAt} (${job.timezone}).`,
                  "Complete the user's saved follow-up below and send the useful result in this iMessage conversation.",
                  "This scheduled run is not fresh authorization for a purchase, a message to another person, a deletion, or another consequential external action. If one is needed, explain it and ask the user first.",
                  job.prompt,
                ].join("\n\n"),
                { auth: job.auth }
              );
              await completeFollowUp(job, new Date());
            } catch (error) {
              await releaseFollowUp(job, {
                error:
                  error instanceof Error ? error : new Error(String(error)),
                retryAt: new Date(Date.now() + 5 * 60_000),
              });
            }
          })
        );
      })()
    );
  },
});
