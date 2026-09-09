import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, type TrendPlayer } from '../api'
import { fmt, fmtInt, pct, POS_ORDER } from '../lib/format'
import { useApp } from '../components/AppContext'
import { Chip, ErrorBox, PlatformBadge, PlayerCell, Pos, Spinner } from '../components/Badges'
import { DataTable, type Column } from '../components/DataTable'

export default function Trends() {
  const { week, openPlan } = useApp()
  const { data, isLoading, error } = useQuery({ queryKey: ['trends'], queryFn: api.trends, staleTime: 60_000 })
  const [kind, setKind] = useState<'adds' | 'drops'>('adds')
  const [win, setWin] = useState<'24h' | '7d'>('24h')
  const [pos, setPos] = useState('ALL')

  const rows = useMemo(() => {
    const list = data?.[kind] ?? []
    const key = `${kind}_${win}` as const
    return list.filter((p) => (p[key] ?? 0) > 0 && (pos === 'ALL' || p.position === pos))
  }, [data, kind, win, pos])

  const columns = useMemo<Column<TrendPlayer>[]>(() => {
    const countKey = `${kind}_${win}` as const
    const cols: Column<TrendPlayer>[] = [
      { key: 'rank', header: '#', render: (p) => <span className="text-stone-400">{rows.indexOf(p) + 1}</span>, align: 'right' },
      { key: 'name', header: 'Player', render: (p) => <PlayerCell p={p} />, sort: (p) => p.name },
      { key: 'pos', header: 'Pos', render: (p) => <Pos pos={p.position} />, sort: (p) => POS_ORDER.indexOf(p.position), align: 'center' },
      { key: 'opp', header: `Wk ${week}`, render: (p) => (p.on_bye ? 'BYE' : p.opponent ?? '—'), sort: (p) => p.opponent },
      { key: 'count', header: kind === 'adds' ? `Adds ${win}` : `Drops ${win}`, render: (p) => <span className={`font-semibold ${kind === 'adds' ? 'text-emerald-700' : 'text-red-700'}`}>{fmtInt(p[countKey])}</span>, sort: (p) => p[countKey], align: 'right', desc: true },
      { key: 'other', header: win === '24h' ? '7d' : '24h', render: (p) => <span className="text-stone-500">{fmtInt(p[`${kind}_${win === '24h' ? '7d' : '24h'}` as const])}</span>, sort: (p) => p[`${kind}_${win === '24h' ? '7d' : '24h'}` as const], align: 'right', desc: true },
      { key: 'opp_count', header: kind === 'adds' ? `Drops ${win}` : `Adds ${win}`, render: (p) => <span className="text-stone-500">{fmtInt(p[`${kind === 'adds' ? 'drops' : 'adds'}_${win}` as const])}</span>, sort: (p) => p[`${kind === 'adds' ? 'drops' : 'adds'}_${win}` as const], align: 'right', desc: true },
      { key: 'owned', header: 'Own%', render: (p) => pct(p.owned), sort: (p) => p.owned, align: 'right', desc: true },
      { key: 'started', header: 'Start%', render: (p) => pct(p.started), sort: (p) => p.started, align: 'right', desc: true },
      { key: 'depth', header: 'Dep', render: (p) => <span className="text-stone-600">{p.depth_chart_position ? `${p.depth_chart_position}${p.depth_chart_order ?? ''}` : '—'}</span>, sort: (p) => p.depth_chart_order, align: 'center' },
      { key: 'prev', header: "'25 PPG", render: (p) => <span className="text-stone-600">{fmt(p.prev_season_ppg)}</span>, sort: (p) => p.prev_season_ppg, align: 'right', desc: true },
    ]
    for (const lg of data?.leagues ?? []) {
      cols.push({
        key: `lg_${lg.league_id}`,
        header: <span className="inline-flex items-center gap-1"><PlatformBadge platform={lg.platform} />{lg.name}</span>,
        title: 'Availability in this league, with projected points this week and rest of season under its scoring',
        className: 'border-l border-stone-200',
        sort: (p) => {
          const s = p.leagues.find((l) => l.league_id === lg.league_id)
          return s ? (s.status === 'free' ? 2 : s.status === 'mine' ? 1 : 0) * 10000 + (s.proj_ros ?? 0) : null
        },
        desc: true,
        render: (p) => {
          const s = p.leagues.find((l) => l.league_id === lg.league_id)
          if (!s) return null
          return (
            <span className="inline-flex items-center gap-1.5">
              {s.status === 'free' && (
                <button onClick={() => openPlan({ leagueId: lg.league_id, add: p })} className={`rounded border px-1.5 py-0.5 text-[11px] font-medium ${s.platform_status === 'WAIVERS' ? 'border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100' : 'border-emerald-300 bg-emerald-50 text-emerald-800 hover:bg-emerald-100'}`} title={s.platform_status === 'WAIVERS' ? 'On waivers — plan a claim' : 'Free agent — plan a pickup'}>
                  {s.platform_status === 'WAIVERS' ? 'Waivers' : 'Free'} · Plan
                </button>
              )}
              {s.status === 'mine' && <Chip tone="blue">Mine</Chip>}
              {s.status === 'owned' && <Chip title={`Rostered by ${s.owner}`}>{s.owner}</Chip>}
              <span className="num text-stone-600">{fmt(s.proj_week)} <span className="text-stone-400">/</span> {fmt(s.proj_ros, 0)}</span>
            </span>
          )
        },
      })
    }
    return cols
  }, [data, kind, win, week, rows, openPlan])

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-base font-semibold">Trends</h1>
        <div className="flex rounded-md border border-stone-200 bg-white p-0.5">
          {(['adds', 'drops'] as const).map((k) => (
            <button key={k} onClick={() => setKind(k)} className={`rounded px-2.5 py-1 text-[12px] capitalize ${kind === k ? 'bg-stone-900 text-white' : 'text-stone-700 hover:bg-stone-100'}`}>{k}</button>
          ))}
        </div>
        <div className="flex rounded-md border border-stone-200 bg-white p-0.5">
          {(['24h', '7d'] as const).map((w) => (
            <button key={w} onClick={() => setWin(w)} className={`rounded px-2.5 py-1 text-[12px] ${win === w ? 'bg-stone-900 text-white' : 'text-stone-700 hover:bg-stone-100'}`}>{w}</button>
          ))}
        </div>
        <div className="flex rounded-md border border-stone-200 bg-white p-0.5">
          {['ALL', ...POS_ORDER].map((f) => (
            <button key={f} onClick={() => setPos(f)} className={`rounded px-2.5 py-1 text-[12px] ${pos === f ? 'bg-stone-900 text-white' : 'text-stone-700 hover:bg-stone-100'}`}>{f}</button>
          ))}
        </div>
        <span className="ml-auto text-[12px] text-stone-500">Sleeper-wide top 100 {kind}. League columns show week / rest-of-season projections.</span>
      </div>
      {isLoading && <Spinner label="Loading trends across your leagues…" />}
      {error && <ErrorBox error={error} />}
      {data && <DataTable rows={rows} columns={columns} rowKey={(p) => p.player_id} initialSort={{ key: 'owned', dir: 'desc' }} />}
    </div>
  )
}
