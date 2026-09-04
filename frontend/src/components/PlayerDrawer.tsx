import { useQuery } from '@tanstack/react-query'
import { api, type WeekRow } from '../api'
import { fmt } from '../lib/format'
import { useApp } from './AppContext'
import { ErrorBox, Injury, Pos, Spinner } from './Badges'

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
  const { drawerPlayer, closePlayer, leagueId, league } = useApp()
  const { data, isLoading, error } = useQuery({
    queryKey: ['player', drawerPlayer, leagueId],
    queryFn: () => api.player(drawerPlayer!, leagueId),
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
                <div className="mt-1 text-[11px] text-stone-500">Points use {league?.name ?? 'Sleeper half-PPR'} scoring.</div>
              </>
            ) : <h2 className="text-lg font-semibold">Player</h2>}
          </div>
          <button onClick={closePlayer} className="rounded px-2 py-1 text-stone-500 hover:bg-stone-100">✕</button>
        </div>
        {isLoading && <Spinner />}
        {error && <ErrorBox error={error} />}
        {data && (
          <div className="space-y-6 p-4">
            <section>
              <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-stone-500">{data.current_season[0]?.season ?? 'This season'} — projections and results</h3>
              <WeekTable rows={data.current_season} position={p?.position ?? 'WR'} showProj />
            </section>
            <section>
              <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-stone-500">{data.previous_season[0]?.season ?? 'Last season'} — game log</h3>
              {data.previous_season.length ? <WeekTable rows={data.previous_season} position={p?.position ?? 'WR'} showProj={false} /> : <div className="text-stone-500">No games last season.</div>}
            </section>
          </div>
        )}
      </aside>
    </div>
  )
}
