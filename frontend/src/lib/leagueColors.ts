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

/** Leagues pinned to a chosen color, by league id. These win over the automatic assignment
 * and do not consume a palette slot, so the remaining leagues still spread out.
 *
 * Both of these knowingly reach into hues the palette above avoids: red is also ESPN's
 * platform badge and the loss color on numeric columns, sky is also the "playing today"
 * marker. The bar/dot shape is what keeps them apart — if a pinned color ever starts reading
 * as a status instead of a league, that is the thing to revisit. */
const OVERRIDES: Record<string, string> = {
  // WFFL (D League) — 49ers red. Not a Tailwind red: #AA0000 is the actual team scarlet.
  'sleeper:1393027888856465408': 'bg-[#AA0000]',
  // Time Tracking FFB 26-27 — sky blue.
  'espn:1280588303': 'bg-sky-500',
  // WDAY BROCKSTARS — lime, at 700 rather than 500. Hue is chosen for separation from the two
  // above (worst-case CIE Lab distance 93, against the 120 between red and sky) but the shade
  // is chosen for contrast: a bar also sits on the amber-100 selected-league row, where
  // lime-500 managed only 1.8:1 and effectively vanished. lime-700 gets 4.5:1 there and
  // 5.0:1 on white. Still yellow-leaning (hue 124) so it reads as a league, not as the
  // emerald used for gains.
  'sleeper:1389709228628791296': 'bg-lime-700',
}

const KEY = 'leagueColors'

/**
 * Stable color per league id. The assignment is persisted, so joining a league next season
 * gives it the first free slot instead of reshuffling the ones you have already learned.
 * Past the end of the palette colors repeat, which beats leaving a league unmarked.
 */
export function assignLeagueColors(leagueIds: string[]): Record<string, string> {
  const stored = load<Record<string, number>>(KEY, {})
  const next = { ...stored }
  let changed = false
  // A league that was auto-assigned before it got pinned should give its slot back.
  for (const id of Object.keys(OVERRIDES)) {
    if (next[id] !== undefined) {
      delete next[id]
      changed = true
    }
  }
  const used = new Set(Object.values(next))
  for (const id of leagueIds) {
    if (OVERRIDES[id] !== undefined || next[id] !== undefined) continue
    let i = 0
    while (i < PALETTE.length && used.has(i)) i++
    if (i === PALETTE.length) i = Object.keys(next).length % PALETTE.length
    next[id] = i
    used.add(i)
    changed = true
  }
  if (changed) save(KEY, next)
  const auto = Object.fromEntries(Object.entries(next).map(([id, i]) => [id, PALETTE[i % PALETTE.length]]))
  return { ...auto, ...OVERRIDES }
}

export const FALLBACK_COLOR = 'bg-stone-300'
