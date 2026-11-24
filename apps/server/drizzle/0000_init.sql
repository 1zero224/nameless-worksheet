CREATE TYPE "public"."role" AS ENUM('admin', 'user');--> statement-breakpoint
CREATE TABLE "invites" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"project_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"role" "role" NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"max_uses" integer NOT NULL,
	"used_count" integer DEFAULT 0 NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invites_token_hash_key" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"project_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memberships_project_id_user_id_pk" PRIMARY KEY("project_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "password_resets" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "password_resets_token_hash_key" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"name" text NOT NULL,
	"realtime_pruned_through" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "realtime_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "realtime_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"project_id" uuid NOT NULL,
	"scope_type" text NOT NULL,
	"scope_id" uuid NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"actor_user_id" uuid,
	"origin_conn_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"token_hash" text NOT NULL,
	"user_id" uuid NOT NULL,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "sessions_token_hash_key" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"login_name" text NOT NULL,
	"display_name" text NOT NULL,
	"password_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_login_name_key" UNIQUE("login_name"),
	CONSTRAINT "users_display_name_key" UNIQUE("display_name")
);
--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "password_resets" ADD CONSTRAINT "password_resets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "password_resets" ADD CONSTRAINT "password_resets_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "realtime_events" ADD CONSTRAINT "realtime_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invites_project_id_idx" ON "invites" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "memberships_user_id_key" ON "memberships" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "password_resets_user_id_idx" ON "password_resets" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "realtime_events_scope_idx" ON "realtime_events" USING btree ("project_id","scope_type","scope_id","id");--> statement-breakpoint
CREATE INDEX "realtime_events_created_at_idx" ON "realtime_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_at_idx" ON "sessions" USING btree ("expires_at");