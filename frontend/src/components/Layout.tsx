import { NavLink, Outlet } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../api'
import { useApp } from './AppContext'
import { ErrorBox, Spinner } from './Badges'
import { PlayerDrawer } from './PlayerDrawer'
import { PlanDialog } from './PlanDialog'

const nav = [
  { to: '/waivers', label: 'Waivers' },
  { to: '/trends', label: 'Trends' },
  { to: '/roster', label: 'Roster' },
  { to: '/league', label: 'League' },
  { to: '/planner', label: 'Planner' },
]

export function Layout() {
  const { me, loading, error, leagues, leagueId, setLeagueId } = useApp()
  const qc = useQueryClient()
  const refresh = useMutation({
    mutationFn: api.refresh,
    onSuccess: () => qc.invalidateQueries(),
  })

  return (
    <div className="flex min-h-full flex-col">
      <header className="sticky top-0 z-30 border-b border-stone-200 bg-white/95 backdrop-blur">
        <div className="flex items-center gap-4 px-4 py-2">
          <div className="flex items-baseline gap-2">
            <span className="text-[15px] font-bold tracking-tight">Zesty</span>
            <span className="text-[11px] text-stone-500">{me ? `${me.state.season} · Week ${me.state.current_week}` : ''}</span>
          </div>
          <nav className="flex items-center gap-1">
            {nav.map((n) => (
              <NavLink key={n.to} to={n.to} className={({ isActive }) => `rounded px-2.5 py-1 text-[13px] ${isActive ? 'bg-stone-900 text-white' : 'text-stone-700 hover:bg-stone-100'}`}>
                {n.label}
              </NavLink>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-1">
            {leagues.map((l) => (
              <button
                key={l.league_id}
                onClick={() => setLeagueId(l.league_id)}
                className={`rounded-full border px-3 py-1 text-[12px] ${l.league_id === leagueId ? 'border-amber-400 bg-amber-100 text-amber-900 font-medium' : 'border-stone-200 bg-white text-stone-700 hover:bg-stone-50'}`}
                title={`${l.scoring_format} · ${l.total_rosters} teams · ${l.waiver.type}`}
              >
                {l.name}
              </button>
            ))}
            <button onClick={() => refresh.mutate()} disabled={refresh.isPending} title="Re-fetch from Sleeper" className="ml-2 rounded border border-stone-200 px-2 py-1 text-[12px] text-stone-600 hover:bg-stone-50 disabled:opacity-50">
              {refresh.isPending ? '…' : '↻'}
            </button>
          </div>
        </div>
      </header>
      <main className="flex-1 px-4 py-3">
        {loading && <Spinner label="Loading your leagues…" />}
        {error && <ErrorBox error={error} />}
        {me && <Outlet />}
      </main>
      <PlayerDrawer />
      <PlanDialog />
    </div>
  )
}
