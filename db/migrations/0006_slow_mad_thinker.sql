CREATE TABLE "follow_ups" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"created_by_user_id" text NOT NULL,
	"prompt" text NOT NULL,
	"timezone" text NOT NULL,
	"recurrence" text NOT NULL,
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
	CONSTRAINT "follow_ups_recurrence_check" CHECK ("follow_ups"."recurrence" IN ('once', 'daily', 'weekly', 'weekdays'))
);
--> statement-breakpoint
ALTER TABLE "follow_ups" ADD CONSTRAINT "follow_ups_membership_fkey" FOREIGN KEY ("workspace_id","created_by_user_id") REFERENCES "public"."workspace_memberships"("workspace_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "follow_ups_due_idx" ON "follow_ups" USING btree ("enabled","next_run_at","lease_expires_at");--> statement-breakpoint
CREATE INDEX "follow_ups_workspace_created_idx" ON "follow_ups" USING btree ("workspace_id","created_at" DESC NULLS FIRST);