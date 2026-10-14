import { useQuery } from '@tanstack/react-query'
import { api, type Matchup as MatchupData, type FpDetail, type FpSet, type MatchupGame, type WeekRow } from '../api'
import { fmt } from '../lib/format'
import { useApp } from './AppContext'
import { ErrorBox, Injury, Pos, Spinner } from './Badges'

const SET_LABEL: Record<string, { label: string; note: string }> = {
  weekly: { label: 'This week', note: 'Rank within position' },
  ros: { label: 'Rest of season', note: 'Overall rank' },
  waiver: { label: 'Waiver wire', note: 'Rank on the pickup shortlist' },
}

function FpRow({ name, set }: { name: string; set: FpSet }) {
  const meta = SET_LABEL[name]
  // A wide min-max band means the experts disagree; on the 3-expert rest-of-season page
  // that band is noisy enough that it is worth seeing next to the number.
  const spread = set.rank_min != null && set.rank_max != null ? `${set.rank_min}–${set.rank_max}` : null
  return (
    <tr className="border-t border-stone-100">
      <td className="py-1 pr-3 text-stone-600">{meta?.label ?? name}</td>
      <td className="py-1 pr-3 font-semibold text-stone-900">{set.pos_rank ?? (set.rank_ecr != null ? `#${set.rank_ecr}` : '—')}</td>
      <td className="num py-1 pr-3 text-right text-stone-600" title={meta?.note}>{set.rank_ecr ?? '—'}</td>
      <td className="num py-1 pr-3 text-right text-stone-500">{spread ?? '—'}</td>
      <td className="num py-1 pr-3 text-right text-stone-500">{set.rank_std != null ? fmt(set.rank_std) : '—'}</td>
      <td className="num py-1 pr-3 text-right text-stone-500">{set.experts ?? '—'}</td>
      <td className="num py-1 text-right text-stone-500">{set.owned_avg != null ? `${fmt(set.owned_avg, 0)}%` : '—'}</td>
    </tr>
  )
}

function FantasyPros({ fp }: { fp: FpDetail }) {
  const order = ['weekly', 'ros', 'waiver'] as const
  const rows = order.filter((k) => fp.sets[k])
  return (
    <section>
      <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-stone-500">
        FantasyPros consensus <span className="font-normal normal-case tracking-normal text-stone-400">· {fp.scoring} PPR · scraped {fp.fetched_at_iso?.slice(0, 10)}</span>
      </h3>
      <table className="w-full text-[12px]">
        <thead>
          <tr className="text-[10.5px] uppercase tracking-wide text-stone-400">
            <th className="py-1 pr-3 text-left font-semibold">Set</th>
            <th className="py-1 pr-3 text-left font-semibold">Rank</th>
            <th className="py-1 pr-3 text-right font-semibold" title="Expert consensus rank">ECR</th>
            <th className="py-1 pr-3 text-right font-semibold" title="Best and worst rank any expert gave">Range</th>
            <th className="py-1 pr-3 text-right font-semibold" title="Standard deviation — how much the experts disagree">±</th>
            <th className="py-1 pr-3 text-right font-semibold" title="How many experts ranked this set">Exp</th>
            <th className="py-1 text-right font-semibold" title="Percent rostered across ESPN and Yahoo">Own</th>
          </tr>
        </thead>
        <tbody>{rows.map((k) => <FpRow key={k} name={k} set={fp.sets[k]!} />)}</tbody>
      </table>
      {fp.sets.ros && (fp.sets.ros.experts ?? 0) <= 5 && (
        <p className="mt-1 text-[11px] text-stone-400">
          Rest-of-season is only {fp.sets.ros.experts} experts — treat it as a hint, not a consensus.
        </p>
      )}
    </section>
  )
}

const STAT_COLS: Record<string, { key: string; label: string; digits?: number }[]> = {
  QB: [
    { key: 'pass_att', label: 'Att', digits: 0 }, { key: 'pass_cmp', label: 'Cmp', digits: 0 }, { key: 'pass_yd', label: 'PaYd', digits: 0 },
    { key: 'pass_td', label: 'PaTD' }, { key: 'pass_int', label: 'Int' }, { key: 'rush_att', label: 'Ru', digits: 0 }, { key: 'rush_yd', label: 'RuYd', digits: 0 }, { key: 'rush_td', label: 'RuTD' },
  ],
  RB: [
    { key: 'rush_att', label: 'Att', digits: 0 }, { key: 'rush_yd', label: 'RuYd', digits: 0 }, { key: 'rush_td', label: 'RuTD' },
    { key: 'rec_tgt', label: 'Tgt', digits: 0 }, { key: 'rec', label: 'Rec', digits: 0 }, { key: 'rec_yd', label: 'ReYd', digits: 0 }, { key: 'rec_td', label: 'ReTD' }, { key: 'off_snp', label: 'Snaps', digits: 0 },
  ],
  WR: [
    { key: 'rec_tgt', label: 'Tgt', digits: 0 }, { key: 'rec', label: 'Rec', digits: 0 }, { key: 'rec_yd', label: 'ReYd', digits: 0 }, { key: 'rec_td', label: 'ReTD' },
    { key: 'rec_air_yd', label: 'AirYd', digits: 0 }, { key: 'rush_att', label: 'Ru', digits: 0 }, { key: 'rush_yd', label: 'RuYd', digits: 0 }, { key: 'off_snp', label: 'Snaps', digits: 0 },
  ],
  K: [
    { key: 'fga', label: 'FGA', digits: 0 }, { key: 'fgm', label: 'FGM', digits: 0 }, { key: 'fgm_50p', label: '50+', digits: 0 }, { key: 'xpa', label: 'XPA', digits: 0 }, { key: 'xpm', label: 'XPM', digits: 0 },
  ],
  DEF: [
    { key: 'pts_allow', label: 'PA', digits: 0 }, { key: 'yds_allow', label: 'YdsA', digits: 0 }, { key: 'sack', label: 'Sck' }, { key: 'int', label: 'Int' }, { key: 'fum_rec', label: 'FR' }, { key: 'def_td', label: 'TD' },
  ],
}
STAT_COLS.TE = STAT_COLS.WR

const ordinal = (n: number) => {
  const end = ['th', 'st', 'nd', 'rd']
  const v = n % 100
  return `${n}${end[(v - 20) % 10] ?? end[v] ?? end[0]}`
}

// What each position's game against the opponent is worth showing: a defence by what the offence
// did to it, a kicker by the kicks he got.
const MATCHUP_COLS: Record<string, { key: keyof MatchupGame; label: string; title?: string; digits?: number }[]> = {
  DEF: [
    { key: 'pts_allow', label: 'PA', title: 'Points the offence scored', digits: 0 },
    { key: 'yds_allow', label: 'YdsA', title: 'Yards the offence gained', digits: 0 },
    { key: 'sack', label: 'Sck', digits: 0 }, { key: 'int', label: 'Int', digits: 0 },
    { key: 'fum_rec', label: 'FR', digits: 0 }, { key: 'def_td', label: 'TD', digits: 0 },
  ],
  K: [
    { key: 'fga', label: 'FGA', digits: 0 }, { key: 'fgm', label: 'FGM', digits: 0 },
    { key: 'fgm_50p', label: '50+', title: 'Field goals made from 50 yards or more', digits: 0 },
    { key: 'fgm_lng', label: 'Lng', title: 'Longest field goal made', digits: 0 },
    { key: 'xpa', label: 'XPA', digits: 0 }, { key: 'xpm', label: 'XPM', digits: 0 },
  ],
}

/** What a streamer actually asks of a defence or a kicker is not how it has played but what the
 * team in front of it has let the rest of the league do. So this is the week's opponent read from
 * the other sideline: every defence that has faced that offence, or every kicker that has faced
 * that defence, and how each one did. An opponent near the top of the league here is the one
 * worth streaming against. */
function Matchup({ m, team }: { m: MatchupData; team: string | null }) {
  const unit = m.position === 'K' ? 'kickers' : 'defences'
  const cols = MATCHUP_COLS[m.position] ?? MATCHUP_COLS.DEF
  if (m.on_bye) {
    return (
      <section>
        <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-stone-500">Week {m.week} matchup</h3>
        <p className="text-[13px] text-stone-600">{team ?? 'This defence'} is on bye in week {m.week}.</p>
      </section>
    )
  }
  const generous = m.rank != null && m.rank <= 8
  const stingy = m.rank != null && m.rank > m.teams - 8
  return (
    <section>
      <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-stone-500">
        How {unit} have done against {m.opponent} <span className="font-normal normal-case tracking-normal text-stone-400">· {team}'s week {m.week} matchup</span>
      </h3>
      {m.avg_pts == null ? <p className="text-[13px] text-stone-600">{m.opponent} have not played yet this season.</p> : (
        <p className="text-[13px] text-stone-700">
          {m.opponent} have handed {unit} <span className="font-semibold">{fmt(m.avg_pts)} points a game</span> —{' '}
          <span className={generous ? 'font-semibold text-emerald-700' : stingy ? 'text-red-700' : 'text-stone-600'}>
            {m.rank === 1 ? `the most of any ${m.position === 'K' ? 'defence' : 'offence'}` : `${ordinal(m.rank!)} most of ${m.teams}`}
          </span>
          <span className="text-stone-500"> · league average {fmt(m.league_avg)}</span>
        </p>
      )}
      {m.games.length > 0 && (
        <table className="data mt-2 w-full border-collapse">
          <thead>
            <tr>
              <th>Wk</th><th>{m.position === 'K' ? 'Kicker' : 'Defense'}</th>
              <th title={`Where the game was played, from ${m.opponent}'s side`}>At</th>
              <th className="text-right" title="Fantasy points scored, in this league's scoring">Pts</th>
              {cols.map((c) => <th key={c.key} className="text-right" title={c.title}>{c.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {m.games.map((g) => (
              <tr key={g.week}>
                <td className="num">{g.week}</td>
                <td className="whitespace-nowrap font-medium">{m.position === 'K' ? <>{g.name} <span className="font-normal text-stone-500">{g.team}</span></> : g.team}</td>
                <td className="text-stone-500">{g.at_home ? 'home' : 'away'}</td>
                <td className={`num text-right font-semibold ${(g.pts ?? 0) >= 10 ? 'text-emerald-700' : ''}`}>{fmt(g.pts)}</td>
                {cols.map((c) => <td key={c.key} className="num text-right">{fmt(g[c.key] as number | null, c.digits ?? 1)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}

function WeekTable({ rows, position, showProj }: { rows: WeekRow[]; position: string; showProj: boolean }) {
  const cols = STAT_COLS[position] ?? STAT_COLS.WR
  return (
    <table className="data w-full border-collapse">
      <thead>
        <tr>
          <th>Wk</th><th>Opp</th>
          {showProj && <th className="text-right">Proj</th>}
          <th className="text-right">Pts</th>
          {cols.map((c) => <th key={c.key} className="text-right">{c.label}</th>)}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const src = Object.keys(r.stats).length ? r.stats : r.proj
          const isProj = !Object.keys(r.stats).length
          return (
            <tr key={r.week} className={isProj ? 'text-stone-500' : ''}>
              <td className="num">{r.week}</td>
              <td>{r.opponent ?? (r.proj || r.stats ? '' : 'BYE')}</td>
              {showProj && <td className="num text-right">{fmt(r.proj_pts)}</td>}
              <td className="num text-right font-semibold">{isProj ? '' : fmt(r.actual_pts)}</td>
              {cols.map((c) => <td key={c.key} className="num text-right">{src[c.key] === undefined ? '' : fmt(src[c.key], c.digits ?? 1)}</td>)}
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

export function PlayerDrawer() {
  const { drawerPlayer, drawerLeague, setDrawerLeague, closePlayer, leagues } = useApp()
  const { data, isLoading, error } = useQuery({
    queryKey: ['player', drawerPlayer, drawerLeague],
    queryFn: () => api.player(drawerPlayer!, drawerLeague),
    enabled: !!drawerPlayer,
  })
  if (!drawerPlayer) return null
  const p = data?.player
  return (
    <div className="fixed inset-0 z-40 flex justify-end" onClick={closePlayer}>
      <div className="absolute inset-0 bg-stone-900/20" />
      <aside className="relative h-full w-[760px] max-w-full overflow-auto border-l border-stone-200 bg-white shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 flex items-start justify-between gap-4 border-b border-stone-200 bg-white p-4">
          <div>
            {p ? (
              <>
                <div className="flex items-center gap-2">
                  {p.position && <Pos pos={p.position} />}
                  <h2 className="text-lg font-semibold">{p.name}</h2>
                  <span className="text-stone-500">{p.team ?? 'FA'}{p.number ? ` #${p.number}` : ''}</span>
                  <Injury status={p.injury_status} title={p.injury_body_part} />
                </div>
                <div className="mt-1 text-[12px] text-stone-600">
                  {p.age ? `Age ${p.age} · ` : ''}{p.years_exp !== null ? `${p.years_exp} yrs exp · ` : ''}{p.college ?? ''}
                  {p.depth_chart_position ? ` · Depth ${p.depth_chart_position}${p.depth_chart_order ?? ''}` : ''}
                  {p.bye_week ? ` · Bye ${p.bye_week}` : ''}
                </div>
                {p.injury_notes && <div className="mt-1 text-[12px] text-red-700">{p.injury_status}: {p.injury_body_part} — {p.injury_notes}</div>}
                {/* Scoring is the one thing on this panel that cannot be read off the player: the
                    same game log is worth different points in each league, so the league says so
                    and can be changed here. */}
                <label className="mt-1 flex items-center gap-1.5 text-[11px] text-stone-500">
                  Points in
                  <select value={drawerLeague ?? ''} onChange={(e) => setDrawerLeague(e.target.value)}
                          className="rounded border border-stone-200 bg-white px-1 py-0.5 text-[11px] text-stone-700">
                    {leagues.map((l) => <option key={l.league_id} value={l.league_id}>{l.name}</option>)}
                  </select>
                  scoring
                </label>
              </>
            ) : <h2 className="text-lg font-semibold">Player</h2>}
          </div>
          <button onClick={closePlayer} className="rounded px-2 py-1 text-stone-500 hover:bg-stone-100">✕</button>
        </div>
        {isLoading && <Spinner />}
        {error && <ErrorBox error={error} />}
        {data && (
          <div className="space-y-6 p-4">
            {data.matchup && <Matchup m={data.matchup} team={p?.team ?? null} />}
            {data.fantasypros && <FantasyPros fp={data.fantasypros} />}
            <section>
              <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-stone-500">{data.current_season[0]?.season ?? 'This season'} — projections and results</h3>
              <WeekTable rows={data.current_season} position={p?.position ?? 'WR'} showProj />
            </section>
            {/* Last season is context for a player whose role can change; a kicker's is noise —
                he kicks what his offence gives him, and that is this season's story. */}
            {p?.position !== 'K' && (
              <section>
                <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-stone-500">{data.previous_season[0]?.season ?? 'Last season'} — game log</h3>
                {data.previous_season.length ? <WeekTable rows={data.previous_season} position={p?.position ?? 'WR'} showProj={false} /> : <div className="text-stone-500">No games last season.</div>}
              </section>
            )}
          </div>
        )}
      </aside>
    </div>
  )
}
