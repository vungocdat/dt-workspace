import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { exec, many, one, withTransaction } from '../db/client.js';
import type { Page } from '../db/schema.js';
import { renderMarkdown } from '../lib/markdown.js';
import { requireAuth } from '../lib/session.js';

interface PageRow {
  id: string;
  space_id: string;
  parent_id: string | null;
  title: string;
  content: string;
  content_html: string;
  sort_order: number;
  created_at: number;
  updated_at: number;
}

interface PageRowFull extends PageRow {
  space_name: string;
}

interface AncestorRow {
  id: string;
  title: string;
}

interface RecentRow {
  id: string;
  title: string;
  space_id: string;
  space_name: string;
  updated_at: number;
}

// ── SQL ──
// Every statement names its columns: pages.search_vector is internal and must
// never reach a response.

const SQL_GET_PAGE = `
  SELECT id, space_id, parent_id, title, content, content_html,
         sort_order, created_at, updated_at
  FROM pages WHERE id = $1
`;

const SQL_GET_PAGE_FULL = `
  SELECT p.id, p.space_id, p.parent_id, p.title, p.content, p.content_html,
         p.sort_order, p.created_at, p.updated_at, s.name AS space_name
  FROM pages p JOIN spaces s ON p.space_id = s.id
  WHERE p.id = $1
`;

const SQL_GET_ANCESTORS = `
  WITH RECURSIVE anc(id, title, parent_id, lvl) AS (
    SELECT p.id, p.title, p.parent_id, 0
    FROM pages p WHERE p.id = (SELECT parent_id FROM pages WHERE id = $1)
    UNION ALL
    SELECT p.id, p.title, p.parent_id, a.lvl + 1
    FROM pages p JOIN anc a ON p.id = a.parent_id
  )
  SELECT id, title FROM anc ORDER BY lvl DESC
`;

const SQL_SPACE_EXISTS = `SELECT id FROM spaces WHERE id = $1`;

const SQL_INSERT_PAGE = `
  INSERT INTO pages (id, space_id, parent_id, title, content, content_html,
                     sort_order, created_at, updated_at)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
`;

// id breaks ties so pages saved in the same second keep a stable order.
const SQL_RECENT = `
  SELECT p.id, p.title, p.space_id, s.name AS space_name, p.updated_at
  FROM pages p JOIN spaces s ON p.space_id = s.id
  ORDER BY p.updated_at DESC, p.id
  LIMIT 10
`;

// Re-parent children to the deleted page's parent, then delete the page.
const SQL_REPARENT_CHILDREN = `
  UPDATE pages
  SET parent_id = (SELECT parent_id FROM pages WHERE id = $1)
  WHERE parent_id = $1
`;
const SQL_DELETE_PAGE = `DELETE FROM pages WHERE id = $1`;

// The moved page and all its descendants. UNION (not UNION ALL) stops the
// recursion even if the parent links ever form a cycle.
const SQL_UPDATE_DESCENDANTS_SPACE = `
  WITH RECURSIVE descendants(id) AS (
    SELECT id FROM pages WHERE id = $1
    UNION
    SELECT p.id FROM pages p JOIN descendants d ON p.parent_id = d.id
  )
  UPDATE pages SET space_id = $2 WHERE id IN (SELECT id FROM descendants)
`;

const SQL_MOVE_PAGE = `
  UPDATE pages SET parent_id = $1, sort_order = $2, updated_at = $3 WHERE id = $4
`;

async function getPageResponse(id: string) {
  const row = await one<PageRowFull>(SQL_GET_PAGE_FULL, [id]);
  if (!row) return undefined;
  const ancestors = await many<AncestorRow>(SQL_GET_ANCESTORS, [id]);
  return {
    ...toPage(row),
    spaceName: row.space_name,
    ancestors: ancestors.map((a) => ({ id: a.id, title: a.title })),
  };
}

function toPage(row: PageRow): Page {
  return {
    id: row.id,
    spaceId: row.space_id,
    parentId: row.parent_id,
    title: row.title,
    content: row.content,
    contentHtml: row.content_html,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const createSchema = z.object({
  spaceId: z.string().min(1),
  parentId: z.string().min(1).nullable().optional(),
  title: z.string().max(512).optional(),
  content: z.string().optional(),
});

const updateSchema = z
  .object({
    title: z.string().max(512).optional(),
    content: z.string().optional(),
  })
  .refine((d) => Object.keys(d).length > 0, { message: 'No fields to update' });

const moveSchema = z.object({
  parentId: z.string().min(1).nullable(),
  // sort_order is a Postgres integer; out-of-range values are bad input (400),
  // not a database error (500).
  sortOrder: z.number().int().min(-2147483648).max(2147483647).optional(),
  spaceId: z.string().min(1).optional(),
});

export const pagesRouter = new Hono();

pagesRouter.use('*', requireAuth);

// GET /recent — 10 most recently updated pages (declared before /:id)
pagesRouter.get('/recent', async (c) => {
  const rows = await many<RecentRow>(SQL_RECENT);
  return c.json(
    rows.map((r) => ({
      id: r.id,
      title: r.title,
      spaceId: r.space_id,
      spaceName: r.space_name,
      updatedAt: r.updated_at,
    })),
  );
});

// GET /:id — full page with space name and ancestor chain
pagesRouter.get('/:id', async (c) => {
  const page = await getPageResponse(c.req.param('id'));
  if (!page) throw new HTTPException(404, { message: 'Page not found' });
  return c.json(page);
});

// POST / — create a page
pagesRouter.post('/', zValidator('json', createSchema), async (c) => {
  const body = c.req.valid('json');

  if (!(await one(SQL_SPACE_EXISTS, [body.spaceId]))) {
    throw new HTTPException(404, { message: 'Space not found' });
  }
  if (body.parentId && !(await one(SQL_GET_PAGE, [body.parentId]))) {
    throw new HTTPException(404, { message: 'Parent page not found' });
  }

  const id = uuidv4();
  const now = Math.floor(Date.now() / 1000);
  const content = body.content ?? '';
  const contentHtml = content ? await renderMarkdown(content) : '';

  await exec(SQL_INSERT_PAGE, [
    id,
    body.spaceId,
    body.parentId ?? null,
    body.title ?? 'Untitled',
    content,
    contentHtml,
    0,
    now,
  ]);

  const row = await one<PageRow>(SQL_GET_PAGE, [id]);
  if (!row) throw new HTTPException(500, { message: 'Failed to create page' });
  return c.json(toPage(row), 201);
});

// PATCH /:id — update title and/or content (re-render on content change).
// search_vector is a generated column, so the search index follows on its own.
pagesRouter.patch('/:id', zValidator('json', updateSchema), async (c) => {
  const id = c.req.param('id');
  const body = c.req.valid('json');

  if (!(await one(SQL_GET_PAGE, [id]))) {
    throw new HTTPException(404, { message: 'Page not found' });
  }

  // Build the SET clause from only the provided fields; column names are
  // fixed strings here, every value is a bound parameter.
  const sets: string[] = [];
  const params: unknown[] = [];
  const set = (column: string, value: unknown) => {
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  };

  if (body.title !== undefined) set('title', body.title);
  if (body.content !== undefined) {
    set('content', body.content);
    set('content_html', body.content ? await renderMarkdown(body.content) : '');
  }
  set('updated_at', Math.floor(Date.now() / 1000));
  params.push(id);

  await exec(`UPDATE pages SET ${sets.join(', ')} WHERE id = $${params.length}`, params);

  // Same shape as GET /:id — the client swaps this into page state, so it must
  // carry spaceName and ancestors or the breadcrumb breaks.
  const page = await getPageResponse(id);
  if (!page) throw new HTTPException(404, { message: 'Page not found' });
  return c.json(page);
});

// DELETE /:id — re-parent children up, then delete (transactional)
pagesRouter.delete('/:id', async (c) => {
  const id = c.req.param('id');
  if (!(await one(SQL_GET_PAGE, [id]))) {
    throw new HTTPException(404, { message: 'Page not found' });
  }

  await withTransaction(async (tx) => {
    await exec(SQL_REPARENT_CHILDREN, [id], tx);
    await exec(SQL_DELETE_PAGE, [id], tx);
  });
  return c.body(null, 204);
});

// PATCH /:id/move — change parent and/or ordering, optionally across spaces
pagesRouter.patch('/:id/move', zValidator('json', moveSchema), async (c) => {
  const id = c.req.param('id');
  const body = c.req.valid('json');

  const existing = await one<PageRow>(SQL_GET_PAGE, [id]);
  if (!existing) throw new HTTPException(404, { message: 'Page not found' });

  if (body.parentId === id) {
    throw new HTTPException(400, { message: 'A page cannot be its own parent' });
  }

  const targetSpaceId = body.spaceId ?? existing.space_id;

  if (body.parentId) {
    const parent = await one<PageRow>(SQL_GET_PAGE, [body.parentId]);
    if (!parent) throw new HTTPException(404, { message: 'Parent page not found' });
    if (parent.space_id !== targetSpaceId) {
      throw new HTTPException(400, { message: 'Parent page is in a different space' });
    }
  }

  const sortOrder = body.sortOrder ?? existing.sort_order;
  const now = Math.floor(Date.now() / 1000);

  if (targetSpaceId !== existing.space_id) {
    // The whole subtree changes space together, or not at all.
    await withTransaction(async (tx) => {
      await exec(SQL_UPDATE_DESCENDANTS_SPACE, [id, targetSpaceId], tx);
      await exec(SQL_MOVE_PAGE, [body.parentId ?? null, sortOrder, now, id], tx);
    });
  } else {
    await exec(SQL_MOVE_PAGE, [body.parentId, sortOrder, now, id]);
  }

  const row = await one<PageRow>(SQL_GET_PAGE, [id]);
  if (!row) throw new HTTPException(404, { message: 'Page not found' });
  return c.json(toPage(row));
});
