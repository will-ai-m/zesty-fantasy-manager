export type Injury = 'Questionable' | 'Doubtful' | 'Out' | 'IR' | 'PUP' | 'Sus' | 'COV' | 'NA' | 'DNR' | null

export interface FpSet {
  rank_ecr: number | null
  pos_rank: string | null
  rank_min: number | null
  rank_max: number | null
  rank_ave: number | null
  rank_std: number | null
  tier: number | null
  ecr_delta: number | null
  owned_avg: number | null
  experts: number | null
}

export interface FpDetail {
  fetched_at_iso: string
  scoring: string
  sets: { weekly?: FpSet; ros?: FpSet; waiver?: FpSet }
}

export interface Player extends Usage {
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
  /** Kickoff day of this player's game this week, YYYY-MM-DD in US Eastern. Null on a bye. */
  game_date: string | null
  game_status: 'pre_game' | 'in_game' | 'complete' | 'canceled' | null
  /** Their game is on the NFL's current calendar day (Eastern), decided server-side. */
  playing_today: boolean
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
  /** Places above the player of yours he would replace, on FantasyPros' rest-of-season overall
   * ranking. Positive is an upgrade. Null when FantasyPros does not rank him. */
  vs_mine?: number | null
  platform_status?: 'FREEAGENT' | 'WAIVERS' | 'ONTEAM' | null
  waiver_until?: number | null
  owned_change?: number | null
  proj_season?: number | null
  /** Points scored in the week being viewed, once the games have been played. */
  week_pts: number | null
  last_week_pts: number | null
  season_pts: number | null
  season_gp: number
  season_ppg: number | null
  prev_season_ppg: number | null
  prev_season_gp: number
  /** FantasyPros weekly ECR, within position, e.g. "WR24". */
  fp_pos_rank?: string | null
  fp_rank_std?: number | null
  /** Place on the FantasyPros waiver-wire shortlist (~50 players league-wide). */
  fp_waiver_rank?: number | null
  fp_waiver_pos_rank?: string | null
  /** FantasyPros rest-of-season rank within position, e.g. "WR11" — what the app calls ROS. */
  fp_ros_pos_rank?: string | null
  /** The same list's overall place, which ranks across positions. */
  fp_ros_ecr?: number | null
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
    /** My fantasy team's name in this league (never null in practice — it falls back to the
     * display name, then "Roster N"). */
    team_name: string | null
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

/** Last completed week's opportunity, carried on every player row. */
export interface Usage {
  lw_snap_pct?: number | null
  lw_snaps?: number | null
  lw_targets?: number | null
  lw_carries?: number | null
  lw_rec?: number | null
  lw_rz?: number | null
  /** Last week's points in standard half-PPR — the one scale the cross-league waiver list reads in. */
  lw_pts_half?: number | null
  lw_volume?: number | null
}

/** One recommendation lifted from this week's waiver columns. Opinion, kept out of the ranked
 * table and shown in its own block. */
export interface ArticleItem {
  name: string
  position: string | null
  team: string | null
  action: 'add' | 'stash' | 'buy' | 'sell' | 'hold'
  faab: string | null
  priority: string | null
  note: string | null
  sources: string[]
}

export interface ArticleSource { id: string; name: string; url: string; partial?: boolean; partial_note?: string }

/** A name-only group from a column — handcuff tiers, drop lists. No per-player reasoning, so
 * these render as compact lines rather than as bullets alongside the reasoned picks. */
export interface ArticleList { label: string; action: 'stash' | 'drop'; names: string[]; sources: string[] }

export interface ArticleDigest { week: number; sources: ArticleSource[]; items: ArticleItem[]; lists: ArticleList[] }

/** A player on the waiver list or a trends list, with where he stands in each of your leagues. */
export interface Target extends Player {
  /** Yahoo only, from its Transaction Trends page: adds and drops across all Yahoo leagues. */
  adds?: number | null
  drops?: number | null
  trades?: number | null
  rank_preseason?: number | null
  rank_actual?: number | null
  leagues: Record<string, WaiverStanding>
}

/** Where a waiver target stands in one league. An open one carries "vs mine" for that league —
 * places above the player of yours he would replace — and your pending claim on him, if any. */
export type WaiverStanding =
  | { status: 'mine'; role: string }
  | { status: 'taken'; owner: string }
  | { status: 'free' | 'waivers'; until?: number | null; vs_mine: number | null; claimed?: boolean; bid?: number | null }

/** A waiver claim you have submitted that has not processed yet. Always your own — every
 * platform keeps claims private until they run. */
export interface PendingClaim {
  player_id: string | null
  name: string | null
  bid: number | null
  priority: number | null
  runs_on: string | null
  drop_player_id: string | null
}

/** One platform's read on who is moving. Each platform publishes a different measure, so each is
 * its own list rather than one blended one. */
export interface Trend { kind: Platform; label: string; blurb: string; rows: Target[]; error?: string }

/** One week of a streamer's schedule. `matchup` is null when the team has no game — a bye. */
export interface StreamGame {
  week: number
  matchup: string | null
  implied: number | null
  opp_implied: number | null
  weather: GameWeather | null
}

/** Conditions at the stadium. The roof is known for every game; `forecast` is there only for an
 * open-air game within a week of kickoff — Open-Meteo, the worst hour of the game window. */
export interface GameWeather {
  stadium: string
  roof: 'dome' | 'retractable' | 'open'
  forecast: {
    wind: number | null
    gust: number | null
    precip_prob: number | null
    /** Inches over the game window, rain and snow melted together. */
    precip: number
    snow: number
    temp: number | null
    hours: number
  } | null
}

/** Team offensive efficiency, season to date — the context behind a kicker's implied total.
 * `games` is the sample it rests on, which is small early in a season. */
export interface TeamFactors {
  games: number | null
  rz_td_pct: number | null
  rz_fg_pct: number | null
  rz_score_pct: number | null
  third_pct: number | null
  third_att: number | null
  fourth_att: number | null
  fourth_att_pg: number | null
  points_pg: number | null
  fg_att: number | null
  fg_made: number | null
  fg_long: number | null
  fg_att_short: number | null
  fg_att_long: number | null
  fg_att_pg: number | null
}

/** A K or D/ST with the next four weeks of matchups running across the row, and where it stands
 * in each of your leagues. */
export interface Streamer extends Player {
  /** Yours in at least one league. Sorts by the same rule as everyone else; it is the benchmark,
   * not an exception. */
  mine: boolean
  weeks: StreamGame[]
  matchup: string | null
  /** The current week's driver: opponent implied total for a defence, own for a kicker. */
  stream_basis: number | null
  /** FantasyPros' rank for this week, and for the rest of the season. Separate fields on purpose
   * — best this Sunday and worth holding are different questions — and neither orders the table. */
  fp_rank: number | null
  fp_ros_rank: number | null
  factors: TeamFactors | null
  /** Standing in each league, keyed by league id. */
  leagues: Record<string, Standing>
}

/** Where one K or D/ST stands in one league. `role` is the slot he fills on your roster (K or DEF
 * when starting, otherwise BN / IR / TAXI). `waivers` only ever comes from ESPN and Yahoo —
 * Sleeper does not publish the split, so a Sleeper player off every roster is `free`. */
export type Standing =
  | { status: 'mine'; role: string }
  | { status: 'taken'; owner: string }
  | { status: 'waivers'; until: number | null }
  | { status: 'free' }

export interface StreamingLeague { league_id: string; name: string; platform: Platform; slots: { K: number; DEF: number } }

/** The K or D/ST you want in one league for one week. Whether it still needs a move is not stored
 * — the page reads that off the rosters each time, so a pick you have made shows as done. */
export interface StreamPick {
  league_id: string
  position: 'K' | 'DEF'
  week: number
  player_id: string
  season: string
  updated_at: number
}
type PickKey = Pick<StreamPick, 'league_id' | 'position' | 'week'>

export interface StreamingResponse {
  week: number
  weeks: number[]
  leagues: StreamingLeague[]
  DEF: Streamer[]
  K: Streamer[]
}

/** One of your own players on the waiver page: where he sits in your lineup, and whether he is the
 * player the "vs mine" column measures free agents against. */
export interface RosterPlayer extends Player {
  /** Starting slot (QB, RB, FLEX…), or BN / IR / TAXI. */
  slot: string
  vs_mine_bar: boolean
}

/** The room on a roster: open spots (starting slots plus bench, less everyone not on IR or taxi),
 * starting slots nobody is in, and IR and taxi slots used of available. */
export interface RosterSpots {
  open: number
  empty_starts: string[]
  ir: { slots: number; used: number }
  taxi: { slots: number; used: number }
}

/** One of your leagues as the waiver page needs it. `roster` is your QBs, RBs, WRs and TEs — K and
 * D/ST belong to the streaming page, though they count towards `spots`. */
export interface WaiverLeague {
  league_id: string
  name: string
  platform: Platform
  waiver: LeagueSummary['waiver']
  my_team: LeagueSummary['my_team']
  roster: RosterPlayer[]
  spots: RosterSpots
  pending: PendingClaim[]
}

/** The waiver wire across every league: FantasyPros' list in its order, the trends, your rosters. */
export interface WaiverBoard {
  week: number
  leagues: WaiverLeague[]
  fantasypros: Target[]
  fantasypros_meta: { experts: number | null; updated: string | null; week: number | null }
  trends: Trend[]
  articles: ArticleDigest | null
}

/** Every free agent in one league, for the Browse tab. */
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
  fantasypros: FpDetail | null
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
  /** Kickoff day in US Eastern — compare against GamesResponse.today, not the browser's date. */
  date_et: string | null
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
  /** Today's date in US Eastern, as the server sees it. */
  today: string
  source: string
  priced: number
  games: Game[]
}

export const api = {
  me: () => http<Me>('/api/me'),
  waivers: (leagueId: string, week?: number) => http<WaiversResponse>(`/api/leagues/${leagueId}/waivers${q({ week })}`),
  waiverBoard: (week?: number) => http<WaiverBoard>(`/api/waivers${q({ week })}`),
  streaming: (week?: number) => http<StreamingResponse>(`/api/streaming${q({ week })}`),
  streamPicks: () => http<StreamPick[]>('/api/stream-picks'),
  setStreamPick: (body: PickKey & { player_id: string }) => http<StreamPick[]>('/api/stream-picks', { method: 'PUT', body: JSON.stringify(body) }),
  clearStreamPick: (key: PickKey) => http<StreamPick[]>(`/api/stream-picks${q(key)}`, { method: 'DELETE' }),
  rosters: (leagueId: string, week?: number) => http<RostersResponse>(`/api/leagues/${leagueId}/rosters${q({ week })}`),
  transactions: (leagueId: string, weeks = 3) => http<TransactionsResponse>(`/api/leagues/${leagueId}/transactions${q({ weeks })}`),
  games: (week?: number) => http<GamesResponse>(`/api/games${q({ week })}`),
  myPlayers: (week?: number) => http<MyPlayersResponse>(`/api/my-players${q({ week })}`),
  player: (playerId: string, leagueId?: string | null) => http<PlayerDetail>(`/api/players/${playerId}${q({ league_id: leagueId })}`),
  refresh: () => http<{ ok: boolean }>('/api/cache/refresh', { method: 'POST' }),
}
