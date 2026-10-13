import { many } from '../db/client.js';
import { SEARCH_SPLIT_CHARS } from '../db/schema.js';

export interface SearchResult {
  id: string;
  title: string;
  spaceId: string;
  snippet: string;
}

interface SearchRow {
  id: string;
  title: string;
  space_id: string;
  content: string;
  headline: string;
}

/**
 * Build a safe tsquery string from arbitrary user input.
 *
 * tsquery has its own operator syntax (& | ! <-> ( ) :* and quoting), so raw
 * user text risks both syntax errors and operator injection. We never pass it
 * through: the input is cut into words on every character that isn't a
 * letter, combining mark or digit — the same split the indexed text gets (see
 * SEARCH_SPLIT_CHARS in db/schema.ts plus the parser's own separators) — so
 * operator characters simply vanish. Each word becomes a quoted lexeme, the
 * words are ANDed, and the LAST one gets `:*` so search-as-you-type matches
 * prefixes. The result is passed to to_tsquery() as a bound parameter.
 *
 * Returns null when there is nothing searchable (empty, whitespace,
 * punctuation- or emoji-only input).
 */
export function buildTsQuery(raw: string): string | null {
  const words = raw.split(/[^\p{L}\p{M}\p{N}]+/u).filter((w) => w.length > 0);
  if (words.length === 0) return null;

  // Words can't contain quotes or backslashes after the split above; escaping
  // them anyway keeps this safe if the split ever changes.
  const lexeme = (w: string) => `'${w.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
  return words
    .map((w, i) => (i === words.length - 1 ? `${lexeme(w)}:*` : lexeme(w)))
    .join(' & ');
}

// ── Snippets ──
//
// ts_headline marks matches with StartSel/StopSel. The client renders the
// snippet with dangerouslySetInnerHTML, and the content is raw markdown that
// may contain HTML, so the headline must be escaped before it is sent. We
// therefore mark with control characters that can't survive in the text
// (they are stripped from the content first), HTML-escape the whole headline,
// then turn just those markers into <mark>…</mark>. Nothing else in a snippet
// is ever real HTML.
const MARK_START = '\u0002';
const MARK_STOP = '\u0003';
const ZWSP = '​';

// The default parser glues words around SEARCH_SPLIT_CHARS ("nginx.conf" is
// one token), so ts_headline wouldn't highlight "nginx" there. A zero-width
// space after each of those characters breaks the glue without changing what
// is displayed; it's removed again below.
const SPLIT_CHARS_RE = `([${SEARCH_SPLIT_CHARS.replace(/[\\\]^-]/g, '\\$&')}])`;
const HEADLINE_OPTIONS =
  `StartSel=${MARK_START}, StopSel=${MARK_STOP}, ` +
  // One fragment of ~20 words, like the old FTS5 snippet(…, 20). MinWords is
  // also the length of the fallback when only the title matched.
  'MaxFragments=1, MaxWords=20, MinWords=15';

/**
 * Search, then build snippets for the ≤20 hits only (ts_headline re-parses the
 * whole document, so it must not run for every match). Ranked by ts_rank with
 * title matches (weight A) counting 2.5× content matches (weight B), divided by
 * 1 + log(document length) so long pages don't win just by being long; ties
 * fall back to the most recently edited page. $2 NULL means "every space".
 */
const SEARCH_SQL = `
  WITH hits AS (
    SELECT id, space_id, title, content, updated_at,
           ts_rank(search_vector, to_tsquery('kb_search', $1), 1) AS rank
    FROM pages
    WHERE search_vector @@ to_tsquery('kb_search', $1)
      AND ($2::text IS NULL OR space_id = $2)
    ORDER BY rank DESC, updated_at DESC, id
    LIMIT 20
  )
  SELECT id, space_id, title, content,
         ts_headline(
           'kb_search',
           regexp_replace(translate(content, $3, ''), $4, $5, 'g'),
           to_tsquery('kb_search', $1),
           $6
         ) AS headline
  FROM hits
  ORDER BY rank DESC, updated_at DESC, id
`;

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]!);
}

const HAS_WORD = /[\p{L}\p{N}]/u;
const MARKERS = /[\u0002\u0003]/g;
const ZWSPS = /​/g;

/**
 * Turn a raw headline into safe snippet HTML, adding "…" where the excerpt
 * cuts text off at either end (as FTS5's snippet did).
 */
function toSnippet(headline: string, content: string): string {
  const visible = headline.replace(ZWSPS, '');
  const plain = visible.replace(MARKERS, '');
  if (!plain) return '';

  // ts_headline copies the document's own characters, so the excerpt is
  // normally a substring of the content; when it isn't (it drops HTML tags),
  // skip the ellipses rather than guess.
  const text = content.replace(MARKERS, '').replace(ZWSPS, '');
  const pos = text.indexOf(plain);
  const cutStart = pos > 0 && HAS_WORD.test(text.slice(0, pos));
  const cutEnd = pos >= 0 && HAS_WORD.test(text.slice(pos + plain.length));

  const html = escapeHtml(visible)
    .replaceAll(MARK_START, '<mark>')
    .replaceAll(MARK_STOP, '</mark>');
  return `${cutStart ? '…' : ''}${html}${cutEnd ? '…' : ''}`;
}

/**
 * Full-text search over page titles and content (accent-insensitive, every
 * word must match, last word as a prefix). Optionally scoped to a space.
 * Returns up to 20 results, best first.
 */
export async function searchPages(query: string, spaceId?: string): Promise<SearchResult[]> {
  const tsquery = buildTsQuery(query);
  if (tsquery === null) return [];

  const rows = await many<SearchRow>(SEARCH_SQL, [
    tsquery,
    spaceId !== undefined && spaceId !== '' ? spaceId : null,
    MARK_START + MARK_STOP,
    SPLIT_CHARS_RE,
    `\\1${ZWSP}`,
    HEADLINE_OPTIONS,
  ]);

  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    spaceId: r.space_id,
    snippet: toSnippet(r.headline, r.content),
  }));
}
