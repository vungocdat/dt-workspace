import { sql } from 'drizzle-orm';
import { bigint, boolean, customType, index, integer, pgTable, text } from 'drizzle-orm/pg-core';

/**
 * Timestamps are Unix epoch SECONDS in a bigint (the API exposes them as plain
 * numbers; lib/db's int8 type parser turns them back into JS numbers). App code
 * writes Math.floor(Date.now() / 1000); the default only covers ad-hoc inserts.
 */
const epochNow = sql`(extract(epoch from now()))::bigint`;
const createdAt = () => bigint('created_at', { mode: 'number' }).notNull().default(epochNow);
const updatedAt = () => bigint('updated_at', { mode: 'number' }).notNull().default(epochNow);

/** Postgres tsvector — drizzle has no built-in column type for it. */
const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' });

/**
 * Punctuation that Postgres' default text-search parser glues words together
 * with: it reads "/etc/nginx/nginx.conf" as one `file` token, "nginx.service"
 * as one `host`, "10.0.0.1" as one `version`, "<hostname>" as an HTML tag (and
 * drops it). A search for "nginx" would then miss all of them, unlike the old
 * FTS5 unicode61 tokenizer which split on every non-alphanumeric character.
 * Translating these to spaces before to_tsvector restores that behaviour
 * deterministically (translate() is immutable and locale-independent, as a
 * generated column requires). lib/search.ts uses the same character set for
 * snippets — keep the two in sync (it's exported for that reason).
 */
export const SEARCH_SPLIT_CHARS = './@-:<>+~\\=?&#%';
const SEARCH_SPLIT_SPACES = ' '.repeat(SEARCH_SPLIT_CHARS.length);
const searchText = (column: string) =>
  `translate(${column}, '${SEARCH_SPLIT_CHARS}', '${SEARCH_SPLIT_SPACES}')`;

/**
 * spaces — top-level containers for pages.
 * id is a UUID string PK.
 */
export const spaces = pgTable('spaces', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  icon: text('icon').notNull().default('📁'),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/**
 * pages — markdown documents, optionally nested via self-referential parent_id.
 *
 * NOTE: parent_id is intentionally NOT a foreign key. Deletion re-parents
 * children (routes/pages.ts), so a hard FK constraint would fight the
 * re-parenting transaction. space_id IS a real FK so deleting a space cascades.
 *
 * search_vector is a STORED generated column over title (weight A) and content
 * (weight B) using the kb_search text search configuration (simple + unaccent,
 * created by hand in the 0000 migration — drizzle-kit can't express it). It
 * replaces the old FTS5 table and its three sync triggers: Postgres keeps it
 * current on every insert/update. Never select it into an API response.
 */
export const pages = pgTable(
  'pages',
  {
    id: text('id').primaryKey(),
    spaceId: text('space_id')
      .notNull()
      .references(() => spaces.id, { onDelete: 'cascade' }),
    parentId: text('parent_id'),
    title: text('title').notNull().default('Untitled'),
    content: text('content').notNull().default(''),
    contentHtml: text('content_html').notNull().default(''),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    searchVector: tsvector('search_vector')
      .notNull()
      .generatedAlwaysAs(
        sql.raw(
          `setweight(to_tsvector('kb_search'::regconfig, ${searchText('title')}), 'A') || ` +
            `setweight(to_tsvector('kb_search'::regconfig, ${searchText('content')}), 'B')`,
        ),
      ),
  },
  (table) => [
    index('pages_space_id_idx').on(table.spaceId),
    index('pages_parent_id_idx').on(table.parentId),
    index('pages_updated_at_idx').on(table.updatedAt),
    index('pages_search_idx').using('gin', table.searchVector),
  ],
);

/**
 * calendar_notes — the Calendar tab's storage, deliberately unrelated to pages:
 * one note per client-local calendar date (YYYY-MM-DD, stored verbatim), no
 * space, no parent, no FK, not in search.
 */
export const calendarNotes = pgTable('calendar_notes', {
  date: text('date').primaryKey(),
  content: text('content').notNull().default(''),
  contentHtml: text('content_html').notNull().default(''),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/**
 * todos — the To-do tab's flat task list, unrelated to pages and the calendar.
 * completed_at is set while done so finished items list most-recent first; a
 * done task keeps its pinned flag so un-ticking returns it to the top.
 */
export const todos = pgTable('todos', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  done: boolean('done').notNull().default(false),
  sortOrder: integer('sort_order').notNull(),
  pinned: boolean('pinned').notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  completedAt: bigint('completed_at', { mode: 'number' }),
});

export type Space = typeof spaces.$inferSelect;
export type NewSpace = typeof spaces.$inferInsert;
/** A page as the API returns it — search_vector is internal. */
export type Page = Omit<typeof pages.$inferSelect, 'searchVector'>;
export type NewPage = typeof pages.$inferInsert;
