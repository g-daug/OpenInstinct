CREATE TABLE "dropped_thread_findings" (
	"id" text PRIMARY KEY NOT NULL,
	"monitor_id" text NOT NULL,
	"source_thread_id" text NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"first_detected_at" text NOT NULL,
	"last_detected_at" text NOT NULL,
	"last_notified_at" text,
	"snoozed_until" text,
	"dismissed_at" text,
	"resolved_at" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "dropped_thread_findings_state_check" CHECK ("dropped_thread_findings"."state" IN ('open', 'snoozed', 'dismissed', 'resolved'))
);
--> statement-breakpoint
CREATE TABLE "dropped_thread_monitors" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"created_by_user_id" text NOT NULL,
	"timezone" text NOT NULL,
	"local_hour" integer NOT NULL,
	"local_minute" integer NOT NULL,
	"lookback_days" integer DEFAULT 14 NOT NULL,
	"minimum_age_hours" integer DEFAULT 48 NOT NULL,
	"next_run_at" text NOT NULL,
	"linq_thread_id" text NOT NULL,
	"authenticator" text NOT NULL,
	"issuer" text,
	"subject" text,
	"phone_number" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"lease_token" text,
	"lease_expires_at" text,
	"last_run_at" text,
	"last_error" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "dropped_thread_monitors_local_hour_check" CHECK ("dropped_thread_monitors"."local_hour" >= 0 AND "dropped_thread_monitors"."local_hour" <= 23),
	CONSTRAINT "dropped_thread_monitors_local_minute_check" CHECK ("dropped_thread_monitors"."local_minute" >= 0 AND "dropped_thread_monitors"."local_minute" <= 59),
	CONSTRAINT "dropped_thread_monitors_lookback_days_check" CHECK ("dropped_thread_monitors"."lookback_days" >= 1 AND "dropped_thread_monitors"."lookback_days" <= 90),
	CONSTRAINT "dropped_thread_monitors_minimum_age_hours_check" CHECK ("dropped_thread_monitors"."minimum_age_hours" >= 1 AND "dropped_thread_monitors"."minimum_age_hours" <= 720)
);
--> statement-breakpoint
ALTER TABLE "dropped_thread_findings" ADD CONSTRAINT "dropped_thread_findings_monitor_fkey" FOREIGN KEY ("monitor_id") REFERENCES "public"."dropped_thread_monitors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dropped_thread_monitors" ADD CONSTRAINT "dropped_thread_monitors_membership_fkey" FOREIGN KEY ("workspace_id","created_by_user_id") REFERENCES "public"."workspace_memberships"("workspace_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "dropped_thread_findings_source_uidx" ON "dropped_thread_findings" USING btree ("monitor_id","source_thread_id");--> statement-breakpoint
CREATE INDEX "dropped_thread_findings_review_idx" ON "dropped_thread_findings" USING btree ("monitor_id","state","snoozed_until");--> statement-breakpoint
CREATE UNIQUE INDEX "dropped_thread_monitors_owner_uidx" ON "dropped_thread_monitors" USING btree ("workspace_id","created_by_user_id");--> statement-breakpoint
CREATE INDEX "dropped_thread_monitors_due_idx" ON "dropped_thread_monitors" USING btree ("enabled","next_run_at","lease_expires_at");