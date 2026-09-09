import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, type MyPlayer, type Player, type RosterView } from '../api'
import { fmt, pct, POS_ORDER } from '../lib/format'
import { useApp } from '../components/AppContext'
import { Chip, ErrorBox, PlatformBadge, PlayerCell, Pos, Spinner } from '../components/Badges'
import { DataTable, type Column } from '../components/DataTable'
import { playerColumns } from './Waivers'

type SlotRow = { slot: string; player: Player | null; key: string }

function slotColumns(week: number, rosEnd: number): Column<SlotRow>[] {
  const base = playerColumns({ week, rosEnd }).filter((c) => !['adds_7d', 'drops_24h'].includes(c.key))
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

function TeamHeader({ r, league }: { r: RosterView; league: { waiver: { budget: number; type_code: number } } }) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-[12px]">
      <Chip>{r.record.wins}-{r.record.losses}{r.record.ties ? `-${r.record.ties}` : ''}</Chip>
      <Chip>PF {fmt(r.fpts)}</Chip>
      {league.waiver.type_code === 2 && <Chip tone="amber">${r.faab_remaining} / ${league.waiver.budget} FAAB</Chip>}
      {r.waiver_position != null && <Chip>Waiver #{r.waiver_position}</Chip>}
      <Chip tone={r.optimal.gain > 0.5 ? 'red' : 'green'}>Proj {fmt(r.optimal.current_total)} · optimal {fmt(r.optimal.optimal_total)}</Chip>
    </div>
  )
}

export function RosterDetail({ r, week, rosEnd, league }: { r: RosterView; week: number; rosEnd: number; league: { waiver: { budget: number; type_code: number } } }) {
  const cols = useMemo(() => slotColumns(week, rosEnd), [week, rosEnd])
  const starters: SlotRow[] = r.starters.map((s, i) => ({ slot: s.slot, player: s.player, key: `${s.slot}-${i}` }))
  const bench: SlotRow[] = r.bench.map((p) => ({ slot: 'BN', player: p, key: p.player_id }))
  const reserve: SlotRow[] = r.reserve.map((p) => ({ slot: 'IR', player: p, key: p.player_id }))
  const taxi: SlotRow[] = r.taxi.map((p) => ({ slot: 'TAXI', player: p, key: p.player_id }))
  const changes = r.optimal.rows.filter((o) => o.change)
  return (
    <div className="space-y-3">
      <TeamHeader r={r} league={league} />
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
        rowClass={(row) => (row.slot === 'BN' ? 'bg-stone-50/60' : row.slot === 'IR' || row.slot === 'TAXI' ? 'bg-red-50/40' : '')} />
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

function MyRoster() {
  const { leagueId, league, week } = useApp()
  const { data, isLoading, error } = useQuery({
    queryKey: ['roster', leagueId, week],
    queryFn: () => api.roster(leagueId!, week),
    enabled: !!leagueId,
    staleTime: 60_000,
  })
  if (isLoading) return <Spinner label="Loading your roster…" />
  if (error) return <ErrorBox error={error} />
  if (!data || !league) return null
  if (!data.roster) return <div className="text-stone-500">You do not have a roster in this league.</div>
  return <RosterDetail r={data.roster} week={week} rosEnd={league.ros_end_week} league={league} />
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
      { key: 'drops', header: '−24h', title: 'Drops across Sleeper, last 24h', render: (p) => <span className={p.drops_24h ? 'text-red-700' : 'text-stone-400'}>{p.drops_24h || '·'}</span>, sort: (p) => p.drops_24h, align: 'right', desc: true },
      { key: 'ros', header: 'ROS', render: (p) => <span className="font-medium">{fmt(p.proj_ros, 0)}</span>, sort: (p) => p.proj_ros, align: 'right', desc: true },
      { key: 'n', header: 'Leagues', render: (p) => p.leagues.length, sort: (p) => p.leagues.length, align: 'center', desc: true },
    ]
    for (const lg of data?.leagues ?? []) {
      cols.push({
        key: `lg_${lg.league_id}`, header: <span className="inline-flex items-center gap-1"><PlatformBadge platform={lg.platform} />{lg.name}</span>, className: 'border-l border-stone-200',
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
  return <DataTable rows={data.players} columns={columns} rowKey={(p) => p.player_id} initialSort={{ key: 'owned', dir: 'desc' }} />
}

export default function Roster() {
  const { league } = useApp()
  const [tab, setTab] = useState<'mine' | 'all'>('mine')
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <h1 className="flex items-center gap-2 text-base font-semibold">{tab === 'mine' ? <><PlatformBadge platform={league?.platform} />My roster · {league?.name ?? ''}</> : 'My players across leagues'}</h1>
        <div className="flex rounded-md border border-stone-200 bg-white p-0.5">
          <button onClick={() => setTab('mine')} className={`rounded px-2.5 py-1 text-[12px] ${tab === 'mine' ? 'bg-stone-900 text-white' : 'text-stone-700 hover:bg-stone-100'}`}>This league</button>
          <button onClick={() => setTab('all')} className={`rounded px-2.5 py-1 text-[12px] ${tab === 'all' ? 'bg-stone-900 text-white' : 'text-stone-700 hover:bg-stone-100'}`}>All leagues</button>
        </div>
      </div>
      {tab === 'mine' ? <MyRoster /> : <AllMyPlayers />}
    </div>
  )
}
