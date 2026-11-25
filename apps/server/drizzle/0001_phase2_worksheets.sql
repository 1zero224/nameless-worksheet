CREATE TYPE "public"."column_type" AS ENUM('stage', 'text', 'date', 'link');--> statement-breakpoint
CREATE TYPE "public"."priority" AS ENUM('normal', 'high', 'urgent');--> statement-breakpoint
CREATE TYPE "public"."publish_status" AS ENUM('unpublished', 'published');--> statement-breakpoint
CREATE TYPE "public"."stage_status" AS ENUM('not_started', 'in_progress', 'done', 'na');--> statement-breakpoint
CREATE TABLE "board_columns" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"sort_order" text COLLATE "C" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "change_logs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"project_id" uuid NOT NULL,
	"worksheet_id" uuid,
	"task_id" uuid,
	"actor_user_id" uuid NOT NULL,
	"action" text NOT NULL,
	"summary" text NOT NULL,
	"changes" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "column_configs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"project_id" uuid NOT NULL,
	"worksheet_id" uuid NOT NULL,
	"name" text NOT NULL,
	"type" "column_type" NOT NULL,
	"sort_order" text COLLATE "C" NOT NULL,
	"width" integer DEFAULT 160 NOT NULL,
	"hidden" boolean DEFAULT false NOT NULL,
	"board_column_id" uuid,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stage_cells" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"project_id" uuid NOT NULL,
	"worksheet_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"column_id" uuid NOT NULL,
	"assignees" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "stage_status" DEFAULT 'not_started' NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"project_id" uuid NOT NULL,
	"worksheet_id" uuid NOT NULL,
	"work_id" uuid,
	"title" text NOT NULL,
	"division_note" text DEFAULT '' NOT NULL,
	"priority" "priority" DEFAULT 'normal' NOT NULL,
	"publish_status" "publish_status" DEFAULT 'unpublished' NOT NULL,
	"published_at" text,
	"publish_url" text,
	"custom_values" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sort_order" text COLLATE "C" NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "works" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"project_id" uuid NOT NULL,
	"worksheet_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "worksheets" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"color" text DEFAULT 'sky' NOT NULL,
	"sort_order" text COLLATE "C" NOT NULL,
	"system_columns" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "board_columns" ADD CONSTRAINT "board_columns_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_logs" ADD CONSTRAINT "change_logs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_logs" ADD CONSTRAINT "change_logs_worksheet_id_worksheets_id_fk" FOREIGN KEY ("worksheet_id") REFERENCES "public"."worksheets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_logs" ADD CONSTRAINT "change_logs_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_logs" ADD CONSTRAINT "change_logs_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "column_configs" ADD CONSTRAINT "column_configs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "column_configs" ADD CONSTRAINT "column_configs_worksheet_id_worksheets_id_fk" FOREIGN KEY ("worksheet_id") REFERENCES "public"."worksheets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "column_configs" ADD CONSTRAINT "column_configs_board_column_id_board_columns_id_fk" FOREIGN KEY ("board_column_id") REFERENCES "public"."board_columns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_cells" ADD CONSTRAINT "stage_cells_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_cells" ADD CONSTRAINT "stage_cells_worksheet_id_worksheets_id_fk" FOREIGN KEY ("worksheet_id") REFERENCES "public"."worksheets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_cells" ADD CONSTRAINT "stage_cells_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_cells" ADD CONSTRAINT "stage_cells_column_id_column_configs_id_fk" FOREIGN KEY ("column_id") REFERENCES "public"."column_configs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_worksheet_id_worksheets_id_fk" FOREIGN KEY ("worksheet_id") REFERENCES "public"."worksheets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_work_id_works_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."works"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "works" ADD CONSTRAINT "works_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "works" ADD CONSTRAINT "works_worksheet_id_worksheets_id_fk" FOREIGN KEY ("worksheet_id") REFERENCES "public"."worksheets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worksheets" ADD CONSTRAINT "worksheets_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "board_columns_project_name_key" ON "board_columns" USING btree ("project_id","name");--> statement-breakpoint
CREATE INDEX "board_columns_project_order_idx" ON "board_columns" USING btree ("project_id","sort_order");--> statement-breakpoint
CREATE INDEX "change_logs_project_ws_created_idx" ON "change_logs" USING btree ("project_id","worksheet_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "change_logs_project_task_created_idx" ON "change_logs" USING btree ("project_id","task_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "column_configs_worksheet_name_active_key" ON "column_configs" USING btree ("worksheet_id","name") WHERE "column_configs"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "column_configs_worksheet_board_col_active_key" ON "column_configs" USING btree ("worksheet_id","board_column_id") WHERE "column_configs"."board_column_id" is not null AND "column_configs"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "column_configs_project_ws_order_idx" ON "column_configs" USING btree ("project_id","worksheet_id","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "stage_cells_task_column_key" ON "stage_cells" USING btree ("task_id","column_id");--> statement-breakpoint
CREATE INDEX "stage_cells_project_ws_idx" ON "stage_cells" USING btree ("project_id","worksheet_id");--> statement-breakpoint
CREATE INDEX "stage_cells_project_status_idx" ON "stage_cells" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "tasks_project_ws_order_active_idx" ON "tasks" USING btree ("project_id","worksheet_id","sort_order") WHERE "tasks"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "tasks_project_publish_active_idx" ON "tasks" USING btree ("project_id","publish_status") WHERE "tasks"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "tasks_project_work_active_idx" ON "tasks" USING btree ("project_id","work_id") WHERE "tasks"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "works_worksheet_name_key" ON "works" USING btree ("worksheet_id","name");--> statement-breakpoint
CREATE INDEX "works_project_ws_idx" ON "works" USING btree ("project_id","worksheet_id");--> statement-breakpoint
CREATE UNIQUE INDEX "worksheets_project_name_active_key" ON "worksheets" USING btree ("project_id","name") WHERE "worksheets"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "worksheets_project_order_active_idx" ON "worksheets" USING btree ("project_id","sort_order") WHERE "worksheets"."deleted_at" is null;
--> statement-breakpoint
INSERT INTO "board_columns" ("project_id", "name", "sort_order")
SELECT p."id", v."name", v."sort_order"
FROM "projects" p
CROSS JOIN (VALUES ('时轴', 'a0'), ('翻译', 'a1'), ('校对', 'a2'), ('嵌字', 'a3')) AS v("name", "sort_order")
WHERE NOT EXISTS (SELECT 1 FROM "board_columns" bc WHERE bc."project_id" = p."id");
