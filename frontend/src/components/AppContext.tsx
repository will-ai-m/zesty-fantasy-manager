import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, type LeagueSummary, type Me, type Player } from '../api'
import { load, save } from '../lib/prefs'
import { assignLeagueColors, FALLBACK_COLOR } from '../lib/leagueColors'

export interface PlanDraft {
  leagueId: string
  add?: Pick<Player, 'player_id' | 'name' | 'position' | 'team'> | null
  drop?: Pick<Player, 'player_id' | 'name' | 'position' | 'team'> | null
}

interface AppState {
  me: Me | undefined
  loading: boolean
  error: Error | null
  leagues: LeagueSummary[]
  erroredLeagues: LeagueSummary[]
  leagueId: string | null
  league: LeagueSummary | null
  setLeagueId: (id: string) => void
  week: number
  /** Tailwind background class identifying this league. Render it only as a bar or dot — see
   * lib/leagueColors. */
  leagueColor: (leagueId: string) => string
  drawerPlayer: string | null
  openPlayer: (playerId: string) => void
  closePlayer: () => void
  planDraft: PlanDraft | null
  openPlan: (draft: PlanDraft) => void
  closePlan: () => void
}

const Ctx = createContext<AppState | null>(null)

export function AppProvider({ children }: { children: ReactNode }) {
  const { data: me, isLoading, error } = useQuery({ queryKey: ['me'], queryFn: api.me, staleTime: 60_000 })
  const [leagueId, setLeagueIdState] = useState<string | null>(() => load<string | null>('leagueId', null))
  const [drawerPlayer, setDrawerPlayer] = useState<string | null>(null)
  const [planDraft, setPlanDraft] = useState<PlanDraft | null>(null)

  const leagues = useMemo(() => (me?.leagues ?? []).filter((l) => !l.error), [me])
  const erroredLeagues = useMemo(() => (me?.leagues ?? []).filter((l) => !!l.error), [me])
  useEffect(() => {
    if (leagues.length && !leagues.some((l) => l.league_id === leagueId)) {
      setLeagueIdState(leagues[0].league_id)
    }
  }, [leagues, leagueId])

  // Errored leagues are included so a league that failed to load still keeps its own color in
  // the sidebar rather than borrowing the next healthy league's.
  const colors = useMemo(
    () => assignLeagueColors((me?.leagues ?? []).map((l) => l.league_id)),
    [me],
  )
  const leagueColor = useCallback((id: string) => colors[id] ?? FALLBACK_COLOR, [colors])

  const setLeagueId = useCallback((id: string) => {
    setLeagueIdState(id)
    save('leagueId', id)
  }, [])

  const value = useMemo<AppState>(() => ({
    me,
    loading: isLoading,
    error: (error as Error | null) ?? null,
    leagues,
    erroredLeagues,
    leagueId,
    league: leagues.find((l) => l.league_id === leagueId) ?? null,
    setLeagueId,
    week: me?.state.current_week ?? 1,
    leagueColor,
    drawerPlayer,
    openPlayer: setDrawerPlayer,
    closePlayer: () => setDrawerPlayer(null),
    planDraft,
    openPlan: setPlanDraft,
    closePlan: () => setPlanDraft(null),
  }), [me, isLoading, error, leagues, erroredLeagues, leagueId, setLeagueId, leagueColor, drawerPlayer, planDraft])

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useApp(): AppState {
  const v = useContext(Ctx)
  if (!v) throw new Error('useApp outside AppProvider')
  return v
}
