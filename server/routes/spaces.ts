import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import JSZip from 'jszip';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { exec, many, one, withTransaction } from '../db/client.js';
import type { Space } from '../db/schema.js';
import { renderMarkdown } from '../lib/markdown.js';
import { requireAuth } from '../lib/session.js';

// ── SQL ──
// The list also carries per-space stats for the knowledge-base landing cards:
// page count and when any page in the space was last edited (NULL if empty).
// Grouping by the primary key lets Postgres select the other s.* columns.
// id is the final tie-breaker: new spaces all start at sort_order 0.
const SQL_LIST_SPACES = `
  SELECT s.id, s.name, s.description, s.icon, s.sort_order, s.created_at, s.updated_at,
         COUNT(p.id) AS page_count, MAX(p.updated_at) AS last_edited_at
  FROM spaces s
  LEFT JOIN pages p ON p.space_id = s.id
  GROUP BY s.id
  ORDER BY s.sort_order, s.created_at, s.id
`;

const SQL_GET_SPACE = `
  SELECT id, name, description, icon, sort_order, created_at, updated_at
  FROM spaces WHERE id = $1
`;

const SQL_INSERT_SPACE = `
  INSERT INTO spaces (id, name, description, icon, sort_order, created_at, updated_at)
  VALUES ($1, $2, $3, $4, $5, $6, $6)
`;

const SQL_DELETE_SPACE = `DELETE FROM spaces WHERE id = $1`;

// Export: fetch all pages in a space ordered by sort_order so parents
// generally precede children in the flat list (not guaranteed for all trees,
// but the export loop handles arbitrary ordering via a topological pass).
const SQL_GET_SPACE_PAGES = `
  SELECT id, title, content, parent_id, sort_order
  FROM pages
  WHERE space_id = $1
  ORDER BY sort_order ASC, created_at, id
`;

// Import: insert a single page; mirrors SQL_INSERT_PAGE in pages.ts but local
// to this module to avoid cross-module coupling.
const SQL_INSERT_PAGE_FOR_IMPORT = `
  INSERT INTO pages (id, space_id, parent_id, title, content, content_html,
                     sort_order, created_at, updated_at)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
`;

const SQL_TREE = `
  WITH RECURSIVE tree(id, title, parent_id, sort_order, depth) AS (
    SELECT id, title, parent_id, sort_order, 0
    FROM pages WHERE space_id = $1 AND parent_id IS NULL
    UNION ALL
    SELECT p.id, p.title, p.parent_id, p.sort_order, t.depth + 1
    FROM pages p JOIN tree t ON p.parent_id = t.id
    WHERE p.space_id = $1
  )
  SELECT id, title, parent_id, sort_order, depth FROM tree
  ORDER BY depth, sort_order, title, id
`;

interface SpaceRow {
  id: string;
  name: string;
  description: string;
  icon: string;
  sort_order: number;
  created_at: number;
  updated_at: number;
}

interface SpaceListRow extends SpaceRow {
  page_count: number;
  last_edited_at: number | null;
}

interface SpacePageRow {
  id: string;
  title: string;
  content: string;
  parent_id: string | null;
  sort_order: number;
}

interface TreeRow {
  id: string;
  title: string;
  parent_id: string | null;
  sort_order: number;
  depth: number;
}

interface TreeNode {
  id: string;
  title: string;
  parentId: string | null;
  sortOrder: number;
  depth: number;
  children: TreeNode[];
}

function toSpace(row: SpaceRow): Space {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    icon: row.icon,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const createSchema = z.object({
  name: z.string().min(1).max(256),
  description: z.string().max(2000).optional(),
  icon: z.string().max(16).optional(),
});

const updateSchema = z
  .object({
    name: z.string().min(1).max(256).optional(),
    description: z.string().max(2000).optional(),
    icon: z.string().max(16).optional(),
    // sort_order is a Postgres integer; out-of-range values are bad input.
    sortOrder: z.number().int().min(-2147483648).max(2147483647).optional(),
  })
  .refine((d) => Object.keys(d).length > 0, { message: 'No fields to update' });

export const spacesRouter = new Hono();

spacesRouter.use('*', requireAuth);

// GET / — list all spaces
spacesRouter.get('/', async (c) => {
  const rows = await many<SpaceListRow>(SQL_LIST_SPACES);
  return c.json(
    rows.map((r) => ({ ...toSpace(r), pageCount: r.page_count, lastEditedAt: r.last_edited_at })),
  );
});

// POST / — create a space
spacesRouter.post('/', zValidator('json', createSchema), async (c) => {
  const body = c.req.valid('json');
  const id = uuidv4();
  const now = Math.floor(Date.now() / 1000);

  await exec(SQL_INSERT_SPACE, [id, body.name, body.description ?? '', body.icon ?? '📁', 0, now]);

  const row = await one<SpaceRow>(SQL_GET_SPACE, [id]);
  if (!row) throw new HTTPException(500, { message: 'Failed to create space' });
  return c.json(toSpace(row), 201);
});

// PATCH /:id — update mutable fields
spacesRouter.patch('/:id', zValidator('json', updateSchema), async (c) => {
  const id = c.req.param('id');
  const body = c.req.valid('json');

  if (!(await one(SQL_GET_SPACE, [id]))) {
    throw new HTTPException(404, { message: 'Space not found' });
  }

  // Build a dynamic SET clause from only the provided fields; column names are
  // fixed strings here, every value is a bound parameter.
  const sets: string[] = [];
  const params: unknown[] = [];
  const set = (column: string, value: unknown) => {
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  };
  if (body.name !== undefined) set('name', body.name);
  if (body.description !== undefined) set('description', body.description);
  if (body.icon !== undefined) set('icon', body.icon);
  if (body.sortOrder !== undefined) set('sort_order', body.sortOrder);
  set('updated_at', Math.floor(Date.now() / 1000));
  params.push(id);

  await exec(`UPDATE spaces SET ${sets.join(', ')} WHERE id = $${params.length}`, params);

  const row = await one<SpaceRow>(SQL_GET_SPACE, [id]);
  if (!row) throw new HTTPException(404, { message: 'Space not found' });
  return c.json(toSpace(row));
});

// DELETE /:id — delete space; pages cascade via FK (whole space going away)
spacesRouter.delete('/:id', async (c) => {
  const id = c.req.param('id');
  if (!(await one(SQL_GET_SPACE, [id]))) {
    throw new HTTPException(404, { message: 'Space not found' });
  }

  await exec(SQL_DELETE_SPACE, [id]);
  return c.body(null, 204);
});

// POST /import — create a space and its pages from a ZIP exported by GET /:id/export
// Declared before GET /:id/tree (and any /:id patterns) so the literal path
// is registered first; Hono matches in declaration order.
const MAX_IMPORT_BYTES = 50 * 1024 * 1024; // 50 MB

// ── Filename sanitization ────────────────────────────────────────────────────

/**
 * Sanitize a page title into a safe filesystem/ZIP component.
 * Keeps the title human-readable: only strips characters that are illegal in
 * common filesystems (\/:*?"<>|) and replaces them with '-', then collapses
 * runs of whitespace to a single space and trims. Does NOT lowercase or slug.
 */
function sanitizeTitle(title: string): string {
  return (
    title
      .replace(/[\\/:*?"<>|]/g, '-')
      .replace(/\s+/g, ' ')
      .trim() || 'Untitled'
  );
}

// ── Legacy format (v1 _meta.json) ───────────────────────────────────────────

interface ImportMeta {
  version: number;
  spaceName: string;
  spaceIcon?: string;
  pages: Array<{
    id: string;
    title: string;
    parentId: string | null;
    sortOrder: number;
    filename: string;
  }>;
}

/**
 * Import handler for the original flat-file format (ZIP contains _meta.json
 * and a pages/ folder). Kept unchanged for backward compatibility.
 */
async function importLegacyFormat(
  zip: JSZip,
  meta: ImportMeta,
): Promise<Array<{
  newId: string;
  title: string;
  content: string;
  contentHtml: string;
  parentId: string | null;
  sortOrder: number;
}>> {
  const pages = Array.isArray(meta.pages) ? meta.pages : [];
  const oldToNewId = new Map<string, string>();
  const renderedPages: Array<{
    newId: string;
    title: string;
    content: string;
    contentHtml: string;
    parentId: string | null;
    sortOrder: number;
  }> = [];

  // Topological sort: process pages whose parent has already been assigned a
  // new ID (or has no parent). Guard against malformed ZIPs with cycles.
  const remaining = [...pages];
  while (remaining.length > 0) {
    const sizeBefore = remaining.length;
    for (let i = remaining.length - 1; i >= 0; i--) {
      const p = remaining[i];
      if (p.parentId !== null && !oldToNewId.has(p.parentId)) continue;

      const pageFile = zip.file(`pages/${p.filename}`);
      const content = pageFile ? await pageFile.async('string') : '';
      const contentHtml = content ? await renderMarkdown(content) : '';
      const newId = uuidv4();

      oldToNewId.set(p.id, newId);
      renderedPages.push({
        newId,
        title: p.title ?? 'Untitled',
        content,
        contentHtml,
        parentId: p.parentId !== null ? (oldToNewId.get(p.parentId) ?? null) : null,
        sortOrder: p.sortOrder ?? 0,
      });
      remaining.splice(i, 1);
    }
    // Cycle guard: if nothing was processed this pass, stop to avoid an
    // infinite loop. Remaining pages will be inserted as root-level pages.
    if (remaining.length === sizeBefore) {
      for (const p of remaining) {
        const pageFile = zip.file(`pages/${p.filename}`);
        const content = pageFile ? await pageFile.async('string') : '';
        const contentHtml = content ? await renderMarkdown(content) : '';
        const newId = uuidv4();
        oldToNewId.set(p.id, newId);
        renderedPages.push({
          newId,
          title: p.title ?? 'Untitled',
          content,
          contentHtml,
          parentId: null, // break the cycle by orphaning to root
          sortOrder: p.sortOrder ?? 0,
        });
      }
      break;
    }
  }

  return renderedPages;
}

// ── New folder-hierarchy format ──────────────────────────────────────────────

/**
 * Import handler for the Docmost-style folder-hierarchy format. The ZIP
 * contains .md files whose paths encode the tree structure, e.g.:
 *   DevOps.md                     → root page "DevOps"
 *   DevOps/Monitoring.md          → child of DevOps
 *   DevOps/Monitoring/Icinga.md   → grandchild
 *
 * Directories that have no corresponding .md file (can occur when Docmost
 * exports a page whose title contained '/') are synthesised as virtual empty
 * pages so the tree structure is preserved.
 */
async function importFolderFormat(zip: JSZip): Promise<
  Array<{
    newId: string;
    title: string;
    content: string;
    contentHtml: string;
    parentId: string | null;
    sortOrder: number;
  }>
> {
  // Collect every .md file path (JSZip keys, forward-slash separated).
  // JSZip represents directories as entries ending with '/'; skip those.
  const mdPaths: string[] = [];
  zip.forEach((relativePath, file) => {
    if (!file.dir && relativePath.endsWith('.md')) {
      mdPaths.push(relativePath);
    }
  });

  // Derive the set of all directory paths that are ancestors of .md files.
  // For a file at A/B/C.md the ancestors are ['A', 'A/B'].
  // Any directory that has no sibling .md file (e.g. 'A' with no 'A.md')
  // will become a virtual page with empty content.
  const dirPaths = new Set<string>();
  for (const p of mdPaths) {
    const segments = p.split('/');
    // walk all prefix directories (exclude the file itself)
    for (let depth = 1; depth < segments.length; depth++) {
      dirPaths.add(segments.slice(0, depth).join('/'));
    }
  }

  // A path key is the path without the .md extension for files,
  // or the bare directory path for virtual nodes.
  // Build a union of all path keys that need a page node.
  const mdPathKeys = new Set(mdPaths.map((p) => p.slice(0, -'.md'.length)));
  const virtualDirKeys = new Set([...dirPaths].filter((d) => !mdPathKeys.has(d)));

  // Combine into a single list of { pathKey, isVirtual }.
  interface PageEntry {
    pathKey: string;   // e.g. "DevOps/Monitoring"
    isVirtual: boolean;
  }
  const allEntries: PageEntry[] = [
    ...[...mdPathKeys].map((k) => ({ pathKey: k, isVirtual: false })),
    ...[...virtualDirKeys].map((k) => ({ pathKey: k, isVirtual: true })),
  ];

  // Sort by depth (number of '/') then alphabetically so parents are always
  // processed before their children — no need for a separate topological pass.
  allEntries.sort((a, b) => {
    const depthA = (a.pathKey.match(/\//g) ?? []).length;
    const depthB = (b.pathKey.match(/\//g) ?? []).length;
    if (depthA !== depthB) return depthA - depthB;
    return a.pathKey.localeCompare(b.pathKey);
  });

  // Assign a UUID to each path key before rendering so parent IDs can be
  // resolved during the same pass.
  const pathToId = new Map<string, string>();
  for (const entry of allEntries) {
    pathToId.set(entry.pathKey, uuidv4());
  }

  const renderedPages: Array<{
    newId: string;
    title: string;
    content: string;
    contentHtml: string;
    parentId: string | null;
    sortOrder: number;
  }> = [];

  // Track sibling insertion order within each parent to assign sort_order.
  const siblingCounter = new Map<string | null, number>();

  for (const entry of allEntries) {
    const segments = entry.pathKey.split('/');
    const title = segments[segments.length - 1]; // last segment = page title

    const parentPathKey = segments.length > 1 ? segments.slice(0, -1).join('/') : null;
    const parentId = parentPathKey !== null ? (pathToId.get(parentPathKey) ?? null) : null;

    const content = entry.isVirtual ? '' : (await zip.file(`${entry.pathKey}.md`)?.async('string')) ?? '';
    const contentHtml = content ? await renderMarkdown(content) : '';

    // Sort order = insertion sequence within this parent bucket.
    const sortOrder = siblingCounter.get(parentId) ?? 0;
    siblingCounter.set(parentId, sortOrder + 1);

    renderedPages.push({
      newId: pathToId.get(entry.pathKey)!,
      title,
      content,
      contentHtml,
      parentId,
      sortOrder,
    });
  }

  return renderedPages;
}

// ── /import route ────────────────────────────────────────────────────────────

spacesRouter.post('/import', async (c) => {
  let formData: FormData;
  try {
    formData = await c.req.formData();
  } catch {
    throw new HTTPException(400, { message: 'Expected multipart/form-data' });
  }

  const file = formData.get('file');
  if (!file || typeof file === 'string') {
    throw new HTTPException(400, { message: 'Missing file field' });
  }

  const arrayBuffer = await (file as File).arrayBuffer();

  // Guard against oversized uploads before decompression (zip-bomb mitigation).
  if (arrayBuffer.byteLength > MAX_IMPORT_BYTES) {
    throw new HTTPException(413, { message: 'ZIP file exceeds 50 MB limit' });
  }

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(arrayBuffer);
  } catch {
    throw new HTTPException(400, { message: 'Invalid ZIP file' });
  }

  const spaceId = uuidv4();
  const now = Math.floor(Date.now() / 1000);

  let spaceName: string;
  let spaceIcon = '📁';
  let renderedPages: Awaited<ReturnType<typeof importFolderFormat>>;

  const metaFile = zip.file('_meta.json');
  if (metaFile) {
    // ── Legacy format ──────────────────────────────────────────────────────
    let meta: ImportMeta;
    try {
      meta = JSON.parse(await metaFile.async('string')) as ImportMeta;
    } catch {
      throw new HTTPException(400, { message: 'Invalid _meta.json — not valid JSON' });
    }

    if (!meta.spaceName || typeof meta.spaceName !== 'string') {
      throw new HTTPException(400, { message: 'Invalid _meta.json — missing spaceName' });
    }

    spaceName = meta.spaceName;
    spaceIcon = meta.spaceIcon ?? '📁';
    renderedPages = await importLegacyFormat(zip, meta);
  } else {
    // ── Folder-hierarchy format ────────────────────────────────────────────
    // Space name: prefer explicit query param, otherwise fall back to generic.
    spaceName = c.req.query('spaceName')?.trim() || 'Imported Space';
    renderedPages = await importFolderFormat(zip);

    if (renderedPages.length === 0) {
      throw new HTTPException(400, { message: 'No .md files found in ZIP' });
    }
  }

  // Markdown was rendered above, outside the transaction, so the connection
  // isn't held open while unified works. Space + pages land atomically.
  try {
    await withTransaction(async (tx) => {
      await exec(
        SQL_INSERT_SPACE,
        [spaceId, spaceName.slice(0, 256), '', spaceIcon, 0, now],
        tx,
      );
      for (const rp of renderedPages) {
        await exec(
          SQL_INSERT_PAGE_FOR_IMPORT,
          [rp.newId, spaceId, rp.parentId, rp.title, rp.content, rp.contentHtml, rp.sortOrder, now],
          tx,
        );
      }
    });
  } catch (err) {
    console.error('[import] transaction failed:', err);
    throw new HTTPException(500, { message: 'Failed to import space' });
  }

  const space = await one<SpaceRow>(SQL_GET_SPACE, [spaceId]);
  if (!space) throw new HTTPException(500, { message: 'Failed to retrieve imported space' });
  return c.json(toSpace(space), 201);
});

// GET /:id/export — download the space as a folder-hierarchy ZIP.
// Each page's path mirrors the page tree: root pages become RootTitle.md,
// their children become RootTitle/ChildTitle.md, and so on.
// Declared after /import (static path) and before /:id/tree (also two-segment,
// no ambiguity in Hono) to keep declaration order semantically clear.
spacesRouter.get('/:id/export', async (c) => {
  const id = c.req.param('id');
  const spaceRow = await one<SpaceRow>(SQL_GET_SPACE, [id]);
  if (!spaceRow) throw new HTTPException(404, { message: 'Space not found' });

  const pages = await many<SpacePageRow>(SQL_GET_SPACE_PAGES, [id]);

  // Build a map from page id → its ZIP path (without .md extension) so we
  // can resolve child paths after the parent path is known.
  // Pages from SQL_GET_SPACE_PAGES are ordered by sort_order ASC, which means
  // parents generally come before their children, but that is not guaranteed
  // for all tree shapes. We therefore do a topological pass: iterate until
  // all pages are placed, skipping any page whose parent isn't resolved yet.
  const pathByPageId = new Map<string, string>(); // id → "A/B/C" (no .md)
  // Track used paths within each parent directory to deduplicate siblings
  // that share the same sanitized title.
  const usedPathsInDir = new Map<string | null, Set<string>>(); // parentId → Set of basenames used

  const remaining = [...pages];
  while (remaining.length > 0) {
    const sizeBefore = remaining.length;

    for (let i = remaining.length - 1; i >= 0; i--) {
      const p = remaining[i];

      // Skip until parent path is resolved (or page is a root page).
      if (p.parent_id !== null && !pathByPageId.has(p.parent_id)) continue;

      const parentPath = p.parent_id !== null ? pathByPageId.get(p.parent_id)! : null;
      const dirKey = parentPath; // null means ZIP root

      if (!usedPathsInDir.has(dirKey)) usedPathsInDir.set(dirKey, new Set());
      const usedInDir = usedPathsInDir.get(dirKey)!;

      const base = sanitizeTitle(p.title);
      let basename = base;
      let counter = 2;
      while (usedInDir.has(basename)) {
        basename = `${base} (${counter++})`;
      }
      usedInDir.add(basename);

      const zipPathKey = parentPath !== null ? `${parentPath}/${basename}` : basename;
      pathByPageId.set(p.id, zipPathKey);
      remaining.splice(i, 1);
    }

    // Cycle guard: if no page was resolved this pass, orphan remaining pages
    // to the ZIP root to avoid an infinite loop.
    if (remaining.length === sizeBefore) {
      const rootUsed = usedPathsInDir.get(null) ?? new Set<string>();
      usedPathsInDir.set(null, rootUsed);
      for (const p of remaining) {
        const base = sanitizeTitle(p.title);
        let basename = base;
        let counter = 2;
        while (rootUsed.has(basename)) {
          basename = `${base} (${counter++})`;
        }
        rootUsed.add(basename);
        pathByPageId.set(p.id, basename);
      }
      break;
    }
  }

  // Write each page's markdown into the ZIP at its resolved path.
  const zip = new JSZip();
  for (const p of pages) {
    const zipPathKey = pathByPageId.get(p.id);
    if (!zipPathKey) continue; // should never happen after the loop above
    zip.file(`${zipPathKey}.md`, p.content);
  }

  const zipBuffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });

  // Use the same readable sanitization for the download filename.
  const safeName = sanitizeTitle(spaceRow.name).replace(/\s+/g, '-') || 'space';

  c.header('Content-Type', 'application/zip');
  c.header('Content-Disposition', `attachment; filename="${safeName}.zip"`);
  // Hono's c.body() accepts Uint8Array; Buffer extends Uint8Array at runtime
  // but TypeScript needs the explicit cast since Buffer<ArrayBufferLike> doesn't
  // satisfy the Uint8Array<ArrayBuffer> overload directly.
  return c.body(new Uint8Array(zipBuffer) as Uint8Array<ArrayBuffer>);
});

// GET /:id/tree — nested page tree for the space
spacesRouter.get('/:id/tree', async (c) => {
  const id = c.req.param('id');
  if (!(await one(SQL_GET_SPACE, [id]))) {
    throw new HTTPException(404, { message: 'Space not found' });
  }

  const rows = await many<TreeRow>(SQL_TREE, [id]);

  // Assemble flat rows into a nested structure. Rows arrive ordered by depth,
  // so a parent is always materialized before its children.
  const byId = new Map<string, TreeNode>();
  const roots: TreeNode[] = [];

  for (const r of rows) {
    byId.set(r.id, {
      id: r.id,
      title: r.title,
      parentId: r.parent_id,
      sortOrder: r.sort_order,
      depth: r.depth,
      children: [],
    });
  }

  for (const r of rows) {
    const node = byId.get(r.id)!;
    if (r.parent_id && byId.has(r.parent_id)) {
      byId.get(r.parent_id)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  return c.json(roots);
});
