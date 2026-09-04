import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type Player } from '../api'
import { fmt } from '../lib/format'
import { useApp } from './AppContext'
import { PlatformBadge, Pos } from './Badges'

export function PlanDialog() {
  const { planDraft, closePlan, leagues, week } = useApp()
  const qc = useQueryClient()
  const leagueId = planDraft?.leagueId
  const league = leagues.find((l) => l.league_id === leagueId)
  const { data: rosterData } = useQuery({
    queryKey: ['roster', leagueId, week],
    queryFn: () => api.roster(leagueId!, week),
    enabled: !!leagueId,
  })
  const { data: plans } = useQuery({ queryKey: ['plans'], queryFn: api.plans, enabled: !!leagueId })

  const [dropId, setDropId] = useState<string>('')
  const [bid, setBid] = useState<string>('0')
  const [note, setNote] = useState('')

  useEffect(() => {
    setDropId(planDraft?.drop?.player_id ?? '')
    setBid('0')
    setNote('')
  }, [planDraft])

  const rosterPlayers = useMemo<Player[]>(() => {
    const r = rosterData?.roster
    if (!r) return []
    const all = [...r.starters.map((s) => s.player).filter((p): p is Player => !!p), ...r.bench, ...r.reserve, ...r.taxi]
    return all.sort((a, b) => (a.proj_ros ?? 0) - (b.proj_ros ?? 0))
  }, [rosterData])

  const plannedBids = (plans ?? []).filter((p) => p.league_id === leagueId && p.status === 'planned').reduce((s, p) => s + (p.bid ?? 0), 0)
  const faab = rosterData?.roster?.faab_remaining ?? league?.my_team?.faab_remaining ?? 0

  const create = useMutation({
    mutationFn: () => api.createPlan({
      league_id: leagueId!,
      add_player_id: planDraft?.add?.player_id ?? null,
      drop_player_id: dropId || null,
      bid: league?.waiver.type_code === 2 ? Number(bid) || 0 : null,
      note,
      target_week: week,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['plans'] })
      closePlan()
    },
  })

  if (!planDraft || !league) return null
  const isFaab = league.waiver.type_code === 2
  const roleOf = (pid: string) => {
    const r = rosterData?.roster
    if (!r) return ''
    const s = r.starters.find((x) => x.player?.player_id === pid)
    if (s) return s.slot
    if (r.reserve.some((p) => p.player_id === pid)) return 'IR'
    if (r.taxi.some((p) => p.player_id === pid)) return 'TAXI'
    return 'BN'
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={closePlan}>
      <div className="absolute inset-0 bg-stone-900/30" />
      <div className="relative w-[520px] max-w-full rounded-lg border border-stone-200 bg-white p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="flex items-center gap-2 text-base font-semibold"><PlatformBadge platform={league.platform} />Plan a move · {league.name}</h2>
        <p className="mt-0.5 text-[12px] text-stone-500">This only records what you intend to do. Make the actual move in {league.platform === 'espn' ? 'ESPN' : league.platform === 'yahoo' ? 'Yahoo' : 'Sleeper'}, then mark it done in the Planner.</p>

        <div className="mt-4 space-y-3">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wide text-stone-500">Add</div>
            {planDraft.add ? (
              <div className="mt-1 flex items-center gap-2 rounded border border-emerald-200 bg-emerald-50 px-2 py-1.5">
                <Pos pos={planDraft.add.position} /><span className="font-medium">{planDraft.add.name}</span><span className="text-stone-500">{planDraft.add.team}</span>
              </div>
            ) : <div className="mt-1 text-stone-500">No add (drop only)</div>}
          </div>

          <div>
            <label className="text-[11px] font-semibold uppercase tracking-wide text-stone-500">Drop</label>
            <select value={dropId} onChange={(e) => setDropId(e.target.value)} className="mt-1 w-full rounded border border-stone-300 bg-white px-2 py-1.5">
              <option value="">— No drop (open roster spot) —</option>
              {rosterPlayers.map((p) => (
                <option key={p.player_id} value={p.player_id}>
                  {roleOf(p.player_id).padEnd(4)} {p.position} {p.name} ({p.team ?? 'FA'}) · wk {fmt(p.proj_week)} · ROS {fmt(p.proj_ros, 0)}{p.injury_status ? ` · ${p.injury_status}` : ''}
                </option>
              ))}
            </select>
            <div className="mt-1 text-[11px] text-stone-500">Sorted by lowest rest-of-season projection first.</div>
          </div>

          {isFaab && (
            <div>
              <label className="text-[11px] font-semibold uppercase tracking-wide text-stone-500">FAAB bid</label>
              <div className="mt-1 flex items-center gap-3">
                <input type="number" min={league.waiver.bid_min} max={faab} value={bid} onChange={(e) => setBid(e.target.value)} className="w-28 rounded border border-stone-300 px-2 py-1.5 num" />
                <span className="text-[12px] text-stone-600">
                  ${faab} remaining · ${plannedBids} already planned · <span className={faab - plannedBids - (Number(bid) || 0) < 0 ? 'text-red-700 font-semibold' : ''}>${faab - plannedBids - (Number(bid) || 0)} after this</span>
                </span>
              </div>
            </div>
          )}

          <div>
            <label className="text-[11px] font-semibold uppercase tracking-wide text-stone-500">Note</label>
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why this move…" className="mt-1 w-full rounded border border-stone-300 px-2 py-1.5" />
          </div>
        </div>

        {create.error && <div className="mt-3 text-red-700">{(create.error as Error).message}</div>}
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={closePlan} className="rounded border border-stone-300 px-3 py-1.5 hover:bg-stone-50">Cancel</button>
          <button onClick={() => create.mutate()} disabled={create.isPending || (!planDraft.add && !dropId)} className="rounded bg-stone-900 px-3 py-1.5 font-medium text-white hover:bg-stone-700 disabled:opacity-50">
            Save plan
          </button>
        </div>
      </div>
    </div>
  )
}
