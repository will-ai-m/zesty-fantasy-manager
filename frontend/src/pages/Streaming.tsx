import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type GameWeather, type Standing, type Streamer, type StreamingLeague, type StreamingResponse, type TeamFactors } from '../api'
import { fmt, shortDate } from '../lib/format'
import { ErrorBox, LeagueBar, PlatformBadge, PlayerCell, Spinner } from '../components/Badges'

type Pos = 'K' | 'DEF'
type OnPick = (leagueId: string, s: Streamer) => void
/** Your pick in a league at a position for a week, as a player id. */
type PickOf = (leagueId: string, pos: Pos, week: number) => string | null

const dash = <span className="text-stone-300">·</span>
const th = 'px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-stone-400'

/** A kicker's conditions for one game, as a line under the matchup. Every game gets one, because
 * the roof is known weeks ahead and a dome is the best thing a kicker's schedule can hold.
 *
 * Wind leads because wind is what moves a kick: accuracy falls away from about 12 mph sustained
 * and sharply past 18, and it is the long attempts that go first. Rain and cold matter less —
 * a wet or cold ball mostly costs range. Gusts only show when they clearly exceed the steady
 * wind; the model sometimes has them lower, which says nothing. */
function kickerWeather(wx: GameWeather | null): { text: string; tone: string; tip: string } | null {
  if (!wx) return null
  if (wx.roof === 'dome') return { text: '⌂ dome', tone: 'text-stone-500', tip: `${wx.stadium} — indoors, no weather.` }
  if (wx.roof === 'retractable') return { text: '⌂ roof', tone: 'text-stone-500', tip: `${wx.stadium} — retractable roof, closed when the weather is bad.` }
  const f = wx.forecast
  if (!f) return { text: 'open air', tone: 'text-stone-300', tip: `${wx.stadium} — outdoors. The forecast appears within a week of kickoff.` }
  const wind = f.wind ?? 0
  const gust = Math.max(f.gust ?? 0, wind)
  const wet = f.snow >= 0.1 ? 'snow' : (f.precip_prob ?? 0) >= 50 || f.precip >= 0.1 ? `rain ${f.precip_prob ?? '?'}%` : null
  const cold = f.temp != null && f.temp <= 32
  const parts = [`${wind} mph`, ...(gust >= wind + 5 ? [`g${gust}`] : []), ...(wet ? [wet] : []), ...(cold ? [`${f.temp}°`] : [])]
  const severe = wind >= 18 || gust >= 30 || f.snow >= 0.2 || f.precip >= 0.25
  const moderate = wind >= 12 || gust >= 22 || !!wet || cold
  return {
    text: parts.join(' · '),
    tone: severe ? 'font-semibold text-red-700' : moderate ? 'text-amber-700' : 'text-stone-400',
    tip: `${wx.stadium}, over the game: wind ${f.wind ?? '?'} mph, gusts ${f.gust ?? '?'} mph, ${f.precip_prob ?? '?'}% chance of precipitation `
      + `(${f.precip}" expected${f.snow ? `, ${f.snow}" of it snow` : ''}), low of ${f.temp ?? '?'}°F. Open-Meteo forecast.`,
  }
}

/** Weather bad enough to matter to a defence, and nothing short of it. The implied total already
 * moves on a forecast, so ordinary wind and rain are in the number; this only flags the games
 * where conditions take the passing game away — 20+ mph sustained, gusts of 35+, real snow or
 * heavy rain — in case the line has not caught up yet. */
function extremeWeather(wx: GameWeather | null): { text: string; tip: string } | null {
  const f = wx?.roof === 'open' ? wx.forecast : null
  if (!f) return null
  const wind = f.wind ?? 0, gust = f.gust ?? 0
  const flags = [
    ...(wind >= 20 ? [`wind ${wind}`] : gust >= 35 ? [`gusts ${gust}`] : []),
    ...(f.snow >= 0.5 ? ['snow'] : f.precip >= 0.4 ? ['heavy rain'] : []),
  ]
  if (!flags.length) return null
  return {
    text: flags.join(' · '),
    tip: `${wx!.stadium}, over the game: wind ${f.wind ?? '?'} mph, gusts ${f.gust ?? '?'} mph, ${f.precip}" of precipitation`
      + `${f.snow ? ` (${f.snow}" snow)` : ''}, low of ${f.temp ?? '?'}°F. Open-Meteo forecast.`,
  }
}

/** Bands for an opponent's implied total, as a defensive matchup.
 *
 * Absolute, not relative to what happens to be available: 20 points is a soft offence and 25 a
 * dangerous one whatever else is on the wire. That means the table can come up mostly red, which
 * is the honest answer — the good matchups are the first thing claimed, so what is left over
 * skews hard. The few green cells are the point of the table.
 */
function band(v: number | null): 'good' | 'ok' | 'bad' | null {
  if (v == null) return null
  return v <= 20.5 ? 'good' : v >= 24.5 ? 'bad' : 'ok'
}
// The band fills the whole cell, opponent and number together, so a row reads as a strip of
// colour at a glance rather than as four small chips you have to look at one at a time. The
// opponent sits a shade lighter than the number so the number still leads.
const BAND = {
  good: { cell: 'bg-emerald-100/70', opp: 'text-emerald-700/70', num: 'text-emerald-900 font-semibold' },
  ok: { cell: 'bg-amber-100/60', opp: 'text-amber-700/70', num: 'text-amber-900' },
  bad: { cell: 'bg-red-100/60', opp: 'text-red-700/70', num: 'text-red-900' },
}

/** The number a week turns on: the opponent's implied total for a defence, the team's own for a
 * kicker. Null on a bye or an unpriced game. */
function basis(s: Streamer, pos: Pos, i: number): number | null {
  const g = s.weeks[i]
  if (!g?.matchup) return null
  return pos === 'DEF' ? g.opp_implied : g.implied
}
/** What orders the page: one week's Vegas number (the default), or FantasyPros' rank — for the
 * one week its K and D/ST pages cover, or for the rest of the season. */
type Order = 'week' | 'fp' | 'ros'

/** A unit's standing under the chosen order as a number where lower is better, so every
 * comparison on the page is one `<`. Null when it has none: a bye, an unpriced game, or a unit
 * FantasyPros did not rank. */
function score(s: Streamer, pos: Pos, order: Order, at: number): number | null {
  if (order === 'fp') return s.fp_rank
  if (order === 'ros') return s.fp_ros_rank
  const v = basis(s, pos, at)
  return v == null ? null : pos === 'DEF' ? v : -v
}

/** Rows best first under the chosen order, with nothing to rank on last. The server orders by the
 * first week's line; re-sorting here lets you plan a later week — on a Monday the first week is
 * already played — or read the table the way the experts rank it. Stable, so ties keep the
 * server's order. */
function sortBy(rows: Streamer[], pos: Pos, order: Order, at: number): Streamer[] {
  return [...rows].sort((a, b) => {
    const x = score(a, pos, order, at), y = score(b, pos, order, at)
    if (x == null || y == null) return x == null ? (y == null ? 0 : 1) : -1
    return x - y
  })
}

/** The best open unit in a league under the order, and how it compares with the best of yours:
 * `gain` is positive when it beats everything you have, in implied points or in rank places. */
function bestOpen(rows: Streamer[], leagueId: string, pos: Pos, order: Order, at: number) {
  const best = rows.find((s) => open(s.leagues[leagueId]) && score(s, pos, order, at) != null) ?? null
  if (!best) return null
  const mine = mineIn(rows, leagueId).map((s) => score(s, pos, order, at)).filter((v): v is number => v != null)
  const bar = mine.length ? Math.min(...mine) : null
  const v = score(best, pos, order, at)!
  return { best, gain: bar == null ? null : bar - v, up: bar == null || v < bar }
}

const open = (st: Standing | undefined) => st?.status === 'free' || st?.status === 'waivers'
const starting = (role: string) => !['BN', 'IR', 'TAXI'].includes(role)

/** Yours in one league, starters first. */
function mineIn(rows: Streamer[], leagueId: string): Streamer[] {
  const role = (s: Streamer) => { const st = s.leagues[leagueId]; return st?.status === 'mine' ? st.role : '' }
  return rows.filter((s) => s.leagues[leagueId]?.status === 'mine')
    .sort((a, b) => Number(starting(role(b))) - Number(starting(role(a))))
}

/** One week of a unit's schedule: who they play and the number that matters. */
function GameCell({ g, pos, lead }: { g: Streamer['weeks'][number] | undefined; pos: Pos; lead: boolean }) {
  const ring = lead ? 'ring-1 ring-inset ring-stone-400' : ''
  if (!g || !g.matchup) return <td className={`whitespace-nowrap px-2 py-1.5 text-center text-[11px] text-stone-300 ${ring}`}>bye</td>
  const v = pos === 'DEF' ? g.opp_implied : g.implied
  // A defence is graded on the band, which colours the cell. A kicker's cell is left plain and
  // only marks the offences priced to score — the kicker table is read down its own columns.
  const b = pos === 'DEF' ? band(v) : null
  const tone = b ? BAND[b] : null
  const kw = pos === 'K' ? kickerWeather(g.weather) : null
  const ex = pos === 'DEF' ? extremeWeather(g.weather) : null
  return (
    <td className={`whitespace-nowrap px-2 py-1.5 text-center ${tone?.cell ?? ''} ${ring}`}>
      <div className={`text-[11px] ${tone?.opp ?? 'text-stone-600'}`}>{g.matchup}</div>
      <div className={`mt-0.5 text-[11px] tabular-nums ${tone?.num ?? (pos === 'K' && v != null && v >= 25 ? 'font-semibold text-emerald-700' : 'text-stone-400')}`}>
        {v == null ? '—' : fmt(v, 1)}
      </div>
      {kw && <div title={kw.tip} className={`mt-0.5 text-[9.5px] leading-tight ${kw.tone}`}>{kw.text}</div>}
      {ex && <div title={ex.tip} className="mt-1 leading-none"><span className="rounded bg-stone-800 px-1 py-0.5 text-[9px] font-bold uppercase text-white">{ex.text}</span></div>}
    </td>
  )
}

function RolePill({ role }: { role: string }) {
  return starting(role)
    ? <span title="In your starting lineup" className="rounded bg-sky-600 px-1.5 py-0.5 text-[9.5px] font-bold leading-none text-white">START</span>
    : <span title={role === 'BN' ? 'On your bench' : role} className="rounded border border-sky-300 bg-white px-1.5 py-0.5 text-[9.5px] font-bold leading-none text-sky-700">{role === 'BN' ? 'BENCH' : role}</span>
}

function LeagueName({ lg, className = '' }: { lg: StreamingLeague; className?: string }) {
  return (
    <span className={`flex items-stretch gap-1.5 ${className}`}>
      <LeagueBar leagueId={lg.league_id} />
      <span className="flex min-w-0 items-center gap-1.5">
        <PlatformBadge platform={lg.platform} />
        <span className="truncate">{lg.name}</span>
      </span>
    </span>
  )
}

/** One unit's standing in one league — the cell that says where to go and get him, and the one
 * you click to make him your pick there. Anything you could start is clickable: an open unit, or
 * one of your own, which is how you record "keep what I have". */
function StandingCell({ s, st, lg, pos, week, picked, onPick }: {
  s: Streamer; st: Standing | undefined; lg: StreamingLeague; pos: Pos; week: number; picked: boolean; onPick: OnPick
}) {
  const base = `border-l border-stone-100 px-2 py-1.5 text-center ${picked ? 'bg-amber-100 ring-2 ring-inset ring-amber-400' : ''}`
  const again = picked ? ` Your week ${week} pick here — click again to clear it.` : ` Click to make him your week ${week} pick here.`
  if (!lg.slots[pos]) return <td className={base} title={`${lg.name} has no ${pos === 'K' ? 'kicker' : 'D/ST'} slot`}>{dash}</td>
  if (!st) return <td className={base}>{dash}</td>
  if (st.status === 'mine') {
    return (
      <td className={base}>
        <button onClick={() => onPick(lg.league_id, s)} title={`Yours in ${lg.name}.${again}`} className="rounded hover:ring-2 hover:ring-amber-300">
          <RolePill role={st.role} />
        </button>
      </td>
    )
  }
  if (st.status === 'taken') {
    return (
      <td className={base} title={`Rostered by ${st.owner}`}>
        <span className="mx-auto block max-w-[6rem] truncate text-[10.5px] text-stone-400">{st.owner}</span>
      </td>
    )
  }
  const w = st.status === 'waivers'
  const tip = (w
    ? `On waivers in ${lg.name}${st.until ? ` until ${shortDate(st.until)}` : ''} — a claim, not an instant add.`
    : `Free agent in ${lg.name}.${lg.platform === 'sleeper' ? " Sleeper doesn't publish waiver status, so once his game kicks off he may sit on waivers until the next run." : ''}`) + again
  return (
    <td className={base}>
      <button onClick={() => onPick(lg.league_id, s)} title={tip}
              className={`rounded border px-1.5 py-0.5 text-[10.5px] font-semibold leading-none ${w
                ? 'border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100'
                : 'border-emerald-300 bg-emerald-50 text-emerald-800 hover:bg-emerald-100'}`}>
        {w ? 'W' : 'FA'}{w && st.until ? <span className="ml-1 font-normal">{new Date(st.until).toLocaleDateString(undefined, { weekday: 'short' })}</span> : null}
      </button>
    </td>
  )
}

/** What you have at this position in every league, with the best thing still open there. */
function Yours({ pos, rows, leagues, weeks, at, order, pickOf, onPick }: {
  pos: Pos; rows: Streamer[]; leagues: StreamingLeague[]; weeks: number[]; at: number; order: Order; pickOf: PickOf; onPick: OnPick
}) {
  const label = pos === 'K' ? 'kicker' : 'D/ST'
  return (
    <div className="overflow-x-auto rounded-md border border-stone-200 bg-white">
      <table className="w-full min-w-[46rem] text-[12px]">
        <thead className="border-b border-stone-200">
          <tr>
            <th className={`${th} text-left`}>League</th>
            <th className={`${th} text-left`}>Yours</th>
            {weeks.map((w, i) => <th key={w} className={`${th} text-center ${i === 0 ? 'border-l border-stone-100' : ''} ${i === at ? 'text-stone-700' : ''}`}>Wk {w}</th>)}
            <th className={`${th} border-l border-stone-100 text-left`} title="The best unit still open in this league by whatever the tables are ordered on, and how far it beats (▲) or trails (▼) the best of yours by the same measure">
              Best open · {order === 'fp' ? `FantasyPros wk ${weeks[0]}` : order === 'ros' ? 'FantasyPros ROS' : `Wk ${weeks[at]}`}
            </th>
          </tr>
        </thead>
        <tbody>
          {leagues.map((lg) => {
            const lead = <td className="py-1.5 pl-2 pr-3 align-top" rowSpan={1}><LeagueName lg={lg} className="max-w-[12rem] text-[12px] font-medium text-stone-800" /></td>
            if (!lg.slots[pos]) {
              return (
                <tr key={lg.league_id} className="border-t border-stone-100">
                  {lead}
                  <td className="py-1.5 pr-3 text-[11px] text-stone-400" colSpan={weeks.length + 2}>No {label} slot in this league.</td>
                </tr>
              )
            }
            const mine = mineIn(rows, lg.league_id)
            const found = bestOpen(rows, lg.league_id, pos, order, at)
            const best = found?.best ?? null
            const up = !!found?.up
            const delta = found?.gain != null ? Math.abs(found.gain) : null
            // FantasyPros' weekly rank is for the first week only, so that is the matchup to show.
            const wi = order === 'fp' ? 0 : at
            const bv = best ? basis(best, pos, wi) : null
            const unit = order === 'week' ? 'implied points' : `place${delta === 1 ? '' : 's'} in the FantasyPros ${order === 'ros' ? 'rest-of-season' : 'weekly'} rank`
            const bestSt = best?.leagues[lg.league_id]
            const bestCell = (
              <td className="border-l border-stone-100 py-1.5 pl-2 pr-3 align-top" rowSpan={Math.max(1, mine.length)}>
                {!best ? <span className="text-[11px] text-stone-400">{order === 'week' ? 'Nothing open with a game' : 'Nothing open that FantasyPros ranks'}</span> : (
                  <span className={`flex items-center gap-2 ${up ? '' : 'opacity-60'}`}>
                    {pickOf(lg.league_id, pos, weeks[at]) === best.player_id
                      ? <button onClick={() => onPick(lg.league_id, best)} title={`Your week ${weeks[at]} pick here — click to clear it`}
                                className="rounded border border-amber-400 bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-900">✓ Pick</button>
                      : <button onClick={() => onPick(lg.league_id, best)} title={`Make this your week ${weeks[at]} pick in ${lg.name}`}
                                className="rounded border border-stone-300 px-1.5 py-0.5 text-[10px] text-stone-700 hover:border-amber-400 hover:bg-amber-50">Pick</button>}
                    <PlayerCell p={best} />
                    <span className="text-[11px] text-stone-500">{best.weeks[wi]?.matchup ?? 'bye'}</span>
                    {bv != null && <span className={`rounded px-1 py-0.5 text-[11px] tabular-nums ${pos === 'DEF' && band(bv) ? `${BAND[band(bv)!].cell} ${BAND[band(bv)!].num}` : 'text-stone-700'}`}>{fmt(bv, 1)}</span>}
                    {order !== 'week' && <span className="text-[11px] font-semibold tabular-nums text-violet-700">{order === 'fp' ? 'FP' : 'ROS'} #{order === 'fp' ? best.fp_rank : best.fp_ros_rank}</span>}
                    {delta != null && (up
                      ? <span className="text-[11px] font-semibold text-emerald-700" title={`Better than your best by ${fmt(delta, order === 'week' ? 1 : 0)} ${unit}`}>▲{fmt(delta, order === 'week' ? 1 : 0)}</span>
                      : <span className="text-[11px] text-stone-500" title={`Behind your best by ${fmt(delta, order === 'week' ? 1 : 0)} ${unit}`}>▼{fmt(delta, order === 'week' ? 1 : 0)}</span>)}
                    {bestSt?.status === 'waivers' && <span className="rounded bg-amber-100 px-1 py-0.5 text-[9.5px] font-semibold leading-none text-amber-800">W</span>}
                  </span>
                )}
              </td>
            )
            if (!mine.length) {
              return (
                <tr key={lg.league_id} className="border-t border-stone-100">
                  {lead}
                  <td className="py-1.5 pr-3 text-[11px] font-medium text-amber-700">None rostered</td>
                  <td colSpan={weeks.length} className="border-l border-stone-100" />
                  {bestCell}
                </tr>
              )
            }
            return mine.map((s, n) => {
              const st = s.leagues[lg.league_id]
              return (
                <tr key={`${lg.league_id}:${s.player_id}`} className={n === 0 ? 'border-t border-stone-100' : ''}>
                  {n === 0 && <td className="py-1.5 pl-2 pr-3 align-top" rowSpan={mine.length}><LeagueName lg={lg} className="max-w-[12rem] text-[12px] font-medium text-stone-800" /></td>}
                  <td className="whitespace-nowrap py-1.5 pr-3">
                    <span className="inline-flex items-center gap-1.5">
                      {st?.status === 'mine' && <RolePill role={st.role} />}
                      <PlayerCell p={s} />
                    </span>
                  </td>
                  {s.weeks.map((g, i) => <GameCell key={g.week} g={g} pos={pos} lead={i === at} />)}
                  {n === 0 && bestCell}
                </tr>
              )
            })
          })}
        </tbody>
      </table>
    </div>
  )
}

/** Every unit at the position: its next four weeks, then where it stands in each league. */
function Matrix({ pos, rows, leagues, weeks, at, setAt, order, setOrder, pickOf, onPick }: {
  pos: Pos; rows: Streamer[]; leagues: StreamingLeague[]; weeks: number[]; at: number; setAt: (i: number) => void
  order: Order; setOrder: (o: Order) => void; pickOf: PickOf; onPick: OnPick
}) {
  const hasFp = rows.some((s) => s.fp_rank != null)
  const hasRos = rows.some((s) => s.fp_ros_rank != null)
  const sortBtn = (active: boolean) => `whitespace-nowrap rounded px-1.5 py-0.5 uppercase disabled:cursor-default disabled:opacity-40 ${active ? 'bg-stone-900 text-white' : 'hover:bg-stone-100 hover:text-stone-700 disabled:hover:bg-transparent'}`
  const k = pos === 'K'
  return (
    <div className="overflow-x-auto rounded-md border border-stone-200 bg-white">
      <table className="w-full min-w-[60rem] text-[12px]">
        <thead className="border-b border-stone-200">
          <tr>
            <th className={`${th} text-left`} rowSpan={2}>{k ? 'Kicker' : 'Defense'}</th>
            <th className={`${th} border-l border-stone-100 text-center`} colSpan={weeks.length}>
              {k ? 'Own team implied total — higher is better' : 'Opponent implied total — lower is better'}
            </th>
            <th className={`${th} border-l border-stone-100 text-center`} colSpan={leagues.length}>Your leagues</th>
            <th className={`${th} border-l border-stone-100 text-center`} colSpan={2} title="FantasyPros expert consensus. Click Wk or ROS to order the table by it instead of by Vegas — where the two disagree is the thing to look at.">FantasyPros</th>
            {k && <th className={`${th} border-l border-stone-100 text-center`} colSpan={5}>Offense, season to date</th>}
          </tr>
          <tr>
            {weeks.map((w, i) => (
              <th key={w} className={`${th} text-center ${i === 0 ? 'border-l border-stone-100' : ''}`}>
                <button onClick={() => { setAt(i); setOrder('week') }}
                        title={order === 'week' ? `Order by week ${w}` : i === at ? `Picking for week ${w} — click to order by its line again` : `Order by week ${w}`}
                        className={`${sortBtn(order === 'week' && i === at)} ${order !== 'week' && i === at ? 'ring-1 ring-stone-400' : ''}`}>
                  Wk {w}{order === 'week' && i === at ? ' ▾' : ''}
                </button>
              </th>
            ))}
            {leagues.map((lg) => (
              <th key={lg.league_id} className="border-l border-stone-100 px-2 py-1 text-[10.5px] font-medium normal-case text-stone-600" title={lg.name}>
                <span className="mx-auto flex max-w-[6.5rem] items-stretch gap-1.5 text-left">
                  <LeagueBar leagueId={lg.league_id} />
                  <span className="min-w-0">
                    <PlatformBadge platform={lg.platform} />
                    <span className="mt-0.5 block truncate">{lg.name}</span>
                  </span>
                </span>
              </th>
            ))}
            <th className={`${th} border-l border-stone-100 text-center`}>
              <button onClick={() => setOrder('fp')} disabled={!hasFp} className={sortBtn(order === 'fp')}
                      title={hasFp ? `FantasyPros' rank for week ${weeks[0]} only — click to order by it` : `No FantasyPros ranks for week ${weeks[0]} yet — run update-fantasypros-data`}>
                Wk{order === 'fp' ? ' ▾' : ''}
              </button>
            </th>
            <th className={`${th} text-center`}>
              <button onClick={() => setOrder('ros')} disabled={!hasRos} className={sortBtn(order === 'ros')}
                      title="Rest-of-season rank — who is worth holding rather than who is best this Sunday. Click to order by it.">
                ROS{order === 'ros' ? ' ▾' : ''}
              </button>
            </th>
            {k && <>
              <th className={`${th} border-l border-stone-100 text-center`} title="Share of red-zone trips ending in a touchdown. LOW is good for a kicker — a team that stalls inside the 20 kicks three points instead of scoring six and leaving him the extra point.">RZ TD</th>
              <th className={`${th} text-center`} title="Share of red-zone trips ending in a field-goal attempt. The same split read from the kicker's side, so high is good.">RZ FG</th>
              <th className={`${th} text-center`} title="Third-down conversion rate. Drives that stay alive are drives that reach field-goal range — though they also reach the end zone, so read it alongside the red-zone split rather than on its own.">3rd</th>
              <th className={`${th} text-center`} title="Fourth-down attempts per game. The only factor here that actively removes kicks — every fourth down the staff goes for is a field goal that never happened. Low is good.">4th/g</th>
              <th className={`${th} text-center`} title="Field-goal attempts per game, and the split short (under 40 yards) · long (40+). The most direct measure there is — every factor beside it ends up here — and the split is what your league's distance scoring actually pays on.">FGA/g</th>
            </>}
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => {
            const f: TeamFactors | null = s.factors
            // Out of reach everywhere and not yours: kept for the schedule context, but quiet.
            const shut = !s.mine && !leagues.some((lg) => lg.slots[pos] && open(s.leagues[lg.league_id]))
            return (
              <tr key={s.player_id} className={`border-t border-stone-100 ${s.mine ? 'bg-sky-50/40' : ''} ${shut ? 'opacity-45' : ''}`}>
                <td className={`whitespace-nowrap py-1.5 pr-3 ${s.mine ? 'border-l-2 border-sky-500 pl-2.5' : 'pl-3'}`}>
                  <PlayerCell p={s} />
                </td>
                {s.weeks.map((g, n) => <GameCell key={g.week} g={g} pos={pos} lead={n === at} />)}
                {leagues.map((lg) => (
                  <StandingCell key={lg.league_id} s={s} st={s.leagues[lg.league_id]} lg={lg} pos={pos} week={weeks[at]}
                                picked={pickOf(lg.league_id, pos, weeks[at]) === s.player_id} onPick={onPick} />
                ))}
                <td className="border-l border-stone-100 px-2 py-1.5 text-center tabular-nums">
                  {s.fp_rank == null ? dash : <span className={s.fp_rank <= 5 ? 'font-semibold text-violet-800' : 'text-violet-700'}>{s.fp_rank}</span>}
                </td>
                <td className="px-2 py-1.5 text-center tabular-nums">
                  {s.fp_ros_rank == null ? dash : <span className={s.fp_ros_rank <= 8 ? 'font-semibold text-violet-800' : 'text-violet-700'}>{s.fp_ros_rank}</span>}
                </td>
                {k && <>
                  <td className="border-l border-stone-100 px-2 py-1.5 text-center tabular-nums">
                    {f?.rz_td_pct == null ? dash : <span className={f.rz_td_pct <= 40 ? 'font-semibold text-emerald-700' : 'text-stone-600'}>{fmt(f.rz_td_pct, 0)}%</span>}
                  </td>
                  <td className="px-2 py-1.5 text-center tabular-nums">
                    {f?.rz_fg_pct == null ? dash : <span className={f.rz_fg_pct >= 50 ? 'font-semibold text-emerald-700' : 'text-stone-600'}>{fmt(f.rz_fg_pct, 0)}%</span>}
                  </td>
                  <td className="px-2 py-1.5 text-center tabular-nums">
                    {f?.third_pct == null ? dash : <span className={f.third_pct >= 45 ? 'font-semibold text-emerald-700' : 'text-stone-600'}>{fmt(f.third_pct, 0)}%</span>}
                  </td>
                  <td className="px-2 py-1.5 text-center tabular-nums">
                    {f?.fourth_att_pg == null ? dash : <span className={f.fourth_att_pg <= 1 ? 'font-semibold text-emerald-700' : 'text-stone-600'}>{fmt(f.fourth_att_pg, 1)}</span>}
                  </td>
                  <td className="px-2 py-1.5 text-center tabular-nums text-stone-700">
                    {f?.fg_att_pg == null ? dash : <><span className={f.fg_att_pg >= 2.5 ? 'font-semibold text-emerald-700' : ''}>{fmt(f.fg_att_pg, 1)}</span><span className="ml-1 text-[10px] text-stone-400">({f.fg_att_short ?? 0}·{f.fg_att_long ?? 0})</span></>}
                  </td>
                </>}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/** What a pick asks of you, read off the rosters rather than stored: nothing (it is already in your
 * lineup), a lineup change, an add or a claim, or a re-pick because someone else got there first. */
function pickStatus(s: Streamer, leagueId: string, prev: Streamer | null): { label: string; tone: string; tip: string } {
  const st = s.leagues[leagueId]
  if (st?.status === 'mine') {
    return starting(st.role)
      ? { label: '✓ set', tone: 'bg-sky-600 text-white', tip: 'Yours and in your lineup — nothing to do.' }
      : { label: 'start', tone: 'border border-sky-300 bg-white text-sky-700', tip: `Yours but ${st.role === 'BN' ? 'on your bench' : st.role} — put him in the lineup.` }
  }
  // Carried from an earlier week's pick you have not made yet: nothing new to do for this week.
  if (prev?.player_id === s.player_id) return { label: 'keep', tone: 'bg-stone-100 text-stone-600', tip: 'Same as your pick the week before — no new move.' }
  if (st?.status === 'free') return { label: 'add', tone: 'border border-emerald-300 bg-emerald-50 text-emerald-800', tip: 'Free agent — add him.' }
  if (st?.status === 'waivers') {
    return { label: 'claim', tone: 'border border-amber-300 bg-amber-50 text-amber-800', tip: `On waivers${st.until ? ` until ${shortDate(st.until)}` : ''} — put in a claim.` }
  }
  if (st?.status === 'taken') return { label: 'gone', tone: 'bg-red-100 text-red-800', tip: `Rostered by ${st.owner} now — pick someone else.` }
  return { label: '?', tone: 'bg-stone-100 text-stone-500', tip: 'No longer in the table.' }
}

/** The planner: your pick for every league, at both positions, for each of the four weeks. Both
 * positions at once, because this is the list you work through league by league when you go and
 * make the moves, and a league's kicker and defence are made in the same sitting.
 *
 * A week without a pick shows, faintly, who you would have anyway — the latest earlier pick, or
 * failing that the one on your roster now — so the grid always reads as "who I start each week". */
function PickBoard({ data, at, setAt, pickOf, onClear }: {
  data: StreamingResponse; at: number; setAt: (i: number) => void; pickOf: PickOf; onClear: (leagueId: string, pos: Pos, week: number) => void
}) {
  const { weeks, leagues } = data
  const byId = useMemo(() => ({
    DEF: new Map(data.DEF.map((s) => [s.player_id, s])),
    K: new Map(data.K.map((s) => [s.player_id, s])),
  }), [data])
  const current = (lid: string, pos: Pos) => mineIn(data[pos], lid)[0] ?? null
  const held = (lid: string, pos: Pos, i: number): Streamer | null => {
    for (let j = i; j >= 0; j--) {
      const id = pickOf(lid, pos, weeks[j])
      if (id) return byId[pos].get(id) ?? null
    }
    return current(lid, pos)
  }
  const lines = leagues.flatMap((lg) => (['DEF', 'K'] as const).filter((pos) => lg.slots[pos]).map((pos) => ({ lg, pos })))
  const count = lines.reduce((n, { lg, pos }) => n + (pickOf(lg.league_id, pos, weeks[at]) ? 1 : 0), 0)

  return (
    <div className="overflow-x-auto rounded-md border border-stone-200 bg-white">
      <table className="w-full min-w-[52rem] text-[12px]">
        <thead className="border-b border-stone-200">
          <tr>
            <th className={`${th} text-left`}>League</th>
            <th className={`${th} text-left`} />
            {weeks.map((w, i) => (
              <th key={w} className={`${th} border-l border-stone-100 text-left`}>
                <button onClick={() => setAt(i)} title={`Pick for week ${w}`}
                        className={`whitespace-nowrap rounded px-1.5 py-0.5 uppercase ${i === at ? 'bg-stone-900 text-white' : 'hover:bg-stone-100 hover:text-stone-700'}`}>
                  Wk {w}{i === at ? ` · ${count}/${lines.length} picked` : ''}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {lines.map(({ lg, pos }, n) => {
            const first = n === 0 || lines[n - 1].lg !== lg
            const span = lines.filter((l) => l.lg === lg).length
            return (
              <tr key={`${lg.league_id}:${pos}`} className={first ? 'border-t border-stone-200' : 'border-t border-stone-100'}>
                {first && <td className="py-1.5 pl-2 pr-3 align-top" rowSpan={span}><LeagueName lg={lg} className="max-w-[12rem] text-[12px] font-medium text-stone-800" /></td>}
                <td className="whitespace-nowrap pr-2 text-[10px] font-semibold uppercase tracking-wide text-stone-400">{pos === 'DEF' ? 'D/ST' : 'K'}</td>
                {weeks.map((w, i) => {
                  const id = pickOf(lg.league_id, pos, w)
                  const cls = `border-l border-stone-100 px-2 py-1.5 align-top ${i === at ? 'bg-amber-50/60' : ''}`
                  if (!id) {
                    const h = held(lg.league_id, pos, i)
                    return (
                      <td key={w} className={cls} title={h ? `No pick for week ${w} — as things stand you would have ${h.name}` : `No pick for week ${w}`}>
                        <span className="text-[11px] text-stone-300">{h ? h.name : '—'}</span>
                      </td>
                    )
                  }
                  const s = byId[pos].get(id)
                  if (!s) {
                    return (
                      <td key={w} className={cls}>
                        <span className="text-[11px] text-stone-500">{id}</span>
                        <button onClick={() => onClear(lg.league_id, pos, w)} className="ml-1 text-stone-300 hover:text-red-600" title="Clear this pick">×</button>
                      </td>
                    )
                  }
                  const prev = i === 0 ? current(lg.league_id, pos) : held(lg.league_id, pos, i - 1)
                  const status = pickStatus(s, lg.league_id, prev)
                  const g = s.weeks[i]
                  const v = basis(s, pos, i)
                  const b = pos === 'DEF' ? band(v) : null
                  const swap = (status.label === 'add' || status.label === 'claim') && prev && prev.player_id !== s.player_id
                  return (
                    <td key={w} className={cls}>
                      <div className="flex items-center gap-1">
                        <span className="truncate font-medium text-stone-900">{s.name}</span>
                        <button onClick={() => onClear(lg.league_id, pos, w)} className="ml-auto px-0.5 text-stone-300 hover:text-red-600" title="Clear this pick">×</button>
                      </div>
                      <div className="mt-0.5 flex items-center gap-1.5 whitespace-nowrap text-[10.5px]">
                        <span title={status.tip} className={`rounded px-1 py-0.5 text-[9.5px] font-bold uppercase leading-none ${status.tone}`}>{status.label}</span>
                        <span className="text-stone-500">{g?.matchup ?? 'bye'}</span>
                        {v != null && <span className={`rounded px-1 tabular-nums ${b ? `${BAND[b].cell} ${BAND[b].num}` : 'text-stone-700'}`}>{fmt(v, 1)}</span>}
                      </div>
                      {swap && <div className="mt-0.5 truncate text-[10px] text-stone-400">drop {prev!.name}</div>}
                    </td>
                  )
                })}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/** Kickers and defences across every league at once, which is how streaming actually works: the
 * same handful of good matchups is on offer everywhere, and the question is which of them is
 * still open where. So the page leads with your picks and what you have in each league, and under
 * them one table per position with a row per unit and a column per league.
 *
 * They get a tab each because they are not the same decision. A defence is a weekly matchup
 * play — you read the schedule and take the soft spot. A kicker is mostly a hold: his points
 * follow his offence's volume, not who it is playing, so the columns that matter are about the
 * offence rather than the opponent. */
export default function Streaming() {
  const qc = useQueryClient()
  const [tab, setTab] = useState<Pos>('DEF')
  const [at, setAt] = useState(0)
  const [order, setOrder] = useState<Order>('week')
  const { data, isLoading, error } = useQuery({
    queryKey: ['streaming'],
    queryFn: () => api.streaming(),
    staleTime: 60_000,
  })
  const { data: picks } = useQuery({ queryKey: ['stream-picks'], queryFn: api.streamPicks })
  const save = useMutation({
    mutationFn: ({ player_id, ...key }: { league_id: string; position: Pos; week: number; player_id: string | null }) =>
      player_id ? api.setStreamPick({ ...key, player_id }) : api.clearStreamPick(key),
    onSuccess: (list) => qc.setQueryData(['stream-picks'], list),
  })
  const weeks = data?.weeks ?? []
  const week = Math.min(at, Math.max(0, weeks.length - 1))
  const sorted = useMemo(() => ({
    DEF: data ? sortBy(data.DEF, 'DEF', order, week) : [],
    K: data ? sortBy(data.K, 'K', order, week) : [],
  }), [data, order, week])

  const pickOf: PickOf = (leagueId, pos, w) =>
    picks?.find((p) => p.league_id === leagueId && p.position === pos && p.week === w)?.player_id ?? null
  // Clicking a unit makes it your pick for the week being viewed; clicking your current pick again
  // clears it. One pick per league, position and week, so a new one replaces the old.
  const onPick = (pos: Pos): OnPick => (leagueId, s) => {
    const w = weeks[week]
    save.mutate({ league_id: leagueId, position: pos, week: w, player_id: pickOf(leagueId, pos, w) === s.player_id ? null : s.player_id })
  }
  const onClear = (leagueId: string, pos: Pos, w: number) => save.mutate({ league_id: leagueId, position: pos, week: w, player_id: null })
  // Leagues where something open beats everything you have at the position, for the tab badges.
  const upgrades = (pos: Pos) => (data?.leagues ?? [])
    .filter((lg) => lg.slots[pos] && bestOpen(sorted[pos], lg.league_id, pos, order, week)?.up).length
  const orderedBy = order === 'fp' ? `FantasyPros' week ${weeks[0]} rank` : order === 'ros' ? "FantasyPros' rest-of-season rank" : `week ${weeks[week]}'s line`
  const games = data?.K.find((s) => s.factors?.games != null)?.factors?.games ?? null

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <h1 className="text-base font-semibold">Streaming D/ST + K · all leagues</h1>
        {weeks.length > 0 && <span className="ml-auto text-[12px] text-stone-500">Weeks {weeks.join(', ')} · every unit, and where it is open</span>}
      </div>

      {isLoading && <Spinner label="Pulling lines and rosters for every league…" />}
      {error && <ErrorBox error={error} />}
      {save.error && <ErrorBox error={save.error} />}

      {data && (
        <section className="space-y-1.5">
          <h2 className="text-[12px] font-semibold uppercase tracking-wide text-stone-500">Your picks</h2>
          <p className="text-[12px] text-stone-500">
            Click a unit's <span className="font-semibold text-emerald-700">FA</span>, <span className="font-semibold text-amber-700">W</span> or
            {' '}<span className="font-semibold text-sky-700">START</span> / bench cell in the tables below to make him your week {weeks[week]} pick in that league,
            and again to clear it. Pick another week by clicking its header. Each pick says what it still takes — add, claim, start — and
            turns to <span className="font-semibold text-sky-700">✓ set</span> by itself once you have made the move and he is in your lineup.
          </p>
          <PickBoard data={data} at={week} setAt={setAt} pickOf={pickOf} onClear={onClear} />
        </section>
      )}

      <div className="flex flex-wrap items-center gap-3 pt-1">
        <div className="flex rounded-md border border-stone-200 bg-white p-0.5">
          {([['DEF', 'Defense / ST'], ['K', 'Kickers']] as const).map(([key, label]) => {
            const n = data ? upgrades(key) : 0
            return (
              <button key={key} onClick={() => setTab(key)}
                      className={`rounded px-3 py-1 text-[12px] ${tab === key ? 'bg-stone-900 text-white' : 'text-stone-700 hover:bg-stone-100'}`}>
                {label}
                {n > 0 && <span title={`${n} league${n === 1 ? '' : 's'} with something open that beats yours on ${orderedBy}`}
                                className={`ml-1.5 ${tab === key ? 'text-emerald-300' : 'text-emerald-700'}`}>▲{n}</span>}
              </button>
            )
          })}
        </div>
        {tab === 'DEF' && (
          <span className="flex items-center gap-1.5 text-[11px]">
            <span className="rounded bg-emerald-100/70 px-1.5 py-0.5 font-semibold text-emerald-900">≤20.5 soft</span>
            <span className="rounded bg-amber-100/60 px-1.5 py-0.5 text-amber-900">20.5–24.5</span>
            <span className="rounded bg-red-100/60 px-1.5 py-0.5 text-red-900">≥24.5 avoid</span>
          </span>
        )}
      </div>

      {data && (
        <>
          <section className="space-y-1.5">
            <h2 className="text-[12px] font-semibold uppercase tracking-wide text-stone-500">Yours, by league</h2>
            <Yours pos={tab} rows={sorted[tab]} leagues={data.leagues} weeks={weeks} at={week} order={order} pickOf={pickOf} onPick={onPick(tab)} />
          </section>

          <section className="space-y-1.5">
            <h2 className="text-[12px] font-semibold uppercase tracking-wide text-stone-500">{tab === 'K' ? 'Every kicker' : 'Every defense'}</h2>
            <p className="text-[12px] text-stone-500">
              {tab === 'DEF'
                ? <>{order === 'week'
                    ? <>Ordered by the opponent's implied total in week {weeks[week]}, lowest first — a defence scores off the other team failing. Click a week to order by it instead, or the FantasyPros Wk / ROS headers to order by the experts.</>
                    : <>Ordered by {orderedBy}, best first — click a week to go back to ordering by the line.</>}
                  A <span className="rounded bg-stone-800 px-1 text-[10px] font-bold uppercase text-white">dark tag</span> flags extreme weather in the forecast (20+ mph wind, 35+ mph gusts, snow or heavy rain) — ordinary weather is already in the line.</>
                : <>{order === 'week'
                    ? <>Ordered by the kicker's own team implied total in week {weeks[week]}, highest first — click a week to order by it instead, or the FantasyPros Wk / ROS headers to order by the experts.</>
                    : <>Ordered by {orderedBy}, best first — click a week to go back to ordering by the line.</>}
                  {' '}A kicker's points follow his offence's <em>volume</em> rather than who it is playing, so the right-hand columns describe the offence: how often it stalls in the red zone, how well it sustains drives, how often the staff takes the kick away on fourth down, and what that adds up to in attempts.
                  {games != null && <> Season to date — <span className="font-medium text-stone-600">{games} game{games === 1 ? '' : 's'}</span>, so read the rates as a first signal.</>}
                  {' '}Limited to the kickers FantasyPros ranks this week, plus yours.
                  {' '}Under each game: <span className="text-stone-600">⌂ dome</span> or <span className="text-stone-600">⌂ roof</span> (retractable) indoors, otherwise the forecast wind in mph, gusts, rain or snow and freezing temperatures —
                  {' '}<span className="text-amber-700">amber</span> from 12 mph wind or 22 mph gusts, <span className="font-semibold text-red-700">red</span> from 18 mph or 30 mph gusts. Forecasts appear within a week of kickoff.</>}
              {' '}Each league column says whether he is yours (<span className="font-semibold text-sky-700">START</span> / bench), open
              (<span className="font-semibold text-emerald-700">FA</span>, or <span className="font-semibold text-amber-700">W</span> on waivers), or whose he is;
              your pick for the week is outlined in <span className="rounded bg-amber-100 px-1 font-semibold text-amber-900 ring-1 ring-amber-400">amber</span>. Rows open nowhere are faded.
            </p>
            <Matrix pos={tab} rows={sorted[tab]} leagues={data.leagues} weeks={weeks} at={week} setAt={setAt} order={order} setOrder={setOrder} pickOf={pickOf} onPick={onPick(tab)} />
          </section>
        </>
      )}
    </div>
  )
}
