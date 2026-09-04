# Yahoo & ESPN fantasy APIs — research findings (2026-09-03)

Items marked **verified** were confirmed with live requests or by reading source on 2026-09-03. The rest comes
from official docs and community sources (cited inline); anything shaky is marked UNVERIFIED.

## Bottom line

| | Sleeper (have) | ESPN | Yahoo |
|---|---|---|---|
| Official API | Yes (read-only, no auth) | **No.** Undocumented v3 "lm-api" the site uses | Yes (OAuth2), but access is now **by application** |
| Read my league | Free | Two browser cookies (`espn_s2`, `SWID`) for private leagues; none for public | Approved app + one-time OAuth login |
| Player pool: ownership %, projections | Ownership + projections (undocumented endpoints) | **Free, no auth** (verified): % rostered, % started, ownership change, ADP, weekly projections for every week, rankings, injury | Ownership % only. **No projections in the API** |
| Writes (add/drop, FAAB claim, lineup) | Internal GraphQL only (not doing) | Write host exists (verified) but payloads are reverse-engineered and unsupported; all libraries are read-only | Documented XML writes exist, but Yahoo's access page now says **"read access only. Write access is not available at this time."** (verified) |
| Realistic plan for us | Recommend-only (done) | Recommend-only, reads via cookies | Recommend-only, reads via approved app |

Conclusion: the recommend-only model we chose for Sleeper is the only defensible one on all three platforms.
ESPN is the easier of the two to add (no application process, richer data). Yahoo needs an approval step first.

---

## ESPN

### Access
- Read host: `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/{season}/segments/0/leagues/{leagueId}` (since April 2024; old `fantasy.espn.com` host redirects).
- Historical seasons (2017 and earlier): `/apis/v3/games/ffl/leagueHistory/{leagueId}?seasonId=YYYY` → array. Since Aug 2025 this also needs cookies.
- Private league → send `Cookie: espn_s2=<value>; SWID={<guid>}`. Get both from the browser: fantasy.espn.com → DevTools → Application → Cookies. `espn_s2` should be used URL-decoded; SWID keeps its braces. Reported lifetime: long (up to ~2 years) but ESPN has forced refreshes; no programmatic login works any more (Disney login API is behind reCAPTCHA). A "make league viewable to public" setting removes the need for cookies entirely.
- Unauthenticated private-league request returns HTTP 401 `AUTH_LEAGUE_NOT_VISIBLE` (verified).
- No published rate limits; 429s reported under bulk polling. Terms: no official API; personal read use is widely tolerated.

### League data (`?view=` params, combine several per request)
`mTeam` (teams, records, `waiverRank`, `transactionCounter.acquisitionBudgetSpent`), `mRoster` (entries with `lineupSlotId`), `mMatchup` / `mMatchupScore` / `mBoxscore` / `mScoreboard`, `mSettings` (see below), `mStandings`, `mSchedule`, `mDraftDetail`, `mTransactions2` (history incl. FAAB bids), `mPendingTransactions` (open waiver claims), `mLiveScoring`, `mNav`, `mStatus`, `kona_player_info` (player pool with projections/ownership), `players_wl`, `proTeamSchedules_wl`.

`mSettings` shape: `settings.scoringSettings.scoringItems[{statId, points, pointsOverrides}]`, `rosterSettings.lineupSlotCounts{slotId: n}`, `acquisitionSettings{acquisitionBudget, isUsingAcquisitionBudget, waiverHours, waiverProcessDays, waiverOrderReset, minimumBid}`, `tradeSettings`, `scheduleSettings.matchupPeriods`.

### Player pool (verified live, no auth)
`GET https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/2026/segments/0/leaguedefaults/3?view=kona_player_info`
with header `X-Fantasy-Filter: {"players":{"filterSlotIds":{"value":[0,2,4,6,16,17,23]},"limit":3,"sortPercOwned":{"sortPriority":1,"sortAsc":false}}}`
→ `{"players":[{id, onTeamId, status ("WAIVERS"/"FREEAGENT"/"ONTEAM"), waiverProcessDate, rosterLocked, ratings{"0":{positionalRanking,totalRanking,totalRating}}, player:{...}}]}`

`player` fields: `id, fullName, firstName, lastName, defaultPositionId, eligibleSlots[], proTeamId, jersey, active, droppable, injured, injuryStatus ("ACTIVE"/"QUESTIONABLE"/"OUT"/...), lastNewsDate, seasonOutlook (text), draftRanksByRankType{STANDARD,PPR,SUPERFLEX,ELIMINATION}{rank, auctionValue}, rankings, ownership{percentOwned, percentStarted, percentChange, averageDraftPosition, auctionValueAverage, ...}, stats[]`.
`stats[]` entries: `{seasonId, scoringPeriodId, statSourceId (0 actual, 1 projected), statSplitTypeId (0 season, 1 week), appliedTotal, appliedAverage, stats{statId: value}}` — Jahmyr Gibbs returned 57 entries including projections for weeks 1–18 (verified). `leaguedefaults/{n}`: 1 = standard, 3 = PPR (appliedTotal uses that default scoring; recompute from `stats{}` with the league's `scoringItems` for league-specific points).

Player list: `GET /apis/v3/games/ffl/seasons/2026/players?scoringPeriodId=0&view=players_wl` with `X-Fantasy-Filter: {"filterActive":{"value":true}}` → 2,627 players with `ownership.percentOwned` (verified). D/ST ids are `-16000 - proTeamId` (e.g. Bills D/ST = -16002) (verified).
Schedules/byes: `GET /apis/v3/games/ffl/seasons/2026?view=proTeamSchedules_wl` → `settings.proTeams[{id, abbrev, byeWeek, proGamesByScoringPeriod}]` (verified).

Filter header keys: `players.filterStatus{"value":["FREEAGENT","WAIVERS","ONTEAM"]}`, `filterSlotIds`, `filterIds`, `filterRanksForScoringPeriodIds`, `filterStatsForTopScoringPeriodIds`, `limit`, `offset`, `sortPercOwned`, `sortDraftRanks`, `sortAppliedStatTotal`.

ID maps: positions 0 QB, 2 RB, 4 WR, 6 TE, 16 D/ST, 17 K; slots add 20 BN, 21 IR, 23 FLEX, 7 OP, 3 RB/WR. Pro teams 1 ATL … 34 (KC = 12, DET = 8). Stat ids: 3 pass yds, 4 pass TD, 20 INT, 24 rush yds, 25 rush TD, 42 rec yds, 43 rec TD, 53 receptions, 72 fumbles lost, 74/77/80 FG buckets, 86 XP, 99 D/ST sacks, 95 D/ST INT, 120s = points-allowed buckets. Full map: `espn_api/football/constant.py` in cwendt94/espn-api.

### Writes
- Host `lm-api-writes.fantasy.espn.com` exists and answers `401 AUTH_MISSING_CREDENTIALS` to an unauthenticated POST on `/leagues/{id}/transactions/` (verified). The read host accepts the same path.
- Community-inferred payload (UNVERIFIED, no public working code found): `POST .../leagues/{id}/transactions/` with `{"type":"FREEAGENT"|"WAIVER"|"ROSTER", "memberId":"{SWID}", "scoringPeriodId":N, "teamId":T, "items":[{"playerId":..,"type":"ADD"|"DROP"|"LINEUP","fromTeamId":..,"toTeamId":..,"fromLineupSlotId":..,"toLineupSlotId":..}], "bidAmount":X, "isLeagueManager":false}` plus headers `X-Fantasy-Source: kona`, `X-Fantasy-Platform: kona-PROD-...`, cookies.
- Every maintained library (cwendt94/espn-api v0.46.0 Mar 2026, mkreiser/ESPN-Fantasy-Football-API, ffscrapr, fflr, all MCP servers) is read-only. The only "automation" projects that write are Selenium bots (rosterdriver, fantasy-football-auto) and they are abandoned.
- Doing writes would mean capturing the real payloads from DevTools while making a move on fantasy.espn.com. Unsupported and fragile. Not planned.

### Libraries worth reusing
- Python `espn-api` (cwendt94, 957★, active): `League(league_id, year, espn_s2, swid)`, `free_agents(week, size, position)` → Player with `percent_owned`, `percent_started`, `projected_points`, `stats`; `recent_activity()` with bids; `settings`; `box_scores()`. Good reference; for our backend a thin httpx client against the views above (like the Sleeper client) is simpler and keeps caching consistent.
- ID crosswalk: Sleeper players file has `espn_id` for most players (verified earlier); D/ST maps by team abbreviation.

---

## Yahoo

### Access (verified from https://sports.yahoo.com/developer/access/ on 2026-09-03)
- "The Yahoo Fantasy Sports API currently provides read access only. Write access is not available at this time."
- "Access to the Yahoo Fantasy Sports API is read-only by default. If your use case is unique and requires read/write access, please include additional details in the notes section."
- Every application is reviewed by the Yahoo Fantasy Sports team; incomplete submissions are closed without correspondence. The form asks for product description, data needed, expected users (Small < 1,000), and an optional existing YDN Client ID. Approval time: unpublished.
- Non-commercial use only; one developer account.
- Unauthenticated requests return 401 `unable_to_determine_oauth_type` (verified).

### Auth
OAuth 2.0 authorization code: `https://api.login.yahoo.com/oauth2/request_auth?client_id=…&redirect_uri=…&response_type=code` → user approves → `POST https://api.login.yahoo.com/oauth2/get_token` (grant `authorization_code`, then `refresh_token`). Scopes `fspt-r` (read) / `fspt-w` (write). Access tokens last 1 hour; refresh tokens are long-lived (unpublished). Redirect: `oob` (paste code) is what CLI libraries use; localhost redirects are reported blocked. Libraries store tokens in a JSON file (`yahoo_oauth`'s `oauth2.json`: access_token, refresh_token, consumer_key, consumer_secret, token_time).

### Read endpoints (base `https://fantasysports.yahooapis.com/fantasy/v2/`, add `?format=json`)
- My leagues: `users;use_login=1/games;game_keys=nfl/leagues`. Keys: `league_key = {game_id}.l.{league_id}`, `team_key = {league_key}.t.{n}`, `player_key = {game_id}.p.{player_id}`; game id changes every season (`game/nfl` gives the current one).
- League: `league/{key}/settings` (roster_positions, stat_categories + stat_modifiers = scoring, `uses_faab`, `waiver_type`, `waiver_rule`, `waiver_time`, trade rules), `/standings`, `/scoreboard;week=N`, `/transactions;types=add,drop,trade` (includes `faab_bid`), `/players;status=A|FA|W|T;position=WR;sort=OR|AR|PTS;sort_type=week|season|lastweek;start=0;count=25` with `;out=ownership,percent_owned,stats,draft_analysis`.
- Team: `team/{key}/roster;week=N` (selected_position per player, injury `status`/`status_full`, `bye_weeks`), `/matchups`, `/standings`.
- Player: `player/{key}/stats;type=week;week=N`, `/percent_owned`, `/ownership` (who owns them in this league), `/draft_analysis` (ADP).
- Not in the API: projections (Yahoo's UI projections are not exposed), % started, ownership trend. Use Sleeper/ESPN projections mapped via `yahoo_id` from the Sleeper players file.
- Responses default to XML; JSON is deeply nested with numeric keys. No published rate limit; throttling and "999" errors reported under heavy use.

### Writes (documented and implemented in spilchen/yahoo_fantasy_api; verified from its source, but gated by Yahoo's read-only policy)
All writes send `Content-Type: application/xml` bodies wrapped in `<fantasy_content>`.
- Add / drop / add+drop, optional FAAB: `POST league/{league_key}/transactions`
  ```xml
  <fantasy_content><transaction>
    <type>add/drop</type>            <!-- or add | drop -->
    <faab_bid>22</faab_bid>          <!-- optional; makes it a waiver claim in FAAB leagues -->
    <players>
      <player><player_key>449.p.6770</player_key><transaction_data><type>add</type><destination_team_key>449.l.123.t.4</destination_team_key></transaction_data></player>
      <player><player_key>449.p.6767</player_key><transaction_data><type>drop</type><source_team_key>449.l.123.t.4</source_team_key></transaction_data></player>
    </players>
  </transaction></fantasy_content>
  ```
- Edit / cancel a pending claim: `PUT transaction/{transaction_key}` (`<faab_bid>`, `<waiver_priority>`), `DELETE transaction/{transaction_key}` (from the old guide; UNVERIFIED against a live league).
- Set lineup: `PUT team/{team_key}/roster`
  ```xml
  <fantasy_content><roster>
    <coverage_type>week</coverage_type><week>3</week>
    <players><player><player_key>449.p.5981</player_key><position>BN</position></player>…</players>
  </roster></fantasy_content>
  ```
- Trades: `POST league/{key}/transactions` with `<type>pending_trade</type>` and `<trader_team_key>/<tradee_team_key>`; accept/reject via `PUT transaction/{key}` with `<action>accept|reject</action>`.

### Libraries
- Python `yahoo_fantasy_api` (spilchen, v2.12.3 Apr 2026, 110★) + `yahoo_oauth`: full read coverage plus the writes above (`add_player`, `drop_player`, `add_and_drop_players`, `claim_player(faab=)`, `claim_and_drop_players(faab=)`, `change_positions`, `accept_trade`, `reject_trade`). Best reference implementation.
- Python `yfpy` (v17, Sep 2025, 263★): read-only, typed models, browser-based auth; `yahoofantasy` (mattdodge): read-only CLI login.
- Node `yahoo-fantasy` (whatadewitt, v5.3, active): reads plus `claim_and_drop_players` with FAAB.
- MCP servers: spilchen/yahoo_fantasy_mcp (read-only by design); a few claim writes (michaelfromorg/mcp-yahoo-fantasy, carterfawson) — UNVERIFIED and now blocked by policy for new apps.
- ffscrapr (R) has no Yahoo support.

---

## Implementation notes (ESPN adapter, built 2026-09-04)

- Verified against the user's league: `mSettings+mTeam+mRoster+mStatus` in one call; `kona_player_info` on the
  **league** endpoint returns `appliedTotal` scored with the league's own settings (Hockenson wk1: 6.94 in the
  league vs 9.22 on the PPR default pool).
- Through the league endpoint ESPN only serves the **current week's** projection (`11{season}{week}`) and the
  season projection/actuals (`10{season}`, `00{season}`, `00{prev}`); requesting other weeks in
  `filterStatsForTopScoringPeriodIds.additionalValue` returns nothing. Full-season weekly projections exist only
  on the public `leaguedefaults/{n}` pool (default scoring).
- `limit` in `X-Fantasy-Filter` must be paired with a sort (`sortPercOwned`), otherwise HTTP 400.
- Coverage of Sleeper's `espn_id` was poor (61 of 168 rostered players); the nflverse `db_playerids.csv`
  crosswalk plus name matching resolved everyone. D/ST id = `-16000 - proTeamId`; ESPN `WSH` = Sleeper `WAS`.
- D/ST scoring items carry their points in `pointsOverrides["16"]` with `points: 0`.

## What this means for the app

1. **Platform adapter.** Introduce a `Platform` interface in the backend (leagues, league settings + scoring, rosters, free agents, transactions, matchups) with Sleeper, ESPN, and Yahoo implementations. The UI is already platform-agnostic in shape (roster slots, FAAB, waiver order, transactions).
2. **Canonical player identity = Sleeper `player_id`.** Map ESPN via `espn_id` and Yahoo via `yahoo_id` from the Sleeper players file (D/ST by team abbreviation). Fallback: name + team + position match; nflverse `ff_playerids` as a second crosswalk.
3. **Projections/ownership per platform.** ESPN: native (public pool). Yahoo: no projections → reuse Sleeper's per-week projections (already cached) and show Yahoo's own `percent_owned`. Points always recomputed from each league's scoring settings.
4. **Config.** `.env` gains `ESPN_LEAGUE_IDS`, `ESPN_S2`, `ESPN_SWID`, `YAHOO_CLIENT_ID`, `YAHOO_CLIENT_SECRET`; Yahoo tokens stored in `data/yahoo_oauth.json`.
5. **Order.** ESPN first (no approval gate, richer data), Yahoo once the API application is approved.

## What I need from you
- **ESPN:** each league ID (from the league URL, `leagueId=…`) and, for private leagues, the `espn_s2` and `SWID` cookie values from your browser (or flip the league to "viewable by public").
- **Yahoo:** submit the access application at https://sports.yahoo.com/developer/access/ (Small, personal/single-league use, read-only). After approval, create the app with a redirect URI, then give me the Client ID and Client Secret. A one-time browser login completes the OAuth flow.
