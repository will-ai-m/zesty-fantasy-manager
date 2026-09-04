import { useQuery } from '@tanstack/react-query'
import { api, type LineupSlot, type Player } from '../api'
import { fmt, gameDate } from '../lib/format'
import { useApp } from '../components/AppContext'
import { Chip, ErrorBox, PlatformBadge, PlayerCell, Pos, Spinner } from '../components/Badges'
import { FpRank } from '../components/Weekly'

function Side({ player, lock }: { player: Player | null; lock: LineupSlot['current_lock'] }) {
  if (!player) return <span className="text-red-600">Empty</span>
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <PlayerCell p={player} />
      <span className="num text-[11px] text-stone-500" title="Projected points this week under your league's scoring">{fmt(player.proj_week)}</span>
      <FpRank fp={player.fp} />
      {lock?.locked && <Chip tone="stone" title={`Game started ${gameDate(lock.date)}`}>locked</Chip>}
    </span>
  )
}

export default function Lineup() {
  const { leagueId, league, week } = useApp()
  const { data, isLoading, error } = useQuery({
    queryKey: ['lineup', leagueId, week],
    queryFn: () => api.lineup(leagueId!, week),
    enabled: !!leagueId,
    staleTime: 60_000,
  })

  if (!league) return <Spinner />
  if (isLoading) return <Spinner label="Working out the best lineup (expert ranks, projections, kickoff times)…" />
  if (error) return <ErrorBox error={error} />
  if (!data) return null

  const changed = data.slots.filter((s) => s.change)
  const settled = data.slots.filter((s) => !s.change)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <h1 className="flex items-center gap-2 text-base font-semibold"><PlatformBadge platform={league.platform} />Week {data.week} lineup · {league.name}</h1>
        <Chip tone={data.basis === 'fantasypros' ? 'green' : 'stone'} title={data.basis === 'fantasypros'
          ? 'Slots go to the highest FantasyPros rank; projections break ties and cover players nobody has ranked.'
          : 'FantasyPros ranks are unavailable, so this falls back to projections under your league scoring.'}>
          {data.basis === 'fantasypros' ? 'FantasyPros first' : 'Projections only'}
        </Chip>
        {data.totals && (
          <span className="text-[12px] text-stone-600">
            Projected {fmt(data.totals.current)} → <span className="font-semibold">{fmt(data.totals.optimal)}</span>
            {data.totals.gain < 0 && <span className="ml-1 text-stone-500" title="The consensus prefers this lineup even though it projects for slightly fewer points">(the experts disagree with the projections here)</span>}
          </span>
        )}
        <span className="ml-auto text-[12px] text-stone-500">First kickoff {gameDate(data.first_kickoff)}</span>
      </div>

      {data.fp_errors.length > 0 && (
        <div className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
          Some FantasyPros pages did not load: {data.fp_errors.join('; ')}
        </div>
      )}

      <section className="rounded-md border border-stone-200 bg-white">
        <header className="flex items-center gap-2 border-b border-stone-200 px-3 py-2">
          <h2 className="font-semibold">{changed.length === 0 ? 'Lineup is set' : `${changed.length} change${changed.length > 1 ? 's' : ''} to make`}</h2>
          <span className="text-[12px] text-stone-500">Make them in {league.platform === 'espn' ? 'ESPN' : 'Sleeper'} — this app only reads.</span>
        </header>
        {changed.length === 0 ? (
          <p className="px-3 py-3 text-[12px] text-stone-500">Every slot already holds the player the consensus wants there.</p>
        ) : (
          <ul className="divide-y divide-stone-100">
            {changed.map((s, i) => (
              <li key={`${s.slot}-${i}`} className={`flex flex-wrap items-center gap-2 px-3 py-2 ${s.locked ? 'opacity-50' : ''}`}>
                <Pos pos={s.slot} />
                <Side player={s.current} lock={s.current_lock} />
                <span className="text-stone-400">→</span>
                <Side player={s.suggested} lock={s.suggested_lock} />
                <span className="text-[11px] text-stone-500">{s.reason}</span>
                {s.locked && <Chip tone="stone" title="That game has kicked off, so the swap is no longer possible">too late</Chip>}
              </li>
            ))}
          </ul>
        )}
      </section>

      {data.watch.length > 0 && (
        <section className="rounded-md border border-amber-200 bg-amber-50/50 p-3">
          <h2 className="text-[12px] font-semibold uppercase tracking-wide text-amber-800">Check before kickoff</h2>
          <ul className="mt-1 space-y-1">
            {data.watch.map((w, i) => (
              <li key={i} className="flex flex-wrap items-center gap-2 text-[12px]">
                <Pos pos={w.slot} />
                {w.player && <PlayerCell p={w.player} />}
                <span className="text-stone-600">{w.player?.injury_status}{w.player?.injury_body_part ? ` (${w.player.injury_body_part})` : ''}</span>
                {w.best_replacement
                  ? <span className="text-stone-600">→ if he sits, start <PlayerCell p={w.best_replacement} /></span>
                  : <span className="text-stone-500">no eligible replacement on your bench</span>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {data.issues.length > 0 && (
        <ul className="space-y-0.5">
          {data.issues.map((f, i) => (
            <li key={i} className={`text-[12px] ${f.level === 'error' ? 'text-red-700' : f.level === 'warn' ? 'text-amber-700' : 'text-stone-600'}`}>
              {f.level === 'error' ? '⛔' : f.level === 'warn' ? '⚠️' : 'ℹ️'} {f.text}
            </li>
          ))}
        </ul>
      )}

      <div className="grid gap-3 md:grid-cols-2">
        <section className="rounded-md border border-stone-200 bg-white p-3">
          <h2 className="text-[12px] font-semibold uppercase tracking-wide text-stone-500">Slots already right</h2>
          <ul className="mt-1 space-y-1">
            {settled.map((s, i) => (
              <li key={`${s.slot}-${i}`} className="flex flex-wrap items-center gap-2 text-[12px]"><Pos pos={s.slot} /><Side player={s.current} lock={s.current_lock} /></li>
            ))}
          </ul>
        </section>
        <section className="rounded-md border border-stone-200 bg-white p-3">
          <h2 className="text-[12px] font-semibold uppercase tracking-wide text-stone-500">Bench, best first</h2>
          <ul className="mt-1 space-y-1">
            {data.bench.map((p) => (
              <li key={p.player_id} className="flex flex-wrap items-center gap-2 text-[12px]">
                <PlayerCell p={p} showPos />
                <span className="num text-stone-500">{fmt(p.proj_week)}</span>
                <FpRank fp={p.fp} />
                {p.fp_disagreement != null && (
                  <span className={`text-[11px] ${p.fp_disagreement > 0 ? 'text-emerald-700' : 'text-stone-500'}`}
                    title="Gap between the expert consensus and the projection, in league points">
                    experts {p.fp_disagreement > 0 ? 'higher' : 'lower'} by {fmt(Math.abs(p.fp_disagreement))}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  )
}
