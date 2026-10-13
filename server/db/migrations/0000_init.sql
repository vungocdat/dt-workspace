-- Hand-written prelude (drizzle-kit can't express these; it never diffs them,
-- so future db:generate runs are unaffected). pages.search_vector below
-- depends on the kb_search configuration, so it must exist first.
--
-- unaccent is a trusted extension: the database owner can create it without
-- superuser rights. kb_search = the `simple` configuration (no stemming, no
-- stop words — the KB mixes Vietnamese and English) with unaccent applied to
-- every token type that can carry letters, so "viet" matches "Việt" and
-- "dep" matches "đẹp". Pure-ASCII token types need no unaccent.
CREATE EXTENSION IF NOT EXISTS unaccent;
--> statement-breakpoint
CREATE TEXT SEARCH CONFIGURATION kb_search (COPY = pg_catalog.simple);
--> statement-breakpoint
ALTER TEXT SEARCH CONFIGURATION kb_search
  ALTER MAPPING FOR word, hword, hword_part, numword, numhword, hword_numpart
  WITH unaccent, simple;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "calendar_notes" (
	"date" text PRIMARY KEY NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"content_html" text DEFAULT '' NOT NULL,
	"created_at" bigint DEFAULT (extract(epoch from now()))::bigint NOT NULL,
	"updated_at" bigint DEFAULT (extract(epoch from now()))::bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pages" (
	"id" text PRIMARY KEY NOT NULL,
	"space_id" text NOT NULL,
	"parent_id" text,
	"title" text DEFAULT 'Untitled' NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"content_html" text DEFAULT '' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" bigint DEFAULT (extract(epoch from now()))::bigint NOT NULL,
	"updated_at" bigint DEFAULT (extract(epoch from now()))::bigint NOT NULL,
	"search_vector" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('kb_search'::regconfig, translate(title, './@-:<>+~\=?&#%', '               ')), 'A') || setweight(to_tsvector('kb_search'::regconfig, translate(content, './@-:<>+~\=?&#%', '               ')), 'B')) STORED NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "spaces" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"icon" text DEFAULT '📁' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" bigint DEFAULT (extract(epoch from now()))::bigint NOT NULL,
	"updated_at" bigint DEFAULT (extract(epoch from now()))::bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "todos" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"done" boolean DEFAULT false NOT NULL,
	"sort_order" integer NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"created_at" bigint DEFAULT (extract(epoch from now()))::bigint NOT NULL,
	"updated_at" bigint DEFAULT (extract(epoch from now()))::bigint NOT NULL,
	"completed_at" bigint
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pages" ADD CONSTRAINT "pages_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pages_space_id_idx" ON "pages" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pages_parent_id_idx" ON "pages" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pages_updated_at_idx" ON "pages" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pages_search_idx" ON "pages" USING gin ("search_vector");