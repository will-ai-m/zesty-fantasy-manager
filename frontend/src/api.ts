export type Injury = 'Questionable' | 'Doubtful' | 'Out' | 'IR' | 'PUP' | 'Sus' | 'COV' | 'NA' | 'DNR' | null

export interface Player {
  player_id: string
  name: string
  position: string
  positions: string[]
  team: string | null
  number: number | null
  age: number | null
  years_exp: number | null
  status: string | null
  injury_status: Injury | string | null
  injury_body_part: string | null
  injury_notes: string | null
  practice_participation: string | null
  depth_chart_position: string | null
  depth_chart_order: number | null
  news_updated: number | null
  bye_week: number | null
  opponent: string | null
  on_bye: boolean
  owned: number
  started: number
  adds_24h: number
  adds_7d: number
  drops_24h: number
  drops_7d: number
  proj_week: number | null
  proj_next: number | null
  proj_ros: number | null
  proj_week_rank?: string | null
  proj_ros_rank?: string | null
  vs_mine?: number | null
  platform_status?: 'FREEAGENT' | 'WAIVERS' | 'ONTEAM' | null
  waiver_until?: number | null
  owned_change?: number | null
  proj_season?: number | null
  last_week_pts: number | null
  season_pts: number | null
  season_gp: number
  season_ppg: number | null
  prev_season_ppg: number | null
  prev_season_gp: number
}

export type Platform = 'sleeper' | 'espn' | 'yahoo'

export interface LeagueSummary {
  league_id: string
  platform: Platform
  platform_league_id?: string | null
  error?: string
  name: string
  season: string
  status: string
  avatar: string | null
  total_rosters: number
  roster_positions: string[]
  scoring_format: string
  pass_td: number | null
  waiver: {
    type: string
    type_code: number
    budget: number
    clear_days: number | null
    day_of_week: string | null
    days?: string[] | null
    hour?: number | null
    daily: boolean
    bid_min: number
  }
  reserve_slots: number
  taxi_slots: number
  trade_deadline: number | null
  trade_deadline_date?: number | null
  playoff_week_start: number | null
  ros_end_week: number
  my_roster_id: number | null
  my_team: {
    wins: number
    losses: number
    ties: number
    fpts: number | null
    waiver_position: number | null
    faab_used: number
    faab_remaining: number
  } | null
}

export interface Me {
  user: { user_id: string; username: string; display_name: string; avatar: string | null }
  state: { season: string; week: number; current_week: number; season_type: string; display_week: number }
  leagues: LeagueSummary[]
}

export interface WaiversResponse {
  league: LeagueSummary
  week: number
  ros_end_week: number
  players: Player[]
}

export interface Owner { user_id: string | null; display_name: string; team_name: string; avatar: string | null }

export interface OptimalRow { slot: string; current: Player | null; suggested: Player | null; change: boolean; delta: number }

export interface RosterView {
  roster_id: number
  owner: Owner
  is_mine: boolean
  record: { wins: number; losses: number; ties: number }
  fpts: number | null
  fpts_against: number | null
  ppts: number | null
  waiver_position: number | null
  faab_used: number
  faab_remaining: number
  total_moves: number
  starters: { slot: string; player: Player | null }[]
  bench: Player[]
  reserve: Player[]
  taxi: Player[]
  optimal: { rows: OptimalRow[]; current_total: number; optimal_total: number; gain: number }
  flags: { level: 'error' | 'warn' | 'info'; text: string }[]
}

export interface RosterResponse { league: LeagueSummary; week: number; roster: RosterView | null }
export interface RostersResponse { league: LeagueSummary; week: number; rosters: RosterView[] }

export interface TxPlayer { player_id: string; name: string; position: string | null; team: string | null; roster: Owner | null }
export interface Transaction {
  transaction_id: string
  type: 'free_agent' | 'waiver' | 'trade'
  status: string
  week: number | null
  created: number | null
  status_updated: number | null
  bid: number | null
  notes: string | null
  adds: TxPlayer[]
  drops: TxPlayer[]
  rosters: (Owner | null)[]
  draft_picks: unknown[]
  faab_moved: unknown[]
}
export interface TransactionsResponse { league: LeagueSummary; weeks: number[]; transactions: Transaction[] }

export interface LeagueStatus {
  league_id: string
  league_name: string
  status: 'free' | 'mine' | 'owned'
  owner: string | null
  proj_week: number | null
  proj_ros: number | null
  platform_status?: string | null
  waiver_until?: number | null
}
export interface TrendPlayer extends Player { leagues: LeagueStatus[] }
export interface TrendsResponse { week: number; leagues: { league_id: string; name: string; platform?: Platform }[]; adds: TrendPlayer[]; drops: TrendPlayer[] }

export interface MyPlayer extends Player {
  leagues: { league_id: string; league_name: string; role: string; proj_week: number | null; proj_ros: number | null }[]
}
export interface MyPlayersResponse { week: number; leagues: { league_id: string; name: string; platform?: Platform }[]; players: MyPlayer[] }

export interface WeekRow {
  season: string
  week: number
  opponent: string | null
  proj_pts: number | null
  actual_pts: number | null
  proj: Record<string, number>
  stats: Record<string, number>
}
export interface PlayerDetail {
  player: {
    player_id: string; name: string; position: string | null; team: string | null; age: number | null; years_exp: number | null
    college: string | null; height: string | null; weight: string | null; number: number | null; injury_status: string | null
    injury_body_part: string | null; injury_notes: string | null; depth_chart_position: string | null; depth_chart_order: number | null
    bye_week: number | null; status: string | null
  }
  scoring_league_id: string | null
  current_season: WeekRow[]
  previous_season: WeekRow[]
}

export type PlanStatus = 'planned' | 'done' | 'skipped'
export interface Plan {
  id: string
  league_id: string
  add_player_id: string | null
  drop_player_id: string | null
  bid: number | null
  note: string
  target_week: number | null
  status: PlanStatus
  created_at: number
  updated_at: number
  add_player?: PlanPlayer | null
  drop_player?: PlanPlayer | null
}
export interface PlanPlayer { player_id: string; name: string; position: string | null; team: string | null }

async function http<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { headers: { 'content-type': 'application/json' }, ...init })
  if (!res.ok) {
    let detail = res.statusText
    try { detail = (await res.json()).detail ?? detail } catch { /* ignore */ }
    throw new Error(`${res.status}: ${detail}`)
  }
  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}

const q = (params: Record<string, string | number | undefined | null>) => {
  const s = Object.entries(params).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&')
  return s ? `?${s}` : ''
}

export interface Game {
  game_id: string
  kickoff: string | null
  state: 'pre' | 'in' | 'post' | null
  status_detail: string | null
  away: string | null
  home: string | null
  away_name: string | null
  home_name: string | null
  away_record: string | null
  home_record: string | null
  away_score: number | null
  home_score: number | null
  /** Home team's line: negative = home favored. */
  spread: number | null
  favorite: string | null
  total: number | null
  away_moneyline: number | null
  home_moneyline: number | null
  away_implied: number | null
  home_implied: number | null
  odds_provider: string | null
  odds_source: 'espn' | 'nflverse' | null
  venue: string | null
  broadcast: string | null
  weather: { summary: string | null; temperature: number | null } | null
}

export interface GamesResponse {
  season: number
  week: number
  source: string
  priced: number
  games: Game[]
}

export const api = {
  me: () => http<Me>('/api/me'),
  waivers: (leagueId: string, week?: number) => http<WaiversResponse>(`/api/leagues/${leagueId}/waivers${q({ week })}`),
  roster: (leagueId: string, week?: number) => http<RosterResponse>(`/api/leagues/${leagueId}/roster${q({ week })}`),
  rosters: (leagueId: string, week?: number) => http<RostersResponse>(`/api/leagues/${leagueId}/rosters${q({ week })}`),
  transactions: (leagueId: string, weeks = 3) => http<TransactionsResponse>(`/api/leagues/${leagueId}/transactions${q({ weeks })}`),
  trends: () => http<TrendsResponse>('/api/trends'),
  games: (week?: number) => http<GamesResponse>(`/api/games${q({ week })}`),
  myPlayers: (week?: number) => http<MyPlayersResponse>(`/api/my-players${q({ week })}`),
  player: (playerId: string, leagueId?: string | null) => http<PlayerDetail>(`/api/players/${playerId}${q({ league_id: leagueId })}`),
  plans: () => http<Plan[]>('/api/plans'),
  createPlan: (body: Omit<Plan, 'id' | 'status' | 'created_at' | 'updated_at' | 'add_player' | 'drop_player'>) => http<Plan>('/api/plans', { method: 'POST', body: JSON.stringify(body) }),
  patchPlan: (id: string, body: Partial<Pick<Plan, 'add_player_id' | 'drop_player_id' | 'bid' | 'note' | 'status' | 'target_week'>>) =>
    http<Plan>(`/api/plans/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deletePlan: (id: string) => http<void>(`/api/plans/${id}`, { method: 'DELETE' }),
  refresh: () => http<{ ok: boolean }>('/api/cache/refresh', { method: 'POST' }),
}
