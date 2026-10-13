// ── Types ─────────────────────────────────────────────────────────────────────

export interface Space {
  id: string
  name: string
  description: string
  icon: string
  sortOrder: number
  createdAt: number
  updatedAt: number
  /** Only on GET /api/spaces (the list): how many pages the space holds. */
  pageCount?: number
  /** Only on GET /api/spaces: newest page updated_at (epoch seconds), null when empty. */
  lastEditedAt?: number | null
}

export interface Page {
  id: string
  spaceId: string
  spaceName: string
  parentId: string | null
  ancestors: { id: string; title: string }[]
  title: string
  content: string
  contentHtml: string
  sortOrder: number
  updatedAt: number
}

export interface PageTreeNode {
  id: string
  title: string
  parentId: string | null
  sortOrder: number
  depth: number
  children: PageTreeNode[]
}

export interface RecentPage {
  id: string
  title: string
  spaceId: string
  spaceName: string
  updatedAt: number
}

export interface SearchResult {
  id: string
  title: string
  spaceId: string
  snippet: string
}

/**
 * A calendar note. Calendar notes are NOT pages — they live in their own table,
 * keyed by date, and never appear in the sidebar tree or in search.
 */
export interface CalendarNote {
  date: string
  content: string
  contentHtml: string
  createdAt: number
  updatedAt: number
}

/** Marker for a day that has a note, used by the month grid. */
export interface CalendarNoteStub {
  date: string
  updatedAt: number
}

// ── Base fetch ────────────────────────────────────────────────────────────────

async function apiFetch<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...options.headers },
    credentials: 'include',
    ...options,
  })

  if (res.status === 401) {
    window.location.href = '/login'
    // Return a never-resolving promise — the page is navigating away
    return new Promise(() => {})
  }

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText)
    throw new Error(`API ${res.status}: ${text}`)
  }

  // 204 No Content
  if (res.status === 204) return undefined as T

  return res.json() as Promise<T>
}

// ── Auth ──────────────────────────────────────────────────────────────────────

// login uses a raw fetch too: a 401 here means wrong credentials, which the
// login page must show — apiFetch would reload /login and swallow the error.
export async function login(username: string, password: string): Promise<void> {
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ username, password }),
  })
  if (!res.ok) throw new Error(`API ${res.status}`)
}

export async function logout(): Promise<void> {
  await apiFetch<void>('/api/auth/logout', { method: 'POST' })
}

// getMe uses a raw fetch — must NOT trigger the 401→/login redirect because
// it's called in beforeLoad on the login page itself to check auth state.
export async function getMe(): Promise<{ username: string }> {
  const res = await fetch('/api/auth/me', { credentials: 'include' })
  if (!res.ok) throw new Error('Unauthorized')
  return res.json()
}

export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  return apiFetch<void>('/api/auth/password', {
    method: 'PATCH',
    body: JSON.stringify({ currentPassword, newPassword }),
  })
}

export async function changeUsername(
  currentPassword: string,
  newUsername: string,
): Promise<{ username: string }> {
  return apiFetch<{ username: string }>('/api/auth/username', {
    method: 'PATCH',
    body: JSON.stringify({ currentPassword, newUsername }),
  })
}

// ── Spaces ────────────────────────────────────────────────────────────────────

export async function getSpaces(): Promise<Space[]> {
  return apiFetch<Space[]>('/api/spaces')
}

export async function createSpace(
  data: Pick<Space, 'name' | 'description' | 'icon'>,
): Promise<Space> {
  return apiFetch<Space>('/api/spaces', {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

export async function updateSpace(
  id: string,
  data: Partial<Pick<Space, 'name' | 'description' | 'icon' | 'sortOrder'>>,
): Promise<Space> {
  return apiFetch<Space>(`/api/spaces/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  })
}

export async function deleteSpace(id: string): Promise<void> {
  return apiFetch<void>(`/api/spaces/${id}`, { method: 'DELETE' })
}

function flattenTree(nodes: PageTreeNode[]): PageTreeNode[] {
  const result: PageTreeNode[] = []
  const walk = (items: PageTreeNode[]) => {
    for (const node of items) {
      result.push(node)
      if (node.children.length) walk(node.children)
    }
  }
  walk(nodes)
  return result
}

export async function getSpaceTree(id: string): Promise<PageTreeNode[]> {
  const nested = await apiFetch<PageTreeNode[]>(`/api/spaces/${id}/tree`)
  return flattenTree(nested)
}

// ── Pages ─────────────────────────────────────────────────────────────────────

export async function getRecentPages(): Promise<RecentPage[]> {
  return apiFetch<RecentPage[]>('/api/pages/recent')
}

export async function getPage(id: string): Promise<Page> {
  return apiFetch<Page>(`/api/pages/${id}`)
}

export async function createPage(
  data: Pick<Page, 'spaceId' | 'title'> & { parentId?: string | null; content?: string },
): Promise<Page> {
  return apiFetch<Page>('/api/pages', {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

export async function updatePage(
  id: string,
  data: Partial<Pick<Page, 'title' | 'content'>>,
): Promise<Page> {
  return apiFetch<Page>(`/api/pages/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  })
}

export async function deletePage(id: string): Promise<void> {
  return apiFetch<void>(`/api/pages/${id}`, { method: 'DELETE' })
}

export async function movePage(
  id: string,
  data: { parentId: string | null; sortOrder?: number; spaceId?: string },
): Promise<Page> {
  return apiFetch<Page>(`/api/pages/${id}/move`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  })
}

// ── Calendar ──────────────────────────────────────────────────────────────────

/** Which days in the visible range have a note. ISO dates are the client's local ones. */
export async function getCalendarNotes(
  from: string,
  to: string,
): Promise<CalendarNoteStub[]> {
  const params = new URLSearchParams({ from, to })
  return apiFetch<CalendarNoteStub[]>(`/api/calendar/notes?${params.toString()}`)
}

/** One day's note, or null when that day has none (404 is the normal empty case). */
export async function getCalendarNote(date: string): Promise<CalendarNote | null> {
  const res = await fetch(`/api/calendar/notes/${date}`, { credentials: 'include' })
  if (res.status === 401) {
    window.location.href = '/login'
    return new Promise(() => {})
  }
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`API ${res.status}`)
  return res.json() as Promise<CalendarNote>
}

/** Upsert — serves both "create note" and every auto-save after it. */
export async function saveCalendarNote(
  date: string,
  content: string,
): Promise<CalendarNote> {
  return apiFetch<CalendarNote>(`/api/calendar/notes/${date}`, {
    method: 'PUT',
    body: JSON.stringify({ content }),
  })
}

export async function deleteCalendarNote(date: string): Promise<void> {
  return apiFetch<void>(`/api/calendar/notes/${date}`, { method: 'DELETE' })
}

// ── To-do ─────────────────────────────────────────────────────────────────────

/** A task in the To-do tab — standalone, unrelated to pages and the calendar. */
export interface Todo {
  id: string
  title: string
  done: boolean
  sortOrder: number
  /** Pinned open tasks sit at the top; a done task keeps its pin for un-ticking. */
  pinned: boolean
  createdAt: number
  updatedAt: number
  completedAt: number | null
}

/** Every task: open ones (pinned first) in list order, then finished ones, most recent first. */
export async function getTodos(): Promise<Todo[]> {
  return apiFetch<Todo[]>('/api/todos')
}

export async function createTodo(title: string): Promise<Todo> {
  return apiFetch<Todo>('/api/todos', { method: 'POST', body: JSON.stringify({ title }) })
}

export async function updateTodo(
  id: string,
  data: { title?: string; done?: boolean; pinned?: boolean },
): Promise<Todo> {
  return apiFetch<Todo>(`/api/todos/${id}`, { method: 'PATCH', body: JSON.stringify(data) })
}

export async function deleteTodo(id: string): Promise<void> {
  return apiFetch<void>(`/api/todos/${id}`, { method: 'DELETE' })
}

export async function clearCompletedTodos(): Promise<void> {
  await apiFetch<{ deleted: number }>('/api/todos/completed', { method: 'DELETE' })
}

// ── Search ────────────────────────────────────────────────────────────────────

export async function search(
  q: string,
  spaceId?: string,
): Promise<SearchResult[]> {
  const params = new URLSearchParams({ q })
  if (spaceId) params.set('spaceId', spaceId)
  return apiFetch<SearchResult[]>(`/api/search?${params.toString()}`)
}

// ── Export / Import ───────────────────────────────────────────────────────────

export async function exportSpace(id: string): Promise<Blob> {
  const res = await fetch(`/api/spaces/${id}/export`, { credentials: 'include' })
  if (!res.ok) throw new Error('Export failed')
  return res.blob()
}

export async function importSpace(file: File): Promise<Space> {
  const form = new FormData()
  form.append('file', file)
  const res = await fetch('/api/spaces/import', {
    method: 'POST',
    credentials: 'include',
    body: form,
  })
  if (!res.ok) throw new Error('Import failed')
  return res.json() as Promise<Space>
}
