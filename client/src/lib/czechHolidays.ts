// Czech public holidays (státní svátky and ostatní svátky — every day off work
// under zákon č. 245/2000 Sb.). Computed client-side, nothing stored. Fixed
// dates plus the two that follow Easter: Velký pátek (a holiday since 2016)
// and Velikonoční pondělí. Easter Sunday itself is not a public holiday.

export interface CzechHoliday {
  /** English name, e.g. "Czech Statehood Day" */
  name: string
  /** Official Czech name, e.g. "Den české státnosti" */
  nameCs: string
}

const FIXED: Record<string, CzechHoliday> = {
  '01-01': { name: 'Restoration Day of the Independent Czech State; New Year', nameCs: 'Den obnovy samostatného českého státu; Nový rok' },
  '05-01': { name: 'Labour Day', nameCs: 'Svátek práce' },
  '05-08': { name: 'Liberation Day', nameCs: 'Den vítězství' },
  '07-05': { name: 'Saints Cyril and Methodius Day', nameCs: 'Den slovanských věrozvěstů Cyrila a Metoděje' },
  '07-06': { name: 'Jan Hus Day', nameCs: 'Den upálení mistra Jana Husa' },
  '09-28': { name: 'Czech Statehood Day', nameCs: 'Den české státnosti' },
  '10-28': { name: 'Independent Czechoslovak State Day', nameCs: 'Den vzniku samostatného československého státu' },
  '11-17': { name: 'Struggle for Freedom and Democracy Day', nameCs: 'Den boje za svobodu a demokracii' },
  '12-24': { name: 'Christmas Eve', nameCs: 'Štědrý den' },
  '12-25': { name: 'Christmas Day', nameCs: '1. svátek vánoční' },
  '12-26': { name: "St. Stephen's Day", nameCs: '2. svátek vánoční' },
}

const GOOD_FRIDAY: CzechHoliday = { name: 'Good Friday', nameCs: 'Velký pátek' }
const EASTER_MONDAY: CzechHoliday = { name: 'Easter Monday', nameCs: 'Velikonoční pondělí' }

const pad = (n: number) => String(n).padStart(2, '0')

/** Gregorian Easter Sunday as "MM-DD" (anonymous Meeus/Jones/Butcher algorithm). */
function easterSunday(y: number): { m: number; d: number } {
  const a = y % 19
  const b = Math.floor(y / 100)
  const c = y % 100
  const d = Math.floor(b / 4)
  const e = b % 4
  const f = Math.floor((b + 8) / 25)
  const g = Math.floor((b - f + 1) / 3)
  const h = (19 * a + b - d - g + 15) % 30
  const i = Math.floor(c / 4)
  const k = c % 4
  const l = (32 + 2 * e + 2 * i - h - k) % 7
  const m = Math.floor((a + 11 * h + 22 * l) / 451)
  const month = Math.floor((h + l - 7 * m + 114) / 31)
  const day = ((h + l - 7 * m + 114) % 31) + 1
  return { m: month, d: day }
}

const easterCache = new Map<number, Record<string, CzechHoliday>>()

function easterHolidays(y: number): Record<string, CzechHoliday> {
  const hit = easterCache.get(y)
  if (hit) return hit
  const { m, d } = easterSunday(y)
  // Built from (y, m, d) triples so month/day overflow is normalized by Date.
  const key = (offset: number) => {
    const dt = new Date(y, m - 1, d + offset)
    return `${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`
  }
  const result: Record<string, CzechHoliday> = { [key(1)]: EASTER_MONDAY }
  if (y >= 2016) result[key(-2)] = GOOD_FRIDAY
  easterCache.set(y, result)
  return result
}

/** The Czech public holiday on an ISO (local) date "YYYY-MM-DD", if any. */
export function czechHoliday(iso: string): CzechHoliday | undefined {
  const y = Number(iso.slice(0, 4))
  const md = iso.slice(5)
  return FIXED[md] ?? easterHolidays(y)[md]
}
