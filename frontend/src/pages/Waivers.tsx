import { useMemo, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, type ArticleDigest, type ArticleItem, type Movement, type Player, type Streamer, type Target } from '../api'
import { fmt, fmtInt, gameDayRowClass, OUT_STATUSES, pct, POS_ORDER, shortDate } from '../lib/format'
import { useApp } from '../components/AppContext'
import { Chip, ErrorBox, LeagueBar, PlatformBadge, PlayerCell, Pos, Spinner } from '../components/Badges'
import { DataTable, type Column } from '../components/DataTable'

/** "WR24" -> 24, for sorting; unranked players sink to the bottom. */
const ecrNum = (posRank: string | null | undefined): number =>
  posRank ? Number(posRank.replace(/\D/g, '')) || 9999 : 9999

const POS_FILTERS = ['ALL', 'QB', 'RB', 'WR', 'TE', 'FLEX', 'K', 'DEF']

/** Usage columns: last week's opportunity, which is what separates a real breakout from one
 * loud box score. Shared by the targets table and the browse table. */
function usageColumns(lastWeek: number): Column<Player>[] {
  return [
    {
      key: 'lw_snap_pct', header: 'Snap%', title: `Share of the team's offensive snaps in week ${lastWeek} — the clearest read on whether the role is real`,
      render: (p) => p.lw_snap_pct == null
        ? <span className="text-stone-300">·</span>
        : <span className={p.lw_snap_pct >= 0.7 ? 'font-semibold text-emerald-700' : p.lw_snap_pct >= 0.45 ? 'text-stone-700' : 'text-stone-400'}>{Math.round(p.lw_snap_pct * 100)}%</span>,
      sort: (p) => p.lw_snap_pct, align: 'right', desc: true,
    },
    {
      key: 'lw_targets', header: 'Tgt', title: `Times targeted in the passing game in week ${lastWeek}`,
      render: (p) => p.lw_targets ? <span className="font-medium text-sky-800">{p.lw_targets}</span> : <span className="text-stone-300">·</span>,
      sort: (p) => p.lw_targets, align: 'right', desc: true,
    },
    {
      key: 'lw_carries', header: 'Car', title: `Rushing attempts in week ${lastWeek}`,
      render: (p) => p.lw_carries ? <span className="font-medium text-amber-800">{p.lw_carries}</span> : <span className="text-stone-300">·</span>,
      sort: (p) => p.lw_carries, align: 'right', desc: true,
    },
    {
      key: 'last_week_pts', header: `Wk ${lastWeek}`, title: `Fantasy points scored in week ${lastWeek} under this league's scoring`,
      render: (p) => p.last_week_pts == null
        ? <span className="text-stone-300">·</span>
        : <span className={p.last_week_pts >= 15 ? 'font-semibold text-emerald-700' : ''}>{fmt(p.last_week_pts)}</span>,
      sort: (p) => p.last_week_pts, align: 'right', desc: true,
    },
  ]
}

/** Shared column set for the two player tables, which ask different questions.
 * `waiver` is "should I pick this up" — ownership and add velocity matter.
 * `lineup` is "should I start this" — they are already mine, so the market says nothing.
 * Backward-looking scoring (last week, PPG, last season) lives in the player drawer, which
 * carries the full per-week game log for both seasons. */
export function playerColumns(opts: { week: number; rosEnd: number; onPlan?: (p: Player) => void; showRank?: boolean; vsMine?: boolean; espn?: boolean; fp?: boolean; fpWaiver?: boolean; usage?: number; variant?: 'waiver' | 'lineup' }): Column<Player>[] {
  const market = (opts.variant ?? 'waiver') === 'waiver'
  const cols: Column<Player>[] = [
    {
      key: 'name', header: 'Player',
      render: (p) => (
        <span className="inline-flex items-center gap-1.5">
          <PlayerCell p={p} />
          {opts.fpWaiver && p.fp_waiver_rank != null && (
            <span
              title={`FantasyPros waiver wire #${p.fp_waiver_rank}${p.fp_waiver_pos_rank ? ` (${p.fp_waiver_pos_rank})` : ''} — a shortlist of ~50 pickups`}
              className="rounded bg-violet-100 px-1 py-0.5 text-[9.5px] font-bold leading-none text-violet-800"
            >FP</span>
          )}
        </span>
      ),
      sort: (p) => p.name,
    },
    { key: 'pos', header: 'Pos', render: (p) => <Pos pos={p.position} />, sort: (p) => POS_ORDER.indexOf(p.position), align: 'center' },
    { key: 'opp', header: `Wk ${opts.week} opp`, title: 'Opponent this week', render: (p) => <span className={p.on_bye ? 'text-stone-400' : ''}>{p.on_bye ? 'BYE' : p.opponent ?? '—'}</span>, sort: (p) => p.opponent },
    { key: 'bye', header: 'Bye', render: (p) => <span className={p.bye_week === opts.week ? 'font-semibold text-red-700' : 'text-stone-500'}>{p.bye_week ?? '—'}</span>, sort: (p) => p.bye_week, align: 'center' },
    { key: 'depth', header: 'Dep', title: 'Depth chart order at position', render: (p) => <span className="text-stone-600">{p.depth_chart_position ? `${p.depth_chart_position}${p.depth_chart_order ?? ''}` : '—'}</span>, sort: (p) => p.depth_chart_order, align: 'center' },
    ...(opts.usage ? usageColumns(opts.usage) : []),
    ...(market ? [{
      key: 'owned', header: 'Own%', title: 'Percent of Sleeper leagues where this player is rostered, and where they are started',
      render: (p: Player) => (
        <span>{pct(p.owned)}<span className="ml-1 text-[10px] text-stone-400">{pct(p.started)}</span></span>
      ),
      sort: (p: Player) => p.owned, align: 'right' as const, desc: true,
    }] : []),
    ...(opts.fpWaiver ? [
      {
        key: 'fp_waiver', header: 'FP wvr', title: 'Rank on the FantasyPros waiver-wire list (4 experts, ~50 players). Blank means they did not make the list.',
        render: (p: Player) => p.fp_waiver_rank == null
          ? <span className="text-stone-300">·</span>
          : <span className="font-semibold text-violet-800">{p.fp_waiver_rank}<span className="ml-1 text-[10px] font-normal text-violet-500">{p.fp_waiver_pos_rank}</span></span>,
        sort: (p: Player) => p.fp_waiver_rank ?? 9999, align: 'right' as const,
      },
    ] : []),
    ...(opts.fp ? [
      {
        key: 'fp_ecr', header: 'ECR', title: 'FantasyPros weekly expert consensus rank within position (~80 experts). The number after it is how much the experts disagree — bigger means less consensus.',
        render: (p: Player) => !p.fp_pos_rank
          ? <span className="text-stone-300">·</span>
          : <span>{p.fp_pos_rank}{p.fp_rank_std != null && <span className="ml-1 text-[10px] text-stone-400">±{fmt(p.fp_rank_std, 0)}</span>}</span>,
        sort: (p: Player) => ecrNum(p.fp_pos_rank), align: 'right' as const,
      },
    ] : []),
    ...(opts.espn ? [
      { key: 'owned_change', header: 'Own Δ', title: 'ESPN ownership change (percentage points)', render: (p: Player) => p.owned_change == null ? <span className="text-stone-400">·</span> : <span className={p.owned_change > 0 ? 'text-emerald-700' : p.owned_change < 0 ? 'text-red-700' : 'text-stone-400'}>{p.owned_change > 0 ? '+' : ''}{fmt(p.owned_change)}</span>, sort: (p: Player) => p.owned_change, align: 'right' as const, desc: true },
      { key: 'platform_status', header: 'Avail', title: 'ESPN availability: free agent, or on waivers until the shown time', render: (p: Player) => p.platform_status === 'WAIVERS' ? <span className="text-amber-700" title={p.waiver_until ? `On waivers until ${shortDate(p.waiver_until)}` : 'On waivers'}>Waivers{p.waiver_until ? ` · ${shortDate(p.waiver_until)}` : ''}</span> : p.platform_status === 'FREEAGENT' ? <span className="text-emerald-700">FA</span> : <span className="text-stone-400">—</span>, sort: (p: Player) => p.platform_status === 'FREEAGENT' ? 0 : p.platform_status === 'WAIVERS' ? 1 : 2 },
    ] : []),
    ...(market ? [{
      key: 'adds_24h', header: '+24h', title: 'Adds across Sleeper, last 24h.',
      render: (p: Player) => <span className={p.adds_24h > 0 ? 'text-emerald-700 font-medium' : 'text-stone-400'}>{p.adds_24h ? fmtInt(p.adds_24h) : '·'}</span>,
      sort: (p: Player) => p.adds_24h, align: 'right' as const, desc: true,
    }] : []),
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

/** Each panel answers one question, so it carries only the columns that answer it. Everything a
 * player is doing elsewhere is a click away in the drawer; repeating all of it in all four panels
 * is what made the page a scroll. Identity (name, position, opponent) is the only shared spine. */
function panelColumns(kind: 'fp' | 'points' | 'usage' | 'move', opts: { week: number; lastWeek: number; move?: Movement['kind']; onPlan?: (p: Player) => void }): Column<Target>[] {
  const identity: Column<Target>[] = [
    { key: 'name', header: 'Player', render: (t) => <PlayerCell p={t} />, sort: (t) => t.name },
    { key: 'pos', header: 'Pos', render: (t) => <Pos pos={t.position} />, sort: (t) => POS_ORDER.indexOf(t.position), align: 'center' },
    { key: 'opp', header: `Wk ${opts.week}`, title: 'Opponent the week you are claiming into', render: (t) => <span className={t.on_bye ? 'text-stone-400' : ''}>{t.on_bye ? 'BYE' : t.opponent ?? '—'}</span>, sort: (t) => t.opponent },
  ]
  const num = (v: number | null | undefined, cls = '') =>
    v == null ? <span className="text-stone-300">·</span> : <span className={cls}>{v}</span>

  let lead: Column<Target>[] = []
  if (kind === 'fp') {
    lead = [{
      key: 'fp_waiver', header: 'FP', title: "Rank on FantasyPros' waiver-wire shortlist (10 experts, ~50 players)",
      render: (t) => t.fp_waiver_rank == null ? <span className="text-stone-300">·</span>
        : <span className="font-semibold text-violet-800">{t.fp_waiver_rank}<span className="ml-1 text-[10px] font-normal text-violet-500">{t.fp_waiver_pos_rank}</span></span>,
      sort: (t) => t.fp_waiver_rank ?? 9999, align: 'right',
    }]
  } else if (kind === 'points') {
    lead = [{
      key: 'last_week_pts', header: `Wk ${opts.lastWeek}`, title: `Fantasy points scored in week ${opts.lastWeek}, in this league's scoring`,
      render: (t) => t.last_week_pts == null ? <span className="text-stone-300">·</span>
        : <span className={t.last_week_pts >= 15 ? 'font-semibold text-emerald-700' : ''}>{fmt(t.last_week_pts)}</span>,
      sort: (t) => t.last_week_pts, align: 'right', desc: true,
    }]
  } else if (kind === 'usage') {
    lead = [
      {
        key: 'lw_snap_pct', header: 'Snap%', title: `Share of the team's offensive snaps in week ${opts.lastWeek}`,
        render: (t) => t.lw_snap_pct == null ? <span className="text-stone-300">·</span>
          : <span className={t.lw_snap_pct >= 0.7 ? 'font-semibold text-emerald-700' : 'text-stone-600'}>{Math.round(t.lw_snap_pct * 100)}%</span>,
        sort: (t) => t.lw_snap_pct, align: 'right', desc: true,
      },
      { key: 'lw_targets', header: 'Tgt', title: `Times targeted in week ${opts.lastWeek}`, render: (t) => num(t.lw_targets, 'font-medium text-sky-800'), sort: (t) => t.lw_targets, align: 'right', desc: true },
      { key: 'lw_carries', header: 'Car', title: `Rushing attempts in week ${opts.lastWeek}`, render: (t) => num(t.lw_carries, 'font-medium text-amber-800'), sort: (t) => t.lw_carries, align: 'right', desc: true },
    ]
  } else if (opts.move === 'sleeper') {
    lead = [
      { key: 'adds_24h', header: 'Adds', title: 'Added across all Sleeper leagues in the last 24 hours', render: (t) => t.adds_24h ? <span className="font-semibold text-emerald-700">{fmtInt(t.adds_24h)}</span> : <span className="text-stone-300">·</span>, sort: (t) => t.adds_24h, align: 'right', desc: true },
      { key: 'drops_24h', header: 'Drops', title: 'Dropped across all Sleeper leagues in the last 24 hours', render: (t) => t.drops_24h ? <span className="text-red-700">{fmtInt(t.drops_24h)}</span> : <span className="text-stone-300">·</span>, sort: (t) => t.drops_24h, align: 'right', desc: true },
    ]
  } else if (opts.move === 'espn') {
    lead = [
      { key: 'owned_change', header: 'Own Δ', title: 'Change in the percentage of ESPN teams rostering this player', render: (t) => t.owned_change == null ? <span className="text-stone-300">·</span> : <span className={t.owned_change > 0 ? 'font-semibold text-emerald-700' : 'text-red-700'}>{t.owned_change > 0 ? '+' : ''}{fmt(t.owned_change)}</span>, sort: (t) => t.owned_change, align: 'right', desc: true },
      { key: 'owned', header: 'Own%', title: 'Percent of ESPN teams rostering this player now', render: (t) => pct(t.owned), sort: (t) => t.owned, align: 'right', desc: true },
    ]
  } else {
    lead = [
      { key: 'adds', header: 'Adds', title: 'Added across all Yahoo leagues, from its Transaction Trends page', render: (t) => t.adds ? <span className="font-semibold text-emerald-700">{fmtInt(t.adds)}</span> : <span className="text-stone-300">·</span>, sort: (t) => t.adds, align: 'right', desc: true },
      { key: 'drops', header: 'Drops', title: 'Dropped across all Yahoo leagues', render: (t) => t.drops ? <span className="text-red-700">{fmtInt(t.drops)}</span> : <span className="text-stone-300">·</span>, sort: (t) => t.drops, align: 'right', desc: true },
    ]
  }

  const cols = [...lead, ...identity]
  if (opts.onPlan) {
    cols.push({
      key: 'plan', header: '', render: (t) => (
        <button onClick={() => opts.onPlan!(t)} className="rounded border border-stone-300 px-1.5 py-0.5 text-[10px] text-stone-700 hover:border-amber-400 hover:bg-amber-50">+</button>
      ), align: 'center',
    })
  }
  return cols
}

/** One ranked panel. The table scrolls inside a fixed height so four panels stay on one screen
 * instead of turning the page into a column of tables. */
function Panel({ title, blurb, rows, columns, sortKey, empty, control }: {
  title: string; blurb: string; rows: Target[]; columns: Column<Target>[]; sortKey: string; empty: string
  control?: ReactNode
}) {
  return (
    <section className="flex min-w-0 flex-col rounded-md border border-stone-200 bg-white">
      <div className="border-b border-stone-200 px-3 py-2">
        <div className="flex items-center gap-2">
          <h2 className="text-[12.5px] font-semibold text-stone-800">{title} <span className="ml-0.5 text-[11px] font-normal text-stone-400">{rows.length}</span></h2>
          {control && <span className="ml-auto">{control}</span>}
        </div>
        <p className="mt-0.5 text-[11px] leading-snug text-stone-500">{blurb}</p>
      </div>
      {rows.length === 0
        ? <p className="px-3 py-2 text-[12px] text-stone-500">{empty}</p>
        : (
          <div className="max-h-[22rem] overflow-y-auto">
            <DataTable rows={rows} columns={columns} rowKey={(t) => t.player_id} initialSort={{ key: sortKey, dir: sortKey === 'fp_waiver' ? 'asc' : 'desc' }} rowClass={gameDayRowClass} />
          </div>
        )}
    </section>
  )
}

/** This week's waiver columns, summarised. Deliberately separate from the ranked table: that
 * table is numbers, this is somebody's opinion, and mixing the two makes it unclear which is
 * which. Sell/hold calls are commentary rather than claims, so they sit in their own group. */
function ArticleBlock({ digest }: { digest: ArticleDigest }) {
  const adds = digest.items.filter((i) => i.action === 'add' || i.action === 'buy')
  const other = digest.items.filter((i) => i.action === 'sell' || i.action === 'hold')

  const Item = ({ i }: { i: ArticleItem }) => (
    <li className="flex gap-2 leading-snug">
      <span className={`mt-[7px] h-1 w-1 shrink-0 rounded-full ${i.action === 'sell' ? 'bg-red-400' : 'bg-amber-500'}`} />
      <span>
        <span className="font-semibold text-stone-800">{i.name}</span>
        <span className="ml-1 text-[11px] text-stone-500">{i.position}{i.team ? ` · ${i.team}` : ''}</span>
        {i.action === 'buy' && <span className="ml-1.5 rounded bg-sky-100 px-1 py-0.5 text-[9.5px] font-bold leading-none text-sky-800">BUY LOW</span>}
        {i.action === 'sell' && <span className="ml-1.5 rounded bg-red-100 px-1 py-0.5 text-[9.5px] font-bold leading-none text-red-800">SELL HIGH</span>}
        {i.action === 'hold' && <span className="ml-1.5 rounded bg-stone-100 px-1 py-0.5 text-[9.5px] font-bold leading-none text-stone-600">HOLD</span>}
        {i.faab && <span className="ml-1.5 rounded bg-emerald-100 px-1 py-0.5 text-[9.5px] font-bold leading-none text-emerald-800">{i.faab} FAAB</span>}
        {i.priority === 'low' && <span className="ml-1.5 text-[10px] text-stone-400">low priority</span>}
        {i.note && <span className="text-stone-600"> — {i.note}</span>}
        <span className="ml-1 text-[10px] text-stone-400">({i.sources.join(', ')})</span>
      </span>
    </li>
  )

  return (
    <aside className="w-full shrink-0 self-start rounded-md border border-amber-200 bg-amber-50/50 lg:sticky lg:top-3 lg:max-h-[calc(100vh-2rem)] lg:w-80 lg:overflow-y-auto xl:w-96">
      <div className="border-b border-amber-200 px-3 py-2">
        <h2 className="text-[13px] font-semibold text-stone-800">What the columns say</h2>
        <p className="mt-0.5 text-[11px] text-stone-500">
          Week {digest.week} · {digest.sources.map((src, n) => (
            <span key={src.id}>{n > 0 && ' · '}<a href={src.url} target="_blank" rel="noreferrer" className="underline decoration-dotted hover:text-amber-900">{src.name}</a>{src.partial && <span title={src.partial_note ?? 'Partly paywalled'}> (partial)</span>}</span>
          ))}
        </p>
      </div>
      <div className="space-y-3 px-3 py-2.5">
        <ul className="space-y-2 text-[12px]">{adds.map((i) => <Item key={i.name} i={i} />)}</ul>
        {other.length > 0 && (
          <ul className="space-y-2 border-t border-amber-200 pt-2.5 text-[12px]">{other.map((i) => <Item key={i.name} i={i} />)}</ul>
        )}
        <p className="border-t border-amber-200 pt-2 text-[11px] text-stone-500">Opinion — not part of the ranking, which is numbers only.</p>
      </div>
    </aside>
  )
}

type Tab = 'targets' | 'browse'

export default function Waivers() {
  const { leagueId, league, week, openPlan } = useApp()
  // Deliberately not keyed on the app's week selector: a waiver claim always processes into the
  // *upcoming* week, so the server decides which week that is rather than the lineup-view week.
  const { data, isLoading, error } = useQuery({
    queryKey: ['waivers', leagueId],
    queryFn: () => api.waivers(leagueId!),
    enabled: !!leagueId,
    staleTime: 60_000,
  })
  const [tab, setTab] = useState<Tab>('targets')
  const [pos, setPos] = useState('ALL')
  const [search, setSearch] = useState('')
  const [hideOut, setHideOut] = useState(false)
  const [relevantOnly, setRelevantOnly] = useState(true)
  const [fpOnly, setFpOnly] = useState(false)
  // The points panel filters itself. Quarterbacks out-score everyone on raw points, so an
  // unfiltered list is a list of quarterbacks; FLEX is the default because that is the pool you
  // are usually shopping in. It overrides the page filter for this panel only.
  const [ptsPos, setPtsPos] = useState('FLEX')

  // The week claims process into, and the week whose box score we are reading.
  const targetWeek = data?.week ?? week
  const lastWeek = Math.max(1, targetWeek - 1)

  const { rows, outCount, fpCount } = useMemo(() => {
    const s = search.trim().toLowerCase()
    const matched = (data?.players ?? []).filter((p) => {
      if (pos === 'FLEX' ? !['RB', 'WR', 'TE'].includes(p.position) : pos !== 'ALL' && p.position !== pos) return false
      if (fpOnly && p.fp_waiver_rank == null) return false
      if (relevantOnly && !(p.owned >= 1 || p.adds_24h > 0 || (p.proj_week ?? 0) >= 2 || (p.proj_ros ?? 0) >= 20)) return false
      if (s && !(p.name.toLowerCase().includes(s) || (p.team ?? '').toLowerCase() === s)) return false
      return true
    })
    const isOut = (p: Player) => OUT_STATUSES.has(p.injury_status ?? '')
    // outCount is reported whether or not the filter is on, so it always reads as "this many
    // players the Out / IR toggle decides the fate of" rather than appearing only once they vanish.
    return {
      rows: hideOut ? matched.filter((p) => !isOut(p)) : matched,
      outCount: matched.filter(isOut).length,
      fpCount: (data?.players ?? []).filter((p) => p.fp_waiver_rank != null).length,
    }
  }, [data, pos, search, hideOut, relevantOnly, fpOnly])

  // The same filters apply to all three panels, so a position filter narrows every read at once.
  const panels = useMemo(() => {
    const q = search.trim().toLowerCase()
    const keep = (t: Target) => {
      if (pos === 'FLEX' ? !['RB', 'WR', 'TE'].includes(t.position) : pos !== 'ALL' && t.position !== pos) return false
      if (hideOut && OUT_STATUSES.has(t.injury_status ?? '')) return false
      if (q && !(t.name.toLowerCase().includes(q) || (t.team ?? '').toLowerCase() === q)) return false
      return true
    }
    return {
      fp: (data?.by_fantasypros ?? []).filter(keep),
      points: (data?.by_points ?? []).filter((t) => {
        if (ptsPos === 'FLEX' ? !['RB', 'WR', 'TE'].includes(t.position) : ptsPos !== 'ALL' && t.position !== ptsPos) return false
        if (hideOut && OUT_STATUSES.has(t.injury_status ?? '')) return false
        if (q && !(t.name.toLowerCase().includes(q) || (t.team ?? '').toLowerCase() === q)) return false
        return true
      }),
      usage: (data?.by_usage ?? []).filter(keep),
      trending: (data?.by_trending ?? []).filter(keep),
    }
  }, [data, pos, search, hideOut, ptsPos])

  const browseColumns = useMemo(() => playerColumns({
    week: targetWeek, rosEnd: data?.ros_end_week ?? 17, showRank: true, vsMine: true, espn: league?.platform === 'espn', fp: true, fpWaiver: true, usage: lastWeek,
    onPlan: (p) => leagueId && openPlan({ leagueId, add: p }),
  }), [targetWeek, lastWeek, data?.ros_end_week, leagueId, openPlan, league?.platform])

  const colOpts = useMemo(() => ({
    week: targetWeek, lastWeek, onPlan: (p: Player) => leagueId && openPlan({ leagueId, add: p }),
  }), [targetWeek, lastWeek, leagueId, openPlan])
  const fpCols = useMemo(() => panelColumns('fp', colOpts), [colOpts])
  const ptsCols = useMemo(() => panelColumns('points', colOpts), [colOpts])
  const useCols = useMemo(() => panelColumns('usage', colOpts), [colOpts])
  const moveCols = useMemo(() => panelColumns('move', { ...colOpts, move: data?.movement?.kind }), [colOpts, data?.movement?.kind])

  if (!league) return <Spinner />
  const t = league.my_team
  const onPlan = (p: Player) => leagueId && openPlan({ leagueId, add: p })

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <h1 className="flex items-stretch gap-2 text-base font-semibold">
          <LeagueBar leagueId={league.league_id} />
          <span className="flex items-center gap-2"><PlatformBadge platform={league.platform} />Waiver wire · {league.name}</span>
        </h1>
        <div className="flex items-center gap-1.5 text-[12px] text-stone-600">
          <Chip tone="amber">{league.waiver.type}{league.waiver.type_code === 2 && t ? ` · $${t.faab_remaining} of $${league.waiver.budget} left` : ''}</Chip>
          {league.waiver.daily ? <Chip title={league.waiver.days?.join(', ')}>Runs daily{league.waiver.hour != null ? ` · ${league.waiver.hour}:00` : ''}{league.waiver.clear_days ? ` · ${league.waiver.clear_days}d clear` : ''}</Chip>
            : league.waiver.day_of_week && <Chip>Runs {league.waiver.day_of_week}{league.waiver.clear_days ? ` · ${league.waiver.clear_days}d clear` : ''}</Chip>}
          {league.waiver.bid_min > 0 && <Chip>Min bid ${league.waiver.bid_min}</Chip>}
          <Chip>{league.scoring_format}{league.pass_td ? ` · ${league.pass_td}pt pass TD` : ''}</Chip>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex rounded-md border border-stone-200 bg-white p-0.5">
          {([['targets', 'Claim targets'], ['browse', 'Browse all']] as [Tab, string][]).map(([k, label]) => (
            <button key={k} onClick={() => setTab(k)} className={`rounded px-3 py-1 text-[12px] ${tab === k ? 'bg-stone-900 text-white' : 'text-stone-700 hover:bg-stone-100'}`}>{label}</button>
          ))}
        </div>
        {(
          <>
            <div className="flex rounded-md border border-stone-200 bg-white p-0.5">
              {POS_FILTERS.map((f) => (
                <button key={f} onClick={() => setPos(f)} className={`rounded px-2.5 py-1 text-[12px] ${pos === f ? 'bg-stone-900 text-white' : 'text-stone-700 hover:bg-stone-100'}`}>{f}</button>
              ))}
            </div>
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name or team…" className="w-56 rounded-md border border-stone-200 bg-white px-2.5 py-1 text-[12px]" />
            <label className="flex items-center gap-1.5 text-[12px] text-stone-700"><input type="checkbox" checked={hideOut} onChange={(e) => setHideOut(e.target.checked)} /> Hide Out / IR{outCount > 0 && <span className={hideOut ? 'text-amber-700' : 'text-stone-400'}>({hideOut ? `${outCount} hidden` : outCount})</span>}</label>
          </>
        )}
        {tab === 'browse' && (
          <>
            <label className="flex items-center gap-1.5 text-[12px] text-stone-700" title="Hide players nobody rosters, adds, or projects"><input type="checkbox" checked={relevantOnly} onChange={(e) => setRelevantOnly(e.target.checked)} /> Relevant only</label>
            <label className="flex items-center gap-1.5 text-[12px] text-stone-700" title="Only players on the FantasyPros waiver-wire list"><input type="checkbox" checked={fpOnly} onChange={(e) => setFpOnly(e.target.checked)} /> <span className="rounded bg-violet-100 px-1 py-0.5 text-[9.5px] font-bold leading-none text-violet-800">FP</span> picks{fpCount > 0 && <span className="text-stone-400">({fpCount})</span>}</label>
          </>
        )}
        <span className="ml-auto text-[12px] text-stone-500">
          {tab === 'targets' ? `Week ${targetWeek} claims` : `${rows.length} of ${data?.players.length ?? 0} free agents`}
        </span>
      </div>

      {isLoading && <Spinner label="Building the waiver wire (projections, usage, lines)…" />}
      {error && <ErrorBox error={error} />}

      {data && tab === 'targets' && (
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start">
          <div className="grid min-w-0 flex-1 gap-3 xl:grid-cols-2">
            <Panel
              title="FantasyPros waiver list" sortKey="fp_waiver" rows={panels.fp} columns={fpCols}
              blurb={`Their week ${targetWeek} shortlist, in their order — 10 experts, and the only forward-looking read here.`}
              empty="Nobody available is on this week's FantasyPros waiver list."
            />
            <Panel
              title={`Week ${lastWeek} points`} sortKey="last_week_pts" rows={panels.points} columns={ptsCols}
              blurb={`What they actually scored, in this league's scoring. Quarterbacks out-score every other position on raw points, so this panel filters itself.`}
              empty={`Nobody available scored in week ${lastWeek}${ptsPos === 'ALL' ? '' : ` at ${ptsPos}`}.`}
              control={
                <select
                  value={ptsPos} onChange={(e) => setPtsPos(e.target.value)}
                  title="Position shown in this panel only"
                  className="rounded border border-stone-200 bg-white px-1.5 py-0.5 text-[11px] text-stone-700"
                >
                  {POS_FILTERS.map((f) => <option key={f} value={f}>{f}</option>)}
                </select>
              }
            />
            <Panel
              title="Snap share and volume" sortKey="lw_snap_pct" rows={panels.usage} columns={useCols}
              blurb={`Ranked on week ${lastWeek} snap share first, then volume — targets for receivers and tight ends, carries for backs. Snaps say whether he is on the field at all; volume says whether they are using him. No quarterbacks.`}
              empty="No usage recorded for available players last week."
            />
            {data.movement && data.by_trending && (
              <Panel
                title={data.movement.label} sortKey={data.movement.kind === 'sleeper' ? 'adds_24h' : data.movement.kind === 'espn' ? 'owned_change' : 'adds'}
                rows={panels.trending} columns={moveCols} blurb={data.movement.blurb}
                empty="Nothing is moving in this league's pool."
              />
            )}
          </div>
          {data.articles && <ArticleBlock digest={data.articles} />}
        </div>
      )}

      {data && tab === 'browse' && (
        <DataTable rows={rows} columns={browseColumns} rowKey={(p) => p.player_id} initialSort={{ key: 'owned', dir: 'desc' }} rowClass={gameDayRowClass} />
      )}
    </div>
  )
}
