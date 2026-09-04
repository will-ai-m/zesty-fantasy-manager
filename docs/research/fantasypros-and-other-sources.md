# FantasyPros & other data sources — research findings (2026-09-03)

## FantasyPros — two access paths

### A. Official API (`https://api.fantasypros.com/public/v2/json/...`, header `x-api-key`)
- Docs page reachable: https://api.fantasypros.com/public/v2/docs (endpoint list behind login). Overview: https://www.fantasypros.com/api-data/. Key request: https://secure.fantasypros.com/api-keys/request.
- Tiers: **Free** (sample data, generous daily limit, prototyping); **Premium** — a personal production key is included with MVP ($8.99/mo) / HOF ($11.99/mo) subscriptions; Commercial (custom).
- Data: ECR consensus rankings (weekly, ROS, draft, dynasty) with tiers, projections with full stat lines, player IDs/teams/positions, news/injuries, weekly fantasy points.
- Likely request shape (UNVERIFIED, from community): `/public/v2/json/nfl/{season}/consensus-rankings?position=QB&type=weekly|ros|draft&scoring=PPR|HALF|STD&week=N`. Unauthenticated call returns 403 (verified).
- **Recommendation: request a free key now; upgrade to MVP if we like it.** It is the only ToS-clean path and gives ROS rankings without the paywall problem below.

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
