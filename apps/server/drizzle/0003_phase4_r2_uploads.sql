CREATE TYPE "public"."upload_session_mode" AS ENUM('create_artifact', 'create_version', 'attach_version');--> statement-breakpoint
CREATE TYPE "public"."upload_session_status" AS ENUM('uploading', 'completed', 'aborted', 'expired');--> statement-breakpoint
CREATE TABLE "blobs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"project_id" uuid NOT NULL,
	"r2_key" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"mime_type" text NOT NULL,
	"sha256" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "upload_sessions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"project_id" uuid NOT NULL,
	"mode" "upload_session_mode" NOT NULL,
	"scope_kind" text,
	"worksheet_id" uuid,
	"work_id" uuid,
	"task_id" uuid,
	"stage_column_id" uuid,
	"artifact_id" uuid,
	"version_id" uuid,
	"artifact_name" text,
	"version_note" text DEFAULT '' NOT NULL,
	"original_filename" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"mime_type" text NOT NULL,
	"is_multipart" boolean NOT NULL,
	"part_size_bytes" integer,
	"r2_key" text NOT NULL,
	"r2_upload_id" text,
	"fingerprint_sha256" text,
	"idempotency_key" text NOT NULL,
	"status" "upload_session_status" DEFAULT 'uploading' NOT NULL,
	"result_blob_id" uuid,
	"result_artifact_id" uuid,
	"result_version_id" uuid,
	"result_location_id" uuid,
	"created_by" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"aborted_at" timestamp with time zone,
	"cleaned_up_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "resource_locations" ADD COLUMN "blob_id" uuid;--> statement-breakpoint
ALTER TABLE "blobs" ADD CONSTRAINT "blobs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blobs" ADD CONSTRAINT "blobs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_sessions" ADD CONSTRAINT "upload_sessions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_sessions" ADD CONSTRAINT "upload_sessions_worksheet_id_worksheets_id_fk" FOREIGN KEY ("worksheet_id") REFERENCES "public"."worksheets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_sessions" ADD CONSTRAINT "upload_sessions_work_id_works_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."works"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_sessions" ADD CONSTRAINT "upload_sessions_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_sessions" ADD CONSTRAINT "upload_sessions_stage_column_id_column_configs_id_fk" FOREIGN KEY ("stage_column_id") REFERENCES "public"."column_configs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_sessions" ADD CONSTRAINT "upload_sessions_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_sessions" ADD CONSTRAINT "upload_sessions_version_id_artifact_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."artifact_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_sessions" ADD CONSTRAINT "upload_sessions_result_blob_id_blobs_id_fk" FOREIGN KEY ("result_blob_id") REFERENCES "public"."blobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_sessions" ADD CONSTRAINT "upload_sessions_result_artifact_id_artifacts_id_fk" FOREIGN KEY ("result_artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_sessions" ADD CONSTRAINT "upload_sessions_result_version_id_artifact_versions_id_fk" FOREIGN KEY ("result_version_id") REFERENCES "public"."artifact_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_sessions" ADD CONSTRAINT "upload_sessions_result_location_id_resource_locations_id_fk" FOREIGN KEY ("result_location_id") REFERENCES "public"."resource_locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_sessions" ADD CONSTRAINT "upload_sessions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "blobs_r2_key_key" ON "blobs" USING btree ("r2_key");--> statement-breakpoint
CREATE INDEX "blobs_project_created_idx" ON "blobs" USING btree ("project_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "upload_sessions_project_idempotency_key" ON "upload_sessions" USING btree ("project_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "upload_sessions_r2_key_key" ON "upload_sessions" USING btree ("r2_key");--> statement-breakpoint
CREATE INDEX "upload_sessions_resume_lookup_idx" ON "upload_sessions" USING btree ("project_id","created_by","fingerprint_sha256","size_bytes") WHERE "upload_sessions"."status" = 'uploading' AND "upload_sessions"."fingerprint_sha256" is not null;--> statement-breakpoint
CREATE INDEX "upload_sessions_cleanup_idx" ON "upload_sessions" USING btree ("status","expires_at") WHERE "upload_sessions"."cleaned_up_at" is null;--> statement-breakpoint
ALTER TABLE "resource_locations" ADD CONSTRAINT "resource_locations_blob_id_blobs_id_fk" FOREIGN KEY ("blob_id") REFERENCES "public"."blobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "resource_locations_version_r2_active_key" ON "resource_locations" USING btree ("version_id") WHERE "resource_locations"."type" = 'r2' AND "resource_locations"."deleted_at" is null;--> statement-breakpoint
ALTER TABLE "resource_locations" ADD CONSTRAINT "resource_locations_type_check" CHECK ((
        ("resource_locations"."type" = 'cloud_link' AND "resource_locations"."provider" IS NOT NULL AND "resource_locations"."url" IS NOT NULL AND "resource_locations"."blob_id" IS NULL)
        OR
        ("resource_locations"."type" = 'r2' AND "resource_locations"."blob_id" IS NOT NULL AND "resource_locations"."url" IS NULL AND "resource_locations"."extract_code" IS NULL)
      ));