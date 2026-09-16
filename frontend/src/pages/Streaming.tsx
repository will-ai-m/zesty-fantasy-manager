import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, type Player, type Streamer, type TeamFactors } from '../api'
import { fmt, pct } from '../lib/format'
import { useApp } from '../components/AppContext'
import { ErrorBox, LeagueBar, PlatformBadge, PlayerCell, Spinner } from '../components/Badges'

const dash = <span className="text-stone-300">·</span>

// Only weather that changes a kick is worth a badge. ESPN reports a condition for every game, so
// flagging all of them puts "Partly sunny" on two thirds of the rows and buries the two that
// matter. ESPN carries no wind at all, which is the real limitation here — it can tell you it is
// raining, never that it is gusting to 25.
const ADVERSE = /rain|storm|snow|shower|sleet|drizzle|wind|fog|blizzard|flurr/i
function adverse(w: { summary: string | null; temperature: number | null } | null | undefined) {
  if (!w?.summary) return null
  if (ADVERSE.test(w.summary)) return w.summary
  return w.temperature != null && w.temperature <= 32 ? `${w.temperature}°F` : null
}

/** One week of a streamer's schedule: who they play and the number that matters. */
function GameCell({ g, pos, lead }: { g: Streamer['weeks'][number] | undefined; pos: 'K' | 'DEF'; lead: boolean }) {
  if (!g || !g.matchup) return <td className="px-2 py-1.5 text-center text-[11px] text-stone-300">bye</td>
  const v = pos === 'DEF' ? g.opp_implied : g.implied
  // Green marks a spot worth taking: a defence facing an offence priced under 19, a kicker on
  // one priced over 25. Read off the line only — FantasyPros has its own column.
  const good = v != null && (pos === 'DEF' ? v <= 19 : v >= 25)
  return (
    <td className={`px-2 py-1.5 text-center ${lead ? 'bg-stone-50/70' : ''}`}>
      <div className="text-[11px] text-stone-600">{g.matchup}</div>
      <div className={`text-[11px] tabular-nums ${good ? 'font-semibold text-emerald-700' : 'text-stone-400'}`}>{v == null ? '—' : fmt(v, 1)}</div>
    </td>
  )
}

function StreamTable({ pos, rows, weeks, onPlan }: { pos: 'K' | 'DEF'; rows: Streamer[]; weeks: number[]; onPlan?: (p: Player) => void }) {
  if (!rows.length) return <p className="rounded-md border border-stone-200 bg-white p-3 text-[12px] text-stone-500">Nothing available at this position.</p>
  const th = 'px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-stone-400'
  const k = pos === 'K'
  return (
    <div className="overflow-x-auto rounded-md border border-stone-200 bg-white">
      <table className="w-full min-w-[48rem] text-[12px]">
        <thead className="border-b border-stone-200">
          <tr>
            <th className={`${th} text-left`} rowSpan={2}>{k ? 'Kicker' : 'Defense'}</th>
            <th className={`${th} border-l border-stone-100 text-center`} colSpan={weeks.length}>
              {k ? 'Own team implied total — higher is better' : 'Opponent implied total — lower is better'}
            </th>
            {k ? <>
              <th className={`${th} border-l border-stone-100 text-center`} colSpan={3}>Offense, season to date</th>
              <th className={`${th} border-l border-stone-100 text-center`} rowSpan={2}
                  title="FantasyPros rest-of-season rank. A kicker is a hold-or-drop call far more than a weekly matchup call, so the rest-of-season read is the one that earns a column — the weekly rank is already doing its real work as the filter that keeps backups out of this table.">FP ROS</th>
            </> : (
              <th className={`${th} border-l border-stone-100 text-center`} colSpan={2} title="FantasyPros expert consensus. Not part of the ordering — this table is ranked on Vegas alone, and where the two disagree is the thing to look at.">FantasyPros</th>
            )}
            <th className={`${th} text-right`} rowSpan={2}>Own%</th>
            <th className="w-8" rowSpan={2} />
          </tr>
          <tr>
            {weeks.map((w, i) => <th key={w} className={`${th} text-center ${i === 0 ? 'border-l border-stone-100' : ''}`}>Wk {w}</th>)}
            {k ? <>
              <th className={`${th} border-l border-stone-100 text-center`} title="Field-goal attempts per game, and the split short (under 40 yards) · long (40+). The most direct measure there is — every factor above it ends up here — and the split is what your league's distance scoring actually pays on.">FGA/g</th>
              <th className={`${th} text-center`} title="Share of red-zone trips that end in a field-goal attempt. The stall you want: a drive that reaches the 20 and settles for three rather than scoring six and leaving him an extra point.">RZ FG</th>
              <th className={`${th} text-center`} title="Fourth-down attempts per game. The only factor here that actively removes kicks — every fourth down the staff goes for is a field goal that never happened. Low is good.">4th/g</th>
            </> : <>
              <th className={`${th} border-l border-stone-100 text-center`} title="Rank for this week only">Wk</th>
              <th className={`${th} text-center`} title="Rest-of-season rank — who is worth holding rather than who is best this Sunday">ROS</th>
            </>}
          </tr>
        </thead>
        <tbody>
          {rows.map((s, i) => {
            const f: TeamFactors | null = s.factors
            const wx = adverse(s.weeks[0]?.weather)
            return (
              <tr key={s.player_id} className={`border-t border-stone-100 ${i === 0 ? 'bg-emerald-50/60' : ''}`}>
                <td className="px-3 py-1.5">
                  <span className="inline-flex items-center gap-1.5">
                    {i === 0 && <span className="rounded bg-emerald-600 px-1 py-0.5 text-[9px] font-bold leading-none text-white">1</span>}
                    <PlayerCell p={s} />
                    {wx && (
                      <span title="Forecast for this week's game. ESPN publishes none for later weeks, and carries no wind — the one thing that most changes a kick."
                            className="rounded bg-amber-100 px-1 py-0.5 text-[9px] font-medium leading-none text-amber-800">{wx}</span>
                    )}
                  </span>
                </td>
                {s.weeks.map((g, n) => <GameCell key={g.week} g={g} pos={pos} lead={n === 0} />)}
                {k ? <>
                  <td className="border-l border-stone-100 px-2 py-1.5 text-center tabular-nums text-stone-700">
                    {f?.fg_att_pg == null ? dash : <><span className={f.fg_att_pg >= 2.5 ? 'font-semibold text-emerald-700' : ''}>{fmt(f.fg_att_pg, 1)}</span><span className="ml-1 text-[10px] text-stone-400">({f.fg_att_short ?? 0}·{f.fg_att_long ?? 0})</span></>}
                  </td>
                  <td className="px-2 py-1.5 text-center tabular-nums">
                    {f?.rz_fg_pct == null ? dash : <span className={f.rz_fg_pct >= 50 ? 'font-semibold text-emerald-700' : 'text-stone-600'}>{fmt(f.rz_fg_pct, 0)}%</span>}
                  </td>
                  <td className="px-2 py-1.5 text-center tabular-nums">
                    {f?.fourth_att_pg == null ? dash : <span className={f.fourth_att_pg <= 1 ? 'font-semibold text-emerald-700' : 'text-stone-600'}>{fmt(f.fourth_att_pg, 1)}</span>}
                  </td>
                  <td className="border-l border-stone-100 px-2 py-1.5 text-center tabular-nums">
                    {s.fp_ros_rank == null ? dash : <span className={s.fp_ros_rank <= 8 ? 'font-semibold text-violet-800' : 'text-violet-700'}>{s.fp_ros_rank}</span>}
                  </td>
                </> : <>
                  <td className="border-l border-stone-100 px-2 py-1.5 text-center tabular-nums">
                    {s.fp_rank == null ? dash : <span className={s.fp_rank <= 5 ? 'font-semibold text-violet-800' : 'text-violet-700'}>{s.fp_rank}</span>}
                  </td>
                  <td className="px-2 py-1.5 text-center tabular-nums">
                    {s.fp_ros_rank == null ? dash : <span className={s.fp_ros_rank <= 8 ? 'font-semibold text-violet-800' : 'text-violet-700'}>{s.fp_ros_rank}</span>}
                  </td>
                </>}
                <td className="px-2 py-1.5 text-right text-stone-500">{pct(s.owned)}</td>
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
 * matchups get claimed by whoever looks furthest ahead.
 *
 * They get a tab each because they are not the same decision. A defence is a weekly matchup
 * play — you read the schedule and take the soft spot. A kicker is mostly a hold: his points
 * follow his offence's volume, not who it is playing, so the columns that matter are about the
 * offence rather than the opponent. */
export default function Streaming() {
  const { leagueId, league, openPlan } = useApp()
  const [tab, setTab] = useState<'DEF' | 'K'>('DEF')
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

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex rounded-md border border-stone-200 bg-white p-0.5">
          {([['DEF', 'Defense / ST'], ['K', 'Kickers']] as const).map(([key, label]) => (
            <button key={key} onClick={() => setTab(key)}
                    className={`rounded px-3 py-1 text-[12px] ${tab === key ? 'bg-stone-900 text-white' : 'text-stone-700 hover:bg-stone-100'}`}>
              {label}{data && <span className={`ml-1.5 ${tab === key ? 'text-stone-400' : 'text-stone-400'}`}>{data.streamers[key].length}</span>}
            </button>
          ))}
        </div>
      </div>

      {isLoading && <Spinner label="Pulling lines for the next few weeks…" />}
      {error && <ErrorBox error={error} />}

      {data && tab === 'DEF' && (
        <div className="space-y-2">
          <p className="text-[12px] text-stone-500">
            Ordered by this week's opponent implied total, lowest first — a defence scores off the other team failing.
            The next {weeks.length} weeks run across each row so you can take a good matchup before someone else does.
          </p>
          <StreamTable pos="DEF" rows={data.streamers.DEF} weeks={weeks} onPlan={onPlan} />
        </div>
      )}

      {data && tab === 'K' && (
        <div className="space-y-2">
          <p className="text-[12px] text-stone-500">
            Ordered by the kicker's own team implied total, highest first. A kicker's points follow his offence's <em>volume</em> rather than
            who it is playing, so the columns here describe the offence: how often it kicks, how often it stalls in the red zone instead of
            scoring, and how often the staff takes the kick away on fourth down.
            {games != null && <> Season to date — <span className="font-medium text-stone-600">{games} game{games === 1 ? '' : 's'}</span>, so read the rates as a first signal rather than a settled one.</>}
            {' '}Limited to the kickers FantasyPros ranks this week, since a backup shares his starter's implied total exactly.
          </p>
          <StreamTable pos="K" rows={data.streamers.K} weeks={weeks} onPlan={onPlan} />
        </div>
      )}
    </div>
  )
}
