import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, type ArticleDigest, type ArticleItem, type Player, type Streamer, type Target, type Tier } from '../api'
import { fmt, fmtInt, gameDayRowClass, OUT_STATUSES, pct, POS_ORDER, shortDate } from '../lib/format'
import { useApp } from '../components/AppContext'
import { Chip, ErrorBox, LeagueBar, PlatformBadge, PlayerCell, Pos, Spinner } from '../components/Badges'
import { DataTable, type Column } from '../components/DataTable'

/** "WR24" -> 24, for sorting; unranked players sink to the bottom. */
const ecrNum = (posRank: string | null | undefined): number =>
  posRank ? Number(posRank.replace(/\D/g, '')) || 9999 : 9999

const POS_FILTERS = ['ALL', 'QB', 'RB', 'WR', 'TE', 'FLEX', 'K', 'DEF']

const TIER_STYLE: Record<Tier, string> = {
  A: 'bg-emerald-600 text-white',
  B: 'bg-emerald-100 text-emerald-900',
  C: 'bg-stone-100 text-stone-700',
  D: 'bg-stone-50 text-stone-500',
}

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
      key: 'adds_24h', header: '+24h', title: 'Adds across Sleeper, last 24h. Longer windows and drops live on the Trends page.',
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

/** The claim list: who to put a bid in on, and for how much. */
function targetColumns(opts: { week: number; lastWeek: number; usesFaab: boolean; onPlan?: (p: Player) => void }): Column<Target>[] {
  const cols: Column<Target>[] = [
    { key: 'rank', header: '#', render: (t) => <span className="text-[11px] tabular-nums text-stone-400">{t.rank}</span>, sort: (t) => t.rank, align: 'right' },
    {
      key: 'tier', header: 'Tier', title: 'Priority: A is a claim worth real money, D is a speculative stash',
      render: (t) => <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold leading-none ${TIER_STYLE[t.tier]}`} title={t.tier_label}>{t.tier}</span>,
      sort: (t) => t.tier, align: 'center',
    },
    {
      key: 'name', header: 'Player', render: (t) => <PlayerCell p={t} />, sort: (t) => t.name,
    },
    { key: 'pos', header: 'Pos', render: (t) => <Pos pos={t.position} />, sort: (t) => POS_ORDER.indexOf(t.position), align: 'center' },
    { key: 'opp', header: `Wk ${opts.week}`, title: 'Opponent the week you are claiming into', render: (t) => <span className={t.on_bye ? 'text-stone-400' : ''}>{t.on_bye ? 'BYE' : t.opponent ?? '—'}</span>, sort: (t) => t.opponent },
  ]
  if (opts.usesFaab) {
    cols.push({
      key: 'bid', header: 'Bid', title: 'Recommended FAAB out of what you have left. The range is min viable → walk-away price; the bold number is what to actually enter.',
      render: (t) => {
        if (!t.bid) return <span className="text-stone-400">—</span>
        if (t.bid.note) return <span className="text-stone-400" title={t.bid.note}>—</span>
        return (
          <span className="whitespace-nowrap">
            <span className="font-bold text-emerald-800">${t.bid.rec}</span>
            <span className="ml-1 text-[10px] text-stone-400">${t.bid.min}–{t.bid.max}</span>
          </span>
        )
      },
      sort: (t) => t.bid?.rec ?? -1, align: 'right', desc: true,
    })
  }
  cols.push(
    {
      key: 'fp_waiver', header: 'FP rank', title: "FantasyPros' waiver-wire rank — a shortlist of ~50 players their experts think are worth adding at all. This is half the ranking; a dot means they did not make the list.",
      render: (t) => t.fp_waiver_rank == null
        ? <span className="text-stone-300">·</span>
        : <span className="font-semibold text-violet-800">{t.fp_waiver_rank}<span className="ml-1 text-[10px] font-normal text-violet-500">{t.fp_waiver_pos_rank}</span></span>,
      sort: (t) => t.fp_waiver_rank ?? 9999, align: 'right',
    },
    ...(usageColumns(opts.lastWeek) as unknown as Column<Target>[]),
    {
      key: 'proj_week', header: `Wk ${opts.week} proj`, title: `Projected points for week ${opts.week}, under this league's scoring`,
      render: (t) => fmt(t.proj_week), sort: (t) => t.proj_week, align: 'right', desc: true,
    },
    { key: 'owned', header: 'Own%', title: 'Percent of Sleeper leagues rostering this player', render: (t) => pct(t.owned), sort: (t) => t.owned, align: 'right', desc: true },
  )
  if (opts.onPlan) {
    cols.push({
      key: 'plan', header: '', render: (t) => (
        <button onClick={() => opts.onPlan!(t)} className="rounded border border-stone-300 px-2 py-0.5 text-[11px] text-stone-700 hover:border-amber-400 hover:bg-amber-50">Plan</button>
      ), align: 'center',
    })
  }
  return cols
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

type Tab = 'targets' | 'stream' | 'browse'

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

  const targetRows = useMemo(() => {
    const s = search.trim().toLowerCase()
    return (data?.targets ?? []).filter((t) => {
      if (pos === 'FLEX' ? !['RB', 'WR', 'TE'].includes(t.position) : pos !== 'ALL' && t.position !== pos) return false
      if (hideOut && OUT_STATUSES.has(t.injury_status ?? '')) return false
      if (s && !(t.name.toLowerCase().includes(s) || (t.team ?? '').toLowerCase() === s)) return false
      return true
    })
  }, [data, pos, search, hideOut])

  const browseColumns = useMemo(() => playerColumns({
    week: targetWeek, rosEnd: data?.ros_end_week ?? 17, showRank: true, vsMine: true, espn: league?.platform === 'espn', fp: true, fpWaiver: true, usage: lastWeek,
    onPlan: (p) => leagueId && openPlan({ leagueId, add: p }),
  }), [targetWeek, lastWeek, data?.ros_end_week, leagueId, openPlan, league?.platform])

  const tgtColumns = useMemo(() => targetColumns({
    week: targetWeek, lastWeek, usesFaab: data?.faab.uses_faab ?? false,
    onPlan: (p) => leagueId && openPlan({ leagueId, add: p }),
  }), [targetWeek, lastWeek, data?.faab.uses_faab, leagueId, openPlan])

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
          {([['targets', 'Claim targets'], ['stream', 'Streaming K/DST'], ['browse', 'Browse all']] as [Tab, string][]).map(([k, label]) => (
            <button key={k} onClick={() => setTab(k)} className={`rounded px-3 py-1 text-[12px] ${tab === k ? 'bg-stone-900 text-white' : 'text-stone-700 hover:bg-stone-100'}`}>{label}</button>
          ))}
        </div>
        {tab !== 'stream' && (
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
          {tab === 'targets' ? `${targetRows.length} ranked for week ${targetWeek}`
            : tab === 'browse' ? `${rows.length} of ${data?.players.length ?? 0} free agents`
              : `Weeks ${data?.stream_weeks?.join(', ') ?? targetWeek}`}
        </span>
      </div>

      {isLoading && <Spinner label="Building the waiver wire (projections, usage, lines)…" />}
      {error && <ErrorBox error={error} />}

      {data && tab === 'targets' && (
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start">
          <div className="min-w-0 flex-1 space-y-2">
            <p className="text-[12px] text-stone-500">
              Ranked for <span className="font-medium text-stone-700">week {targetWeek}</span> on FantasyPros' waiver rank, plus week {lastWeek} points, snap share and volume — targets for a receiver, carries for a back. The last three are ranked against others at the same position.
              {data.faab.uses_faab && <> Bids are out of your <span className="font-medium text-stone-700">${data.faab.remaining}</span> remaining.</>}
            </p>
            <DataTable rows={targetRows} columns={tgtColumns} rowKey={(t) => t.player_id} initialSort={{ key: 'rank', dir: 'asc' }} rowClass={gameDayRowClass} />
          </div>
          {data.articles && <ArticleBlock digest={data.articles} />}
        </div>
      )}

      {data && tab === 'stream' && (
        <div className="space-y-4">
          <p className="text-[12px] text-stone-500">
            K and D/ST are matchup plays, so these rank on Vegas implied totals rather than season value — a defense against an offense projected to score little, a kicker on an offense projected to score a lot.
            Looking ahead {data.stream_weeks.length} weeks lets you claim a good matchup before someone else does.
          </p>
          {(['DEF', 'K'] as const).map((p) => (
            <div key={p} className="space-y-2">
              <h2 className="text-[13px] font-semibold text-stone-800">{p === 'DEF' ? 'Defense / Special teams' : 'Kickers'}</h2>
              <div className="grid gap-3 lg:grid-cols-3">
                {(data.streamers[p] ?? []).map((w) => (
                  <StreamTable key={w.week} pos={p} week={w.week} players={w.players} onPlan={onPlan} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {data && tab === 'browse' && (
        <DataTable rows={rows} columns={browseColumns} rowKey={(p) => p.player_id} initialSort={{ key: 'owned', dir: 'desc' }} rowClass={gameDayRowClass} />
      )}
    </div>
  )
}
