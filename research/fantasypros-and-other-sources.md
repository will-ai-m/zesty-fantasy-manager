# FantasyPros & other data sources — research findings (2026-09-03, §A updated 2026-09-04)

## FantasyPros — two access paths

### A. Official API — verified 2026-09-04
- Base `https://api.fantasypros.com/public/v2/json`, header `x-api-key`. Public Redoc docs: https://api.fantasypros.com/public/v2/docs — the OpenAPI 3.1 spec behind it downloads without a key: https://api.fantasypros.com/public/v2/docs/fantasypros_v2_public.yml ("FantasyPros Public API" v2.0; description: "This is the free limited public API"). Key request: https://secure.fantasypros.com/api-keys/request/. Tiers page: https://www.fantasypros.com/api-data/.
- Tiers (api-data page, quoted): **Free** "$0 / mo · All endpoints, sample data · Generous daily call limit · Non-production use". **Premium** "$8.99 / mo · Bundled with FantasyPros HOF (from $8.99/mo annual) · Production keys for personal apps · Rankings, projections, players, news & injuries · Personal-use license". **Commercial** custom. On the plans page (https://www.fantasypros.com/premium/plans/) only **HOF** lists the API ("Use FantasyPros data in your own tools and apps. For personal use only."): $22.99/mo monthly, $11.99/mo semi-annual ($71.94), $8.99/mo annual ($107.88). PRO ($3.99–11.99/mo) and MVP ($5.99–16.99/mo) do not include it. **Correction to the 2026-09-03 note: MVP does not include a key, and the free key returns sample data, not live data.**
- Without a key the gateway answers `{"message":"Forbidden"}` (403) on real routes and `{"message":"Missing Authentication Token"}` on nonexistent ones — a free way to confirm routes. Verified present: `nfl/players`, `nfl/news`, `nfl/injuries`, `nfl/compare-players`, `nfl/2026/rankings`, `nfl/2026/consensus-rankings`, `nfl/2026/projections`, `nfl/2026/player-points`. Not routes: `nfl/adp`, `nfl/2026/experts` (experts live under `rankings/experts`), `dfs`, `start-sit`, `waiver-wire`.
- Endpoints from the spec (`*` = required; sport ∈ nfl|mlb|nba|nhl|pga|ncaaf):

| Endpoint | Query params |
|---|---|
| `GET /{sport}/players` | `player`, `update`, `ecr=included\|excluded`, `external_ids=yahoo\|espn\|cbs\|rts\|fanduel\|draftkings\|fantasydraft\|rotogrinders\|fleaflicker\|rotowire\|rotoworld\|numberfire\|fantrax\|nfl\|mfl\|tsn\|onroto\|xmlteam\|ffwc\|mlbam\|nba`, `show=pos_rank` |
| `GET /{sport}/{season}/consensus-rankings` | `position*`, `type` (draft\|weekly\|ros), `scoring` (STD\|HALF\|PPR), `week`, `include_idp=true`, `filters`, `experts=show\|available` |
| `GET /{sport}/{season}/rankings` | `week`, `player`, `filters`, `min`, `range`, `rankstats`, `type=DRAFTERS`, `site_eligibility` |
| `GET /{sport}/{season}/rankings/experts` | `position`, `type`, `scoring`, `include_overall=true` |
| `GET /nfl/{season}/projections` | `position*`, `positions`, `players`, `week`, `ros` (default false), `filters` |
| `GET /nfl/{season}/player-points` | `start` (default 1), `end`, `position=ALL\|QB\|RB\|WR\|TE\|K\|DST\|...`, `scoring=STD\|PPR\|HALF`, `min` |
| `GET /{sport}/compare-players` | `players*`, `position*`, `year`, `week`, `experts`, `ranking_type=draft\|weekly\|ros`, `details=players\|experts\|all` |
| `GET /{sport}/news` | `fpid`, `limit` (default 25), `category=injury\|recap\|transaction\|rumor\|breaking`, `order_by=updated\|created` |
| `GET /{sport}/injuries` | `year`, `week`, `team_id`, `player_ids`, `include_probabilities=true`, `include_minors=true` |

- Response shapes present in the spec: news item `{id, created, created_formated, author, player_id, team_id, title, sport_id, categories[], link, desc, impact}`; projections `{season, week, count, positions, scoring, experts[], players[{fpid, mflid, name, position_id, team_id, filename, stats[]}]}`; player-points `{season, scoring, players[{player_id, player_name, position_id, team_id, filename, games, points, average, weeks{"1": 6.9, ...}}]}`. `consensus-rankings`, `players` and `injuries` have no schema in the spec; the community-reported fields (`rank_ecr, rank_min, rank_max, rank_ave, rank_std, tier, player_owned_avg, ...`) match the website's `ecrData` and are UNVERIFIED for the API.
- Player ids: FantasyPros `player_id` / `fpid`. `external_ids` has no Sleeper option (nearest: `rotowire`, `espn`, `yahoo`, `mfl`). Join to Sleeper via dynastyprocess `db_playerids.csv` (`fantasypros_id` ↔ `sleeper_id`, verified) or Sleeper's own `rotowire_id` (on 98% of active skill players).
- Wrappers: PHP only (JoeyMckenzie/fantasypros-php, HansPeterOrding/fantasypros-api-client — UNVERIFIED, GitHub reported the first as moved). No Python/JS wrapper; none of 16 surveyed OSS projects use the official API. A thin httpx client is ~30 lines.
- **DECIDED 2026-09-04: (B), the public-page scraper.** No key, no subscription; `backend/app/fantasypros.py`
  reads weekly, rest-of-season and waiver-wire pages behind the Crawl-delay. The official API was
  considered and declined on cost; if that changes, only the fetch method has to move.
- **Recommendation (updated 2026-09-04):** the free key is for prototyping only. Live data via the API costs $107.88/yr (HOF annual); it is the only ToS-clean, supported path and includes news + injuries (see player-news-apis.md). Scraping `ecrData` (B) stays the zero-cost path and the current decision. Sleeper's news feed already carries FantasyPros news items, which removes the main reason to pay.

### B. Public pages with embedded JSON (verified 2026-09-03)
Every rankings page embeds `var ecrData = {...};` in the HTML. Regex `var ecrData = (\{.*?\});\n`. Needs a browser User-Agent; robots.txt asks `Crawl-delay: 5` and disallows `/ajax/`, `/api/`, `/json/`, `/nfl/ranker/` (rankings pages themselves are allowed).

`ecrData` top-level: `sport, year, week, type (weekly|draft|waiver), ranking_type_name, scoring (PPR|HALF|STD), position_id, total_experts, experts_available, count, last_updated, last_updated_ts, filters, players[]`.

`players[]` fields: `player_id (FP id), player_name, player_short_name, player_filename, player_page_url, player_team_id, player_position_id, player_positions, player_eligibility, player_bye_week, player_opponent ("vs. NO"/"at PIT"), player_opponent_id, player_owned_avg (% rostered across ESPN/Yahoo), rank_ecr, rank_min, rank_max, rank_ave, rank_std, player_ecr_delta, pos_rank ("RB1"), tier, note, recommendation, tag`. (No `start_sit_grade` on these pages.)

| Page | URL | Verified result |
|---|---|---|
| Weekly flex (half) | `/nfl/rankings/half-point-ppr-flex.php?week=1` | 476 players, 25 experts |
| Weekly RB (half) | `/nfl/rankings/half-point-ppr-rb.php?week=1` | 175 players |
| Weekly K / DST | `/nfl/rankings/k.php`, `/nfl/rankings/dst.php` | 32 DST, type weekly |
| **Waiver wire** overall (half) | `/nfl/rankings/waiver-wire-half-point-ppr-overall.php` | 56 players, 2 experts, week 1 |
| Waiver wire per-pos | `/nfl/rankings/waiver-wire-half-point-ppr-rb.php` | 16 players |
| **ROS** overall (half) | `/nfl/rankings/ros-half-point-ppr-overall.php` | 922 players, 123 experts |
| ROS RB (half) | `/nfl/rankings/ros-half-point-ppr-rb.php` | 257 players |
| ROS QB / K / DST | `/nfl/rankings/ros-qb.php`, `ros-k.php`, `ros-dst.php` | 115 / 44 / 32 |
| ROS flex (half & PPR) | `/nfl/rankings/ros-half-point-ppr-flex.php` | **0 players — paywalled** (page contains "premium"/"locked" markers). Derive flex from overall instead. |
| Projections | `/nfl/projections/dst.php?week=1`, `/qb.php`, ... | No `ecrData`; HTML `<table id="data">` with headers e.g. DST: `Player, SACK, INT, FR, FF, TD, SAFETY, PA, YDS AGN, FPTS`. Parse table rows. |
| Points allowed / DvP | `/nfl/points-allowed.php` | 200 but no table in static HTML (JS-rendered) — use nflverse or Sleeper stats instead. |
| Strength of schedule | `/nfl/strength-of-schedule.php` | unverified |

Scoring variants: `ppr-`, `half-point-ppr-`, none (= STD). Positions: `qb, rb, wr, te, flex, k, dst, idp`. Note ROS pages before week 1 are served with `type: draft`, `week: 0`.

FantasyPros "My Playbook" syncs Sleeper leagues and has Waiver Wire Assistant / Start-Sit / Trade Analyzer, but no exported API for those.

ToS: "no reproduction without permission"; scraping for personal use is common (ffpros R pkg, many Python scrapers) but not sanctioned. Anti-bot: plain curl with a browser UA worked; no Cloudflare challenge seen.

## Complementary sources
| Source | What | Access |
|---|---|---|
| **nflverse** (`nfl_data_py` / `nflreadpy`, https://github.com/nflverse) | play-by-play, snap counts, weekly stats (targets, air yards, red zone), depth charts, injuries, schedules, `ff_playerids` crosswalk, `ff_opportunity` | free CSV/parquet on GitHub releases |
| **Sleeper** projections/stats/ownership | see sleeper-api.md | free |
| ESPN fantasy public API | ownership % (`percentOwned`, `percentStarted`), ESPN projections | `lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/{y}/players?view=kona_player_info` with `x-fantasy-filter` header; no auth for player pool |
| Boris Chen tiers (borischen.co) | k-means tiers over FP ECR; weekly K and DST tiers | text files, free |
| FantasyCalc (fantasycalc.com/api) | redraft & dynasty trade values from real Sleeper trades | free JSON |
| KeepTradeCut | dynasty values | scrape |
| FFToday, 4for4 | rankings/projections | scrape / paid |
| Fantasy Nerds (api.fantasynerds.com) | rankings, projections, waiver wire | free tier, key |
| ffanalytics (R) | multi-source projection aggregation | free |

## Design implications for waiver / streaming features
- **Breakout detection** = Sleeper trending adds (24h & 7d) × ownership % (`research` endpoint) × snap-share / target-share delta (Sleeper `off_snp/tm_off_snp`, `rec_tgt`; nflverse for deeper) × FP waiver-wire rank & ROS ECR delta (`player_ecr_delta`) × depth-chart changes × injury feed. Filter to players not on any roster in the league (rosters ∪ players).
- **K/DST streaming for future weeks** = Sleeper schedule (opponent per week, byes) + Sleeper per-week projections (`/projections/nfl/{season}/{week}` filtered `position[]=K|DEF`) + FP weekly K/DST ECR + team implied totals (need Vegas lines: FP projections page or nflverse schedules `spread_line`, `total_line`). Score by league `scoring_settings` (e.g. `pts_allow_*`, `fgm_50p`).
- **League-specific points**: always recompute from `scoring_settings × stats` instead of trusting `pts_half_ppr`.
