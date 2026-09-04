export const fmt = (n: number | null | undefined, digits = 1): string =>
  n === null || n === undefined || Number.isNaN(n) ? '—' : n.toFixed(digits)

export const fmtInt = (n: number | null | undefined): string =>
  n === null || n === undefined ? '—' : n.toLocaleString()

export const pct = (n: number | null | undefined): string =>
  n === null || n === undefined ? '—' : `${n.toFixed(n >= 10 ? 0 : 1)}%`

export const timeAgo = (ms: number | null | undefined): string => {
  if (!ms) return '—'
  const diff = Date.now() - ms
  const m = Math.round(diff / 60000)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 48) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}

/** "2d 4h" / "3h 12m" / "18m" until a deadline; "now" once it has passed. */
export const countdown = (ms: number | null | undefined): string => {
  if (!ms) return '—'
  const secs = Math.round((ms - Date.now()) / 1000)
  if (secs <= 0) return 'now'
  const d = Math.floor(secs / 86400)
  const h = Math.floor((secs % 86400) / 3600)
  const m = Math.floor((secs % 3600) / 60)
  if (d) return `${d}d ${h}h`
  if (h) return `${h}h ${m}m`
  return `${m}m`
}

/** "Wed 12 AM" — the weekday matters more than the date for a waiver run. */
export const dayTime = (ms: number | null | undefined): string => {
  if (!ms) return '—'
  const d = new Date(ms)
  return `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${d.toLocaleTimeString(undefined, { hour: 'numeric' })}`
}

export const gameDate = (iso: string | null | undefined): string => {
  if (!iso) return '—'
  const d = new Date(`${iso}T12:00:00`)
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
}

export const NEWS_TONE: Record<string, 'red' | 'amber' | 'green' | 'blue' | 'stone' | 'violet'> = {
  injury: 'red',
  suspension: 'red',
  practice: 'amber',
  depth: 'green',
  return: 'green',
  transaction: 'blue',
  usage: 'violet',
  other: 'stone',
}

export const POS_ORDER = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF']

export const posClass: Record<string, string> = {
  QB: 'bg-rose-100 text-rose-800',
  RB: 'bg-emerald-100 text-emerald-800',
  WR: 'bg-sky-100 text-sky-800',
  TE: 'bg-amber-100 text-amber-800',
  K: 'bg-violet-100 text-violet-800',
  DEF: 'bg-stone-200 text-stone-700',
  FLEX: 'bg-stone-100 text-stone-600',
  SUPER_FLEX: 'bg-stone-100 text-stone-600',
  BN: 'bg-stone-100 text-stone-500',
  IR: 'bg-red-100 text-red-700',
  TAXI: 'bg-stone-100 text-stone-500',
}

export const injuryClass = (s: string | null | undefined): string => {
  switch (s) {
    case 'Questionable': return 'bg-yellow-100 text-yellow-800'
    case 'Doubtful': return 'bg-orange-100 text-orange-800'
    case 'Out': case 'IR': case 'PUP': case 'Sus': case 'COV': case 'NA': case 'DNR': return 'bg-red-100 text-red-800'
    default: return 'bg-stone-100 text-stone-600'
  }
}

export const injuryShort = (s: string | null | undefined): string => {
  switch (s) {
    case 'Questionable': return 'Q'
    case 'Doubtful': return 'D'
    case 'Out': return 'O'
    default: return s ?? ''
  }
}

export const OUT_STATUSES = new Set(['Out', 'IR', 'PUP', 'Sus', 'COV', 'NA', 'DNR'])

export const platformLabel: Record<string, string> = { sleeper: 'Sleeper', espn: 'ESPN', yahoo: 'Yahoo' }
export const platformClass: Record<string, string> = {
  sleeper: 'bg-indigo-100 text-indigo-800',
  espn: 'bg-red-100 text-red-800',
  yahoo: 'bg-purple-100 text-purple-800',
}

export const shortDate = (ms: number | null | undefined): string => {
  if (!ms) return '—'
  const d = new Date(ms)
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString(undefined, { hour: 'numeric' })
}
