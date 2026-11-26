CREATE TYPE "public"."worksheet_kind" AS ENUM('task', 'free');--> statement-breakpoint
CREATE TYPE "public"."worksheet_placement" AS ENUM('topbar', 'docs');--> statement-breakpoint
ALTER TYPE "public"."publish_status" ADD VALUE IF NOT EXISTS 'shelved';--> statement-breakpoint
CREATE TABLE "account_claims" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"project_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_claims_token_hash_key" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "import_batches" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"project_id" uuid NOT NULL,
	"source_filename" text NOT NULL,
	"source_sha256" text NOT NULL,
	"backup_r2_key" text NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"summary" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "login_name" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "import_batch_id" uuid;--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "import_source_key" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "import_batch_id" uuid;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "import_source_key" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "worksheets" ADD COLUMN "kind" "worksheet_kind" DEFAULT 'task' NOT NULL;--> statement-breakpoint
ALTER TABLE "worksheets" ADD COLUMN "placement" "worksheet_placement" DEFAULT 'topbar' NOT NULL;--> statement-breakpoint
ALTER TABLE "worksheets" ADD COLUMN "import_source_key" text;--> statement-breakpoint
ALTER TABLE "account_claims" ADD CONSTRAINT "account_claims_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_claims" ADD CONSTRAINT "account_claims_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_claims" ADD CONSTRAINT "account_claims_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_claims_project_user_created_idx" ON "account_claims" USING btree ("project_id","user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "import_batches_project_created_idx" ON "import_batches" USING btree ("project_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "import_batches_project_sha256_idx" ON "import_batches" USING btree ("project_id","source_sha256");--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_import_batch_id_import_batches_id_fk" FOREIGN KEY ("import_batch_id") REFERENCES "public"."import_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_import_batch_id_import_batches_id_fk" FOREIGN KEY ("import_batch_id") REFERENCES "public"."import_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "artifacts_project_import_source_active_key" ON "artifacts" USING btree ("project_id","import_source_key") WHERE "artifacts"."import_source_key" is not null AND "artifacts"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_project_import_source_active_key" ON "tasks" USING btree ("project_id","import_source_key") WHERE "tasks"."import_source_key" is not null AND "tasks"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "worksheets_project_import_source_active_key" ON "worksheets" USING btree ("project_id","import_source_key") WHERE "worksheets"."import_source_key" is not null AND "worksheets"."deleted_at" is null;--> statement-breakpoint
UPDATE "users" SET "claimed_at" = "created_at" WHERE "login_name" IS NOT NULL AND "claimed_at" IS NULL;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_claim_consistency_check" CHECK ((("users"."claimed_at" IS NULL AND "users"."login_name" IS NULL AND "users"."password_hash" IS NULL) OR ("users"."login_name" IS NOT NULL)));--> statement-breakpoint
ALTER TABLE "worksheets" ADD CONSTRAINT "worksheets_docs_free_check" CHECK ("worksheets"."placement" != 'docs' OR "worksheets"."kind" = 'free');