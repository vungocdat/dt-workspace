import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { z } from 'zod';
import { searchPages } from '../lib/search.js';
import { requireAuth } from '../lib/session.js';

const searchSchema = z.object({
  q: z.string().max(512).optional().default(''),
  spaceId: z.string().min(1).optional(),
});

export const searchRouter = new Hono();

searchRouter.use('*', requireAuth);

// GET /?q=...&spaceId=... — full-text search across pages
searchRouter.get('/', zValidator('query', searchSchema), async (c) => {
  const { q, spaceId } = c.req.valid('query');
  const results = await searchPages(q, spaceId);
  return c.json(results);
});
