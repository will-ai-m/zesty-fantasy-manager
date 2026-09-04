import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type Plan } from '../api'
import { timeAgo } from '../lib/format'
import { useApp } from '../components/AppContext'
import { Chip, ErrorBox, PlatformBadge, Pos, Spinner } from '../components/Badges'

function PlayerLabel({ p }: { p: Plan['add_player'] }) {
  if (!p) return <span className="text-stone-400">—</span>
  return <span className="inline-flex items-center gap-1.5">{p.position && <Pos pos={p.position} />}<span className="font-medium">{p.name}</span><span className="text-stone-500">{p.team}</span></span>
}

function Editable({ value, onSave, type = 'text', className = '' }: { value: string; onSave: (v: string) => void; type?: string; className?: string }) {
  const [v, setV] = useState(value)
  const [editing, setEditing] = useState(false)
  if (!editing) {
    return <button onClick={() => { setV(value); setEditing(true) }} className={`rounded px-1 text-left hover:bg-stone-100 ${className}`} title="Click to edit">{value || <span className="text-stone-400">—</span>}</button>
  }
  return (
    <input autoFocus type={type} value={v} onChange={(e) => setV(e.target.value)}
      onBlur={() => { setEditing(false); if (v !== value) onSave(v) }}
      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') { setV(value); setEditing(false) } }}
      className={`rounded border border-stone-300 px-1 ${className}`} />
  )
}

export default function Planner() {
  const { leagues, openPlan } = useApp()
  const qc = useQueryClient()
  const { data, isLoading, error } = useQuery({ queryKey: ['plans'], queryFn: api.plans })
  const patch = useMutation({ mutationFn: ({ id, body }: { id: string; body: Parameters<typeof api.patchPlan>[1] }) => api.patchPlan(id, body), onSuccess: () => qc.invalidateQueries({ queryKey: ['plans'] }) })
  const del = useMutation({ mutationFn: api.deletePlan, onSuccess: () => qc.invalidateQueries({ queryKey: ['plans'] }) })
  const [showDone, setShowDone] = useState(false)

  /** Claims run in the order you set them, so moving one renumbers the whole league's queue. */
  const reorder = (rows: Plan[], index: number, delta: number) => {
    const next = [...rows]
    const [moved] = next.splice(index, 1)
    next.splice(index + delta, 0, moved)
    next.forEach((p, i) => {
      if (p.priority !== i + 1) patch.mutate({ id: p.id, body: { priority: i + 1 } })
    })
  }

  if (isLoading) return <Spinner label="Loading plans…" />
  if (error) return <ErrorBox error={error} />
  const plans = data ?? []

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <h1 className="text-base font-semibold">Moves planner</h1>
        <span className="text-[12px] text-stone-500">Sleeper's API is read-only: record the moves you intend to make, make them in Sleeper, then mark them done.</span>
        <label className="ml-auto flex items-center gap-1.5 text-[12px] text-stone-700"><input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} /> Show done / skipped</label>
      </div>
      {leagues.map((lg) => {
        const mine = plans.filter((p) => p.league_id === lg.league_id).filter((p) => showDone || p.status === 'planned')
        const planned = plans.filter((p) => p.league_id === lg.league_id && p.status === 'planned')
        const bids = planned.reduce((s, p) => s + (p.bid ?? 0), 0)
        const faab = lg.my_team?.faab_remaining ?? 0
        const isFaab = lg.waiver.type_code === 2
        return (
          <section key={lg.league_id} className="rounded-md border border-stone-200 bg-white">
            <div className="flex flex-wrap items-center gap-2 border-b border-stone-200 px-3 py-2">
              <h2 className="flex items-center gap-2 font-semibold"><PlatformBadge platform={lg.platform} />{lg.name}</h2>
              {isFaab && <Chip tone="amber">${faab} FAAB left</Chip>}
              {isFaab && planned.length > 0 && <Chip tone={faab - bids < 0 ? 'red' : 'stone'}>${bids} planned → ${faab - bids} after</Chip>}
              {!isFaab && lg.my_team?.waiver_position != null && <Chip>Waiver #{lg.my_team.waiver_position}</Chip>}
              <Chip>{planned.length} planned</Chip>
              {isFaab && planned.length > 1 && <Chip title="Sleeper runs your claims in this order: if an early one lands, later ones still run unless the roster is full">ordered</Chip>}
              <button onClick={() => openPlan({ leagueId: lg.league_id })} className="ml-auto rounded border border-stone-300 px-2 py-0.5 text-[11px] hover:bg-stone-50">+ Drop-only plan</button>
            </div>
            {mine.length === 0 ? (
              <div className="px-3 py-3 text-[12px] text-stone-500">No planned moves. Use “Plan” on the Waivers or Trends page.</div>
            ) : (
              <table className="data w-full">
                <thead><tr><th title="Claims are processed in this order, so put the one you most want first">#</th><th>Add</th><th>Drop</th>{isFaab && <th className="text-right">Bid</th>}<th>Note</th><th>Status</th><th>Updated</th><th></th></tr></thead>
                <tbody>
                  {mine.map((p, i) => (
                    <tr key={p.id} className={p.status !== 'planned' ? 'text-stone-400' : ''}>
                      <td className="num w-10 whitespace-nowrap text-stone-500">
                        {i + 1}
                        {p.status === 'planned' && (
                          <>
                            <button disabled={i === 0} onClick={() => reorder(mine, i, -1)} title="Claim this one earlier" className="ml-1 disabled:opacity-20">↑</button>
                            <button disabled={i === mine.length - 1} onClick={() => reorder(mine, i, 1)} title="Claim this one later" className="disabled:opacity-20">↓</button>
                          </>
                        )}
                      </td>
                      <td><PlayerLabel p={p.add_player} /></td>
                      <td><PlayerLabel p={p.drop_player} /></td>
                      {isFaab && <td className="num text-right"><Editable value={p.bid == null ? '' : String(p.bid)} type="number" className="w-16 text-right num" onSave={(v) => patch.mutate({ id: p.id, body: { bid: Number(v) || 0 } })} /></td>}
                      <td className="max-w-[360px]"><Editable value={p.note} className="w-full" onSave={(v) => patch.mutate({ id: p.id, body: { note: v } })} /></td>
                      <td><Chip tone={p.status === 'planned' ? 'blue' : p.status === 'done' ? 'green' : 'stone'}>{p.status}</Chip></td>
                      <td className="text-stone-500">{timeAgo(p.updated_at * 1000)}</td>
                      <td className="whitespace-nowrap text-right">
                        {p.status === 'planned' ? (
                          <>
                            <button onClick={() => patch.mutate({ id: p.id, body: { status: 'done' } })} className="rounded border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-[11px] text-emerald-800 hover:bg-emerald-100">Done</button>
                            <button onClick={() => patch.mutate({ id: p.id, body: { status: 'skipped' } })} className="ml-1 rounded border border-stone-300 px-2 py-0.5 text-[11px] hover:bg-stone-50">Skip</button>
                          </>
                        ) : (
                          <button onClick={() => patch.mutate({ id: p.id, body: { status: 'planned' } })} className="rounded border border-stone-300 px-2 py-0.5 text-[11px] hover:bg-stone-50">Reopen</button>
                        )}
                        <button onClick={() => del.mutate(p.id)} className="ml-1 rounded border border-red-200 px-2 py-0.5 text-[11px] text-red-700 hover:bg-red-50">Delete</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        )
      })}
    </div>
  )
}
