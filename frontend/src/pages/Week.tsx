import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type Plan, type Target, type WeekLeague } from '../api'
import { countdown, gameDate } from '../lib/format'
import { useApp } from '../components/AppContext'
import { Chip, ErrorBox, PlatformBadge, PlayerCell, Pos, Spinner } from '../components/Badges'
import { Bid, ClockBar, LineupMove, NewsCard, PriorityBadge } from '../components/Weekly'

function Claims({ entry, plans, onPlan }: { entry: WeekLeague; plans: Plan[]; onPlan: (t: Target) => void }) {
  const targets = entry.waivers.targets ?? []
  const faab = entry.waivers.faab
  const planned = plans.filter((p) => p.league_id === entry.league.league_id && p.status === 'planned')
  const committed = planned.reduce((s, p) => s + (p.bid ?? 0), 0)
  const isFaab = entry.league.waiver.type_code === 2

  return (
    <div>
      <div className="flex items-center gap-2">
        <h3 className="text-[12px] font-semibold uppercase tracking-wide text-stone-500">Claims to file</h3>
        <Link to="/board" className="text-[11px] text-stone-500 underline hover:text-amber-700">full board</Link>
        {isFaab && planned.length > 0 && faab && (
          <Chip tone={faab.remaining - committed < 0 ? 'red' : 'stone'}>
            ${committed} planned → ${faab.remaining - committed} left
          </Chip>
        )}
      </div>
      {planned.length > 0 && (
        <ul className="mt-1 space-y-0.5">
          {planned.map((p, i) => (
            <li key={p.id} className="flex flex-wrap items-center gap-2 text-[12px]">
              <span className="num w-4 text-stone-400">{i + 1}.</span>
              <span className="font-medium">{p.add_player?.name ?? '—'}</span>
              {p.drop_player && <span className="text-stone-500">drop {p.drop_player.name}</span>}
              {isFaab && <Chip tone="amber">${p.bid ?? 0}</Chip>}
              <Chip tone="blue">queued</Chip>
            </li>
          ))}
        </ul>
      )}
      <ul className="mt-1 space-y-1">
        {targets.map((t) => (
          <li key={t.player_id} className="flex flex-wrap items-center gap-2 text-[12px]">
            <PriorityBadge target={t} />
            <PlayerCell p={t} showPos />
            {isFaab && <Bid target={t} />}
            {t.clears_at
              ? <span className="text-amber-700" title="Still on waivers until then">clears in {countdown(t.clears_at)}</span>
              : <span className="text-emerald-700">free now</span>}
            <span className="text-stone-500">{t.priority.why[0]}</span>
            <button onClick={() => onPlan(t)} className="ml-auto rounded border border-stone-300 px-2 py-0.5 text-[11px] hover:border-amber-400 hover:bg-amber-50">Plan</button>
          </li>
        ))}
      </ul>
      {targets.length === 0 && <p className="mt-1 text-[12px] text-stone-500">Nothing on the wire worth a claim right now.</p>}
    </div>
  )
}

function LeagueCard({ entry, plans, onPlan }: { entry: WeekLeague; plans: Plan[]; onPlan: (leagueId: string, t: Target) => void }) {
  const { setLeagueId } = useApp()
  const moves = entry.lineup.moves ?? []
  const watch = entry.lineup.watch ?? []
  const problems = (entry.lineup.issues ?? []).filter((i) => i.level === 'error')

  return (
    <section className="rounded-md border border-stone-200 bg-white">
      <header className="flex flex-wrap items-center gap-2 border-b border-stone-200 px-3 py-2">
        <h2 className="flex items-center gap-2 font-semibold">
          <PlatformBadge platform={entry.league.platform} />
          <button onClick={() => setLeagueId(entry.league.league_id)} className="hover:text-amber-700 hover:underline">{entry.league.name}</button>
        </h2>
        {entry.clock && <ClockBar clock={entry.clock} faab={entry.waivers.faab} />}
        <span className="ml-auto text-[11px] text-stone-500">Kickoff {gameDate(entry.lineup.first_kickoff)}</span>
      </header>

      <div className="grid gap-4 p-3 md:grid-cols-2">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-[12px] font-semibold uppercase tracking-wide text-stone-500">Lineup</h3>
            <Link to="/lineup" className="text-[11px] text-stone-500 underline hover:text-amber-700">full lineup</Link>
            {entry.lineup.basis === 'projections' && <Chip title="FantasyPros ranks were unavailable, so this is projections only">projections only</Chip>}
          </div>
          {entry.lineup.error && <p className="mt-1 text-[12px] text-red-700">{entry.lineup.error}</p>}
          {moves.length === 0 && !entry.lineup.error && <p className="mt-1 text-[12px] text-emerald-700">Lineup is already right.</p>}
          <ul className="mt-1">
            {moves.map((m, i) => <LineupMove key={`${m.slot}-${i}`} move={m} />)}
          </ul>
          {watch.length > 0 && (
            <div className="mt-1.5 text-[12px]">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-amber-700">Watch </span>
              {watch.map((w, i) => (
                <span key={i} className="mr-2 inline-flex items-center gap-1">
                  <Pos pos={w.slot} />{w.player?.name} ({w.player?.injury_status})
                  {w.best_replacement && <span className="text-stone-500">→ {w.best_replacement.name}</span>}
                </span>
              ))}
            </div>
          )}
          {problems.map((p, i) => <p key={i} className="mt-1 text-[12px] text-red-700">⛔ {p.text}</p>)}
        </div>

        <div>
          {entry.waivers.error
            ? <p className="text-[12px] text-red-700">{entry.waivers.error}</p>
            : <Claims entry={entry} plans={plans} onPlan={(t) => onPlan(entry.league.league_id, t)} />}
        </div>
      </div>
    </section>
  )
}

export default function Week() {
  const { openPlan } = useApp()
  const qc = useQueryClient()
  const { data, isLoading, error } = useQuery({ queryKey: ['week'], queryFn: api.week, staleTime: 60_000 })
  const { data: plans } = useQuery({ queryKey: ['plans'], queryFn: api.plans })
  const mark = useMutation({
    mutationFn: ({ key, seen }: { key: string; seen: boolean }) => api.markNews([key], seen),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['week'] }); qc.invalidateQueries({ queryKey: ['news'] }) },
  })

  if (isLoading) return <Spinner label="Building this week: lineups, the wire, and the news…" />
  if (error) return <ErrorBox error={error} />
  if (!data) return null

  const totalMoves = data.leagues.reduce((s, l) => s + (l.lineup.moves?.length ?? 0), 0)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h1 className="text-base font-semibold">Week {data.week}</h1>
        <span className="text-[12px] text-stone-500">
          {totalMoves === 0 ? 'Lineups are set.' : `${totalMoves} lineup change${totalMoves > 1 ? 's' : ''} to make.`}
          {data.news.length > 0 && ` ${data.news.length} story${data.news.length > 1 ? ' items' : ''} worth a look.`}
        </span>
        <span className="ml-auto text-[11px] text-stone-400">Times in {data.timezone}</span>
      </div>

      {data.news.length > 0 && (
        <section className="space-y-2">
          <div className="flex items-center gap-2">
            <h2 className="text-[12px] font-semibold uppercase tracking-wide text-stone-500">News to act on</h2>
            <Link to="/news" className="text-[11px] text-stone-500 underline hover:text-amber-700">full feed</Link>
          </div>
          {data.news.slice(0, 5).map((item) => (
            <NewsCard key={`${item.key}-${item.player_id}`} item={item}
              onSeen={(key, seen) => mark.mutate({ key, seen })}
              onPlan={(leagueId, add) => openPlan({ leagueId, add })} />
          ))}
        </section>
      )}

      {data.leagues.map((entry) => (
        <LeagueCard key={entry.league.league_id} entry={entry} plans={plans ?? []}
          onPlan={(leagueId, t) => openPlan({ leagueId, add: t })} />
      ))}

      {data.news_errors.length > 0 && (
        <p className="text-[11px] text-stone-400">News feed: {data.news_errors.join('; ')}</p>
      )}
      <p className="text-[11px] text-stone-400">
        Nothing here is applied for you — Sleeper and ESPN are read-only through their public APIs.
        Make the moves in the app, then mark them done in the <Link to="/planner" className="underline">Planner</Link>.
        Projected totals use your league's scoring; start/sit calls follow the FantasyPros consensus where it exists.
        {data.leagues.some((l) => (l.lineup.gain ?? 0) < 0) && ' A negative projected delta means the experts and the projections disagree.'}
      </p>
    </div>
  )
}
