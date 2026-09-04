/** FantasyPros expert consensus, as far as it covers this player. */
export interface FpRanks {
  fp_id?: string
  position?: string | null
  pos_rank?: string | null
  pos_rank_n?: number | null
  rank?: number | null
  tier?: number | null
  rank_std?: number | null
  ecr_delta?: number | null
  owned_avg?: number | null
  opponent?: string | null
  note?: string | null
  recommendation?: string | null
  tag?: string | null
  ros_rank?: number | null
  ros_pos_rank?: number | null
  ros_pos_rank_label?: string | null
  ros_tier?: number | null
  ros_ecr_delta?: number | null
  waiver_rank?: number | null
  waiver_tier?: number | null
  waiver_note?: string | null
}

export interface FpMeta {
  scoring: string
  week: number | null
  type: string | null
  experts: number | null
  last_updated: string | null
  fetched_at: number | null
  players: number
}

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
  fp?: FpRanks | null
  /** The consensus rank expressed in this league's points (see backend/app/ranks.py). */
  fp_implied?: number | null
  /** Points between the consensus and the projection, when they meaningfully disagree. */
  fp_disagreement?: number | null
}

export interface Opportunity {
  blockers: { player_id: string; name: string; injury_status: string; certain: boolean }[]
  certain: boolean
  reason: string
}

export interface FaabSuggestion {
  low: number
  mid: number
  high: number
  share_of_remaining: number | null
  calibrated: boolean
  basis: string
  comparables: { name: string | null; bid: number; week: number | null; position: string | null }[]
}

export interface Priority {
  score: number
  parts: Record<string, number>
  why: string[]
}

export interface Target extends Player {
  priority: Priority
  faab?: FaabSuggestion
  clears_at: number | null
  on_waivers: boolean
  opportunity: Opportunity | null
}

export interface WaiverClock {
  label: string
  timezone: string
  next_runs: number[]
  next_run: number | null
  clear_days: number | null
  daily: boolean
}

export interface FaabMarket {
  budget: number
  claims: number
  won: number
  max: number | null
  median: number | null
  p75: number | null
  p90: number | null
  p90_share: number | null
  top: { player_id: string; name: string | null; position: string | null; bid: number; week: number | null }[]
}

export interface WaiverBoard {
  league: LeagueSummary
  week: number
  ros_end_week: number
  clock: WaiverClock
  faab: { budget: number; remaining: number; pace: number; market: FaabMarket }
  targets: Target[]
  drop_candidates: (Player & { is_starter: boolean })[]
  fp: FpMeta | null
  fp_errors: string[]
}

export interface Kickoff { date: string | null; status: string | null; locked: boolean }

export interface LineupSlot {
  slot: string
  current: Player | null
  suggested: Player | null
  change: boolean
  delta: number
  current_lock: Kickoff | null
  suggested_lock: Kickoff | null
  locked: boolean
  reason: string | null
}

export interface LineupView {
  league: LeagueSummary
  week: number
  basis: 'fantasypros' | 'projections'
  slots: LineupSlot[]
  moves: LineupSlot[]
  watch: { slot: string; player: Player | null; best_replacement: Player | null }[]
  bench: Player[]
  totals: { current: number; optimal: number; gain: number; value_gain: number } | null
  issues: { level: 'error' | 'warn' | 'info'; text: string }[]
  first_kickoff: string | null
  fp: FpMeta | null
  fp_errors: string[]
}

export interface NewsLeagueStatus { league_id: string; league_name: string; status: 'free' | 'mine' | 'owned'; owner: string | null }

export interface NewsItem {
  key: string
  source: string
  source_key: string
  player_id: string
  published: number | null
  title: string | null
  description: string | null
  analysis: string | null
  url: string | null
  hot: boolean
  category: 'injury' | 'practice' | 'depth' | 'transaction' | 'suspension' | 'return' | 'usage' | 'other'
  severity: number
  direction: number
  player: Player
  leagues: NewsLeagueStatus[]
  mine: boolean
  seen: boolean
  beneficiaries: { player_id: string; name: string; group: string; steps: number; reason: string; player: Player; leagues: NewsLeagueStatus[] }[]
}

export interface NewsResponse {
  week: number
  leagues: { league_id: string; name: string; platform?: Platform }[]
  items: NewsItem[]
  unseen: number
  provider: string | null
  errors: string[]
}

export interface WeekLeague {
  league: LeagueSummary
  clock?: WaiverClock
  waivers: { faab?: WaiverBoard['faab']; targets?: Target[]; drop_candidates?: Player[]; error?: string }
  lineup: { moves?: LineupSlot[]; watch?: LineupView['watch']; issues?: LineupView['issues']; gain?: number | null; basis?: string; first_kickoff?: string | null; error?: string }
}

export interface WeekView {
  week: number
  generated_at: number
  timezone: string
  leagues: WeekLeague[]
  news: NewsItem[]
  news_errors: string[]
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
  fp: FpMeta | null
  fp_errors: string[]
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
  priority: number | null
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

export const api = {
  me: () => http<Me>('/api/me'),
  waivers: (leagueId: string, week?: number) => http<WaiversResponse>(`/api/leagues/${leagueId}/waivers${q({ week })}`),
  waiverBoard: (leagueId: string, week?: number) => http<WaiverBoard>(`/api/leagues/${leagueId}/waiver-board${q({ week })}`),
  lineup: (leagueId: string, week?: number) => http<LineupView>(`/api/leagues/${leagueId}/lineup${q({ week })}`),
  week: () => http<WeekView>('/api/week'),
  news: (leagueId?: string | null) => http<NewsResponse>(`/api/news${q({ league_id: leagueId })}`),
  markNews: (keys: string[], seen = true) => http<{ ok: boolean }>('/api/news/seen', { method: 'POST', body: JSON.stringify({ keys, seen }) }),
  roster: (leagueId: string, week?: number) => http<RosterResponse>(`/api/leagues/${leagueId}/roster${q({ week })}`),
  rosters: (leagueId: string, week?: number) => http<RostersResponse>(`/api/leagues/${leagueId}/rosters${q({ week })}`),
  transactions: (leagueId: string, weeks = 3) => http<TransactionsResponse>(`/api/leagues/${leagueId}/transactions${q({ weeks })}`),
  trends: () => http<TrendsResponse>('/api/trends'),
  myPlayers: (week?: number) => http<MyPlayersResponse>(`/api/my-players${q({ week })}`),
  player: (playerId: string, leagueId?: string | null) => http<PlayerDetail>(`/api/players/${playerId}${q({ league_id: leagueId })}`),
  plans: () => http<Plan[]>('/api/plans'),
  createPlan: (body: Omit<Plan, 'id' | 'status' | 'created_at' | 'updated_at' | 'add_player' | 'drop_player' | 'priority'> & { priority?: number | null }) =>
    http<Plan>('/api/plans', { method: 'POST', body: JSON.stringify(body) }),
  patchPlan: (id: string, body: Partial<Pick<Plan, 'add_player_id' | 'drop_player_id' | 'bid' | 'note' | 'status' | 'target_week' | 'priority'>>) =>
    http<Plan>(`/api/plans/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deletePlan: (id: string) => http<void>(`/api/plans/${id}`, { method: 'DELETE' }),
  refresh: () => http<{ ok: boolean }>('/api/cache/refresh', { method: 'POST' }),
}
