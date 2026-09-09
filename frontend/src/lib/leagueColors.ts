import { load, save } from './prefs'

/** Colors reserved for league identity.
 *
 * They are only ever rendered as a bar or a dot — a shape nothing else in the app uses —
 * because every hue is already spoken for as text or a fill: emerald and red are gain and
 * loss on every numeric column, amber is the active/selected accent, sky is "playing today",
 * violet is FantasyPros, and the position badges own rose / emerald / sky / amber / violet /
 * stone. Reserving the *shape* rather than the hue is what keeps a lime league bar from
 * reading as "positive". Never apply these as text colors or row backgrounds.
 *
 * indigo, red and purple are left out: PlatformBadge uses them for Sleeper, ESPN and Yahoo,
 * and a league bar that matches a platform badge invites exactly the confusion this is meant
 * to remove. Class names are spelled out in full — Tailwind only generates what it can see.
 */
const PALETTE = [
  'bg-teal-500',
  'bg-fuchsia-500',
  'bg-orange-500',
  'bg-cyan-500',
  'bg-lime-600',
  'bg-pink-500',
  'bg-blue-600',
  'bg-yellow-500',
]

const KEY = 'leagueColors'

/**
 * Stable color per league id. The assignment is persisted, so joining a league next season
 * gives it the first free slot instead of reshuffling the ones you have already learned.
 * Past the end of the palette colors repeat, which beats leaving a league unmarked.
 */
export function assignLeagueColors(leagueIds: string[]): Record<string, string> {
  const stored = load<Record<string, number>>(KEY, {})
  const next = { ...stored }
  const used = new Set(Object.values(next))
  let changed = false
  for (const id of leagueIds) {
    if (next[id] !== undefined) continue
    let i = 0
    while (i < PALETTE.length && used.has(i)) i++
    if (i === PALETTE.length) i = Object.keys(next).length % PALETTE.length
    next[id] = i
    used.add(i)
    changed = true
  }
  if (changed) save(KEY, next)
  return Object.fromEntries(Object.entries(next).map(([id, i]) => [id, PALETTE[i % PALETTE.length]]))
}

export const FALLBACK_COLOR = 'bg-stone-300'
