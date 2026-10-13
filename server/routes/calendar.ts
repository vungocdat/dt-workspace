import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { exec, many, one } from '../db/client.js';
import { renderMarkdown } from '../lib/markdown.js';
import { requireAuth } from '../lib/session.js';

/**
 * The calendar is a standalone feature, not a view over the knowledge base.
 * Its notes live in calendar_notes keyed by date — they are not pages: no
 * space, no parent, nothing in the sidebar tree, and not in search. Creating a
 * calendar note touches nothing else in the app.
 *
 * Dates are the *client's* local calendar dates. The server stores the ISO
 * string it is given verbatim and never derives one from a timestamp, which
 * would mean guessing the browser's UTC offset.
 *
 * Markdown is rendered server-side on save and cached in content_html, exactly
 * as pages do it, so read mode never parses markdown in the browser.
 */

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

interface NoteRow {
  date: string;
  content: string;
  content_html: string;
  created_at: number;
  updated_at: number;
}

// ── SQL ──

const SQL_GET_NOTE = `
  SELECT date, content, content_html, created_at, updated_at
  FROM calendar_notes WHERE date = $1
`;

// Range listing for one calendar view — content is deliberately not selected,
// the grid only needs to know which days have a note. All dates share the
// YYYY-MM-DD shape (validated), so text comparison is date order.
const SQL_LIST_NOTES_IN_RANGE = `
  SELECT date, updated_at FROM calendar_notes
  WHERE date >= $1 AND date <= $2
  ORDER BY date
`;

const SQL_UPSERT_NOTE = `
  INSERT INTO calendar_notes (date, content, content_html, created_at, updated_at)
  VALUES ($1, $2, $3, $4, $4)
  ON CONFLICT (date) DO UPDATE SET
    content      = excluded.content,
    content_html = excluded.content_html,
    updated_at   = excluded.updated_at
`;

const SQL_DELETE_NOTE = `DELETE FROM calendar_notes WHERE date = $1`;

// ── Helpers ──

/**
 * True only for dates that actually exist — the regex alone would accept
 * 2026-02-31. Compared in UTC so the host timezone can't shift the roll-over.
 */
function isRealDate(date: string): boolean {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
  );
}

function toNote(row: NoteRow) {
  return {
    date: row.date,
    content: row.content,
    contentHtml: row.content_html,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Rejects malformed or impossible dates from the :date path param. */
function requireDateParam(raw: string): string {
  if (!ISO_DATE_RE.test(raw) || !isRealDate(raw)) {
    throw new HTTPException(400, { message: 'date must be a real YYYY-MM-DD date' });
  }
  return raw;
}

// ── Schemas ──

const rangeQuerySchema = z
  .object({
    from: z.string().regex(ISO_DATE_RE, 'from must be YYYY-MM-DD'),
    to: z.string().regex(ISO_DATE_RE, 'to must be YYYY-MM-DD'),
  })
  .refine((q) => q.from <= q.to, { message: 'from must not be after to' });

const saveBodySchema = z.object({
  content: z.string(),
});

// ── Router ──

export const calendarRouter = new Hono();

calendarRouter.use('*', requireAuth);

/**
 * GET /notes?from=&to= — which days in the visible range have a note.
 * Declared before /notes/:date so the literal path wins in Hono's
 * declaration-order matching.
 */
calendarRouter.get('/notes', zValidator('query', rangeQuerySchema), async (c) => {
  const { from, to } = c.req.valid('query');
  const rows = await many<{ date: string; updated_at: number }>(SQL_LIST_NOTES_IN_RANGE, [
    from,
    to,
  ]);
  return c.json(rows.map((r) => ({ date: r.date, updatedAt: r.updated_at })));
});

// GET /notes/:date — one note, or 404 if that day has none
calendarRouter.get('/notes/:date', async (c) => {
  const date = requireDateParam(c.req.param('date'));
  const row = await one<NoteRow>(SQL_GET_NOTE, [date]);
  if (!row) throw new HTTPException(404, { message: 'No note for that date' });
  return c.json(toNote(row));
});

/**
 * PUT /notes/:date — create or overwrite the note for a date (upsert), so the
 * same call serves both "create note" and every auto-save after it.
 */
calendarRouter.put('/notes/:date', zValidator('json', saveBodySchema), async (c) => {
  const date = requireDateParam(c.req.param('date'));
  const { content } = c.req.valid('json');

  const existing = await one(SQL_GET_NOTE, [date]);
  const contentHtml = content ? await renderMarkdown(content) : '';

  await exec(SQL_UPSERT_NOTE, [date, content, contentHtml, Math.floor(Date.now() / 1000)]);

  const row = await one<NoteRow>(SQL_GET_NOTE, [date]);
  if (!row) throw new HTTPException(500, { message: 'Failed to save note' });
  return c.json(toNote(row), existing ? 200 : 201);
});

// DELETE /notes/:date — remove a day's note
calendarRouter.delete('/notes/:date', async (c) => {
  const date = requireDateParam(c.req.param('date'));
  if ((await exec(SQL_DELETE_NOTE, [date])) === 0) {
    throw new HTTPException(404, { message: 'No note for that date' });
  }
  return c.body(null, 204);
});
