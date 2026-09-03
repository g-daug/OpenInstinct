CREATE TABLE "google_email_send_audit_events" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"requested_by_user_id" text NOT NULL,
	"session_id" text NOT NULL,
	"request_key" text NOT NULL,
	"google_account" text NOT NULL,
	"recipients" text NOT NULL,
	"email_subject" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"gmail_message_id" text,
	"gmail_thread_id" text,
	"error" text,
	"created_at" text NOT NULL,
	"completed_at" text,
	CONSTRAINT "google_email_send_audit_events_account_check" CHECK ("google_email_send_audit_events"."google_account" IN ('dedicated', 'personal')),
	CONSTRAINT "google_email_send_audit_events_status_check" CHECK ("google_email_send_audit_events"."status" IN ('pending', 'sent', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "email_reply_watches" ADD COLUMN "google_account" text DEFAULT 'personal' NOT NULL;--> statement-breakpoint
ALTER TABLE "email_reply_watches" ALTER COLUMN "google_account" SET DEFAULT 'dedicated';--> statement-breakpoint
ALTER TABLE "google_email_send_audit_events" ADD CONSTRAINT "google_email_send_audit_events_membership_fkey" FOREIGN KEY ("workspace_id","requested_by_user_id") REFERENCES "public"."workspace_memberships"("workspace_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "google_email_send_audit_events_request_uidx" ON "google_email_send_audit_events" USING btree ("request_key");--> statement-breakpoint
CREATE INDEX "google_email_send_audit_events_requester_idx" ON "google_email_send_audit_events" USING btree ("requested_by_user_id","created_at" DESC NULLS FIRST);--> statement-breakpoint
ALTER TABLE "email_reply_watches" ADD CONSTRAINT "email_reply_watches_google_account_check" CHECK ("email_reply_watches"."google_account" IN ('dedicated', 'personal'));
