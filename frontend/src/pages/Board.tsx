import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, type Player, type Target } from '../api'
import { countdown, dayTime, fmt, fmtInt, OUT_STATUSES, pct, POS_ORDER } from '../lib/format'
import { useApp } from '../components/AppContext'
import { Chip, ErrorBox, PlatformBadge, PlayerCell, Pos, Spinner } from '../components/Badges'
import { DataTable, type Column } from '../components/DataTable'
import { Bid, ClockBar, FpRank, PriorityBadge } from '../components/Weekly'

const POS_FILTERS = ['ALL', 'QB', 'RB', 'WR', 'TE', 'FLEX', 'K', 'DEF']

export default function Board() {
  const { leagueId, league, week, openPlan } = useApp()
  const { data, isLoading, error } = useQuery({
    queryKey: ['waiver-board', leagueId, week],
    queryFn: () => api.waiverBoard(leagueId!, week),
    enabled: !!leagueId,
    staleTime: 60_000,
  })
  const [pos, setPos] = useState('ALL')
  const [onlyUpgrades, setOnlyUpgrades] = useState(false)
  const tz = data?.clock.timezone

  const rows = useMemo(() => (data?.targets ?? []).filter((t) => {
    if (pos === 'FLEX' ? !['RB', 'WR', 'TE'].includes(t.position) : pos !== 'ALL' && t.position !== pos) return false
    if (onlyUpgrades && (t.vs_mine ?? 0) <= 0) return false
    if (OUT_STATUSES.has(t.injury_status ?? '')) return false
    return true
  }), [data, pos, onlyUpgrades])

  const columns = useMemo<Column<Target>[]>(() => [
    { key: 'priority', header: 'Claim', title: 'Upgrade over your weakest starter, expert rank, market trend, projected role, and whether his path just cleared. Hover a row for the reasons.', render: (t) => <PriorityBadge target={t} />, sort: (t) => t.priority.score, align: 'left', desc: true },
    { key: 'name', header: 'Player', render: (t) => <PlayerCell p={t} />, sort: (t) => t.name },
    { key: 'pos', header: 'Pos', render: (t) => <Pos pos={t.position} />, sort: (t) => POS_ORDER.indexOf(t.position), align: 'center' },
    { key: 'bid', header: 'Bid', title: "Suggested FAAB, calibrated to what this league's winning bids have actually cost. Hover for the reasoning and comparable claims.", render: (t) => <Bid target={t} />, sort: (t) => t.faab?.mid, align: 'right', desc: true },
    {
      key: 'clears', header: 'Clears', title: 'When he comes off waivers. Blank means he is a free agent you can add now.',
      render: (t) => t.clears_at
        ? <span className="whitespace-nowrap text-amber-700" title={dayTime(t.clears_at, tz)}>{countdown(t.clears_at)}</span>
        : <span className="whitespace-nowrap text-emerald-700">free now</span>,
      sort: (t) => t.clears_at ?? 0, align: 'right',
    },
    { key: 'fp_wire', header: 'Wire', title: 'FantasyPros waiver-wire ranking this week', render: (t) => t.fp?.waiver_rank ? <span className="font-medium">#{t.fp.waiver_rank}</span> : <span className="text-stone-300">—</span>, sort: (t) => t.fp?.waiver_rank, align: 'right' },
    { key: 'fp_week', header: 'ECR', title: 'FantasyPros rank for this week, with tier and the change since last week', render: (t) => <FpRank fp={t.fp} />, sort: (t) => t.fp?.pos_rank_n, align: 'right' },
    { key: 'fp_ros', header: 'ROS ECR', title: 'FantasyPros rest-of-season rank', render: (t) => <FpRank fp={t.fp} kind="ros" />, sort: (t) => t.fp?.ros_pos_rank, align: 'right' },
    {
      key: 'opportunity', header: 'Why now', title: 'Somebody ahead of him on the depth chart is hurt, or there is recent news about him',
      render: (t) => {
        if (t.opportunity) {
          return <span className={t.opportunity.certain ? 'text-emerald-700' : 'text-amber-700'} title={t.opportunity.reason}>
            {t.opportunity.certain ? '✓' : '~'} {t.opportunity.blockers[0].name} {t.opportunity.blockers[0].injury_status}
          </span>
        }
        const story = t.news_signal ?? t.news?.[0]
        return story
          ? <span className="block max-w-[260px] truncate text-stone-600" title={`${story.title}\n\n${story.description ?? ''}`}>{story.title}</span>
          : <span className="text-stone-300">—</span>
      },
      sort: (t) => (t.opportunity ? (t.opportunity.certain ? 3 : 2) : t.news?.length ? 1 : 0), align: 'left', desc: true,
    },
    { key: 'vs_mine', header: 'vs mine', title: 'Rest-of-season projection minus your weakest player at that position (RB/WR/TE compare against your weakest flex-eligible player)', render: (t) => t.vs_mine == null ? <span className="text-stone-300">—</span> : <span className={t.vs_mine > 0 ? 'font-semibold text-emerald-700' : 'text-stone-400'}>{t.vs_mine > 0 ? '+' : ''}{fmt(t.vs_mine, 0)}</span>, sort: (t) => t.vs_mine, align: 'right', desc: true },
    { key: 'proj_week', header: `Wk ${week}`, title: 'Projected points this week under this league’s scoring', render: (t) => fmt(t.proj_week), sort: (t) => t.proj_week, align: 'right', desc: true },
    { key: 'proj_ros', header: 'ROS', render: (t) => <span className="font-medium">{fmt(t.proj_ros, 0)}</span>, sort: (t) => t.proj_ros, align: 'right', desc: true },
    { key: 'owned', header: 'Own%', title: 'Percent of Sleeper leagues where rostered', render: (t) => pct(t.owned), sort: (t) => t.owned, align: 'right', desc: true },
    { key: 'adds_24h', header: '+24h', title: 'Adds across Sleeper in the last 24 hours', render: (t) => <span className={t.adds_24h > 0 ? 'text-emerald-700 font-medium' : 'text-stone-400'}>{t.adds_24h ? fmtInt(t.adds_24h) : '·'}</span>, sort: (t) => t.adds_24h, align: 'right', desc: true },
    {
      key: 'plan', header: '', render: (t) => (
        <button onClick={() => leagueId && openPlan({ leagueId, add: t })} className="rounded border border-stone-300 px-2 py-0.5 text-[11px] hover:border-amber-400 hover:bg-amber-50">Plan</button>
      ), align: 'center',
    },
  ], [week, leagueId, openPlan, tz])

  if (!league) return <Spinner />

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <h1 className="flex items-center gap-2 text-base font-semibold"><PlatformBadge platform={league.platform} />Waiver board · {league.name}</h1>
        {data && <ClockBar clock={data.clock} faab={data.faab} />}
        <span className="ml-auto text-[12px] text-stone-500">
          {data?.fp ? `FantasyPros ${data.fp.scoring} · ${data.fp.experts} experts · ${data.fp.last_updated ?? ''}` : 'FantasyPros ranks unavailable'}
        </span>
      </div>
      {data?.fp_errors?.length ? (
        <div className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
          Some FantasyPros pages did not load, so those ranks are missing: {data.fp_errors.join('; ')}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex rounded-md border border-stone-200 bg-white p-0.5">
          {POS_FILTERS.map((f) => (
            <button key={f} onClick={() => setPos(f)} className={`rounded px-2.5 py-1 text-[12px] ${pos === f ? 'bg-stone-900 text-white' : 'text-stone-700 hover:bg-stone-100'}`}>{f}</button>
          ))}
        </div>
        <label className="flex items-center gap-1.5 text-[12px] text-stone-700"><input type="checkbox" checked={onlyUpgrades} onChange={(e) => setOnlyUpgrades(e.target.checked)} /> Only upgrades on my roster</label>
        <span className="text-[12px] text-stone-500">{rows.length} of {data?.targets.length ?? 0} ranked targets</span>
      </div>

      {isLoading && <Spinner label="Ranking the wire (projections, expert ranks, depth charts, bid history)…" />}
      {error && <ErrorBox error={error} />}
      {data && (
        <>
          <DataTable rows={rows} columns={columns} rowKey={(t) => t.player_id} initialSort={{ key: 'priority', dir: 'desc' }} maxHeight="calc(100vh - 420px)" />
          <div className="grid gap-3 md:grid-cols-2">
            <Market data={data} />
            <Drops rows={data.drop_candidates} onPlan={(p) => leagueId && openPlan({ leagueId, drop: p })} faab={league.waiver.type_code === 2} />
          </div>
        </>
      )}
    </div>
  )
}

function Market({ data }: { data: NonNullable<Awaited<ReturnType<typeof api.waiverBoard>>> }) {
  const m = data.faab.market
  if (data.league.waiver.type_code !== 2) {
    return (
      <section className="rounded-md border border-stone-200 bg-white p-3">
        <h2 className="text-[12px] font-semibold uppercase tracking-wide text-stone-500">Waiver order</h2>
        <p className="mt-1 text-[12px] text-stone-600">
          This league runs {data.league.waiver.type.toLowerCase()}, not FAAB{data.league.my_team?.waiver_position != null ? `; you are #${data.league.my_team.waiver_position}` : ''}.
          Claims are ordered by priority, so put the target you most want first in the Planner.
        </p>
      </section>
    )
  }
  return (
    <section className="rounded-md border border-stone-200 bg-white p-3">
      <h2 className="text-[12px] font-semibold uppercase tracking-wide text-stone-500">What this league pays</h2>
      {m.won === 0 ? (
        <p className="mt-1 text-[12px] text-stone-600">No winning bids yet this season, so suggestions use a plain curve over the ${m.budget} budget.</p>
      ) : (
        <>
          <div className="mt-1.5 flex flex-wrap gap-2 text-[12px]">
            <Chip>{m.won} winning bids</Chip>
            <Chip>median ${m.median}</Chip>
            <Chip>top 25% ≥ ${m.p75}</Chip>
            <Chip tone="amber">max ${m.max}</Chip>
          </div>
          <ul className="mt-2 space-y-0.5 text-[12px] text-stone-600">
            {m.top.map((b) => (
              <li key={`${b.player_id}-${b.week}`}>${b.bid} · {b.name} <span className="text-stone-400">{b.position} · week {b.week}</span></li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}

function Drops({ rows, onPlan, faab }: { rows: (Player & { is_starter: boolean })[]; onPlan: (p: Player) => void; faab: boolean }) {
  return (
    <section className="rounded-md border border-stone-200 bg-white p-3">
      <h2 className="text-[12px] font-semibold uppercase tracking-wide text-stone-500">Cheapest to drop</h2>
      <p className="mt-0.5 text-[11px] text-stone-500">Your roster by rest-of-season projection, worst first{faab ? '. Pair one with a claim.' : ''}</p>
      <ul className="mt-1.5 space-y-1">
        {rows.map((p) => (
          <li key={p.player_id} className="flex flex-wrap items-center gap-2 text-[12px]">
            <PlayerCell p={p} showPos />
            <span className="text-stone-500">ROS {fmt(p.proj_ros, 0)}</span>
            <FpRank fp={p.fp} kind="ros" />
            {p.is_starter && <Chip tone="amber">starting</Chip>}
            {p.bye_week != null && <span className="text-stone-400">bye {p.bye_week}</span>}
            <button onClick={() => onPlan(p)} className="ml-auto rounded border border-stone-300 px-2 py-0.5 text-[11px] hover:bg-stone-50">Plan drop</button>
          </li>
        ))}
      </ul>
    </section>
  )
}
