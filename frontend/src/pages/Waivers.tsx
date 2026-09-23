import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type ArticleDigest, type ArticleItem, type Platform, type Player, type Target, type WaiverLeague, type WaiverPlan, type WaiverStanding } from '../api'
import { load, save } from '../lib/prefs'
import { fmt, fmtInt, gameDayRowClass, OUT_STATUSES, pct, POS_ORDER, shortDate } from '../lib/format'
import { useApp } from '../components/AppContext'
import { ErrorBox, LeagueBar, PlatformBadge, PlayerCell, Pos, Spinner } from '../components/Badges'
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
/** ROS everywhere in the app is FantasyPros' rest-of-season rank within position ("WR11"), not a
 * points projection. Sorted by the same list's overall place so a mixed table orders across
 * positions; players FantasyPros does not rank sort last. */
export const rosColumn: Column<Player> = {
  key: 'fp_ros', header: 'ROS',
  title: "FantasyPros rest-of-season rank within position (half PPR). Sorts by their overall rank, so mixed positions order across each other.",
  render: (p) => p.fp_ros_pos_rank ? <span className="font-medium">{p.fp_ros_pos_rank}</span> : <span className="text-stone-300">·</span>,
  sort: (p) => p.fp_ros_ecr ?? 9999, align: 'right',
}

export function playerColumns(opts: { week: number; showRank?: boolean; vsMine?: boolean; espn?: boolean; fp?: boolean; fpWaiver?: boolean; usage?: number; owned?: boolean; livePts?: boolean; variant?: 'waiver' | 'lineup' }): Column<Player>[] {
  // The market view is the waiver default, but a lineup can ask for ownership explicitly — on
  // your own roster it is not "should I add him" but "is the rest of the world starting him".
  const market = opts.owned ?? (opts.variant ?? 'waiver') === 'waiver'
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
      key: 'owned', header: 'Own%', title: "Percent of this platform's leagues where the player is rostered, and the smaller number, where they are started",
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
    ...(opts.livePts ? [{
      key: 'week_pts', header: `Wk ${opts.week} pts`,
      title: `Points actually scored in week ${opts.week} under this league's scoring. Blank until the game has been played.`,
      render: (p: Player) => p.week_pts == null
        ? <span className="text-stone-300">·</span>
        : <span className={p.week_pts >= 15 ? 'font-semibold text-emerald-700' : 'font-medium'}>{fmt(p.week_pts)}</span>,
      sort: (p: Player) => p.week_pts, align: 'right' as const, desc: true,
    }] : []),
    {
      key: 'proj_week', header: `Wk ${opts.week} proj`, title: opts.espn ? "ESPN's projection for this week under this league's scoring" : 'Projected points this week (league scoring)',
      render: (p) => <span>{fmt(p.proj_week)}{opts.showRank && p.proj_week_rank ? <span className="ml-1 text-[10px] text-stone-400">{p.proj_week_rank}</span> : null}</span>,
      sort: (p) => p.proj_week, align: 'right', desc: true,
    },
    { key: 'proj_next', header: `Wk ${opts.week + 1} proj`, title: opts.espn ? "Sleeper's projection for next week, scored with this league's settings (ESPN only publishes the current week)" : 'Projected points next week', render: (p) => fmt(p.proj_next), sort: (p) => p.proj_next, align: 'right', desc: true },
    rosColumn,
  ]
  if (opts.vsMine) {
    cols.push({
      key: 'vs_mine', header: 'vs mine', title: "Places above the player of yours he would replace, on FantasyPros' rest-of-season overall ranking — your worst at his position, or for RB/WR/TE your worst one beyond the starters your lineup needs. Positive = an upgrade. That player is marked 'weakest' on your roster.",
      render: (p) => p.vs_mine == null ? <span className="text-stone-400">—</span> : <span className={p.vs_mine > 0 ? 'font-semibold text-emerald-700' : 'text-stone-400'}>{p.vs_mine > 0 ? '+' : ''}{p.vs_mine}</span>,
      sort: (p) => p.vs_mine, align: 'right', desc: true,
    })
  }
  return cols
}

const LIST_POS = ['ALL', 'QB', 'RB', 'WR', 'TE', 'FLEX']
const dot = <span className="text-stone-300">·</span>
const fits = (pos: string, p: Player) => pos === 'FLEX' ? ['RB', 'WR', 'TE'].includes(p.position) : pos === 'ALL' || p.position === pos
const shown = (p: Player, pos: string, hideOut: boolean) => fits(pos, p) && !(hideOut && OUT_STATUSES.has(p.injury_status ?? ''))

/** A target's standing in one league: whether you can have him there, what he would be worth
 * over the player of yours he would replace, and your claim on him if you have made one. */
function StandingCell({ st, lg, planned, onPlan }: {
  st: WaiverStanding | undefined; lg: WaiverLeague; planned: boolean; onPlan: () => void
}) {
  if (!st) return dot
  if (st.status === 'mine') {
    const starting = !['BN', 'IR', 'TAXI'].includes(st.role)
    return starting
      ? <span title={`Yours in ${lg.name}, starting`} className="rounded bg-sky-600 px-1.5 py-0.5 text-[9.5px] font-bold leading-none text-white">START</span>
      : <span title={`Yours in ${lg.name}`} className="rounded border border-sky-300 bg-white px-1.5 py-0.5 text-[9.5px] font-bold leading-none text-sky-700">{st.role === 'BN' ? 'BENCH' : st.role}</span>
  }
  if (st.status === 'taken') return <span title={`Rostered by ${st.owner}`} className="mx-auto block max-w-[4rem] truncate text-[10.5px] text-stone-400">{st.owner}</span>
  const w = st.status === 'waivers'
  const gain = st.vs_mine
  const tip = `${w ? `On waivers in ${lg.name}${st.until ? ` until ${shortDate(st.until)}` : ''}` : `Free agent in ${lg.name}`}.`
    + (gain == null ? ' FantasyPros does not rank him rest of season.' : ` ${Math.abs(gain)} place${Math.abs(gain) === 1 ? '' : 's'} ${gain >= 0 ? 'above' : 'below'} the player of yours he would replace there (marked "weakest" on that roster), on FantasyPros' rest-of-season ranking.`)
    + (st.claimed ? ` You have a claim in${st.bid != null ? ` for $${st.bid}` : ''}.` : '')
    + (planned ? ' Planned here — click to drop the plan.' : ' Click to plan this claim here.')
  return (
    <span title={tip} className="inline-flex items-center gap-1 whitespace-nowrap">
      <button onClick={onPlan}
              className={`rounded border px-1 py-0.5 text-[10px] font-semibold leading-none ${planned
                ? 'border-amber-500 bg-amber-400 text-white'
                : w ? 'border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100' : 'border-emerald-300 bg-emerald-50 text-emerald-800 hover:bg-emerald-100'}`}>{w ? 'W' : 'FA'}</button>
      {gain != null && <span className={`text-[11px] tabular-nums ${gain > 0 ? 'font-semibold text-emerald-700' : 'text-stone-400'}`}>{gain > 0 ? '+' : ''}{gain}</span>}
      {st.claimed && <span className="rounded bg-sky-200 px-1 py-0.5 text-[9px] font-bold leading-none text-sky-900">{st.bid != null ? `$${st.bid}` : 'CLAIM'}</span>}
    </span>
  )
}

/** Open first, best upgrade first; then yours; then gone. */
function standingSort(st: WaiverStanding | undefined): number | null {
  if (!st) return null
  if (st.status === 'free' || st.status === 'waivers') return 1000 + (st.vs_mine ?? -500)
  return st.status === 'mine' ? 0 : -1000
}

/** The columns for a waiver-list or trends table: who he is, what FantasyPros thinks of him for
 * the rest of the season, what he did on the field last week, and where he is open. `lead` is
 * whatever orders the list — FantasyPros' rank, or a platform's movement numbers. */
function targetColumns(lead: Column<Target>[], opts: {
  week: number; lastWeek: number; leagues: WaiverLeague[]; stars: Set<string>; onStar: (id: string) => void
  planned: Set<string>; onPlan: (leagueId: string, playerId: string) => void
}): Column<Target>[] {
  const lw = opts.lastWeek
  return [
    ...lead,
    {
      key: 'name', header: 'Player', sort: (t) => t.name,
      render: (t) => {
        // The star rides in the name cell rather than a column of its own: the table is already
        // as wide as a laptop allows.
        const on = opts.stars.has(t.player_id)
        return (
          <span className="inline-flex items-center gap-1.5">
            <button onClick={() => opts.onStar(t.player_id)} title={on ? 'Unstar' : 'Star this player — the row lights up here and in the trends list'}
                    className={`text-[13px] leading-none ${on ? 'text-amber-500' : 'text-stone-300 hover:text-amber-400'}`}>{on ? '★' : '☆'}</button>
            <PlayerCell p={t} showPos />
          </span>
        )
      },
    },
    { key: 'opp', header: 'Opp', title: `Opponent in week ${opts.week}, the week you are claiming into`, render: (t) => <span className={t.on_bye ? 'text-stone-400' : ''}>{t.on_bye ? 'BYE' : t.opponent ?? '—'}</span>, sort: (t) => t.opponent },
    rosColumn as Column<Target>,
    {
      key: 'lw_pts_half', header: `Wk ${lw}`, className: 'border-l border-stone-200',
      title: `Fantasy points in week ${lw}, standard half-PPR — one scale for every league`,
      render: (t) => t.lw_pts_half == null ? dot : <span className={t.lw_pts_half >= 15 ? 'font-semibold text-emerald-700' : ''}>{fmt(t.lw_pts_half)}</span>,
      sort: (t) => t.lw_pts_half, align: 'right', desc: true,
    },
    {
      key: 'lw_snap_pct', header: 'Snap', title: `Share of the team's offensive snaps in week ${lw} — the clearest read on whether the role is real`,
      render: (t) => t.lw_snap_pct == null ? dot
        : <span className={t.lw_snap_pct >= 0.7 ? 'font-semibold text-emerald-700' : t.lw_snap_pct >= 0.45 ? 'text-stone-700' : 'text-stone-400'}>{Math.round(t.lw_snap_pct * 100)}%</span>,
      sort: (t) => t.lw_snap_pct, align: 'right', desc: true,
    },
    { key: 'lw_targets', header: 'Tgt', title: `Times targeted in week ${lw}`, render: (t) => t.lw_targets ? <span className="font-medium text-sky-800">{t.lw_targets}</span> : dot, sort: (t) => t.lw_targets, align: 'right', desc: true },
    { key: 'lw_carries', header: 'Car', title: `Rushing attempts in week ${lw}`, render: (t) => t.lw_carries ? <span className="font-medium text-amber-800">{t.lw_carries}</span> : dot, sort: (t) => t.lw_carries, align: 'right', desc: true },
    ...opts.leagues.map((lg, i): Column<Target> => ({
      key: `lg_${lg.league_id}`,
      className: i === 0 ? 'border-l border-stone-200' : '',
      title: `${lg.name} — FA / W is open (with "vs mine": places above the player of yours he would replace), otherwise yours or whose`,
      header: (
        <span className="mx-auto flex max-w-[4.25rem] items-stretch gap-1.5 text-left normal-case">
          <LeagueBar leagueId={lg.league_id} />
          <span className="min-w-0"><PlatformBadge platform={lg.platform} /><span className="mt-0.5 block truncate font-medium text-stone-600">{lg.name}</span></span>
        </span>
      ),
      render: (t) => (
        <StandingCell st={t.leagues[lg.league_id]} lg={lg} planned={opts.planned.has(`${lg.league_id}|${t.player_id}`)}
                      onPlan={() => opts.onPlan(lg.league_id, t.player_id)} />
      ),
      sort: (t) => standingSort(t.leagues[lg.league_id]), align: 'center', desc: true,
    })),
  ]
}

/** How each platform measures movement, as the columns that lead its trends table. */
function movementColumns(kind: Platform): Column<Target>[] {
  if (kind === 'espn') {
    return [
      { key: 'owned_change', header: 'Own Δ', title: 'Change in the percentage of ESPN teams rostering this player', render: (t) => t.owned_change == null ? dot : <span className={t.owned_change > 0 ? 'font-semibold text-emerald-700' : 'text-red-700'}>{t.owned_change > 0 ? '+' : ''}{fmt(t.owned_change)}</span>, sort: (t) => t.owned_change, align: 'right', desc: true },
      { key: 'owned', header: 'Own%', title: 'Percent of ESPN teams rostering this player now', render: (t) => pct(t.owned), sort: (t) => t.owned, align: 'right', desc: true },
    ]
  }
  if (kind === 'yahoo') {
    return [
      { key: 'adds', header: 'Adds', title: 'Added across all Yahoo leagues, from its Transaction Trends page', render: (t) => t.adds ? <span className="font-semibold text-emerald-700">{fmtInt(t.adds)}</span> : dot, sort: (t) => t.adds, align: 'right', desc: true },
      { key: 'drops', header: 'Drops', title: 'Dropped across all Yahoo leagues', render: (t) => t.drops ? <span className="text-red-700">{fmtInt(t.drops)}</span> : dot, sort: (t) => t.drops, align: 'right', desc: true },
    ]
  }
  return [
    { key: 'adds_24h', header: 'Adds', title: 'Added across all Sleeper leagues in the last 24 hours', render: (t) => t.adds_24h ? <span className="font-semibold text-emerald-700">{fmtInt(t.adds_24h)}</span> : dot, sort: (t) => t.adds_24h, align: 'right', desc: true },
    { key: 'drops_24h', header: 'Drops', title: 'Dropped across all Sleeper leagues in the last 24 hours', render: (t) => t.drops_24h ? <span className="text-red-700">{fmtInt(t.drops_24h)}</span> : dot, sort: (t) => t.drops_24h, align: 'right', desc: true },
  ]
}

const FP_LEAD: Column<Target>[] = [{
  key: 'fp_waiver', header: 'FP', title: "Rank on FantasyPros' waiver-wire list, and within position",
  render: (t) => t.fp_waiver_rank == null ? dot
    : <span className="font-semibold text-violet-800">{t.fp_waiver_rank}<span className="ml-1 text-[10px] font-normal text-violet-500">{t.fp_waiver_pos_rank}</span></span>,
  sort: (t) => t.fp_waiver_rank ?? 9999, align: 'right',
}]

/** A starred row gets a warm fill and an amber rule down its left edge, over anything else the row
 * would carry — the game-day tint, or the fade for a player out of reach everywhere, which is kept
 * for the context but quiet. Amber because it is the app's "picked" colour: the streaming picks
 * and the selected league use it too. */
const rowClassFor = (stars: Set<string>) => (t: Target) => {
  if (stars.has(t.player_id)) return 'bg-amber-100/70 [&>td:first-child]:shadow-[inset_3px_0_0_0_#f59e0b]'
  const open = Object.values(t.leagues).some((s) => s.status === 'free' || s.status === 'waivers' || s.status === 'mine')
  return `${gameDayRowClass(t)} ${open ? '' : 'opacity-45'}`
}

/** The claims you mean to put in, under your roster — where you can see the spots and the budget
 * they have to fit. A claim is planned by clicking a league's FA or W cell in the tables; here it
 * gets the two things a cell cannot hold: what you mean to bid, and who you would drop for him.
 * Nothing is submitted anywhere — you make the move on the platform, and the row then says so. */
function PlannerStrip({ leagues, plans, week, lookup, onSet, onClear }: {
  leagues: WaiverLeague[]; plans: WaiverPlan[]; week: number; lookup: Map<string, Player>
  onSet: (p: { league_id: string; player_id: string; bid?: number | null; drop_player_id?: string | null }) => void
  onClear: (leagueId: string, playerId: string) => void
}) {
  const byLeague = leagues
    .map((lg) => [lg, plans.filter((p) => p.league_id === lg.league_id)] as const)
    .filter(([, rows]) => rows.length)
  return (
    <section className="shrink-0 rounded-md border border-amber-300 bg-amber-50/60">
      <div className="flex items-baseline gap-2 border-b border-amber-200 px-3 py-2">
        <h2 className="text-[12.5px] font-semibold text-stone-800">Waiver plan</h2>
        <span className="text-[11px] text-stone-500">week {week}</span>
      </div>
      {!byLeague.length ? (
        <p className="px-3 py-2 text-[11.5px] text-stone-500">Nothing planned. Click a league's <span className="font-semibold text-emerald-700">FA</span> or <span className="font-semibold text-amber-700">W</span> cell in the tables to plan a claim there.</p>
      ) : (
        <div className="divide-y divide-amber-200">
          {byLeague.map(([lg, rows]) => {
            const budget = lg.waiver.type_code === 2 ? lg.my_team?.faab_remaining ?? 0 : null
            const spent = rows.reduce((n, p) => n + (p.bid ?? 0), 0)
            const drops = [...lg.roster].sort((a, b) => (b.fp_ros_ecr ?? 9999) - (a.fp_ros_ecr ?? 9999))
            return (
              <div key={lg.league_id} className="px-3 py-2">
                <div className="flex items-center gap-1.5 text-[11.5px]">
                  <LeagueBar leagueId={lg.league_id} />
                  <span className="min-w-0 truncate font-medium text-stone-800">{lg.name}</span>
                  {budget != null && (
                    <span className={`ml-auto shrink-0 rounded px-1 py-0.5 text-[10px] ${spent > budget ? 'bg-red-100 font-semibold text-red-800' : 'bg-white text-stone-600'}`}
                          title={spent > budget ? 'More planned than you have left' : 'Planned of what you have left'}>${spent} / ${budget}</span>
                  )}
                </div>
                <ul className="mt-1 space-y-1">
                  {rows.map((p) => {
                    const row = lg.roster.find((r) => r.player_id === p.player_id)
                    const name = lookup.get(p.player_id)?.name ?? row?.name ?? p.player_id
                    return (
                      <li key={p.player_id} className="rounded border border-amber-200 bg-white px-1.5 py-1">
                        <div className="flex items-center gap-1.5 text-[12px]">
                          <span className="min-w-0 flex-1 truncate font-medium text-stone-800">{name}</span>
                          {row && <span title="Already on your roster — this one is done" className="shrink-0 rounded bg-emerald-100 px-1 py-0.5 text-[9px] font-bold uppercase leading-none text-emerald-800">yours</span>}
                          <button onClick={() => onClear(lg.league_id, p.player_id)} title="Drop this plan" className="shrink-0 px-0.5 text-stone-300 hover:text-red-600">×</button>
                        </div>
                        <div className="mt-1 flex items-center gap-1.5">
                          {lg.waiver.type_code === 2 && (
                            <label className="flex shrink-0 items-center gap-0.5 text-[10.5px] text-stone-500" title="What you mean to bid">
                              $
                              <input type="number" min={lg.waiver.bid_min} defaultValue={p.bid ?? ''} placeholder="—"
                                     onBlur={(e) => onSet({ league_id: lg.league_id, player_id: p.player_id, bid: e.target.value === '' ? null : Number(e.target.value) })}
                                     onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
                                     className="w-12 rounded border border-stone-300 px-1 py-0.5 text-[11.5px] tabular-nums text-stone-800" />
                            </label>
                          )}
                          <select value={p.drop_player_id ?? ''} title="Who you would drop for him"
                                  onChange={(e) => onSet({ league_id: lg.league_id, player_id: p.player_id, drop_player_id: e.target.value || null })}
                                  className="min-w-0 flex-1 rounded border border-stone-300 bg-white px-1 py-0.5 text-[11px] text-stone-700">
                            <option value="">{lg.spots.open > 0 ? 'no drop — open spot' : 'drop: nobody yet'}</option>
                            {drops.map((r) => <option key={r.player_id} value={r.player_id}>drop {r.slot} {r.name} ({r.fp_ros_pos_rank ?? '—'})</option>)}
                          </select>
                        </div>
                      </li>
                    )
                  })}
                </ul>
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}

/** Claims you have already submitted, under the roster with the plan: it stops you bidding twice
 * and shows what each budget is already committed to. Every platform keeps claims private until
 * they run, so these are only ever your own. */
function PendingStrip({ leagues }: { leagues: WaiverLeague[] }) {
  const withClaims = leagues.filter((l) => l.pending.length)
  if (!withClaims.length) return null
  return (
    <section className="shrink-0 rounded-md border border-sky-200 bg-sky-50/60">
      <div className="flex items-baseline gap-2 border-b border-sky-200 px-3 py-2">
        <h2 className="text-[12.5px] font-semibold text-stone-800">Pending claims</h2>
        <span className="text-[11px] text-stone-500">already submitted</span>
      </div>
      <div className="divide-y divide-sky-200">
        {withClaims.map((lg) => (
          <div key={lg.league_id} className="px-3 py-2">
            <div className="flex items-center gap-1.5 text-[11.5px]">
              <LeagueBar leagueId={lg.league_id} />
              <span className="min-w-0 truncate font-medium text-stone-800">{lg.name}</span>
              {lg.pending[0]?.runs_on && <span className="ml-auto shrink-0 text-[10px] text-stone-500">runs {lg.pending[0].runs_on}</span>}
            </div>
            <ul className="mt-1 space-y-0.5">
              {lg.pending.map((c, i) => (
                <li key={`${c.player_id ?? c.name}-${i}`} className="flex items-baseline gap-1.5 text-[12px]">
                  {c.priority != null && <span className="shrink-0 rounded bg-sky-200 px-1 py-0.5 text-[9.5px] font-bold leading-none text-sky-900">{c.priority}</span>}
                  <span className="min-w-0 flex-1 truncate font-medium text-stone-800">{c.name}</span>
                  {c.bid != null && <span className="shrink-0 font-semibold text-emerald-800">${c.bid}</span>}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  )
}

/** This week's waiver columns, summarised. Deliberately separate from the ranked table: that
 * table is numbers, this is somebody's opinion, and mixing the two makes it unclear which is
 * which. Sell/hold calls are commentary rather than claims, so they sit in their own group. */
function ArticleBlock({ digest }: { digest: ArticleDigest }) {
  // Two columns covering ~40 players is a wall of bullets if left flat, so it reads in the same
  // order you would work the wire: the reasoned adds by position, then the speculative stashes,
  // then the buy/sell commentary, then the name-only tiers and drop lists at the bottom.
  const POS = ['RB', 'WR', 'TE', 'QB', 'DEF', 'K']
  const adds = digest.items.filter((i) => i.action === 'add')
  const addGroups = POS.map((p) => [p, adds.filter((i) => i.position === p)] as const).filter(([, v]) => v.length)
  const stashes = digest.items.filter((i) => i.action === 'stash')
  const calls = digest.items.filter((i) => i.action === 'buy' || i.action === 'sell' || i.action === 'hold')

  const Item = ({ i }: { i: ArticleItem }) => (
    <li className="flex gap-2 leading-snug">
      <span className={`mt-[7px] h-1 w-1 shrink-0 rounded-full ${i.action === 'sell' ? 'bg-red-400' : i.action === 'stash' ? 'bg-stone-300' : 'bg-amber-500'}`} />
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

  const Section = ({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) => (
    <div className="border-t border-amber-200 pt-2.5 first:border-t-0 first:pt-0">
      <h3 className="mb-1.5 text-[10px] font-bold uppercase tracking-wide text-amber-800/70">
        {label}{hint && <span className="ml-1 font-medium normal-case tracking-normal text-stone-400">{hint}</span>}
      </h3>
      {children}
    </div>
  )

  return (
    <aside className="w-full rounded-md border border-amber-200 bg-amber-50/50 lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
      <div className="sticky top-0 z-10 border-b border-amber-200 bg-amber-50 px-3 py-2">
        <h2 className="text-[13px] font-semibold text-stone-800">What the columns say</h2>
        <p className="mt-0.5 text-[11px] text-stone-500">
          Week {digest.week} · {digest.sources.map((src, n) => (
            <span key={src.id}>{n > 0 && ' · '}<a href={src.url} target="_blank" rel="noreferrer" className="underline decoration-dotted hover:text-amber-900">{src.name}</a>{src.partial && <span title={src.partial_note ?? 'Partly paywalled'}> (partial)</span>}</span>
          ))}
        </p>
      </div>
      <div className="space-y-3 px-3 py-2.5">
        {addGroups.map(([pos, group]) => (
          <Section key={pos} label={pos === 'DEF' ? 'D/ST' : pos}>
            <ul className="space-y-2 text-[12px]">{group.map((i) => <Item key={i.name} i={i} />)}</ul>
          </Section>
        ))}
        {stashes.length > 0 && (
          <Section label="Deep stashes" hint="under 5% rostered">
            <ul className="space-y-2 text-[12px]">{stashes.map((i) => <Item key={i.name} i={i} />)}</ul>
          </Section>
        )}
        {calls.length > 0 && (
          <Section label="Buy / sell">
            <ul className="space-y-2 text-[12px]">{calls.map((i) => <Item key={i.name} i={i} />)}</ul>
          </Section>
        )}
        {digest.lists.length > 0 && (
          <Section label="Named without comment" hint="no reasoning given">
            <div className="space-y-1.5 text-[11px]">
              {digest.lists.map((l) => (
                <p key={l.label} className="leading-snug">
                  <span className={`font-semibold ${l.action === 'drop' ? 'text-red-800' : 'text-stone-700'}`}>{l.label}</span>
                  <span className="text-stone-500"> — {l.names.join(', ')}</span>
                </p>
              ))}
            </div>
          </Section>
        )}
        <p className="border-t border-amber-200 pt-2 text-[11px] text-stone-500">Opinion — not part of the ranking, which is numbers only.</p>
      </div>
    </aside>
  )
}

/** Your team in one league at a time, beside the pool — the players any claim is made over, and
 * the room you have to make one. The numbers come off the same projections and rankings as the
 * waiver rows, so a free agent and the man he would replace read alike. Grouped by position in
 * FantasyPros' rest-of-season order, so the bottom of each group is where a drop would come from;
 * "weakest" marks the player "vs mine" measures against. Then IR, taxi and whatever is open —
 * open roster spots mean a claim needs no drop, and an empty starting slot is a lineup to fix. */
function RosterCard({ leagues, selected, onSelect, week }: { leagues: WaiverLeague[]; selected: string | null; onSelect: (id: string) => void; week: number }) {
  const lg = leagues.find((l) => l.league_id === selected) ?? leagues[0]
  if (!lg) return null
  const active = lg.roster.filter((r) => r.slot !== 'IR' && r.slot !== 'TAXI')
  const groups = (['QB', 'RB', 'WR', 'TE'] as const)
    .map((pos) => [pos, active.filter((r) => r.position === pos).sort((a, b) => (a.fp_ros_ecr ?? 9999) - (b.fp_ros_ecr ?? 9999))] as const)
    .filter(([, rows]) => rows.length)
  const ir = lg.roster.filter((r) => r.slot === 'IR')
  const taxi = lg.roster.filter((r) => r.slot === 'TAXI')
  const { spots } = lg
  const t = lg.my_team
  const faab = lg.waiver.type_code === 2 && t ? `$${t.faab_remaining} FAAB` : null

  const Row = ({ r }: { r: typeof lg.roster[number] }) => (
    <li className={`flex items-center gap-1.5 py-0.5 text-[12px] ${r.slot === 'IR' || r.slot === 'TAXI' ? 'opacity-70' : ''}`}>
      <span className="w-10 shrink-0"><Pos pos={r.slot} /></span>
      <span className="min-w-0 flex-1 overflow-hidden whitespace-nowrap"><PlayerCell p={r} /></span>
      {r.vs_mine_bar && (
        <span title={`The player "vs mine" measures a free agent against: your lowest FantasyPros rest-of-season rank among those a claim could replace — your worst ${r.position === 'QB' ? 'QB' : 'at a position, or your worst RB / WR / TE beyond the starters your lineup needs'}. IR and taxi aside.`}
              className="shrink-0 rounded bg-stone-100 px-1 py-0.5 text-[9px] font-semibold uppercase leading-none text-stone-500">weakest</span>
      )}
      <span className="w-8 shrink-0 text-right tabular-nums text-stone-800">{fmt(r.proj_week)}</span>
      <span className="w-9 shrink-0 text-right tabular-nums text-stone-500">{r.fp_ros_pos_rank ?? dot}</span>
    </li>
  )
  const Empty = ({ slot, text, tone = 'text-stone-400' }: { slot: string; text: string; tone?: string }) => (
    <li className="flex items-center gap-1.5 py-0.5 text-[12px]">
      <span className="w-10 shrink-0"><Pos pos={slot} /></span>
      <span className={`flex-1 rounded border border-dashed border-stone-200 px-1.5 text-[11px] ${tone}`}>{text}</span>
    </li>
  )
  const Group = ({ label, count, children }: { label: string; count?: string; children: ReactNode }) => (
    <div>
      <h3 className="text-[10px] font-bold uppercase tracking-wide text-stone-400">{label} {count && <span className="font-medium">{count}</span>}</h3>
      <ul>{children}</ul>
    </div>
  )

  return (
    <section className="shrink-0 rounded-md border border-stone-200 bg-white">
      <div className="grid border-b border-stone-200" style={{ gridTemplateColumns: `repeat(${leagues.length}, minmax(0, 1fr))` }}>
        {leagues.map((l) => (
          <button key={l.league_id} onClick={() => onSelect(l.league_id)} title={l.name}
                  className={`flex min-w-0 items-stretch gap-1 px-1.5 py-1.5 text-left text-[10.5px] ${l.league_id === lg.league_id ? 'bg-stone-900 text-white' : 'text-stone-600 hover:bg-stone-100'}`}>
            <LeagueBar leagueId={l.league_id} />
            <span className="truncate">{l.name}</span>
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-stone-200 px-3 py-2">
        <h2 className="min-w-0 truncate text-[12.5px] font-semibold text-stone-800">{t?.team_name ?? 'Your roster'}</h2>
        <span className="flex flex-wrap items-center gap-1.5 text-[10.5px]">
          <span className={`rounded px-1.5 py-0.5 font-semibold ${spots.open ? 'bg-emerald-100 text-emerald-800' : 'bg-stone-100 text-stone-500'}`}
                title={spots.open ? 'Room to add without dropping anyone' : 'Every roster spot is taken — a claim needs a drop'}>{spots.open ? `${spots.open} open` : 'full'}</span>
          {spots.ir.slots > 0 && <span className="rounded bg-stone-100 px-1.5 py-0.5 text-stone-600" title="IR slots used of available">IR {spots.ir.used}/{spots.ir.slots}</span>}
          {faab && <span className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-800">{faab}</span>}
        </span>
        <span className="ml-auto flex shrink-0 gap-2 text-[10px] font-medium uppercase tracking-wide text-stone-400">
          <span className="w-8 text-right" title={`Projected points in week ${week}, this league's scoring`}>Wk {week}</span>
          <span className="w-9 text-right" title="FantasyPros rest-of-season rank within position (half PPR)">ROS</span>
        </span>
      </div>
      <div className="space-y-1.5 px-3 py-2">
        {spots.empty_starts.length > 0 && (
          <Group label="Empty in the lineup">
            {spots.empty_starts.map((slot, i) => <Empty key={`${slot}-${i}`} slot={slot} text="nobody starting" tone="font-medium text-red-700" />)}
          </Group>
        )}
        {groups.map(([pos, rows]) => (
          <Group key={pos} label={pos} count={String(rows.length)}>{rows.map((r) => <Row key={r.player_id} r={r} />)}</Group>
        ))}
        {spots.open > 0 && (
          <Group label="Open" count={String(spots.open)}>
            {Array.from({ length: spots.open }, (_, i) => <Empty key={i} slot="BN" text="open roster spot" />)}
          </Group>
        )}
        {(spots.ir.slots > 0 || ir.length > 0) && (
          <Group label="IR" count={`${spots.ir.used}/${spots.ir.slots}`}>
            {ir.map((r) => <Row key={r.player_id} r={r} />)}
            {Array.from({ length: Math.max(0, spots.ir.slots - spots.ir.used) }, (_, i) => <Empty key={i} slot="IR" text="open IR slot" />)}
          </Group>
        )}
        {(spots.taxi.slots > 0 || taxi.length > 0) && (
          <Group label="Taxi" count={`${spots.taxi.used}/${spots.taxi.slots}`}>
            {taxi.map((r) => <Row key={r.player_id} r={r} />)}
            {Array.from({ length: Math.max(0, spots.taxi.slots - spots.taxi.used) }, (_, i) => <Empty key={i} slot="TAXI" text="open taxi slot" />)}
          </Group>
        )}
      </div>
    </section>
  )
}

/** The right-hand column on both tabs: your roster, then the waiver columns when there are any.
 * It stays in view while the tables scroll, under the 2.5rem header. */
function SideColumn({ children }: { children: ReactNode }) {
  return (
    <div className="flex w-full shrink-0 flex-col gap-3 self-start lg:sticky lg:top-12 lg:max-h-[calc(100vh-3.5rem)] lg:w-72 lg:overflow-y-auto">
      {children}
    </div>
  )
}

type Tab = 'list' | 'browse'

/** The waiver wire across every league at once, the way streaming works: FantasyPros' waiver list
 * is the spine, in their order, and each row carries both halves of the decision — what the
 * player did on the field last week, and where he is open and what he would be worth to you in
 * each league. The trends lists follow with the same columns, then your roster in whichever
 * league you are looking at. Browse all is the whole free-agent pool of the league picked in the
 * sidebar, for anyone the lists do not reach. */
export default function Waivers() {
  const { leagueId, league, week } = useApp()
  const board = useQuery({ queryKey: ['waiver-board'], queryFn: () => api.waiverBoard(), staleTime: 60_000 })
  const [tab, setTab] = useState<Tab>('list')
  const browse = useQuery({
    queryKey: ['waivers', leagueId],
    queryFn: () => api.waivers(leagueId!),
    enabled: !!leagueId && tab === 'browse',
    staleTime: 60_000,
  })
  const qc = useQueryClient()
  const { data: plans } = useQuery({ queryKey: ['waiver-plans'], queryFn: api.waiverPlans })
  const savePlan = useMutation({
    mutationFn: ({ clear, ...v }: { league_id: string; player_id: string; week: number; bid?: number | null; drop_player_id?: string | null; clear?: boolean }) =>
      clear ? api.clearWaiverPlan({ league_id: v.league_id, player_id: v.player_id, week: v.week }) : api.setWaiverPlan(v),
    onSuccess: (list) => qc.setQueryData(['waiver-plans'], list),
  })
  const [pos, setPos] = useState('ALL')
  const [hideOut, setHideOut] = useState(false)
  const [trendKind, setTrendKind] = useState<Platform | null>(null)
  // Starred players, kept in this browser — the ones you are after this week.
  const [stars, setStars] = useState<Set<string>>(() => new Set(load<string[]>('waiverStars', [])))
  const onStar = (id: string) => setStars((cur) => {
    const next = new Set(cur)
    if (!next.delete(id)) next.add(id)
    save('waiverStars', [...next])
    return next
  })
  const rowClass = useMemo(() => rowClassFor(stars), [stars])
  // The roster follows the league picked in the sidebar until you switch it here.
  const [rosterLeague, setRosterLeague] = useState<string | null>(leagueId)
  useEffect(() => { if (leagueId) setRosterLeague(leagueId) }, [leagueId])
  // Browse filters.
  const [browsePos, setBrowsePos] = useState('ALL')
  const [search, setSearch] = useState('')
  const [relevantOnly, setRelevantOnly] = useState(true)
  const [fpOnly, setFpOnly] = useState(false)

  const d = board.data
  const targetWeek = d?.week ?? week
  const lastWeek = Math.max(1, targetWeek - 1)
  const fpRows = useMemo(() => (d?.fantasypros ?? []).filter((t) => shown(t, pos, hideOut)), [d, pos, hideOut])
  const trend = d?.trends.find((t) => t.kind === trendKind) ?? d?.trends[0] ?? null
  const trendRows = useMemo(() => (trend?.rows ?? []).filter((t) => shown(t, pos, hideOut)), [trend, pos, hideOut])

  // Planned claims are keyed by league and player: one plan per man per league per week.
  const weekPlans = useMemo(() => (plans ?? []).filter((p) => p.week === targetWeek), [plans, targetWeek])
  const plannedKeys = useMemo(() => new Set(weekPlans.map((p) => `${p.league_id}|${p.player_id}`)), [weekPlans])
  const onPlanClaim = (league_id: string, player_id: string) => {
    const has = plannedKeys.has(`${league_id}|${player_id}`)
    const cur = weekPlans.find((p) => p.league_id === league_id && p.player_id === player_id)
    savePlan.mutate({ league_id, player_id, week: targetWeek, clear: has, bid: cur?.bid, drop_player_id: cur?.drop_player_id })
  }
  // Every player the page can name, so a plan still reads as a name once he leaves the lists.
  const lookup = useMemo(() => {
    const m = new Map<string, Player>()
    for (const t of d?.fantasypros ?? []) m.set(t.player_id, t)
    for (const tr of d?.trends ?? []) for (const t of tr.rows) m.set(t.player_id, t)
    for (const lg of d?.leagues ?? []) for (const r of lg.roster) m.set(r.player_id, r)
    return m
  }, [d])

  const colOpts = { week: targetWeek, lastWeek, leagues: d?.leagues ?? [], stars, onStar, planned: plannedKeys, onPlan: onPlanClaim }
  const fpCols = useMemo(() => targetColumns(FP_LEAD, colOpts),
    [targetWeek, lastWeek, d?.leagues, stars, plannedKeys])  // the handlers only ever set state
  const trendCols = useMemo(() => targetColumns(movementColumns(trend?.kind ?? 'sleeper'), colOpts),
    [trend?.kind, targetWeek, lastWeek, d?.leagues, stars, plannedKeys])

  const browseRows = useMemo(() => {
    const q = search.trim().toLowerCase()
    return (browse.data?.players ?? []).filter((p) => {
      if (!shown(p, browsePos, hideOut)) return false
      if (fpOnly && p.fp_waiver_rank == null) return false
      if (relevantOnly && !(p.owned >= 1 || p.adds_24h > 0 || (p.proj_week ?? 0) >= 2 || (p.proj_ros ?? 0) >= 20 || p.fp_ros_ecr != null)) return false
      if (q && !(p.name.toLowerCase().includes(q) || (p.team ?? '').toLowerCase() === q)) return false
      return true
    })
  }, [browse.data, browsePos, hideOut, fpOnly, relevantOnly, search])
  const browseColumns = useMemo(() => playerColumns({
    week: browse.data?.week ?? targetWeek, showRank: true, vsMine: true, espn: league?.platform === 'espn', fp: true, fpWaiver: true, usage: lastWeek,
  }), [browse.data?.week, targetWeek, lastWeek, league?.platform])

  const meta = d?.fantasypros_meta
  const side = d && (
    <SideColumn>
      <RosterCard leagues={d.leagues} selected={rosterLeague} onSelect={setRosterLeague} week={targetWeek} />
      <PendingStrip leagues={d.leagues} />
      <PlannerStrip leagues={d.leagues} plans={weekPlans} week={targetWeek} lookup={lookup}
                    onSet={(v) => savePlan.mutate({ ...v, week: targetWeek })}
                    onClear={(league_id, player_id) => savePlan.mutate({ league_id, player_id, week: targetWeek, clear: true })} />
      {tab === 'list' && d.articles && <ArticleBlock digest={d.articles} />}
    </SideColumn>
  )

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <h1 className="text-base font-semibold">Waiver wire · all leagues</h1>
        <span className="ml-auto text-[12px] text-stone-500">
          Week {targetWeek} claims{meta?.updated ? ` · FantasyPros list of ${meta.updated}${meta.experts ? `, ${meta.experts} experts` : ''}` : ''}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex rounded-md border border-stone-200 bg-white p-0.5">
          {([['list', 'Waiver list'], ['browse', `Browse all${league ? ` · ${league.name}` : ''}`]] as [Tab, string][]).map(([k, label]) => (
            <button key={k} onClick={() => setTab(k)} className={`rounded px-3 py-1 text-[12px] ${tab === k ? 'bg-stone-900 text-white' : 'text-stone-700 hover:bg-stone-100'}`}>{label}</button>
          ))}
        </div>
        <div className="flex rounded-md border border-stone-200 bg-white p-0.5">
          {(tab === 'list' ? LIST_POS : POS_FILTERS).map((f) => {
            const on = (tab === 'list' ? pos : browsePos) === f
            return <button key={f} onClick={() => (tab === 'list' ? setPos : setBrowsePos)(f)} className={`rounded px-2.5 py-1 text-[12px] ${on ? 'bg-stone-900 text-white' : 'text-stone-700 hover:bg-stone-100'}`}>{f}</button>
          })}
        </div>
        <label className="flex items-center gap-1.5 text-[12px] text-stone-700"><input type="checkbox" checked={hideOut} onChange={(e) => setHideOut(e.target.checked)} /> Hide Out / IR</label>
        {tab === 'browse' && (
          <>
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name or team…" className="w-56 rounded-md border border-stone-200 bg-white px-2.5 py-1 text-[12px]" />
            <label className="flex items-center gap-1.5 text-[12px] text-stone-700" title="Hide players nobody rosters, adds, projects or ranks"><input type="checkbox" checked={relevantOnly} onChange={(e) => setRelevantOnly(e.target.checked)} /> Relevant only</label>
            <label className="flex items-center gap-1.5 text-[12px] text-stone-700" title="Only players on the FantasyPros waiver-wire list"><input type="checkbox" checked={fpOnly} onChange={(e) => setFpOnly(e.target.checked)} /> <span className="rounded bg-violet-100 px-1 py-0.5 text-[9.5px] font-bold leading-none text-violet-800">FP</span> picks</label>
            <span className="ml-auto text-[12px] text-stone-500">{browseRows.length} of {browse.data?.players.length ?? 0} free agents</span>
          </>
        )}
      </div>

      {board.isLoading && <Spinner label="Reading every league's wire (rosters, usage, trends)…" />}
      {board.error && <ErrorBox error={board.error} />}
      {savePlan.error && <ErrorBox error={savePlan.error} />}

      {d && tab === 'list' && (
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start">
          <div className="min-w-0 flex-1 space-y-3">
            <section className="space-y-1.5">
              <h2 className="text-[12px] font-semibold uppercase tracking-wide text-stone-500">FantasyPros waiver list <span className="font-normal normal-case text-stone-400">{fpRows.length}</span></h2>
              <p className="text-[12px] text-stone-500">
                Their week {targetWeek} shortlist in their order, with what each player actually did in week {lastWeek} beside it — points, then the snap share
                and targets or carries that say whether the role is real. Each league column says where he is open (<span className="font-semibold text-emerald-700">FA</span>,
                or <span className="font-semibold text-amber-700">W</span> on waivers) and how many places he sits above the player of yours he would replace on the
                rest-of-season ranking; otherwise yours, or whose. K and D/ST are on the streaming page.
              </p>
              <DataTable rows={fpRows} columns={fpCols} rowKey={(t) => t.player_id} initialSort={{ key: 'fp_waiver', dir: 'asc' }} rowClass={rowClass} maxHeight="36rem"
                         empty="Nobody on this week's FantasyPros list matches the filters." />
            </section>

            {trend && (
              <section className="space-y-1.5">
                <div className="flex flex-wrap items-center gap-3">
                  <h2 className="text-[12px] font-semibold uppercase tracking-wide text-stone-500">Trending <span className="font-normal normal-case text-stone-400">{trendRows.length}</span></h2>
                  {d.trends.length > 1 && (
                    <div className="flex rounded-md border border-stone-200 bg-white p-0.5">
                      {d.trends.map((t) => (
                        <button key={t.kind} onClick={() => setTrendKind(t.kind)}
                                className={`rounded px-2.5 py-0.5 text-[11.5px] ${t.kind === trend.kind ? 'bg-stone-900 text-white' : 'text-stone-700 hover:bg-stone-100'}`}>{t.label}</button>
                      ))}
                    </div>
                  )}
                </div>
                <p className="text-[12px] text-stone-500">{trend.blurb}</p>
                {trend.error
                  ? <ErrorBox error={new Error(`${trend.label}: ${trend.error}`)} />
                  : <DataTable key={trend.kind} rows={trendRows} columns={trendCols} rowKey={(t) => t.player_id}
                               initialSort={{ key: trend.kind === 'espn' ? 'owned_change' : trend.kind === 'yahoo' ? 'adds' : 'adds_24h', dir: 'desc' }}
                               rowClass={rowClass} maxHeight="30rem" empty="Nothing is moving at this position." />}
              </section>
            )}
          </div>
          {side}
        </div>
      )}

      {tab === 'browse' && (
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start">
          <div className="min-w-0 flex-1">
            {browse.isLoading && <Spinner label="Loading the whole pool…" />}
            {browse.error && <ErrorBox error={browse.error} />}
            {browse.data && <DataTable rows={browseRows} columns={browseColumns} rowKey={(p) => p.player_id} initialSort={{ key: 'owned', dir: 'desc' }} rowClass={gameDayRowClass} />}
          </div>
          {side}
        </div>
      )}
    </div>
  )
}
