import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { exec, many, one } from '../db/client.js';
import { requireAuth } from '../lib/session.js';

/**
 * The To-do tab: a single flat list of tasks in the todos table. Unrelated to
 * pages, spaces, search and the calendar.
 *
 * Open tasks are ordered pinned first, then by sort_order (new ones append to
 * the end); finished ones by completed_at, most recent first. A done task keeps
 * its pin, so un-ticking it puts it back at the top.
 */

interface TodoRow {
  id: string;
  title: string;
  done: boolean;
  sort_order: number;
  pinned: boolean;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

// ── SQL ──

const TODO_COLUMNS = `id, title, done, sort_order, pinned, created_at, updated_at, completed_at`;

// Open (done = false) before done; open ones pinned first, then by sort_order;
// done ones most recently completed first. NULLS LAST keeps a done task with
// no completed_at (never written by the app) at the bottom, where SQLite's
// NULL ordering put it; id makes every tie deterministic.
const SQL_LIST = `
  SELECT ${TODO_COLUMNS} FROM todos
  ORDER BY done,
    CASE WHEN NOT done THEN pinned END DESC NULLS LAST,
    CASE WHEN NOT done THEN sort_order END,
    completed_at DESC NULLS LAST,
    id
`;

const SQL_GET = `SELECT ${TODO_COLUMNS} FROM todos WHERE id = $1`;

// Computed inside the INSERT so the read and the write are one statement.
const SQL_INSERT = `
  INSERT INTO todos (id, title, done, sort_order, created_at, updated_at, completed_at)
  VALUES ($1, $2, false, (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM todos), $3, $3, NULL)
`;

const SQL_UPDATE = `
  UPDATE todos SET
    title = $2, done = $3, pinned = $4, completed_at = $5, updated_at = $6
  WHERE id = $1
`;

const SQL_DELETE = `DELETE FROM todos WHERE id = $1`;
const SQL_DELETE_DONE = `DELETE FROM todos WHERE done`;

// ── Helpers ──

function toTodo(row: TodoRow) {
  return {
    id: row.id,
    title: row.title,
    done: row.done,
    sortOrder: row.sort_order,
    pinned: row.pinned,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

async function requireTodo(id: string): Promise<TodoRow> {
  const row = await one<TodoRow>(SQL_GET, [id]);
  if (!row) throw new HTTPException(404, { message: 'Todo not found' });
  return row;
}

const now = () => Math.floor(Date.now() / 1000);

// ── Schemas ──

const title = z.string().trim().min(1, 'title is required').max(500);

const createSchema = z.object({ title });

const updateSchema = z
  .object({
    title: title.optional(),
    done: z.boolean().optional(),
    pinned: z.boolean().optional(),
  })
  .refine((b) => b.title !== undefined || b.done !== undefined || b.pinned !== undefined, {
    message: 'nothing to update',
  });

// ── Router ──

export const todosRouter = new Hono();

todosRouter.use('*', requireAuth);

// GET / — every task, open ones first
todosRouter.get('/', async (c) => c.json((await many<TodoRow>(SQL_LIST)).map(toTodo)));

// POST / — add a task to the end of the open list
todosRouter.post('/', zValidator('json', createSchema), async (c) => {
  const { title } = c.req.valid('json');
  const id = uuidv4();
  await exec(SQL_INSERT, [id, title, now()]);
  return c.json(toTodo(await requireTodo(id)), 201);
});

/**
 * DELETE /completed — clear every finished task. Declared before /:id so the
 * literal path wins in Hono's declaration-order matching.
 */
todosRouter.delete('/completed', async (c) => {
  const deleted = await exec(SQL_DELETE_DONE);
  return c.json({ deleted });
});

// PATCH /:id — rename, tick/untick and/or pin/unpin
todosRouter.patch('/:id', zValidator('json', updateSchema), async (c) => {
  const row = await requireTodo(c.req.param('id'));
  const body = c.req.valid('json');

  const done = body.done ?? row.done;
  // Keep the original completion time when a done task is only renamed.
  const completedAt = done ? (row.done ? row.completed_at : now()) : null;

  await exec(SQL_UPDATE, [
    row.id,
    body.title ?? row.title,
    done,
    body.pinned ?? row.pinned,
    completedAt,
    now(),
  ]);
  return c.json(toTodo(await requireTodo(row.id)));
});

// DELETE /:id — remove one task
todosRouter.delete('/:id', async (c) => {
  const row = await requireTodo(c.req.param('id'));
  await exec(SQL_DELETE, [row.id]);
  return c.body(null, 204);
});
