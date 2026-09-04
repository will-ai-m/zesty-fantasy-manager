import { Fragment, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, type RosterView, type Transaction } from '../api'
import { fmt, shortDate, timeAgo } from '../lib/format'
import { useApp } from '../components/AppContext'
import { Chip, ErrorBox, PlatformBadge, Pos, Spinner } from '../components/Badges'
import { RosterDetail } from './Roster'

function TxRow({ t }: { t: Transaction }) {
  const tone = t.status === 'complete' ? (t.type === 'trade' ? 'violet' : t.type === 'waiver' ? 'amber' : 'stone') : 'red'
  const label = t.type === 'free_agent' ? 'Free agent' : t.type === 'waiver' ? 'Waiver' : 'Trade'
  return (
    <tr>
      <td className="whitespace-nowrap text-stone-500">{timeAgo(t.status_updated ?? t.created)}</td>
      <td><Chip tone={tone}>{label}{t.status !== 'complete' ? ` · ${t.status}` : ''}</Chip></td>
      <td>
        <div className="flex flex-col gap-0.5">
          {t.adds.map((a) => (
            <span key={a.player_id} className="inline-flex items-center gap-1.5"><span className="text-emerald-700">+</span>{a.position && <Pos pos={a.position} />}<span className="font-medium">{a.name}</span><span className="text-stone-500">{a.team}</span><span className="text-stone-400">→ {a.roster?.display_name}</span></span>
          ))}
          {t.drops.map((d) => (
            <span key={d.player_id} className="inline-flex items-center gap-1.5"><span className="text-red-700">−</span>{d.position && <Pos pos={d.position} />}<span>{d.name}</span><span className="text-stone-500">{d.team}</span><span className="text-stone-400">from {d.roster?.display_name}</span></span>
          ))}
          {t.type === 'trade' && t.adds.length === 0 && <span className="text-stone-500">{t.rosters.map((r) => r?.display_name).join(' ↔ ')}</span>}
        </div>
      </td>
      <td className="num text-right">{t.bid != null ? `$${t.bid}` : ''}</td>
      <td className="text-stone-500">{t.notes}</td>
    </tr>
  )
}

export default function League() {
  const { leagueId, league, week } = useApp()
  const rosters = useQuery({ queryKey: ['rosters', leagueId, week], queryFn: () => api.rosters(leagueId!, week), enabled: !!leagueId, staleTime: 60_000 })
  const txs = useQuery({ queryKey: ['transactions', leagueId], queryFn: () => api.transactions(leagueId!, 3), enabled: !!leagueId, staleTime: 60_000 })
  const [open, setOpen] = useState<number | null>(null)
  if (!league) return <Spinner />

  const projTotal = (r: RosterView) => r.starters.reduce((s, x) => s + (x.player?.proj_week ?? 0), 0)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="flex items-center gap-2 text-base font-semibold"><PlatformBadge platform={league.platform} />{league.name}</h1>
        <Chip>{league.total_rosters} teams</Chip>
        <Chip>{league.scoring_format}{league.pass_td ? ` · ${league.pass_td}pt pass TD` : ''}</Chip>
        <Chip>{league.roster_positions.filter((p) => p !== 'BN').join(' ')} · {league.roster_positions.filter((p) => p === 'BN').length} BN · {league.reserve_slots} IR</Chip>
        <Chip tone="amber">{league.waiver.type}{league.waiver.type_code === 2 ? ` $${league.waiver.budget}` : ''} · runs {league.waiver.daily ? 'daily' : league.waiver.day_of_week ?? '?'} · {league.waiver.clear_days}d clear</Chip>
        <Chip>Playoffs wk {league.playoff_week_start} · trade deadline {league.trade_deadline_date ? shortDate(league.trade_deadline_date) : league.trade_deadline ? `wk ${league.trade_deadline}` : '—'}</Chip>
      </div>

      <section>
        <h2 className="mb-1.5 text-[12px] font-semibold uppercase tracking-wide text-stone-500">Teams</h2>
        {rosters.isLoading && <Spinner label="Loading rosters…" />}
        {rosters.error && <ErrorBox error={rosters.error} />}
        {rosters.data && (
          <div className="overflow-hidden rounded-md border border-stone-200 bg-white">
            <table className="data w-full">
              <thead>
                <tr><th></th><th>Team</th><th>Owner</th><th className="text-right">W-L</th><th className="text-right">PF</th><th className="text-right">PA</th><th className="text-right">Proj wk {week}</th><th className="text-right">FAAB left</th><th className="text-right">Waiver #</th><th className="text-right">Moves</th><th>Roster</th></tr>
              </thead>
              <tbody>
                {rosters.data.rosters.map((r, i) => (
                  <Fragment key={r.roster_id}>
                    <tr className={`cursor-pointer ${r.is_mine ? 'bg-amber-50/70' : ''}`} onClick={() => setOpen(open === r.roster_id ? null : r.roster_id)}>
                      <td className="text-stone-400">{i + 1}</td>
                      <td className="font-medium">{r.owner.team_name}{r.is_mine && <span className="ml-1.5 text-[10px] font-semibold text-amber-700">YOU</span>}</td>
                      <td className="text-stone-600">{r.owner.display_name}</td>
                      <td className="num text-right">{r.record.wins}-{r.record.losses}{r.record.ties ? `-${r.record.ties}` : ''}</td>
                      <td className="num text-right">{fmt(r.fpts)}</td>
                      <td className="num text-right">{fmt(r.fpts_against)}</td>
                      <td className="num text-right">{fmt(projTotal(r))}</td>
                      <td className="num text-right">{league.waiver.type_code === 2 ? `$${r.faab_remaining}` : '—'}</td>
                      <td className="num text-right">{r.waiver_position ?? '—'}</td>
                      <td className="num text-right">{r.total_moves}</td>
                      <td className="text-[11px] text-stone-500">
                        {r.starters.map((s) => s.player?.name.split(' ').slice(-1)[0] ?? '—').join(', ')}
                      </td>
                    </tr>
                    {open === r.roster_id && (
                      <tr>
                        <td colSpan={11} className="bg-stone-50 p-3">
                          <RosterDetail r={r} week={week} rosEnd={league.ros_end_week} league={league} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-1.5 text-[12px] font-semibold uppercase tracking-wide text-stone-500">Recent transactions (weeks {txs.data?.weeks.join(', ')})</h2>
        {txs.isLoading && <Spinner label="Loading transactions…" />}
        {txs.error && <ErrorBox error={txs.error} />}
        {txs.data && (
          <div className="overflow-hidden rounded-md border border-stone-200 bg-white">
            <table className="data w-full">
              <thead><tr><th>When</th><th>Type</th><th>Detail</th><th className="text-right">Bid</th><th>Notes</th></tr></thead>
              <tbody>
                {txs.data.transactions.length === 0 && <tr><td colSpan={5} className="p-4 text-center text-stone-500">No transactions yet.</td></tr>}
                {txs.data.transactions.map((t) => <TxRow key={t.transaction_id} t={t} />)}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}
