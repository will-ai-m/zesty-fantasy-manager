import { useQuery } from '@tanstack/react-query'
import { api, type Player, type Streamer } from '../api'
import { fmt, pct } from '../lib/format'
import { useApp } from '../components/AppContext'
import { ErrorBox, LeagueBar, PlatformBadge, PlayerCell, Spinner } from '../components/Badges'

/** One week's streaming shortlist for K or D/ST. */
function StreamTable({ pos, week, players, onPlan }: { pos: 'K' | 'DEF'; week: number; players: Streamer[]; onPlan?: (p: Player) => void }) {
  if (!players.length) {
    return (
      <div className="rounded-md border border-stone-200 bg-white p-3 text-[12px] text-stone-500">
        Week {week} — no lines posted yet, so there is nothing to rank on.
      </div>
    )
  }
  const basisLabel = pos === 'DEF' ? 'Opp implied' : 'Team implied'
  return (
    <div className="overflow-hidden rounded-md border border-stone-200 bg-white">
      <div className="border-b border-stone-200 bg-stone-50 px-3 py-1.5 text-[11px] font-semibold text-stone-600">Week {week}</div>
      <table className="w-full text-[12px]">
        <thead>
          <tr className="text-[10px] uppercase tracking-wide text-stone-400">
            <th className="px-3 py-1 text-left font-medium">{pos === 'DEF' ? 'Defense' : 'Kicker'}</th>
            <th className="px-2 py-1 text-left font-medium">Matchup</th>
            <th className="px-2 py-1 text-right font-medium" title={pos === 'DEF' ? "Points the opponent is projected to score — lower is a better streaming spot" : "Points this kicker's own offense is projected to score — higher is better"}>{basisLabel}</th>
            <th className="px-2 py-1 text-right font-medium">Own%</th>
            <th className="w-8" />
          </tr>
        </thead>
        <tbody>
          {players.slice(0, 6).map((s, i) => (
            <tr key={s.player_id} className={`border-t border-stone-100 ${i === 0 ? 'bg-emerald-50/60' : ''}`}>
              <td className="px-3 py-1.5">
                <span className="inline-flex items-center gap-1.5">
                  {i === 0 && <span className="rounded bg-emerald-600 px-1 py-0.5 text-[9px] font-bold leading-none text-white">1</span>}
                  <PlayerCell p={s} />
                </span>
              </td>
              <td className="px-2 py-1.5 text-stone-600">{s.matchup ?? '—'}</td>
              <td className="px-2 py-1.5 text-right tabular-nums">
                <span className={s.stream_score >= 0.6 ? 'font-semibold text-emerald-700' : 'text-stone-700'}>{fmt(s.stream_basis, 1)}</span>
              </td>
              <td className="px-2 py-1.5 text-right text-stone-500">{pct(s.owned)}</td>
              <td className="pr-2">
                {onPlan && <button onClick={() => onPlan(s)} className="rounded border border-stone-300 px-1.5 py-0.5 text-[10px] text-stone-700 hover:border-amber-400 hover:bg-amber-50">+</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** Kickers and defences, which are a different game from the rest of the waiver wire: almost no
 * week-to-week carryover, so you are picking a matchup rather than a player, and the good
 * matchups get claimed by whoever looks furthest ahead. */
export default function Streaming() {
  const { leagueId, league, openPlan } = useApp()
  // Same query key as the waiver page, so the two share one fetch rather than each paying for it.
  const { data, isLoading, error } = useQuery({
    queryKey: ['waivers', leagueId],
    queryFn: () => api.waivers(leagueId!),
    enabled: !!leagueId,
    staleTime: 60_000,
  })
  if (!league) return <Spinner />
  const onPlan = (p: Player) => leagueId && openPlan({ leagueId, add: p })

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <h1 className="flex items-stretch gap-2 text-base font-semibold">
          <LeagueBar leagueId={league.league_id} />
          <span className="flex items-center gap-2"><PlatformBadge platform={league.platform} />Streaming · {league.name}</span>
        </h1>
        {data && <span className="ml-auto text-[12px] text-stone-500">Weeks {data.stream_weeks.join(', ')}</span>}
      </div>

      <p className="text-[12px] text-stone-500">
        Ranked on Vegas implied totals, not season value — a defence against an offence projected to score little, a kicker on an offence projected to score a lot.
        Looking {data?.stream_weeks.length ?? 3} weeks out lets you take a good matchup before someone else does.
      </p>

      {isLoading && <Spinner label="Pulling lines for the next few weeks…" />}
      {error && <ErrorBox error={error} />}

      {data && (['DEF', 'K'] as const).map((p) => (
        <div key={p} className="space-y-2">
          <h2 className="text-[13px] font-semibold text-stone-800">{p === 'DEF' ? 'Defence / Special teams' : 'Kickers'}</h2>
          <div className="grid gap-3 lg:grid-cols-3">
            {(data.streamers[p] ?? []).map((w) => (
              <StreamTable key={w.week} pos={p} week={w.week} players={w.players} onPlan={onPlan} />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
