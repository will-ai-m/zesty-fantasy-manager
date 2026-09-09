import { useState } from 'react'
import { NavLink, Outlet } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api, type LeagueSummary } from '../api'
import { useApp } from './AppContext'
import { ErrorBox, PlatformBadge, Spinner } from './Badges'
import { PlayerDrawer } from './PlayerDrawer'
import { PlanDialog } from './PlanDialog'
import { SidebarGames } from './SidebarGames'
import { load, save } from '../lib/prefs'

const nav = [
  { to: '/waivers', label: 'Waivers' },
  { to: '/trends', label: 'Trends' },
  { to: '/roster', label: 'Roster' },
  { to: '/league', label: 'League' },
  { to: '/planner', label: 'Planner' },
]

const record = (t: NonNullable<LeagueSummary['my_team']>) =>
  `${t.wins}-${t.losses}${t.ties ? `-${t.ties}` : ''}`

function LeagueButton({ league, active, collapsed, onSelect }: {
  league: LeagueSummary
  active: boolean
  collapsed: boolean
  onSelect: () => void
}) {
  const t = league.my_team
  const tip = league.error ?? `${league.scoring_format} · ${league.total_rosters} teams · ${league.waiver.type}`
  const tone = league.error
    ? 'border-red-200 bg-red-50 text-red-700'
    : active
      ? 'border-amber-400 bg-amber-100 text-amber-900'
      : 'border-transparent text-stone-700 hover:border-stone-200 hover:bg-stone-50'

  if (collapsed) {
    return (
      <button
        onClick={onSelect}
        disabled={!!league.error}
        title={`${league.name} — ${tip}`}
        className={`flex w-full justify-center rounded border px-1 py-1.5 ${tone}`}
      >
        <PlatformBadge platform={league.platform} />
      </button>
    )
  }
  return (
    <button
      onClick={onSelect}
      disabled={!!league.error}
      title={tip}
      className={`w-full rounded border px-2 py-1.5 text-left ${tone}`}
    >
      <span className="flex items-center gap-1.5">
        <PlatformBadge platform={league.platform} />
        <span className={`truncate text-[12.5px] ${active ? 'font-semibold' : ''}`}>{league.name}</span>
      </span>
      {league.error ? (
        <span className="mt-0.5 block truncate text-[10.5px]">{league.error}</span>
      ) : t ? (
        <span className="mt-0.5 flex items-center gap-1.5 text-[10.5px] text-stone-500">
          <span>{record(t)}</span>
          {league.waiver.type === 'FAAB' && <span>${t.faab_remaining}</span>}
          {t.waiver_position != null && <span>W#{t.waiver_position}</span>}
        </span>
      ) : null}
    </button>
  )
}

export function Layout() {
  const { me, loading, error, leagues, erroredLeagues, leagueId, setLeagueId } = useApp()
  const [collapsed, setCollapsed] = useState(() => load<boolean>('sidebarCollapsed', false))
  const qc = useQueryClient()
  const refresh = useMutation({
    mutationFn: api.refresh,
    onSuccess: () => qc.invalidateQueries(),
  })

  const toggle = () => {
    setCollapsed((c) => {
      save('sidebarCollapsed', !c)
      return !c
    })
  }

  return (
    <div className="flex min-h-full flex-col">
      <header className="sticky top-0 z-30 border-b border-stone-200 bg-white/95 backdrop-blur">
        <div className="flex h-10 items-center gap-4 px-4 whitespace-nowrap">
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
          <button onClick={() => refresh.mutate()} disabled={refresh.isPending} title="Re-fetch from Sleeper" className="ml-auto rounded border border-stone-200 px-2 py-1 text-[12px] text-stone-600 hover:bg-stone-50 disabled:opacity-50">
            {refresh.isPending ? '…' : '↻'}
          </button>
        </div>
      </header>

      <div className="flex flex-1 items-start">
        <aside className={`sticky top-10 max-h-[calc(100vh-2.5rem)] shrink-0 overflow-y-auto border-r border-stone-200 bg-white py-2 ${collapsed ? 'w-12 px-1.5' : 'w-52 px-2'}`}>
          <div className={`mb-1.5 flex items-center ${collapsed ? 'justify-center' : 'justify-between'}`}>
            {!collapsed && <span className="text-[10.5px] font-semibold uppercase tracking-wide text-stone-400">Leagues</span>}
            <button
              onClick={toggle}
              title={collapsed ? 'Expand leagues' : 'Collapse leagues'}
              className="rounded px-1 py-0.5 text-[12px] text-stone-400 hover:bg-stone-100 hover:text-stone-700"
            >
              {collapsed ? '»' : '«'}
            </button>
          </div>
          <div className="flex flex-col gap-0.5">
            {[...leagues, ...erroredLeagues].map((l) => (
              <LeagueButton
                key={l.league_id}
                league={l}
                active={l.league_id === leagueId}
                collapsed={collapsed}
                onSelect={() => setLeagueId(l.league_id)}
              />
            ))}
          </div>
          {!collapsed && <SidebarGames />}
        </aside>

        <main className="min-w-0 flex-1 px-4 py-3">
          {loading && <Spinner label="Loading your leagues…" />}
          {error && <ErrorBox error={error} />}
          {me && <Outlet />}
        </main>
      </div>

      <PlayerDrawer />
      <PlanDialog />
    </div>
  )
}
