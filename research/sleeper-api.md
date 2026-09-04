# Sleeper API — research findings (2026-09-03)

Everything marked **verified** was confirmed with live `curl` calls on 2026-09-03. Sources: https://docs.sleeper.com, community repos (see bottom).

## 1. Summary

- **Read side is excellent and free.** No auth, no key. Documented REST (`/v1/...`) plus a large set of undocumented-but-stable endpoints used by the Sleeper app itself: weekly stats, weekly projections, ownership %, schedule, depth charts, injuries. All return JSON without auth.
- **Write side does not exist in the public API.** Add/drop, waiver claims, lineup changes only exist in Sleeper's internal GraphQL API (`https://sleeper.app/graphql`), which needs a bearer token from a username/password `login` query. One 2020 repo shows a `update_waiver_claim` mutation; add/drop/lineup mutations exist (the web app uses them) but must be reverse-engineered from browser DevTools. ToS prohibits reverse engineering. **Decision needed:** recommend-only tool vs. one that executes moves.
- Both `api.sleeper.app` and `api.sleeper.com` serve the same endpoints (verified).
- Rate limit: stay under ~1000 req/min per IP. Players file is 14.6 MB (docs say 5 MB, it has grown); cache it, fetch ≤1×/day. CDN cache headers: `s-maxage=600`.
- Non-commercial use only.

## 2. Documented REST endpoints (`https://api.sleeper.app/v1`)

| Endpoint | Notes |
|---|---|
| `GET /user/{username_or_user_id}` | `user_id`, `username`, `display_name`, `avatar`. Store `user_id`; usernames change. |
| `GET /user/{user_id}/leagues/nfl/{season}` | Array of league objects. |
| `GET /league/{league_id}` | League object — see §3. |
| `GET /league/{league_id}/rosters` | Roster objects — see §3. |
| `GET /league/{league_id}/users` | Users incl. `metadata.team_name`, `is_owner` (commissioner). |
| `GET /league/{league_id}/matchups/{week}` | Per-roster: `roster_id`, `matchup_id`, `points`, `custom_points`, `starters[]`, `players[]`, `starters_points[]`, `players_points{}` (**verified**, the last two are undocumented). Same `matchup_id` = opponents. |
| `GET /league/{league_id}/transactions/{week}` | See §3. |
| `GET /league/{league_id}/traded_picks` | |
| `GET /league/{league_id}/winners_bracket`, `/losers_bracket` | `r`, `m`, `t1`, `t2`, `w`, `l`, `t1_from`, `t2_from`. |
| `GET /league/{league_id}/drafts`, `GET /draft/{id}`, `/picks`, `/traded_picks`, `GET /user/{id}/drafts/nfl/{season}` | |
| `GET /players/nfl` | 14.6 MB dict `player_id -> player`. 12,226 players. `?position=K&active=true` filter works (**verified**, undocumented). |
| `GET /players/nfl/trending/{add\|drop}?lookback_hours=N&limit=N` | `[{player_id, count}]`. `lookback_hours=168&limit=100` works (**verified**). This is exactly the Trends tab. |
| `GET /state/nfl` | `week`, `leg`, `season`, `season_type` (`pre`/`regular`/`post`), `display_week`, `season_start_date`, `league_season`, `previous_season`, `season_has_scores`. |
| CDN | `https://sleepercdn.com/avatars/{avatar_id}`, `/avatars/thumbs/{id}`, headshots `https://sleepercdn.com/content/nfl/players/{player_id}.jpg` |

### Player object fields (verified)
`player_id, first_name, last_name, full_name, position, fantasy_positions[], team, team_abbr, team_changed_at, status (Active/Inactive/Injured Reserve/PUP/...), active, injury_status (Questionable/Doubtful/Out/IR/PUP/null), injury_body_part, injury_notes, injury_start_date, practice_participation, practice_description, depth_chart_position, depth_chart_order, number, age, years_exp, height, weight, college, birth_date, news_updated, search_rank, search_full_name, hashtag, metadata, competitions`
Cross-IDs: `espn_id, yahoo_id, gsis_id, sportradar_id, rotowire_id, rotoworld_id, fantasy_data_id, stats_id, swish_id, opta_id, oddsjam_id, kalshi_id, pandascore_id`. **No FantasyPros ID** → need name+team+position matching or nflverse `ff_playerids` crosswalk.
Team defenses are players with `player_id` = team abbr (e.g. `"JAX"`), `position: "DEF"`.

## 3. Object shapes (verified against league 289646328504385536)

### League
- `roster_positions`: e.g. `["QB","RB","RB","WR","WR","TE","FLEX","FLEX","DEF","BN",...]`. Other slots seen in wild: `SUPER_FLEX`, `K`, `IDP_FLEX`, `DL`, `LB`, `DB`, `REC_FLEX`, `WRRB_FLEX`.
- `scoring_settings`: flat map stat_key → points, e.g. `pass_yd: 0.04, rec: 0.5, rec_yd: 0.1, bonus_rec_yd_100: 1, fgm_40_49: 4, xpm: 1, pts_allow_0: 10, def_td: 6, sack: 1, int: 2 ...`. Stat keys match the keys in the stats/projections endpoints, so **league-specific fantasy points = Σ stats[k] × scoring_settings[k]**. `pts_std/pts_half_ppr/pts_ppr` on stats records are Sleeper defaults only.
- `settings` (all ints):
  - Waivers: `waiver_type` (0 = rolling/priority, 1 = reverse standings, 2 = FAAB), `waiver_budget` (FAAB total, 100 default), `waiver_clear_days` (days a dropped player sits on waivers), `waiver_day_of_week` (0 = Sun … 2 = Tue; when weekly waivers process), `daily_waivers` (0/1), `daily_waivers_hour`, `daily_waivers_days` (bitmask, not in old leagues), `waiver_bid_min`, `offseason_adds`.
  - Roster/IR: `reserve_slots`, `reserve_allow_out`, `reserve_allow_doubtful`, `reserve_allow_sus`, `reserve_allow_dnr`, `reserve_allow_cov`, `reserve_allow_na`, `taxi_slots/taxi_years/taxi_deadline/taxi_allow_vets`, `max_keepers`, `bench_lock`.
  - Season: `num_teams`, `start_week`, `leg` (current week), `last_scored_leg`, `playoff_week_start`, `playoff_teams`, `playoff_type`, `playoff_round_type`, `trade_deadline` (week), `trade_review_days`, `pick_trading`, `type` (0 redraft, 1 keeper, 2 dynasty), `best_ball`, `league_average_match`.
- Other: `status` (`pre_draft`/`drafting`/`in_season`/`complete`), `season`, `season_type`, `total_rosters`, `draft_id`, `previous_league_id` (chain to prior seasons), `bracket_id`, `metadata`, chat fields (`last_message_*`).

### Roster
`roster_id, owner_id (user_id), co_owners[], league_id, players[], starters[] (slot order = roster_positions, "0" = empty), reserve[] (IR), taxi[], keepers[], player_map, metadata (p_nick_{player_id} nicknames, notification prefs), settings{wins, losses, ties, fpts, fpts_decimal, fpts_against, fpts_against_decimal, ppts, ppts_decimal (potential points), waiver_position, waiver_budget_used, total_moves}`.
Bench = players − starters − reserve − taxi. Map roster→user via `owner_id == users[].user_id`. FAAB remaining = `league.settings.waiver_budget − roster.settings.waiver_budget_used`.

### Transaction
`transaction_id, type (free_agent|waiver|trade), status (complete|failed|pending), status_updated, created (ms), leg (week), creator (user_id), roster_ids[], consenter_ids[], adds{player_id: roster_id}, drops{player_id: roster_id}, draft_picks[], waiver_budget[] (FAAB moved in trades), settings{waiver_bid, seq, priority}, metadata{notes}`. Failed waiver claims include losing bids → **historical FAAB market data for your league**.

## 4. Undocumented endpoints (all verified live, no auth, both hosts)

Base: `https://api.sleeper.app` (no `/v1`).

| Endpoint | Returns |
|---|---|
| `GET /projections/nfl/{season}/{week}?season_type=regular&position[]=QB&position[]=RB...&order_by=pts_half_ppr` | Array of projection records (see shape below). Powers Players tab projections. K and DEF included. |
| `GET /stats/nfl/{season}/{week}?season_type=regular&position[]=RB...&order_by=pts_half_ppr` | Same shape, actual stats. Powers Scores/Players stats. 442 RB+WR records for 2025 wk1. |
| `GET /projections/nfl/player/{player_id}?season=2026&season_type=regular&grouping=week` | `{ "1": record, "2": record, ... }` per week. `grouping=season` → single totals record. |
| `GET /stats/nfl/player/{player_id}?season=2025&season_type=regular&grouping=week\|season` | Same for actuals. Season record includes `rank_std`, `rank_half_ppr`, `pos_rank_*`. |
| `GET /players/nfl/research/regular/{season}/{week}` | `{player_id: {owned: 99.6, started: 98.6}}` — **Sleeper-wide % rostered / % started.** |
| `GET /schedule/nfl/regular/{season}` and `/schedule/nfl/post/{season}` | `[{week, date, home, away, game_id, status (pre_game|in_game|complete|canceled)}]`. Bye weeks = teams absent in a week. |
| `GET /players/nfl/{TEAM}/depth_chart` | `{ "QB": [ids], "RB": [ids], "WR1"/"WR2"/"WR3"/"TE"/"K"/"LDE"/... }` ordered. |
| `GET /players/nfl/injuries` | `{player_id: {injury_status, injury_body_part, injury_notes}}`. |
| `POST https://sleeper.app/graphql` | Internal. Needs `authorization: <token>` header. See §6. |

### Stats/projection record shape
```
{ player_id, season, season_type, week, category ("proj"|"stat"), company ("rotowire" seen for proj),
  team, opponent, game_id, date, status, last_modified, updated_at, week_shard,
  player: { first_name, last_name, position, fantasy_positions, team, injury_status, injury_body_part, injury_notes, news_updated, years_exp, metadata },
  stats: { ...keys below } }
```
`stats` keys seen — offense: `pts_std, pts_half_ppr, pts_ppr, pos_rank_std/half_ppr/ppr, gp, gs, gms_active, off_snp, tm_off_snp, tm_def_snp, tm_st_snp` (→ **snap share = off_snp/tm_off_snp**), `rec_tgt, rec, rec_yd, rec_air_yd, rec_yac/rec_yar, rec_fd, rec_lng, rec_ypr, rec_ypt, rec_10_19..., rush_att, rush_yd, rush_td, rush_fd, rush_btkl, rush_yac, rush_40p, pass_att, pass_cmp, pass_yd, pass_td, pass_int, pass_sack, pass_rz_att, pass_air_yd, pass_rtg, anytime_tds, fum, fum_lost, bonus_*`.
Projection-only: `adp_dd_ppr`, `pos_adp_dd_ppr`.
K: `fga, fgm, fgm_0_19..fgm_50p, fgm_yds, fgmiss_*, xpa, xpm, xpmiss`.
DEF: `pts_allow, yds_allow, sack, int, ff, fum_rec, def_td, blk_kick, safe, tkl_loss, pts_allow_0..35p buckets, yds_allow_*_* buckets, def_kr_yd, def_pr_yd`.
Red-zone stats: only `pass_rz_att` seen; no rush/rec red-zone fields → use nflverse for that.

## 5. What powers each Sleeper app tab
- **Players tab** → `/v1/players/nfl` (cached) + `/projections/nfl/{season}/{week}` + `/stats/...` + `/players/nfl/research/...` (owned/started %).
- **Trends tab** → `/v1/players/nfl/trending/add|drop` (lookback 24h/limit 25 default).
- **Scores tab** → `/stats/nfl/{season}/{week}` (+ GraphQL `stats_for_players_in_week` for live batches) + `/schedule/nfl/...`.

## 6. Write access (GraphQL, internal)
- `POST https://sleeper.app/graphql` (also `sleeper.com/graphql`). Login: `query login_query($email_or_phone_or_username: String!, $password: String) { login(...) { token user_id ... } }` → put `token` in `authorization` header.
- Known mutations from rsromanowski/sleeper-api (2020): `update_waiver_claim(league_id, transaction_id, leg, k_settings: ["waiver_bid","priority"], v_settings: [Int])`, `watch_player`, `unwatch_player`, `create_reaction`, `delete_reaction`. Known queries: `stats_for_players_in_week(sport, season, category, season_type, week, player_ids)`, `messages`, `my_dms`, `mentions`.
- Add/drop (`league_create_transaction`-style), lineup (`update_roster_starters`-style) mutations are used by the web client but **not published anywhere**; would need capture from DevTools → Network on sleeper.com. Names above are guesses.
- Risks: Sleeper ToS prohibits reverse engineering; token/2FA handling; silent breakage. Community AI tools (Sleeper AI Manager, LeagueLogs, all MCP servers) are all **recommend-only** for this reason.

## 7. Existing libraries / tooling worth reusing or reading
- Python: `sleeper-api-wrapper` (dtsong, ~100★, covers stats/projections), `joeyagreco/sleeper` (typed, tested, 3.10+; discussion #11 is the best undocumented-endpoint index: https://github.com/joeyagreco/sleeper/discussions/11).
- Go: `lum8rjack/sleeper-go` (covers research/depth_chart/schedule), `dsheehan167/go-sleeper`.
- TS: nothing mature (`plee1295/sleeper-client-typescript` 0★). Writing our own thin client is the right call.
- MCP servers (read-only, useful as reference for tool design): `anthonybaldwin/sleeper-api-mcp` (16 tools incl. get_waiver_recommendations, get_free_agents), `FloSchl8/sleeper-mcp` (19 tools).
- ID crosswalk: nflverse `load_ff_playerids()` / DynastyProcess `db_playerids.csv` (https://github.com/dynastyprocess/data) — includes `sleeper_id`, `fantasypros_id`, `espn_id`, `yahoo_id`, `gsis_id`.
- Yahoo (future): OAuth2 app, scope `fspt-w` allows writes; libs `yahoo_fantasy_api` (v2.12.3, Apr 2026), `yfpy`. ESPN (future): needs `espn_s2` + `SWID` cookies; `cwendt94/espn-api` (read-focused; writes UNVERIFIED).
