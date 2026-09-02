CREATE TABLE "browser_auth_checkpoints" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"created_by_user_id" text NOT NULL,
	"root_session_id" text NOT NULL,
	"worker_session_id" text NOT NULL,
	"browser_session_id" text NOT NULL,
	"origin" text NOT NULL,
	"challenge_type" text NOT NULL,
	"prompt" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "browser_auth_checkpoints_challenge_type_check" CHECK ("browser_auth_checkpoints"."challenge_type" IN ('otp_sms', 'otp_email', 'totp', 'push', 'passkey', 'captcha', 'vault_login', 'approval', 'other')),
	CONSTRAINT "browser_auth_checkpoints_status_check" CHECK ("browser_auth_checkpoints"."status" IN ('pending', 'resuming', 'completed', 'expired', 'cancelled', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "browser_auth_checkpoints" ADD CONSTRAINT "browser_auth_checkpoints_membership_fkey" FOREIGN KEY ("workspace_id","created_by_user_id") REFERENCES "public"."workspace_memberships"("workspace_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "browser_auth_checkpoints_owner_status_idx" ON "browser_auth_checkpoints" USING btree ("workspace_id","created_by_user_id","root_session_id","status","updated_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "browser_auth_checkpoints_worker_idx" ON "browser_auth_checkpoints" USING btree ("workspace_id","created_by_user_id","worker_session_id");