import { useQuery } from '@tanstack/react-query'
import { api, type Player, type Streamer, type TeamFactors } from '../api'
import { fmt, pct } from '../lib/format'
import { useApp } from '../components/AppContext'
import { ErrorBox, LeagueBar, PlatformBadge, PlayerCell, Spinner } from '../components/Badges'

const dash = <span className="text-stone-300">·</span>

/** One week of a streamer's schedule, as a cell: who they play and the number that matters. */
function GameCell({ g, pos, lead }: { g: { matchup: string | null; implied: number | null; opp_implied: number | null } | undefined; pos: 'K' | 'DEF'; lead: boolean }) {
  if (!g || !g.matchup) return <td className="px-2 py-1.5 text-center text-[11px] text-stone-300">bye</td>
  const v = pos === 'DEF' ? g.opp_implied : g.implied
  // Green marks a spot worth taking: a defence facing an offence priced under 19, a kicker on
  // one priced over 25. Read off the line only — FantasyPros has its own columns.
  const good = v != null && (pos === 'DEF' ? v <= 19 : v >= 25)
  return (
    <td className={`px-2 py-1.5 text-center ${lead ? 'bg-stone-50/70' : ''}`}>
      <div className="text-[11px] text-stone-600">{g.matchup}</div>
      <div className={`text-[11px] tabular-nums ${good ? 'font-semibold text-emerald-700' : 'text-stone-400'}`}>{v == null ? '—' : fmt(v, 1)}</div>
    </td>
  )
}

/** A number that reads better the lower it is, or the higher — shaded so the good end stands out. */
function Rate({ v, good, suffix = '%' }: { v: number | null | undefined; good?: 'high' | 'low'; suffix?: string }) {
  if (v == null) return dash
  const strong = good === 'high' ? v >= 60 : good === 'low' ? v <= 40 : false
  return <span className={strong ? 'font-semibold text-emerald-700' : 'text-stone-600'}>{fmt(v, v >= 10 ? 0 : 1)}{suffix}</span>
}

function StreamTable({ pos, rows, weeks, onPlan }: { pos: 'K' | 'DEF'; rows: Streamer[]; weeks: number[]; onPlan?: (p: Player) => void }) {
  if (!rows.length) return <p className="rounded-md border border-stone-200 bg-white p-3 text-[12px] text-stone-500">Nothing available at this position.</p>
  const th = 'px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-stone-400'
  return (
    <div className="overflow-x-auto rounded-md border border-stone-200 bg-white">
      <table className="w-full min-w-[54rem] text-[12px]">
        <thead className="border-b border-stone-200">
          <tr>
            <th className={`${th} text-left`} rowSpan={2}>{pos === 'DEF' ? 'Defense' : 'Kicker'}</th>
            <th className={`${th} border-l border-stone-100 text-center`} colSpan={weeks.length}>
              {pos === 'DEF' ? 'Opponent implied total — lower is better' : 'Own team implied total — higher is better'}
            </th>
            <th className={`${th} border-l border-stone-100 text-center`} colSpan={2} title="FantasyPros expert consensus. Not part of the ordering — this table is ranked on Vegas alone, and where the two disagree is the thing to look at.">FantasyPros</th>
            {pos === 'K' && <th className={`${th} border-l border-stone-100 text-center`} colSpan={5}>Offense, season to date</th>}
            <th className={`${th} border-l border-stone-100 text-right`} rowSpan={2}>Own%</th>
            <th className="w-8" rowSpan={2} />
          </tr>
          <tr>
            {weeks.map((w, i) => <th key={w} className={`${th} text-center ${i === 0 ? 'border-l border-stone-100' : ''}`}>Wk {w}</th>)}
            <th className={`${th} border-l border-stone-100 text-center`} title="Rank for this week only">Wk</th>
            <th className={`${th} text-center`} title="Rest-of-season rank — who is worth holding rather than who is best this Sunday">ROS</th>
            {pos === 'K' && <>
              <th className={`${th} border-l border-stone-100 text-center`} title="Share of red-zone trips ending in a touchdown. LOW is good for a kicker — a team that stalls inside the 20 kicks 3 points instead of scoring 6 and handing him the extra point.">RZ TD</th>
              <th className={`${th} text-center`} title="Share of red-zone trips ending in a field-goal attempt. The same split read from the kicker's side, so high is good.">RZ FG</th>
              <th className={`${th} text-center`} title="Third-down conversion rate. Drives that stay alive are drives that reach field-goal range, so high is good.">3rd</th>
              <th className={`${th} text-center`} title="Fourth-down attempts per game. Coaching aggressiveness — every fourth down the staff goes for is a field goal that never happened, so low is good.">4th/g</th>
              <th className={`${th} text-center`} title="Field-goal attempts per game so far, and the split short (under 40) / long (40+). Leagues that pay more for longer kicks make the split matter, not just the count.">FGA/g</th>
            </>}
          </tr>
        </thead>
        <tbody>
          {rows.map((s, i) => {
            const f: TeamFactors | null = s.factors
            const wx = s.weeks[0]?.weather
            return (
              <tr key={s.player_id} className={`border-t border-stone-100 ${i === 0 ? 'bg-emerald-50/60' : ''}`}>
                <td className="px-3 py-1.5">
                  <span className="inline-flex items-center gap-1.5">
                    {i === 0 && <span className="rounded bg-emerald-600 px-1 py-0.5 text-[9px] font-bold leading-none text-white">1</span>}
                    <PlayerCell p={s} />
                    {wx?.summary && (
                      <span title={`Forecast for this week's game${wx.temperature != null ? ` — ${wx.temperature}°F` : ''}. ESPN publishes no forecast for later weeks, and carries no wind.`}
                            className="rounded bg-sky-50 px-1 py-0.5 text-[9px] font-medium leading-none text-sky-700">{wx.summary}</span>
                    )}
                  </span>
                </td>
                {s.weeks.map((g, n) => <GameCell key={g.week} g={g} pos={pos} lead={n === 0} />)}
                <td className="border-l border-stone-100 px-2 py-1.5 text-center tabular-nums">
                  {s.fp_rank == null ? dash : <span className={s.fp_rank <= 5 ? 'font-semibold text-violet-800' : 'text-violet-700'}>{s.fp_rank}</span>}
                </td>
                <td className="px-2 py-1.5 text-center tabular-nums">
                  {s.fp_ros_rank == null ? dash : <span className={s.fp_ros_rank <= 8 ? 'font-semibold text-violet-800' : 'text-violet-700'}>{s.fp_ros_rank}</span>}
                </td>
                {pos === 'K' && <>
                  <td className="border-l border-stone-100 px-2 py-1.5 text-center tabular-nums"><Rate v={f?.rz_td_pct} good="low" /></td>
                  <td className="px-2 py-1.5 text-center tabular-nums"><Rate v={f?.rz_fg_pct} good="high" /></td>
                  <td className="px-2 py-1.5 text-center tabular-nums"><Rate v={f?.third_pct} good="high" /></td>
                  <td className="px-2 py-1.5 text-center tabular-nums">{f?.fourth_att_pg == null ? dash : <span className={f.fourth_att_pg <= 1 ? 'font-semibold text-emerald-700' : 'text-stone-600'}>{fmt(f.fourth_att_pg, 1)}</span>}</td>
                  <td className="px-2 py-1.5 text-center tabular-nums text-stone-600">
                    {f?.fg_att_pg == null ? dash : <>{fmt(f.fg_att_pg, 1)}<span className="ml-1 text-[10px] text-stone-400">({f.fg_att_short ?? 0}·{f.fg_att_long ?? 0})</span></>}
                  </td>
                </>}
                <td className="border-l border-stone-100 px-2 py-1.5 text-right text-stone-500">{pct(s.owned)}</td>
                <td className="pr-2">
                  {onPlan && <button onClick={() => onPlan(s)} className="rounded border border-stone-300 px-1.5 py-0.5 text-[10px] text-stone-700 hover:border-amber-400 hover:bg-amber-50">+</button>}
                </td>
              </tr>
            )
          })}
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
  const weeks = data?.stream_weeks ?? []
  const games = data?.streamers.K[0]?.factors?.games ?? null

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <h1 className="flex items-stretch gap-2 text-base font-semibold">
          <LeagueBar leagueId={league.league_id} />
          <span className="flex items-center gap-2"><PlatformBadge platform={league.platform} />Streaming · {league.name}</span>
        </h1>
        {weeks.length > 0 && <span className="ml-auto text-[12px] text-stone-500">Weeks {weeks.join(', ')} · available only</span>}
      </div>

      {isLoading && <Spinner label="Pulling lines for the next few weeks…" />}
      {error && <ErrorBox error={error} />}

      {data && (
        <>
          <section className="space-y-2">
            <h2 className="text-[13px] font-semibold text-stone-800">Defence / Special teams</h2>
            <p className="text-[12px] text-stone-500">
              Ordered by this week's opponent implied total, lowest first — a defence scores off the other team failing.
              The next {weeks.length} weeks run across each row so you can take a good matchup before someone else does.
            </p>
            <StreamTable pos="DEF" rows={data.streamers.DEF} weeks={weeks} onPlan={onPlan} />
          </section>

          <section className="space-y-2 pt-1">
            <h2 className="text-[13px] font-semibold text-stone-800">Kickers</h2>
            <p className="text-[12px] text-stone-500">
              Ordered by the kicker's own team implied total, highest first. The offence columns are the context that number misses:
              a team that scores touchdowns hands its kicker extra points, a team that stalls inside the 20 hands him three.
              {games != null && <> Season to date — <span className="font-medium text-stone-600">{games} game{games === 1 ? '' : 's'}</span>, so treat the rates as a first signal rather than a settled one.</>}
              {' '}Limited to the kickers FantasyPros ranks this week, since a backup shares his starter's implied total exactly.
            </p>
            <StreamTable pos="K" rows={data.streamers.K} weeks={weeks} onPlan={onPlan} />
          </section>
        </>
      )}
    </div>
  )
}
