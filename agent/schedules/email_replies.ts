import { defineSchedule } from "eve/schedules";
import linq from "../channels/linq-v2";
import {
  findReplyAfterSentMessage,
  readGmailThreadForUser,
} from "@/agent/lib/google-workspace/gmail";
import {
  claimDueEmailReplyWatches,
  completeEmailReplyWatchPoll,
  recordEmailReplyDetection,
  releaseEmailReplyWatch,
} from "@/db/services/email-reply-watches";

export default defineSchedule({
  cron: "* * * * *",
  run({ to, waitUntil }) {
    waitUntil(
      (async () => {
        const jobs = await claimDueEmailReplyWatches({
          leaseForMs: 10 * 60_000,
          limit: 25,
          now: new Date(),
        });

        await Promise.all(
          jobs.map(async (job) => {
            try {
              const thread = await readGmailThreadForUser(
                job.createdByUserId,
                job.gmailThreadId
              );
              const reply = findReplyAfterSentMessage(
                thread,
                job.sentMessageId,
                job.sentAt
              );
              if (!reply) {
                await completeEmailReplyWatchPoll(job, new Date());
                return;
              }

              const recorded = await recordEmailReplyDetection(job, {
                detectedAt: new Date(),
                replyMessageId: reply.messageId,
              });
              if (!recorded) return;
              const replyFrom = reply.from ?? "The recipient";
              const emailSubject = reply.subject ?? job.emailSubject;
              await to(linq, {
                adapterName: "linq",
                threadId: job.linqThreadId,
              }).send(
                [
                  "Send exactly one brief iMessage notification using the facts below.",
                  `${replyFrom} replied to the email about “${emailSubject}”.`,
                  "Do not call tools, take actions, quote the reply, summarize its contents, expose internal IDs, or add unsupported details.",
                ].join("\n\n"),
                { auth: job.auth }
              );
              await completeEmailReplyWatchPoll(job, new Date());
            } catch (error) {
              await releaseEmailReplyWatch(
                job,
                error instanceof Error ? error : new Error(String(error))
              );
            }
          })
        );
      })()
    );
  },
});
