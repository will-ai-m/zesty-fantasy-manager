import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api, type Game } from '../api'
import { useApp } from './AppContext'

/** "1:00p" — the sidebar has ~192px, so every character counts. */
const shortTime = (iso: string | null) => {
  if (!iso) return '—'
  const s = new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  return s.replace(/\s?([AP])M$/i, (_, p: string) => p.toLowerCase())
}

const shortDay = (iso: string | null) => {
  if (!iso) return 'TBD'
  const d = new Date(iso)
  return `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${d.getMonth() + 1}/${d.getDate()}`
}

const tip = (g: Game) => {
  const bits: string[] = []
  if (g.spread != null && g.favorite) bits.push(`${g.favorite} ${g.spread < 0 ? g.spread : -g.spread}`)
  if (g.total != null) bits.push(`O/U ${g.total}`)
  if (g.away_implied != null && g.home_implied != null) {
    bits.push(`implied ${g.away} ${g.away_implied} · ${g.home} ${g.home_implied}`)
  }
  if (g.broadcast) bits.push(g.broadcast)
  if (g.weather?.summary) bits.push(`${g.weather.summary}${g.weather.temperature != null ? ` ${g.weather.temperature}°` : ''}`)
  return bits.join(' · ') || 'No line posted'
}

function Row({ g }: { g: Game }) {
  const live = g.state === 'in'
  const done = g.state === 'post'
  const favAway = g.favorite === g.away
  const favHome = g.favorite === g.home
  return (
    <Link
      to="/games"
      title={tip(g)}
      className="flex items-baseline gap-1 rounded px-1 py-[3px] text-[11px] leading-tight hover:bg-stone-100"
    >
      <span className={`w-9 shrink-0 tabular-nums ${live ? 'font-semibold text-red-600' : 'text-stone-400'}`}>
        {live ? 'LIVE' : done ? 'FIN' : shortTime(g.kickoff)}
      </span>
      <span className="min-w-0 flex-1 truncate">
        <span className={favAway ? 'font-semibold text-stone-900' : 'text-stone-600'}>{g.away}</span>
        <span className="text-stone-300"> @ </span>
        <span className={favHome ? 'font-semibold text-stone-900' : 'text-stone-600'}>{g.home}</span>
      </span>
      {done || live ? (
        <span className="shrink-0 tabular-nums text-stone-500">{g.away_score ?? 0}-{g.home_score ?? 0}</span>
      ) : (
        <span className="shrink-0 tabular-nums text-stone-400">{g.total != null ? g.total.toFixed(1) : '·'}</span>
      )}
    </Link>
  )
}

export function SidebarGames() {
  const { week } = useApp()
  const { data, isLoading } = useQuery({
    queryKey: ['games', week],
    queryFn: () => api.games(week),
    staleTime: 5 * 60_000,
  })

  const days: { label: string; games: Game[] }[] = []
  for (const g of data?.games ?? []) {
    const label = shortDay(g.kickoff)
    const last = days[days.length - 1]
    if (last && last.label === label) last.games.push(g)
    else days.push({ label, games: [g] })
  }

  return (
    <div className="mt-3 border-t border-stone-200 pt-2">
      <div className="mb-1 flex items-baseline justify-between px-1">
        <span className="text-[10.5px] font-semibold uppercase tracking-wide text-stone-400">Week {week}</span>
        <Link to="/games" className="text-[10px] text-stone-400 hover:text-stone-700 hover:underline">all →</Link>
      </div>
      {isLoading && <div className="px-1 py-1 text-[11px] text-stone-400">Loading games…</div>}
      {data && data.games.length === 0 && <div className="px-1 py-1 text-[11px] text-stone-400">No games.</div>}
      {days.map((d) => (
        <div key={d.label} className="mb-1">
          <div className="px-1 py-0.5 text-[10px] font-medium text-stone-400">{d.label}</div>
          {d.games.map((g) => <Row key={g.game_id} g={g} />)}
        </div>
      ))}
    </div>
  )
}
