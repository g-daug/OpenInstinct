CREATE TABLE "linq_tool_confirmations" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"action" text NOT NULL,
	"payload_hash" text NOT NULL,
	"expires_at" text NOT NULL,
	"consumed_at" text,
	"created_at" text NOT NULL,
	CONSTRAINT "linq_tool_confirmations_action_check" CHECK ("linq_tool_confirmations"."action" IN ('send_email', 'create_calendar_event'))
);
--> statement-breakpoint
CREATE INDEX "linq_tool_confirmations_session_idx" ON "linq_tool_confirmations" USING btree ("session_id","principal_id","created_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "linq_tool_confirmations_expires_idx" ON "linq_tool_confirmations" USING btree ("expires_at");