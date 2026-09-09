import { Fragment, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, type Game, type MyPlayer, type MyPlayersResponse } from '../api'
import { fmt } from '../lib/format'
import { useApp } from '../components/AppContext'
import { Chip, ErrorBox, Injury, LeagueBar, PlatformBadge, Pos, Spinner } from '../components/Badges'

const dayLabel = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' }) : 'Time TBD'

const timeLabel = (iso: string | null) =>
  iso ? new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : '—'

const ml = (n: number | null) => (n == null ? '' : n > 0 ? `+${n}` : `${n}`)

/** The home team's line as each side sees it, e.g. spread -3 -> away "+3", home "-3". */
const sideSpread = (g: Game, side: 'away' | 'home') => {
  if (g.spread == null) return null
  const v = side === 'home' ? g.spread : -g.spread
  return v > 0 ? `+${v}` : `${v}`
}

/** Bench-only roles. Anything else is a starting slot in at least one league. */
const BENCH_ROLES = new Set(['BN', 'IR', 'TAXI'])

function Side({ g, side }: { g: Game; side: 'away' | 'home' }) {
  const abbr = side === 'away' ? g.away : g.home
  const score = side === 'away' ? g.away_score : g.home_score
  const record = side === 'away' ? g.away_record : g.home_record
  const impl = side === 'away' ? g.away_implied : g.home_implied
  const money = side === 'away' ? g.away_moneyline : g.home_moneyline
  const fav = g.favorite === abbr
  const live = g.state === 'in' || g.state === 'post'
  return (
    <div className="flex items-baseline gap-1.5">
      <span className={`w-9 text-[13px] ${fav ? 'font-bold text-stone-900' : 'font-medium text-stone-700'}`}>{abbr}</span>
      {record && <span className="w-8 text-[10.5px] text-stone-400">{record}</span>}
      {live && <span className="num w-6 text-right text-[13px] font-semibold">{score ?? 0}</span>}
      <span className={`num w-11 text-right text-[12px] ${fav ? 'text-stone-900' : 'text-stone-500'}`}>{sideSpread(g, side) ?? '·'}</span>
      <span className="num w-10 text-right text-[11px] text-stone-400">{ml(money)}</span>
      <span className="num w-11 text-right text-[12px] text-stone-600" title="Implied team total">
        {impl != null ? impl.toFixed(2) : '·'}
      </span>
    </div>
  )
}

/** One of my players in one league. Split per league rather than per player, because the slot
 * and the projection are both league-specific — the same player can be a FLEX starter in one
 * league and a bench body in another, worth different points under each scoring set. */
function PlayerChip({ p, role, proj }: { p: MyPlayer; role: string; proj: number | null }) {
  const { openPlayer } = useApp()
  const starting = !BENCH_ROLES.has(role)
  return (
    <button
      type="button"
      onClick={() => openPlayer(p.player_id)}
      title={`${p.name}${p.team ? ` · ${p.team}` : ''} · ${role}`}
      className={`inline-flex items-center gap-1.5 rounded border px-1.5 py-0.5 text-[11.5px] leading-none hover:border-amber-400 hover:bg-amber-50 ${
        starting ? 'border-sky-200 bg-sky-50' : 'border-stone-200 bg-white'
      }`}
    >
      <span className="text-[9.5px] font-semibold uppercase text-stone-400">{p.team}</span>
      <Pos pos={role} />
      <span className={starting ? 'font-medium text-stone-900' : 'text-stone-600'}>{p.name}</span>
      <Injury status={p.injury_status} title={p.injury_body_part} />
      <span className="num text-stone-500">{fmt(proj)}</span>
    </button>
  )
}

/** Away-team players before home-team, starters before bench, then by projection. */
function order(g: Game, entries: { p: MyPlayer; role: string; proj: number | null }[]) {
  const side = (e: { p: MyPlayer }) => (e.p.team === g.away ? 0 : 1)
  return entries.sort(
    (a, b) =>
      side(a) - side(b) ||
      Number(BENCH_ROLES.has(a.role)) - Number(BENCH_ROLES.has(b.role)) ||
      (b.proj ?? 0) - (a.proj ?? 0),
  )
}

function MyPlayersRow({ g, byTeam, leagues }: { g: Game; byTeam: Map<string, MyPlayer[]>; leagues: MyPlayersResponse['leagues'] }) {
  const inGame = [...((g.away && byTeam.get(g.away)) || []), ...((g.home && byTeam.get(g.home)) || [])]
  if (inGame.length === 0) return null
  const rows = leagues
    .map((lg) => {
      const entries = inGame.flatMap((p) => {
        const seat = p.leagues.find((l) => l.league_id === lg.league_id)
        return seat ? [{ p, role: seat.role, proj: seat.proj_week }] : []
      })
      return { lg, entries: order(g, entries) }
    })
    .filter((r) => r.entries.length > 0)
  if (rows.length === 0) return null
  return (
    <tr className="align-top">
      <td />
      <td colSpan={4} className="pb-2 pr-3">
        <div className="flex flex-col gap-1">
          {rows.map(({ lg, entries }) => (
            <div key={lg.league_id} className="flex items-stretch gap-1.5">
              <LeagueBar leagueId={lg.league_id} />
              <div className="flex flex-wrap items-center gap-1">
                <span className="inline-flex w-44 shrink-0 items-center gap-1 text-[10.5px] text-stone-500" title={lg.name}>
                  <PlatformBadge platform={lg.platform} />
                  <span className="truncate">{lg.name}</span>
                </span>
                {entries.map((e) => <PlayerChip key={e.p.player_id} p={e.p} role={e.role} proj={e.proj} />)}
              </div>
            </div>
          ))}
        </div>
      </td>
    </tr>
  )
}

function GameRow({ g, today }: { g: Game; today: string | undefined }) {
  const isToday = !!today && g.date_et === today
  return (
    <tr className={`border-t border-stone-100 align-top ${isToday && g.state !== 'post' ? 'bg-sky-50/60' : ''}`}>
      <td className="whitespace-nowrap py-1.5 pr-3 text-[12px] text-stone-500">
        {timeLabel(g.kickoff)}
        {g.state === 'in' && <span className="ml-1.5 rounded bg-red-600 px-1 py-0.5 text-[9px] font-bold text-white">LIVE</span>}
        {g.state === 'post' && <span className="ml-1.5 text-[10px] text-stone-400">FINAL</span>}
        {isToday && g.state === 'pre' && <span className="ml-1.5 rounded bg-sky-600 px-1 py-0.5 text-[9px] font-bold text-white">TODAY</span>}
      </td>
      <td className="py-1.5 pr-4">
        <Side g={g} side="away" />
        <Side g={g} side="home" />
      </td>
      <td className="num whitespace-nowrap py-1.5 pr-4 text-right text-[12px] text-stone-700" title="Over/under">
        {g.total != null ? g.total.toFixed(1) : <span className="text-stone-300">no line</span>}
      </td>
      <td className="whitespace-nowrap py-1.5 pr-3 text-[11px] text-stone-500">{g.broadcast ?? ''}</td>
      <td className="py-1.5 pr-3 text-[11px] text-stone-500">
        {g.weather && (
          <span title={g.venue ?? undefined}>
            {g.weather.summary}
            {g.weather.temperature != null && ` · ${g.weather.temperature}°`}
          </span>
        )}
      </td>
    </tr>
  )
}

export default function Games() {
  const { week: currentWeek } = useApp()
  const [week, setWeek] = useState<number | null>(null)
  const [minesOnly, setMinesOnly] = useState(false)
  const shown = week ?? currentWeek
  const { data, isLoading, error } = useQuery({
    queryKey: ['games', shown],
    queryFn: () => api.games(shown),
    staleTime: 5 * 60_000,
  })
  // Shares its cache key with the roster page's "All leagues" tab, so switching between them
  // is free.
  const mine = useQuery({ queryKey: ['my-players', shown], queryFn: () => api.myPlayers(shown), staleTime: 60_000 })

  const byTeam = useMemo(() => {
    const m = new Map<string, MyPlayer[]>()
    for (const p of mine.data?.players ?? []) {
      if (!p.team) continue
      const list = m.get(p.team)
      if (list) list.push(p)
      else m.set(p.team, [p])
    }
    return m
  }, [mine.data])

  const hasMine = (g: Game) => (g.away && byTeam.has(g.away)) || (g.home && byTeam.has(g.home))
  const games = (data?.games ?? []).filter((g) => !minesOnly || hasMine(g))
  const myGameCount = (data?.games ?? []).filter(hasMine).length

  const days: { label: string; today: boolean; games: Game[] }[] = []
  for (const g of games) {
    const label = dayLabel(g.kickoff)
    const last = days[days.length - 1]
    if (last && last.label === label) last.games.push(g)
    else days.push({ label, today: !!data && g.date_et === data.today, games: [g] })
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-[15px] font-semibold">NFL games</h1>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setWeek(Math.max(1, shown - 1))}
            disabled={shown <= 1}
            className="rounded border border-stone-200 px-1.5 py-0.5 text-[12px] text-stone-600 hover:bg-stone-50 disabled:opacity-40"
          >‹</button>
          <span className="min-w-16 text-center text-[13px] font-medium">Week {shown}</span>
          <button
            onClick={() => setWeek(Math.min(18, shown + 1))}
            disabled={shown >= 18}
            className="rounded border border-stone-200 px-1.5 py-0.5 text-[12px] text-stone-600 hover:bg-stone-50 disabled:opacity-40"
          >›</button>
        </div>
        {shown !== currentWeek && (
          <button onClick={() => setWeek(null)} className="rounded border border-stone-200 px-2 py-0.5 text-[11px] text-stone-600 hover:bg-stone-50">
            Back to week {currentWeek}
          </button>
        )}
        <label className="flex items-center gap-1.5 text-[12px] text-stone-700" title="Only games at least one of your players is in">
          <input type="checkbox" checked={minesOnly} onChange={(e) => setMinesOnly(e.target.checked)} />
          My games{myGameCount > 0 && <span className="text-stone-400">({myGameCount})</span>}
        </label>
        {data && (
          <div className="ml-auto flex items-center gap-2 text-[11px] text-stone-500">
            <Chip>{games.length} games</Chip>
            <Chip tone={data.priced === data.games.length ? 'green' : 'amber'}>
              {data.priced} priced
            </Chip>
            {data.games[0]?.odds_provider && <span>Lines: {data.games[0].odds_provider}</span>}
          </div>
        )}
      </div>

      {isLoading && <Spinner label="Loading games…" />}
      {error && <ErrorBox error={error} />}

      {data && games.length === 0 && (
        <div className="rounded border border-stone-200 bg-white p-4 text-stone-500">
          {minesOnly ? `None of your players are in a week ${shown} game.` : `No games scheduled for week ${shown}.`}
        </div>
      )}

      {data && games.length > 0 && (
        <div className="overflow-x-auto rounded border border-stone-200 bg-white">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="bg-stone-100 text-[10.5px] uppercase tracking-wide text-stone-500">
                <th className="px-3 py-1.5 text-left font-semibold">Time</th>
                <th className="px-0 py-1.5 text-left font-semibold">
                  <span className="inline-flex gap-1.5">
                    <span className="w-9">Team</span><span className="w-8" /><span className="w-11 text-right">Spread</span>
                    <span className="w-10 text-right">ML</span><span className="w-11 text-right">Implied</span>
                  </span>
                </th>
                <th className="px-0 py-1.5 pr-4 text-right font-semibold">Total</th>
                <th className="py-1.5 pr-3 text-left font-semibold">TV</th>
                <th className="py-1.5 pr-3 text-left font-semibold">Weather</th>
              </tr>
            </thead>
            <tbody>
              {days.map((d) => (
                <Fragment key={d.label}>
                  <tr className={`border-t border-stone-200 ${d.today ? 'bg-sky-100' : 'bg-stone-50'}`}>
                    <td colSpan={5} className={`px-3 py-1 text-[11px] font-semibold ${d.today ? 'text-sky-900' : 'text-stone-600'}`}>
                      {d.label}{d.today && ' · today'}
                    </td>
                  </tr>
                  {d.games.map((g) => (
                    <Fragment key={g.game_id}>
                      <GameRow g={g} today={data.today} />
                      <MyPlayersRow g={g} byTeam={byTeam} leagues={mine.data?.leagues ?? []} />
                    </Fragment>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {mine.isLoading && <p className="text-[11px] text-stone-400">Loading your players…</p>}
      {mine.error && <ErrorBox error={mine.error} />}

      <p className="text-[11px] text-stone-400">
        Implied team total = total ÷ 2 ∓ spread ÷ 2 — the points Vegas expects each team to score.
        High implied total favours that team's kicker; a low opponent implied total favours streaming its defence.
      </p>
    </div>
  )
}
