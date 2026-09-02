CREATE TABLE "vault_audit_events" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"vault_item_id" text NOT NULL,
	"action" text NOT NULL,
	"purpose" text NOT NULL,
	"origin" text NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "vault_audit_events_action_check" CHECK ("vault_audit_events"."action" = 'secret_accessed'),
	CONSTRAINT "vault_audit_events_purpose_check" CHECK ("vault_audit_events"."purpose" IN ('availability_check', 'autofill'))
);
--> statement-breakpoint
CREATE TABLE "vault_encryption_keys" (
	"workspace_id" text NOT NULL,
	"version" integer NOT NULL,
	"encrypted_key" text NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "vault_encryption_keys_pkey" PRIMARY KEY("workspace_id","version"),
	CONSTRAINT "vault_encryption_keys_version_check" CHECK ("vault_encryption_keys"."version" > 0)
);
--> statement-breakpoint
ALTER TABLE "vault_audit_events" ADD CONSTRAINT "vault_audit_events_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_encryption_keys" ADD CONSTRAINT "vault_encryption_keys_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "vault_audit_events_workspace_created_idx" ON "vault_audit_events" USING btree ("workspace_id","created_at" DESC NULLS FIRST);