CREATE TYPE "public"."cloud_provider" AS ENUM('baidu', 'aliyun', 'quark', 'tianyi', '115', 'gdrive', 'mega', 'onedrive', 'other');--> statement-breakpoint
CREATE TYPE "public"."location_type" AS ENUM('cloud_link', 'r2');--> statement-breakpoint
CREATE TABLE "artifact_versions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"project_id" uuid NOT NULL,
	"artifact_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"original_filename" text,
	"size_bytes" bigint,
	"mime_type" text,
	"created_by" uuid NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "artifacts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"project_id" uuid NOT NULL,
	"worksheet_id" uuid,
	"work_id" uuid,
	"task_id" uuid,
	"stage_column_id" uuid,
	"name" text NOT NULL,
	"latest_version_id" uuid,
	"created_by" uuid NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artifacts_scope_check" CHECK ((
        ("artifacts"."worksheet_id" IS NULL AND "artifacts"."work_id" IS NULL AND "artifacts"."task_id" IS NULL AND "artifacts"."stage_column_id" IS NULL)
        OR
        ("artifacts"."worksheet_id" IS NOT NULL AND "artifacts"."work_id" IS NOT NULL AND "artifacts"."task_id" IS NULL AND "artifacts"."stage_column_id" IS NULL)
        OR
        ("artifacts"."worksheet_id" IS NOT NULL AND "artifacts"."work_id" IS NULL AND "artifacts"."task_id" IS NOT NULL AND "artifacts"."stage_column_id" IS NULL)
        OR
        ("artifacts"."worksheet_id" IS NOT NULL AND "artifacts"."work_id" IS NULL AND "artifacts"."task_id" IS NOT NULL AND "artifacts"."stage_column_id" IS NOT NULL)
      ))
);
--> statement-breakpoint
CREATE TABLE "resource_locations" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"project_id" uuid NOT NULL,
	"artifact_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"type" "location_type" DEFAULT 'cloud_link' NOT NULL,
	"provider" "cloud_provider",
	"url" text,
	"extract_code" text,
	"is_folder" boolean DEFAULT false NOT NULL,
	"expires_at" text,
	"note" text DEFAULT '' NOT NULL,
	"created_by" uuid NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "change_logs" ADD COLUMN "artifact_id" uuid;--> statement-breakpoint
ALTER TABLE "artifact_versions" ADD CONSTRAINT "artifact_versions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_versions" ADD CONSTRAINT "artifact_versions_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_versions" ADD CONSTRAINT "artifact_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_worksheet_id_worksheets_id_fk" FOREIGN KEY ("worksheet_id") REFERENCES "public"."worksheets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_work_id_works_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."works"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_stage_column_id_column_configs_id_fk" FOREIGN KEY ("stage_column_id") REFERENCES "public"."column_configs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_locations" ADD CONSTRAINT "resource_locations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_locations" ADD CONSTRAINT "resource_locations_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_locations" ADD CONSTRAINT "resource_locations_version_id_artifact_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."artifact_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_locations" ADD CONSTRAINT "resource_locations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "artifact_versions_artifact_num_key" ON "artifact_versions" USING btree ("artifact_id","version_number");--> statement-breakpoint
CREATE INDEX "artifact_versions_project_artifact_active_idx" ON "artifact_versions" USING btree ("project_id","artifact_id","version_number" DESC NULLS LAST) WHERE "artifact_versions"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "artifacts_project_docs_active_idx" ON "artifacts" USING btree ("project_id","updated_at" DESC NULLS LAST) WHERE "artifacts"."worksheet_id" is null AND "artifacts"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "artifacts_project_ws_active_idx" ON "artifacts" USING btree ("project_id","worksheet_id") WHERE "artifacts"."worksheet_id" is not null AND "artifacts"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "artifacts_project_work_active_idx" ON "artifacts" USING btree ("project_id","work_id") WHERE "artifacts"."work_id" is not null AND "artifacts"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "artifacts_project_task_active_idx" ON "artifacts" USING btree ("project_id","task_id") WHERE "artifacts"."task_id" is not null AND "artifacts"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "artifacts_project_stage_col_active_idx" ON "artifacts" USING btree ("project_id","stage_column_id") WHERE "artifacts"."stage_column_id" is not null AND "artifacts"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "resource_locations_project_version_active_idx" ON "resource_locations" USING btree ("project_id","version_id","created_at") WHERE "resource_locations"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "resource_locations_project_artifact_active_idx" ON "resource_locations" USING btree ("project_id","artifact_id") WHERE "resource_locations"."deleted_at" is null;--> statement-breakpoint
ALTER TABLE "change_logs" ADD CONSTRAINT "change_logs_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "change_logs_project_docs_created_idx" ON "change_logs" USING btree ("project_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "change_logs"."worksheet_id" is null AND "change_logs"."artifact_id" is not null;