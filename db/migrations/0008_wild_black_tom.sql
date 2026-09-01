CREATE TABLE "scheduled_agent_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"job_id" text NOT NULL,
	"scheduled_for" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"worker_session_id" text,
	"outcome" jsonb,
	"report_status" text DEFAULT 'not_ready' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"retry_at" text,
	"lease_token" text,
	"lease_expires_at" text,
	"last_error" text,
	"started_at" text,
	"completed_at" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "scheduled_agent_runs_status_check" CHECK ("scheduled_agent_runs"."status" IN ('queued', 'running', 'completed', 'dead_letter')),
	CONSTRAINT "scheduled_agent_runs_report_status_check" CHECK ("scheduled_agent_runs"."report_status" IN ('not_ready', 'not_needed', 'pending', 'queued', 'delivered', 'suppressed'))
);
--> statement-breakpoint
ALTER TABLE "scheduled_agent_jobs" DROP CONSTRAINT "scheduled_agent_jobs_every_minutes_check";--> statement-breakpoint
DROP INDEX "scheduled_agent_jobs_due_idx";--> statement-breakpoint
ALTER TABLE "scheduled_agent_jobs" ALTER COLUMN "next_run_at" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "scheduled_agent_jobs" ADD COLUMN "timing" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "scheduled_agent_jobs" ADD COLUMN "missed_run_policy" text DEFAULT 'run_latest' NOT NULL;--> statement-breakpoint
ALTER TABLE "scheduled_agent_jobs" ADD COLUMN "status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "scheduled_agent_runs" ADD CONSTRAINT "scheduled_agent_runs_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "public"."scheduled_agent_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "scheduled_agent_runs_occurrence_idx" ON "scheduled_agent_runs" USING btree ("job_id","scheduled_for");--> statement-breakpoint
CREATE INDEX "scheduled_agent_runs_ready_idx" ON "scheduled_agent_runs" USING btree ("status","retry_at" NULLS FIRST);--> statement-breakpoint
CREATE INDEX "scheduled_agent_runs_report_idx" ON "scheduled_agent_runs" USING btree ("report_status","updated_at");--> statement-breakpoint
CREATE INDEX "scheduled_agent_jobs_due_idx" ON "scheduled_agent_jobs" USING btree ("status","next_run_at");--> statement-breakpoint
ALTER TABLE "scheduled_agent_jobs" DROP COLUMN "every_minutes";--> statement-breakpoint
ALTER TABLE "scheduled_agent_jobs" DROP COLUMN "enabled";--> statement-breakpoint
ALTER TABLE "scheduled_agent_jobs" DROP COLUMN "lease_token";--> statement-breakpoint
ALTER TABLE "scheduled_agent_jobs" DROP COLUMN "lease_expires_at";--> statement-breakpoint
ALTER TABLE "scheduled_agent_jobs" ADD CONSTRAINT "scheduled_agent_jobs_missed_run_policy_check" CHECK ("scheduled_agent_jobs"."missed_run_policy" IN ('skip', 'run_latest', 'catch_up'));--> statement-breakpoint
ALTER TABLE "scheduled_agent_jobs" ADD CONSTRAINT "scheduled_agent_jobs_status_check" CHECK ("scheduled_agent_jobs"."status" IN ('active', 'paused', 'completed', 'deleted'));