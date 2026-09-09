import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, type Player } from '../api'
import { fmt, fmtInt, OUT_STATUSES, pct, POS_ORDER, shortDate } from '../lib/format'
import { useApp } from '../components/AppContext'
import { Chip, ErrorBox, PlatformBadge, PlayerCell, Pos, Spinner } from '../components/Badges'
import { DataTable, type Column } from '../components/DataTable'

const POS_FILTERS = ['ALL', 'QB', 'RB', 'WR', 'TE', 'FLEX', 'K', 'DEF']

export function playerColumns(opts: { week: number; rosEnd: number; onPlan?: (p: Player) => void; showRank?: boolean; vsMine?: boolean; espn?: boolean }): Column<Player>[] {
  const cols: Column<Player>[] = [
    { key: 'name', header: 'Player', render: (p) => <PlayerCell p={p} />, sort: (p) => p.name },
    { key: 'pos', header: 'Pos', render: (p) => <Pos pos={p.position} />, sort: (p) => POS_ORDER.indexOf(p.position), align: 'center' },
    { key: 'opp', header: `Wk ${opts.week} opp`, title: 'Opponent this week', render: (p) => <span className={p.on_bye ? 'text-stone-400' : ''}>{p.on_bye ? 'BYE' : p.opponent ?? '—'}</span>, sort: (p) => p.opponent },
    { key: 'bye', header: 'Bye', render: (p) => <span className={p.bye_week === opts.week ? 'font-semibold text-red-700' : 'text-stone-500'}>{p.bye_week ?? '—'}</span>, sort: (p) => p.bye_week, align: 'center' },
    { key: 'depth', header: 'Dep', title: 'Depth chart order at position', render: (p) => <span className="text-stone-600">{p.depth_chart_position ? `${p.depth_chart_position}${p.depth_chart_order ?? ''}` : '—'}</span>, sort: (p) => p.depth_chart_order, align: 'center' },
    { key: 'owned', header: 'Own%', title: 'Percent of Sleeper leagues where rostered', render: (p) => pct(p.owned), sort: (p) => p.owned, align: 'right', desc: true },
    { key: 'started', header: 'Start%', title: 'Percent of Sleeper leagues where started', render: (p) => pct(p.started), sort: (p) => p.started, align: 'right', desc: true },
    ...(opts.espn ? [
      { key: 'owned_change', header: 'Own Δ', title: 'ESPN ownership change (percentage points)', render: (p: Player) => p.owned_change == null ? <span className="text-stone-400">·</span> : <span className={p.owned_change > 0 ? 'text-emerald-700' : p.owned_change < 0 ? 'text-red-700' : 'text-stone-400'}>{p.owned_change > 0 ? '+' : ''}{fmt(p.owned_change)}</span>, sort: (p: Player) => p.owned_change, align: 'right' as const, desc: true },
      { key: 'platform_status', header: 'Avail', title: 'ESPN availability: free agent, or on waivers until the shown time', render: (p: Player) => p.platform_status === 'WAIVERS' ? <span className="text-amber-700" title={p.waiver_until ? `On waivers until ${shortDate(p.waiver_until)}` : 'On waivers'}>Waivers{p.waiver_until ? ` · ${shortDate(p.waiver_until)}` : ''}</span> : p.platform_status === 'FREEAGENT' ? <span className="text-emerald-700">FA</span> : <span className="text-stone-400">—</span>, sort: (p: Player) => p.platform_status === 'FREEAGENT' ? 0 : p.platform_status === 'WAIVERS' ? 1 : 2 },
    ] : []),
    { key: 'adds_24h', header: '+24h', title: 'Adds across Sleeper, last 24h', render: (p) => <span className={p.adds_24h > 0 ? 'text-emerald-700 font-medium' : 'text-stone-400'}>{p.adds_24h ? fmtInt(p.adds_24h) : '·'}</span>, sort: (p) => p.adds_24h, align: 'right', desc: true },
    { key: 'adds_7d', header: '+7d', title: 'Adds across Sleeper, last 7 days', render: (p) => <span className={p.adds_7d > 0 ? 'text-emerald-700' : 'text-stone-400'}>{p.adds_7d ? fmtInt(p.adds_7d) : '·'}</span>, sort: (p) => p.adds_7d, align: 'right', desc: true },
    { key: 'drops_24h', header: '−24h', title: 'Drops across Sleeper, last 24h', render: (p) => <span className={p.drops_24h > 0 ? 'text-red-700' : 'text-stone-400'}>{p.drops_24h ? fmtInt(p.drops_24h) : '·'}</span>, sort: (p) => p.drops_24h, align: 'right', desc: true },
    {
      key: 'proj_week', header: `Wk ${opts.week} proj`, title: opts.espn ? "ESPN's projection for this week under this league's scoring" : 'Projected points this week (league scoring)',
      render: (p) => <span>{fmt(p.proj_week)}{opts.showRank && p.proj_week_rank ? <span className="ml-1 text-[10px] text-stone-400">{p.proj_week_rank}</span> : null}</span>,
      sort: (p) => p.proj_week, align: 'right', desc: true,
    },
    { key: 'proj_next', header: `Wk ${opts.week + 1} proj`, title: opts.espn ? "Sleeper's projection for next week, scored with this league's settings (ESPN only publishes the current week)" : 'Projected points next week', render: (p) => fmt(p.proj_next), sort: (p) => p.proj_next, align: 'right', desc: true },
    {
      key: 'proj_ros', header: 'ROS', title: opts.espn ? "ESPN's rest-of-season projection under this league's scoring (season projection minus points already scored)" : `Projected points, weeks ${opts.week}–${opts.rosEnd} (league scoring)`,
      render: (p) => <span className="font-medium">{fmt(p.proj_ros, 0)}{opts.showRank && p.proj_ros_rank ? <span className="ml-1 text-[10px] text-stone-400">{p.proj_ros_rank}</span> : null}</span>,
      sort: (p) => p.proj_ros, align: 'right', desc: true,
    },
    { key: 'last', header: 'Last', title: 'Points last week', render: (p) => fmt(p.last_week_pts), sort: (p) => p.last_week_pts, align: 'right', desc: true },
    { key: 'ppg', header: 'PPG', title: 'Points per game this season', render: (p) => <span>{fmt(p.season_ppg)}{p.season_gp ? <span className="ml-1 text-[10px] text-stone-400">{p.season_gp}g</span> : null}</span>, sort: (p) => p.season_ppg, align: 'right', desc: true },
    { key: 'prev', header: "'25 PPG", title: 'Points per game last season (league scoring)', render: (p) => <span className="text-stone-600">{fmt(p.prev_season_ppg)}{p.prev_season_gp ? <span className="ml-1 text-[10px] text-stone-400">{p.prev_season_gp}g</span> : null}</span>, sort: (p) => p.prev_season_ppg, align: 'right', desc: true },
  ]
  if (opts.vsMine) {
    cols.push({
      key: 'vs_mine', header: 'vs mine', title: 'Rest-of-season projection minus the weakest player you roster at this position (RB/WR/TE compare against your weakest flex-eligible player). Positive = an upgrade.',
      render: (p) => p.vs_mine == null ? <span className="text-stone-400">—</span> : <span className={p.vs_mine > 0 ? 'font-semibold text-emerald-700' : 'text-stone-400'}>{p.vs_mine > 0 ? '+' : ''}{fmt(p.vs_mine, 0)}</span>,
      sort: (p) => p.vs_mine, align: 'right', desc: true,
    })
  }
  if (opts.onPlan) {
    cols.push({
      key: 'plan', header: '', render: (p) => (
        <button onClick={() => opts.onPlan!(p)} className="rounded border border-stone-300 px-2 py-0.5 text-[11px] text-stone-700 hover:border-amber-400 hover:bg-amber-50">Plan</button>
      ), align: 'center',
    })
  }
  return cols
}

export default function Waivers() {
  const { leagueId, league, week, openPlan } = useApp()
  const { data, isLoading, error } = useQuery({
    queryKey: ['waivers', leagueId, week],
    queryFn: () => api.waivers(leagueId!, week),
    enabled: !!leagueId,
    staleTime: 60_000,
  })
  const [pos, setPos] = useState('ALL')
  const [search, setSearch] = useState('')
  const [hideOut, setHideOut] = useState(true)
  const [relevantOnly, setRelevantOnly] = useState(true)

  const rows = useMemo(() => {
    const all = data?.players ?? []
    const s = search.trim().toLowerCase()
    return all.filter((p) => {
      if (pos === 'FLEX' ? !['RB', 'WR', 'TE'].includes(p.position) : pos !== 'ALL' && p.position !== pos) return false
      if (hideOut && OUT_STATUSES.has(p.injury_status ?? '')) return false
      if (relevantOnly && !(p.owned >= 1 || p.adds_24h > 0 || (p.proj_week ?? 0) >= 2 || (p.proj_ros ?? 0) >= 20)) return false
      if (s && !(p.name.toLowerCase().includes(s) || (p.team ?? '').toLowerCase() === s)) return false
      return true
    })
  }, [data, pos, search, hideOut, relevantOnly])

  const columns = useMemo(() => playerColumns({
    week, rosEnd: data?.ros_end_week ?? 17, showRank: true, vsMine: true, espn: league?.platform === 'espn',
    onPlan: (p) => leagueId && openPlan({ leagueId, add: p }),
  }), [week, data?.ros_end_week, leagueId, openPlan, league?.platform])

  if (!league) return <Spinner />
  const t = league.my_team

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <h1 className="flex items-center gap-2 text-base font-semibold"><PlatformBadge platform={league.platform} />Waiver wire · {league.name}</h1>
        <div className="flex items-center gap-1.5 text-[12px] text-stone-600">
          <Chip tone="amber">{league.waiver.type}{league.waiver.type_code === 2 && t ? ` · $${t.faab_remaining} of $${league.waiver.budget} left` : ''}</Chip>
          {t?.waiver_position != null && <Chip>Waiver #{t.waiver_position}</Chip>}
          {league.waiver.daily ? <Chip title={league.waiver.days?.join(', ')}>Runs daily{league.waiver.hour != null ? ` · ${league.waiver.hour}:00` : ''}{league.waiver.clear_days ? ` · ${league.waiver.clear_days}d clear` : ''}</Chip>
            : league.waiver.day_of_week && <Chip>Runs {league.waiver.day_of_week}{league.waiver.clear_days ? ` · ${league.waiver.clear_days}d clear` : ''}</Chip>}
          {league.waiver.bid_min > 0 && <Chip>Min bid ${league.waiver.bid_min}</Chip>}
          <Chip>{league.scoring_format}{league.pass_td ? ` · ${league.pass_td}pt pass TD` : ''}</Chip>
        </div>
        <span className="ml-auto text-[12px] text-stone-500">{rows.length} of {data?.players.length ?? 0} free agents</span>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex rounded-md border border-stone-200 bg-white p-0.5">
          {POS_FILTERS.map((f) => (
            <button key={f} onClick={() => setPos(f)} className={`rounded px-2.5 py-1 text-[12px] ${pos === f ? 'bg-stone-900 text-white' : 'text-stone-700 hover:bg-stone-100'}`}>{f}</button>
          ))}
        </div>
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name or team…" className="w-56 rounded-md border border-stone-200 bg-white px-2.5 py-1 text-[12px]" />
        <label className="flex items-center gap-1.5 text-[12px] text-stone-700"><input type="checkbox" checked={hideOut} onChange={(e) => setHideOut(e.target.checked)} /> Hide Out / IR</label>
        <label className="flex items-center gap-1.5 text-[12px] text-stone-700" title="Hide players nobody rosters, adds, or projects"><input type="checkbox" checked={relevantOnly} onChange={(e) => setRelevantOnly(e.target.checked)} /> Relevant only</label>
      </div>

      {isLoading && <Spinner label="Building the waiver wire (projections, ownership, trends)…" />}
      {error && <ErrorBox error={error} />}
      {data && <DataTable rows={rows} columns={columns} rowKey={(p) => p.player_id} initialSort={{ key: 'owned', dir: 'desc' }} />}
    </div>
  )
}
