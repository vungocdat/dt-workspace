import { createFileRoute } from '@tanstack/react-router'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  deleteCalendarNote,
  getCalendarNote,
  getCalendarNotes,
  saveCalendarNote,
  type CalendarNote,
} from '../../api'
import MarkdownEditor from '../../components/editor/MarkdownEditor'
import { MarkdownRenderer } from '../../components/editor/MarkdownRenderer'
import { Skeleton } from '../../components/ui/Skeleton'
import { lunarFor, lunarMonthSpan, type LunarDay } from '../../lib/lunar'
import { czechHoliday } from '../../lib/czechHolidays'
import { useUIStore } from '../../store'
import { useDocumentTitle } from '../../lib/title'
import { shortcut } from '../../lib/platform'
import { confirmDialog } from '../../components/ui/ConfirmDialog'
import { toast } from '../../components/ui/Toaster'

export const Route = createFileRoute('/_auth/calendar')({
  component: Calendar,
})

// ── Local-date helpers ────────────────────────────────────────────────────────
// Everything here works in the browser's local timezone on purpose: a note is
// keyed by the date the user believes it is, not by UTC. Dates are only ever
// constructed from (y, m, d) triples so no parsing/offset surprises creep in.

const pad = (n: number) => String(n).padStart(2, '0')

const toISO = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

const addDays = (d: Date, n: number) =>
  new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

/**
 * The 42 cells (6 fixed rows, so the grid never reflows between months) starting
 * on the Monday of the week containing the 1st.
 */
function buildGrid(year: number, month: number): Date[] {
  const first = new Date(year, month, 1)
  const mondayOffset = (first.getDay() + 6) % 7
  const start = addDays(first, -mondayOffset)
  return Array.from({ length: 42 }, (_, i) => addDays(start, i))
}

function formatMonthLabel(year: number, month: number): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'long',
    year: 'numeric',
  }).format(new Date(year, month, 1))
}

function formatLongDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(new Date(y, m - 1, d))
}

/** Colour of the small lunar label under each day number. */
const LUNAR_LABEL_CLASS: Record<LunarDay['kind'], string> = {
  festival: 'text-red-400 font-medium',
  term: 'text-emerald-400/80',
  newMonth: 'text-amber-400/90 font-medium',
  fullMoon: 'text-amber-400/90',
  day: 'text-gray-500',
}

/** Starter body for a new note, so the editor doesn't open on a blank page. */
const noteTemplate = (iso: string) => `# ${formatLongDate(iso)}\n\n`

function Calendar() {
  useDocumentTitle('Calendar')
  const today = useMemo(() => new Date(), [])
  const todayISO = toISO(today)

  // Cmd/Ctrl+E already toggles this store value globally, so reusing it gets the
  // shortcut for free on this route too.
  const currentMode = useUIStore((s) => s.currentMode)
  const setMode = useUIStore((s) => s.setMode)
  const toggleMode = useUIStore((s) => s.toggleMode)

  const [view, setView] = useState({ year: today.getFullYear(), month: today.getMonth() })
  const [selected, setSelected] = useState(todayISO)

  // Dates in the visible range that have a note (drives the grid markers).
  const [noteDates, setNoteDates] = useState<Set<string>>(new Set())
  const [gridLoading, setGridLoading] = useState(true)

  const [note, setNote] = useState<CalendarNote | null>(null)
  const [noteLoading, setNoteLoading] = useState(true)
  const [creating, setCreating] = useState(false)

  const cells = useMemo(() => buildGrid(view.year, view.month), [view])
  const lunarSpan = useMemo(
    () =>
      lunarMonthSpan(
        toISO(new Date(view.year, view.month, 1)),
        toISO(new Date(view.year, view.month + 1, 0)),
      ),
    [view],
  )
  const selectedLunar = lunarFor(selected)
  const selectedHoliday = czechHoliday(selected)
  const cellRefs = useRef(new Map<string, HTMLButtonElement>())
  // Set when arrow-key nav crosses a month boundary: the destination button
  // doesn't exist until the new view renders, so focus is handed over below.
  const focusAfterRender = useRef<string | null>(null)

  useEffect(() => {
    if (!focusAfterRender.current) return
    cellRefs.current.get(focusAfterRender.current)?.focus()
    focusAfterRender.current = null
  }, [cells])

  // Which days in the visible range have notes.
  useEffect(() => {
    const from = toISO(cells[0])
    const to = toISO(cells[41])

    let cancelled = false
    setGridLoading(true)
    const load = async () => {
      try {
        const stubs = await getCalendarNotes(from, to)
        if (!cancelled) setNoteDates(new Set(stubs.map((s) => s.date)))
      } finally {
        if (!cancelled) setGridLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [cells])

  // The selected day's note. Read mode on arrival — switching days shouldn't
  // drop you into an editor you didn't ask for.
  useEffect(() => {
    let cancelled = false
    setNoteLoading(true)
    setMode('read')
    const load = async () => {
      try {
        const loaded = await getCalendarNote(selected)
        if (!cancelled) setNote(loaded)
      } catch {
        if (!cancelled) setNote(null)
      } finally {
        if (!cancelled) setNoteLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [selected, setMode])

  const markHasNote = (date: string, has: boolean) => {
    setNoteDates((prev) => {
      const next = new Set(prev)
      if (has) next.add(date)
      else next.delete(date)
      return next
    })
  }

  const goToMonth = (year: number, month: number) => {
    const normalized = new Date(year, month, 1)
    setView({ year: normalized.getFullYear(), month: normalized.getMonth() })
    // Land on today when stepping into the current month, otherwise the 1st —
    // keeping a selection that has scrolled out of view would be confusing.
    setSelected(
      normalized.getFullYear() === today.getFullYear() &&
        normalized.getMonth() === today.getMonth()
        ? todayISO
        : toISO(normalized),
    )
  }

  const goToToday = () => {
    setView({ year: today.getFullYear(), month: today.getMonth() })
    setSelected(todayISO)
  }

  const selectDate = (date: Date) => {
    setSelected(toISO(date))
    // Stepping outside the current month follows the selection into that month.
    if (date.getMonth() !== view.month || date.getFullYear() !== view.year) {
      setView({ year: date.getFullYear(), month: date.getMonth() })
    }
  }

  const createNote = useCallback(
    async (iso: string) => {
      setCreating(true)
      try {
        const created = await saveCalendarNote(iso, noteTemplate(iso))
        setNote(created)
        markHasNote(iso, true)
        setMode('edit')
      } catch {
        toast.error('Could not create the note.')
      } finally {
        setCreating(false)
      }
    },
    [setMode],
  )

  const handleDelete = async () => {
    const ok = await confirmDialog({
      title: `Delete the note for ${formatLongDate(selected)}?`,
      message: 'This cannot be undone.',
      confirmLabel: 'Delete note',
    })
    if (!ok) return
    try {
      await deleteCalendarNote(selected)
      setNote(null)
      markHasNote(selected, false)
      setMode('read')
    } catch {
      toast.error('Could not delete the note.')
    }
  }

  // Arrow keys walk the grid; each cell is a button, so Enter/Space selects.
  const handleGridKeyDown = (e: React.KeyboardEvent) => {
    const deltas: Record<string, number> = {
      ArrowLeft: -1,
      ArrowRight: 1,
      ArrowUp: -7,
      ArrowDown: 7,
    }
    const delta = deltas[e.key]
    if (delta === undefined) return
    e.preventDefault()

    const [y, m, d] = selected.split('-').map(Number)
    const next = new Date(y, m - 1, d + delta)
    selectDate(next)

    const nextISO = toISO(next)
    const el = cellRefs.current.get(nextISO)
    if (el) el.focus()
    else focusAfterRender.current = nextISO
  }

  return (
    // Below xl the panes stack and the page scrolls; from xl up the row fills
    // the shell exactly and each pane scrolls on its own.
    <div className="flex-1 min-h-0 flex flex-col xl:flex-row gap-6 p-4 sm:p-6 overflow-y-auto xl:overflow-hidden">
      {/* ── Month grid: the larger (3:2) share beside the note, capped so cells stay sane on ultra-wide ── */}
      <div className="flex flex-col min-h-0 min-w-0 flex-1 xl:flex-[3] xl:max-w-[68rem]">
        <div className="flex items-center gap-2 mb-4 flex-shrink-0">
          <div className="min-w-0">
            <h1 className="text-2xl 2xl:text-3xl font-bold text-gray-100">
              {formatMonthLabel(view.year, view.month)}
            </h1>
            <p className="text-xs 2xl:text-sm text-gray-500 truncate">Âm lịch: {lunarSpan}</p>
          </div>
          <div className="flex-1" />
          <button
            onClick={() => goToMonth(view.year, view.month - 1)}
            aria-label="Previous month"
            className="p-1.5 rounded text-gray-400 hover:text-gray-100 hover:bg-gray-800 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <button
            onClick={goToToday}
            className="px-3 py-1 text-xs font-medium rounded bg-gray-700 text-gray-200 hover:bg-gray-600 hover:text-gray-100 transition-colors"
          >
            Today
          </button>
          <button
            onClick={() => goToMonth(view.year, view.month + 1)}
            aria-label="Next month"
            className="p-1.5 rounded text-gray-400 hover:text-gray-100 hover:bg-gray-800 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </button>
        </div>

        <div className="grid grid-cols-7 mb-1 flex-shrink-0">
          {WEEKDAYS.map((label) => (
            <div
              key={label}
              className="text-center text-xs font-semibold text-gray-500 uppercase tracking-wider py-1"
            >
              {label}
            </div>
          ))}
        </div>

        {/* 7 x 6 fixed tracks: the rows split whatever height the pane has, so
            cell size follows the window instead of a hard-coded h-14. The
            min-height keeps them usable in the stacked (narrow) layout. */}
        <div
          onKeyDown={handleGridKeyDown}
          className="grid grid-cols-7 grid-rows-6 gap-1 sm:gap-1.5 flex-1 min-h-[19rem] max-h-[54rem]"
        >
          {cells.map((cell) => {
            const iso = toISO(cell)
            const inMonth = cell.getMonth() === view.month
            const isToday = iso === todayISO
            const isSelected = iso === selected
            const hasNote = noteDates.has(iso)
            const lunar = lunarFor(iso)
            const holiday = czechHoliday(iso)

            return (
              <button
                key={iso}
                ref={(el) => {
                  if (el) cellRefs.current.set(iso, el)
                  else cellRefs.current.delete(iso)
                }}
                onClick={() => selectDate(cell)}
                aria-label={[formatLongDate(iso), holiday?.name, lunar.full].filter(Boolean).join(', ')}
                title={[
                  holiday && `${holiday.name} (${holiday.nameCs})`,
                  lunar.full,
                  lunar.festivalFull,
                  lunar.tietKhi,
                ]
                  .filter(Boolean)
                  .join(' · ')}
                aria-current={isToday ? 'date' : undefined}
                aria-pressed={isSelected}
                className={`h-full w-full min-h-0 min-w-0 px-0.5 flex flex-col items-center justify-center gap-0.5 2xl:gap-1 rounded-md border transition-colors focus:outline-none focus:ring-1 focus:ring-blue-500 ${
                  isSelected
                    ? 'border-gray-500 bg-gray-800'
                    : isToday
                    ? 'border-blue-500/50 bg-blue-500/5 hover:bg-gray-800'
                    : 'border-gray-800 hover:bg-gray-800'
                }`}
              >
                <span
                  className={`text-xs 2xl:text-sm leading-5 w-5 h-5 2xl:w-7 2xl:h-7 flex items-center justify-center rounded-full ${
                    isToday
                      ? 'bg-blue-600 text-gray-50 font-semibold'
                      : holiday
                      ? `text-red-400 font-semibold ${inMonth ? '' : 'opacity-50'}`
                      : inMonth
                      ? 'text-gray-300'
                      : 'text-gray-600'
                  }`}
                >
                  {cell.getDate()}
                </span>
                <span
                  className={`max-w-full truncate text-[10px] 2xl:text-xs leading-tight ${
                    LUNAR_LABEL_CLASS[lunar.kind]
                  } ${inMonth ? '' : 'opacity-50'}`}
                >
                  {lunar.label}
                </span>
                {/* Reserve the dot's row either way so cells never jump height */}
                <span
                  className={`w-1.5 h-1.5 rounded-full ${
                    hasNote && !gridLoading ? 'bg-blue-400' : 'bg-transparent'
                  }`}
                />
              </button>
            )
          })}
        </div>
      </div>

      {/* ── Selected day's note ── */}
      <section className="flex flex-col min-w-0 min-h-0 flex-none xl:flex-[2] xl:min-w-[22rem] h-[32rem] xl:h-auto bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
        <header className="flex items-center gap-2 px-4 py-2.5 min-h-14 flex-shrink-0 border-b border-gray-800">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold text-gray-200">
                {formatLongDate(selected)}
              </h2>
              {selected === todayISO && (
                <span className="text-xs text-blue-400 flex-shrink-0">Today</span>
              )}
            </div>
            <p className="text-xs text-gray-500">
              {selectedLunar.full}
              {' · '}ngày {selectedLunar.dayCanChi}, tháng {selectedLunar.monthCanChi}
              {selectedLunar.festivalFull && (
                <span className="text-red-400"> · {selectedLunar.festivalFull}</span>
              )}
              {selectedLunar.tietKhi && (
                <span className="text-emerald-400/80"> · {selectedLunar.tietKhi}</span>
              )}
            </p>
            {selectedHoliday && (
              <p className="text-xs text-red-400" title={selectedHoliday.nameCs}>
                Czech public holiday: {selectedHoliday.name}
              </p>
            )}
          </div>
          <div className="flex-1" />

          {note && (
            <>
              <button
                onClick={toggleMode}
                title={`Switch to ${currentMode === 'read' ? 'edit' : 'read'} mode (${shortcut('E')})`}
                className={`px-3 py-1 text-xs font-medium rounded transition-colors ${
                  currentMode === 'edit'
                    ? 'bg-blue-600 text-gray-50 hover:bg-blue-500'
                    : 'bg-gray-700 text-gray-300 hover:bg-gray-600 hover:text-gray-100'
                }`}
              >
                {currentMode === 'edit' ? 'Read' : 'Edit'}
              </button>
              <button
                onClick={() => void handleDelete()}
                aria-label="Delete note"
                title="Delete note"
                className="p-1.5 rounded text-gray-400 hover:text-red-400 hover:bg-red-900/20 transition-colors"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
              </button>
            </>
          )}

        </header>

        {noteLoading ? (
          <div className="p-6 space-y-3">
            <Skeleton className="h-6 w-1/2" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-5/6" />
          </div>
        ) : !note ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-3 px-6 text-center">
            <p className="text-sm text-gray-500">No note for this day.</p>
            <button
              onClick={() => void createNote(selected)}
              disabled={creating}
              className="px-3 py-1.5 text-sm font-medium rounded bg-blue-600 text-gray-50 hover:bg-blue-500 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
            >
              {creating ? 'Creating…' : 'Create note'}
            </button>
          </div>
        ) : currentMode === 'edit' ? (
          <MarkdownEditor
            // Remount per day (and on each entry into edit mode) so the editor
            // picks up the right document — its value is frozen at mount.
            key={selected}
            initialContent={note.content}
            onSave={async (content) => {
              const saved = await saveCalendarNote(selected, content)
              setNote(saved)
              markHasNote(selected, true)
            }}
          />
        ) : (
          <div className="flex-1 min-h-0 overflow-y-auto">
            {note.contentHtml ? (
              <MarkdownRenderer html={note.contentHtml} compact />
            ) : (
              <p className="px-5 py-4 text-sm text-gray-500">
                This note is empty. Press Edit (or {shortcut('E')}) to write something.
              </p>
            )}
          </div>
        )}
      </section>
    </div>
  )
}
