import { Fragment, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, type MyPlayer, type Player, type RosterView, type Transaction } from '../api'
import { fmt, gameDayRowClass, pct, POS_ORDER, shortDate, timeAgo } from '../lib/format'
import { useApp } from '../components/AppContext'
import { Chip, ErrorBox, LeagueBar, LeagueDot, PlatformBadge, PlayerCell, Pos, Spinner } from '../components/Badges'
import { DataTable, type Column } from '../components/DataTable'
import { playerColumns, rosColumn } from './Waivers'

type SlotRow = { slot: string; player: Player | null; key: string }

function slotColumns(week: number): Column<SlotRow>[] {
  const base = playerColumns({ week, fp: true, owned: true, livePts: true, variant: 'lineup' })
  const wrapped: Column<SlotRow>[] = base.map((c) => ({
    ...c,
    render: (r) => (r.player ? c.render(r.player) : c.key === 'name' ? <span className="text-red-600">Empty</span> : null),
    sort: undefined,
  }))
  return [
    { key: 'slot', header: 'Slot', render: (r) => <Pos pos={r.slot} />, align: 'center' },
    ...wrapped,
  ]
}

// Record, FAAB and waiver position are deliberately absent: the sidebar carries them for your
// own team, and the League table already has a column for each on every team.
function TeamHeader({ r }: { r: RosterView }) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-[12px]">
      <Chip>PF {fmt(r.fpts)}</Chip>
      <Chip tone={r.optimal.gain > 0.5 ? 'red' : 'green'}>Proj {fmt(r.optimal.current_total)} · optimal {fmt(r.optimal.optimal_total)}</Chip>
    </div>
  )
}

export function RosterDetail({ r, week }: { r: RosterView; week: number }) {
  const cols = useMemo(() => slotColumns(week), [week])
  const starters: SlotRow[] = r.starters.map((s, i) => ({ slot: s.slot, player: s.player, key: `${s.slot}-${i}` }))
  const bench: SlotRow[] = r.bench.map((p) => ({ slot: 'BN', player: p, key: p.player_id }))
  const reserve: SlotRow[] = r.reserve.map((p) => ({ slot: 'IR', player: p, key: p.player_id }))
  const taxi: SlotRow[] = r.taxi.map((p) => ({ slot: 'TAXI', player: p, key: p.player_id }))
  const changes = r.optimal.rows.filter((o) => o.change)
  return (
    <div className="space-y-3">
      <TeamHeader r={r} />
      {r.flags.length > 0 && (
        <ul className="space-y-0.5">
          {r.flags.map((f, i) => (
            <li key={i} className={`text-[12px] ${f.level === 'error' ? 'text-red-700' : f.level === 'warn' ? 'text-amber-700' : 'text-stone-600'}`}>
              {f.level === 'error' ? '⛔' : f.level === 'warn' ? '⚠️' : 'ℹ️'} {f.text}
            </li>
          ))}
        </ul>
      )}
      <DataTable rows={[...starters, ...bench, ...reserve, ...taxi]} columns={cols} rowKey={(r) => r.key} maxHeight="none"
        rowClass={(row) => (row.player && gameDayRowClass(row.player)) || (row.slot === 'BN' ? 'bg-stone-50/60' : row.slot === 'IR' || row.slot === 'TAXI' ? 'bg-red-50/40' : '')} />
      <div className="rounded-md border border-stone-200 bg-white p-3">
        <div className="mb-1 text-[12px] font-semibold uppercase tracking-wide text-stone-500">Optimal lineup by projections</div>
        {changes.length === 0 ? (
          <div className="text-[12px] text-emerald-700">Current starters already maximize projected points ({fmt(r.optimal.current_total)}).</div>
        ) : (
          <table className="text-[12.5px]">
            <tbody>
              {changes.map((o) => (
                <tr key={o.slot + (o.suggested?.player_id ?? '')}>
                  <td className="py-0.5 pr-3"><Pos pos={o.slot} /></td>
                  <td className="py-0.5 pr-3 text-stone-500">{o.current ? `${o.current.name} (${fmt(o.current.proj_week)})` : 'empty'}</td>
                  <td className="py-0.5 pr-3">→</td>
                  <td className="py-0.5 pr-3 font-medium">{o.suggested ? `${o.suggested.name} (${fmt(o.suggested.proj_week)})` : 'empty'}</td>
                  <td className={`py-0.5 num ${o.delta > 0 ? 'text-emerald-700' : 'text-stone-500'}`}>{o.delta > 0 ? '+' : ''}{fmt(o.delta)}</td>
                </tr>
              ))}
              <tr><td colSpan={5} className="pt-1 text-[12px] text-stone-600">Total gain: <span className="font-semibold text-emerald-700">+{fmt(r.optimal.gain)}</span> → {fmt(r.optimal.optimal_total)} projected. Out/IR players and byes are treated as 0.</td></tr>
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

function AllMyPlayers() {
  const { week } = useApp()
  const { data, isLoading, error } = useQuery({ queryKey: ['my-players', week], queryFn: () => api.myPlayers(week), staleTime: 60_000 })
  const columns = useMemo<Column<MyPlayer>[]>(() => {
    const cols: Column<MyPlayer>[] = [
      { key: 'name', header: 'Player', render: (p) => <PlayerCell p={p} />, sort: (p) => p.name },
      { key: 'pos', header: 'Pos', render: (p) => <Pos pos={p.position} />, sort: (p) => POS_ORDER.indexOf(p.position), align: 'center' },
      { key: 'opp', header: `Wk ${week}`, render: (p) => (p.on_bye ? 'BYE' : p.opponent ?? '—'), sort: (p) => p.opponent },
      { key: 'bye', header: 'Bye', render: (p) => <span className="text-stone-500">{p.bye_week ?? '—'}</span>, sort: (p) => p.bye_week, align: 'center' },
      { key: 'owned', header: 'Own%', render: (p) => pct(p.owned), sort: (p) => p.owned, align: 'right', desc: true },
      {
        key: 'fp_ecr', header: 'ECR', title: 'FantasyPros weekly expert consensus rank within position (~80 experts)',
        render: (p) => p.fp_pos_rank ? <span className="text-stone-700">{p.fp_pos_rank}</span> : <span className="text-stone-300">·</span>,
        sort: (p) => Number((p.fp_pos_rank ?? '').replace(/\D/g, '')) || 9999, align: 'right',
      },
      { key: 'drops', header: '−24h', title: 'Drops across Sleeper, last 24h', render: (p) => <span className={p.drops_24h ? 'text-red-700' : 'text-stone-400'}>{p.drops_24h || '·'}</span>, sort: (p) => p.drops_24h, align: 'right', desc: true },
      rosColumn as Column<MyPlayer>,
      { key: 'n', header: 'Leagues', render: (p) => p.leagues.length, sort: (p) => p.leagues.length, align: 'center', desc: true },
    ]
    for (const lg of data?.leagues ?? []) {
      cols.push({
        key: `lg_${lg.league_id}`, header: <span className="inline-flex items-center gap-1"><LeagueDot leagueId={lg.league_id} /><PlatformBadge platform={lg.platform} />{lg.name}</span>, className: 'border-l border-stone-200',
        sort: (p) => { const s = p.leagues.find((l) => l.league_id === lg.league_id); return s ? (s.role === 'BN' ? 0 : s.role === 'IR' ? -1 : 1) * 1000 + (s.proj_week ?? 0) : null },
        desc: true,
        render: (p) => {
          const s = p.leagues.find((l) => l.league_id === lg.league_id)
          if (!s) return <span className="text-stone-300">—</span>
          return <span className="inline-flex items-center gap-1.5"><Pos pos={s.role} /><span className="num text-stone-600">{fmt(s.proj_week)}</span></span>
        },
      })
    }
    return cols
  }, [data, week])
  if (isLoading) return <Spinner label="Loading players across leagues…" />
  if (error) return <ErrorBox error={error} />
  if (!data) return null
  return <DataTable rows={data.players} columns={columns} rowKey={(p) => p.player_id} initialSort={{ key: 'owned', dir: 'desc' }} rowClass={gameDayRowClass} />
}

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

/** One league, top to bottom: your team, then everyone's, then what has been moving. Your
 * lineup leads because it is what you come here to act on; the standings and transactions are
 * the context around it. The cross-league view of every player you own sits behind a toggle —
 * it answers a different question ("how exposed am I to this player") but it is still about
 * your rosters, so it lives here rather than on a tab of its own. */
export default function League() {
  const { leagueId, league, week } = useApp()
  const [view, setView] = useState<'league' | 'all'>('league')
  const rosters = useQuery({ queryKey: ['rosters', leagueId, week], queryFn: () => api.rosters(leagueId!, week), enabled: !!leagueId && view === 'league', staleTime: 60_000 })
  const txs = useQuery({ queryKey: ['transactions', leagueId], queryFn: () => api.transactions(leagueId!, 3), enabled: !!leagueId && view === 'league', staleTime: 60_000 })
  const [open, setOpen] = useState<number | null>(null)
  if (!league) return <Spinner />

  const projTotal = (r: RosterView) => r.starters.reduce((s, x) => s + (x.player?.proj_week ?? 0), 0)
  const mine = rosters.data?.rosters.find((r) => r.is_mine) ?? null
  const h2 = 'mb-1.5 text-[12px] font-semibold uppercase tracking-wide text-stone-500'

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="flex items-stretch gap-2 text-base font-semibold">
          {view === 'league' ? (
            <>
              <LeagueBar leagueId={league.league_id} />
              <span className="flex items-center gap-2">
                <PlatformBadge platform={league.platform} />
                {league.name}
                {league.my_team?.team_name && <span className="text-[13px] font-normal text-stone-500">{league.my_team.team_name}</span>}
              </span>
            </>
          ) : 'My players across leagues'}
        </h1>
        <div className="flex rounded-md border border-stone-200 bg-white p-0.5">
          <button onClick={() => setView('league')} className={`rounded px-2.5 py-1 text-[12px] ${view === 'league' ? 'bg-stone-900 text-white' : 'text-stone-700 hover:bg-stone-100'}`}>This league</button>
          <button onClick={() => setView('all')} className={`rounded px-2.5 py-1 text-[12px] ${view === 'all' ? 'bg-stone-900 text-white' : 'text-stone-700 hover:bg-stone-100'}`}>All leagues</button>
        </div>
      </div>

      {view === 'all' ? <AllMyPlayers /> : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Chip>{league.total_rosters} teams</Chip>
            <Chip>{league.scoring_format}{league.pass_td ? ` · ${league.pass_td}pt pass TD` : ''}</Chip>
            <Chip>{league.roster_positions.filter((p) => p !== 'BN').join(' ')} · {league.roster_positions.filter((p) => p === 'BN').length} BN · {league.reserve_slots} IR</Chip>
            <Chip tone="amber">{league.waiver.type}{league.waiver.type_code === 2 ? ` $${league.waiver.budget}` : ''} · runs {league.waiver.daily ? 'daily' : league.waiver.day_of_week ?? '?'} · {league.waiver.clear_days}d clear</Chip>
            <Chip>Playoffs wk {league.playoff_week_start} · trade deadline {league.trade_deadline_date ? shortDate(league.trade_deadline_date) : league.trade_deadline ? `wk ${league.trade_deadline}` : '—'}</Chip>
          </div>

          {rosters.isLoading && <Spinner label="Loading rosters…" />}
          {rosters.error && <ErrorBox error={rosters.error} />}

          {rosters.data && (
            <section>
              <h2 className={h2}>Your team · week {week}</h2>
              {mine
                ? <RosterDetail r={mine} week={week} />
                : <div className="text-[12px] text-stone-500">You do not have a roster in this league.</div>}
            </section>
          )}

          {rosters.data && (
            <section>
              <h2 className={h2}>Standings</h2>
              <div className="overflow-hidden rounded-md border border-stone-200 bg-white">
                <table className="data w-full">
                  <thead>
                    <tr><th></th><th>Team</th><th>Owner</th><th className="text-right">W-L</th><th className="text-right">PF</th><th className="text-right">PA</th><th className="text-right">Proj wk {week}</th><th className="text-right">FAAB left</th><th className="text-right">Waiver #</th><th className="text-right">Moves</th></tr>
                  </thead>
                  <tbody>
                    {rosters.data.rosters.map((r, i) => (
                      <Fragment key={r.roster_id}>
                        {/* Yours is already laid out in full above, so only the others expand. */}
                        <tr className={r.is_mine ? 'bg-amber-50/70' : 'cursor-pointer'} title={r.is_mine ? undefined : 'Show this roster'}
                            onClick={r.is_mine ? undefined : () => setOpen(open === r.roster_id ? null : r.roster_id)}>
                          <td className="text-stone-400">{r.is_mine ? i + 1 : <><span className="mr-1 inline-block w-2 text-stone-300">{open === r.roster_id ? '▾' : '▸'}</span>{i + 1}</>}</td>
                          <td className="font-medium">{r.owner.team_name}{r.is_mine && <span className="ml-1.5 text-[10px] font-semibold text-amber-700">YOU</span>}</td>
                          <td className="text-stone-600">{r.owner.display_name}</td>
                          <td className="num text-right">{r.record.wins}-{r.record.losses}{r.record.ties ? `-${r.record.ties}` : ''}</td>
                          <td className="num text-right">{fmt(r.fpts)}</td>
                          <td className="num text-right">{fmt(r.fpts_against)}</td>
                          <td className="num text-right">{fmt(projTotal(r))}</td>
                          <td className="num text-right">{league.waiver.type_code === 2 ? `$${r.faab_remaining}` : '—'}</td>
                          <td className="num text-right">{r.waiver_position ?? '—'}</td>
                          <td className="num text-right">{r.total_moves}</td>
                        </tr>
                        {open === r.roster_id && !r.is_mine && (
                          <tr>
                            <td colSpan={10} className="bg-stone-50 p-3">
                              <RosterDetail r={r} week={week} />
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          <section>
            <h2 className={h2}>Recent transactions{txs.data ? ` (weeks ${txs.data.weeks.join(', ')})` : ''}</h2>
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
        </>
      )}
    </div>
  )
}
