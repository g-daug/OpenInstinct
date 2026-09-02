CREATE TABLE "email_reply_watches" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"created_by_user_id" text NOT NULL,
	"linq_thread_id" text NOT NULL,
	"authenticator" text NOT NULL,
	"issuer" text,
	"subject" text,
	"phone_number" text,
	"gmail_thread_id" text NOT NULL,
	"sent_message_id" text NOT NULL,
	"email_subject" text NOT NULL,
	"sent_at" text NOT NULL,
	"next_check_at" text NOT NULL,
	"expires_at" text NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"reply_message_id" text,
	"reply_detected_at" text,
	"notified_at" text,
	"lease_token" text,
	"lease_expires_at" text,
	"last_checked_at" text,
	"last_error" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "email_reply_watches_state_check" CHECK ("email_reply_watches"."state" IN ('active', 'notified', 'expired', 'cancelled'))
);
--> statement-breakpoint
ALTER TABLE "email_reply_watches" ADD CONSTRAINT "email_reply_watches_membership_fkey" FOREIGN KEY ("workspace_id","created_by_user_id") REFERENCES "public"."workspace_memberships"("workspace_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "email_reply_watches_thread_uidx" ON "email_reply_watches" USING btree ("workspace_id","created_by_user_id","linq_thread_id","gmail_thread_id");--> statement-breakpoint
CREATE INDEX "email_reply_watches_due_idx" ON "email_reply_watches" USING btree ("state","next_check_at","lease_expires_at");