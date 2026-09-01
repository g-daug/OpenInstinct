CREATE TABLE "scheduled_agent_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"created_by_user_id" text NOT NULL,
	"prompt" text NOT NULL,
	"linq_thread_id" text NOT NULL,
	"next_run_at" text NOT NULL,
	"every_minutes" integer,
	"enabled" boolean DEFAULT true NOT NULL,
	"lease_token" text,
	"lease_expires_at" text,
	"last_run_at" text,
	"last_error" text,
	"revision" integer DEFAULT 0 NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "scheduled_agent_jobs_every_minutes_check" CHECK ("scheduled_agent_jobs"."every_minutes" IS NULL OR "scheduled_agent_jobs"."every_minutes" > 0),
	CONSTRAINT "scheduled_agent_jobs_linq_thread_check" CHECK ("scheduled_agent_jobs"."linq_thread_id" LIKE 'linq:%')
);
--> statement-breakpoint
ALTER TABLE "scheduled_agent_jobs" ADD CONSTRAINT "scheduled_agent_jobs_membership_fkey" FOREIGN KEY ("workspace_id","created_by_user_id") REFERENCES "public"."workspace_memberships"("workspace_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "scheduled_agent_jobs_due_idx" ON "scheduled_agent_jobs" USING btree ("enabled","next_run_at");--> statement-breakpoint
CREATE INDEX "scheduled_agent_jobs_owner_idx" ON "scheduled_agent_jobs" USING btree ("workspace_id","created_by_user_id","next_run_at");
