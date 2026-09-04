# Player news APIs — research findings (2026-09-04)

Items marked **verified** were confirmed with live requests from this machine on 2026-09-04. Everything else comes from
official docs / pricing pages / community sources (cited inline) and is marked UNVERIFIED where shaky. Six Haiku research
agents did the sweep; every load-bearing claim below was re-checked by hand.

## Bottom line

| Source | Cost / auth | Keyed to | What you get | Freshness | Status |
|---|---|---|---|---|---|
| **Sleeper GraphQL `get_player_news`** (undocumented) | Free, no auth | Sleeper `player_id` | Full items from **RotoWire (with analysis), FantasyPros and RotoBaller**: title, description, analysis, url, published, source, source_key. History back to 2023. | Same minute RotoWire publishes | **verified — best option** |
| Sleeper REST `/v1/players/nfl` | Free | Sleeper id | `news_updated` (cheap change detector), injury fields, depth chart, `rotowire_id` on 98% of active skill players | `news_updated` lagged the item by 3–48 min in three checks | verified |
| ESPN fantasy news `site.web.api.espn.com/apis/fantasy/v2/games/ffl/news/players` | Free, no auth | ESPN athlete id, one per call | RotoWire items: headline, description, story (analysis), type, published | Same RotoWire stories as Sleeper (same story ids) | verified; Sleeper has `espn_id` for only 25% of active skill players → needs the dynastyprocess crosswalk |
| ESPN injuries `sports.core.api.espn.com/v2/.../teams/{id}/injuries` | Free | ESPN athlete id | status, type, shortComment / longComment (RotoWire text), date | ~hourly | verified |
| RotoWire RSS `rotowire.com/rss/news.php?sport=NFL` | Free | RotoWire player id in link = Sleeper `rotowire_id` (verified) | title, truncated description, pubDate, guid `nfl{storyId}` | real-time, **only the 5 newest items** | verified; too short to poll reliably |
| FantasyPros API `GET /nfl/news` | Key. Free key = sample data; production key only with HOF ($8.99/mo billed annually = $107.88/yr) | FantasyPros `player_id` (`fpid` filter) | id, created, author, player_id, team_id, title, categories[], link, desc, **impact**; `category=injury\|recap\|transaction\|rumor\|breaking` | unknown | route exists (verified 403 without key); shape from the public OpenAPI spec |
| FantasyPros API `GET /nfl/injuries` | same | FantasyPros id | injuries, optional `include_probabilities=true` | unknown | route exists (verified); no schema in spec |
| Tank01 NFL API (RapidAPI) `getNFLNews` | Free 1,000 req/mo; Pro $10/mo = 1,000/day | own ids; roster endpoint carries ESPN/Yahoo ids | `fantasyNews=true`, `playerID`, `teamID`, `maxItems`, `recentNews` | "multiple times per hour" | UNVERIFIED (pricing read from RapidAPI page; not called) |
| SportsDataIO `News`, `NewsByPlayerID/{id}`, `NewsByTeam`, `NewsByDate` | From ~$25/mo; free trial = 1,000 calls/mo of **simulated data** | SportsDataIO PlayerID (probably = Sleeper `fantasy_data_id`, 99% fill — UNVERIFIED) | Field Level Media wire + AI-generated items, not RotoWire | 5–10 min | UNVERIFIED |
| RotoWire / RotoBaller / Sportradar feeds | Enterprise B2B, custom quotes | — | — | — | not viable |
| Fantasy Nerds `/v1/nfl/news`, MySportsFeeds, BALLDONTLIE | $5–15/mo tiers; news coverage unclear | — | — | — | UNVERIFIED (docs/pricing 403 or login-gated) |
| ESPN / Yahoo general RSS; nflverse injuries + depth charts | Free | RSS: names only; nflverse: gsis/espn ids | headlines only / weekly injury report + depth charts CSV | RSS ~30 min; nflverse weekly, **2026 injuries not published yet** | verified |

Conclusion: **Sleeper already aggregates the three feeds everyone else sells (RotoWire, FantasyPros, RotoBaller) and exposes
them for free, keyed by the player id we already use.** Nothing paid is better for a personal tool. The only reasons to add a
second source are a supported/licensed feed (FantasyPros HOF key) or a fallback if the undocumented GraphQL query changes.

---

## Sleeper (verified live)

### GraphQL read endpoint
`POST https://sleeper.com/graphql`, `Content-Type: application/json`, no auth, no cookies (a browser User-Agent was sent;
not tested without one). Absinthe (Elixir) server: introspection works with snake_case (`{ __schema { query_type { fields
{ name args { name type { name } } } } } }`) and lists 240 root queries. The news-related ones:

- `get_player_news(sport: "nfl", player_id: "9221", limit: 5) { source source_key sport player_id published metadata }`.
  Without `limit` it returns the full history (Gibbs: 242 items back to 2023-04-28; rotowire 106, fantasy_pros 89, rotoballer 47).
- `get_player_news_by_id(sport, player_id, source, source_key)` — one item.
- `get_player_outlook(sport: "nfl", player_id: "9221", season: "2026") { source published metadata }` — season outlook
  paragraph in `metadata.description` (RotoWire-style prose).
- `trending_players(sport, sort)`, `get_player(sport, player_id)`, `search_players(prefix, limit, sport)` also exist (untested).

Aliases batch many players into one request (verified with three players plus an outlook in a single POST):
```graphql
{ swift:  get_player_news(sport: "nfl", player_id: "6790",  limit: 3) { source source_key published metadata }
  odunze: get_player_news(sport: "nfl", player_id: "11620", limit: 3) { source source_key published metadata } }
```

Item shape (Gibbs, RotoWire item):
```json
{"source": "rotowire", "player_id": "9221", "source_key": "636010", "sport": "nfl", "published": 1788365712000,
 "metadata": {"title": "Jahmyr Gibbs - Reels off 59-yard run in final camp practice",
              "description": "Gibbs had a strong day in the Lions' final practice of training camp Thursday, ... Tim Twentyman of the team's official site reports.",
              "analysis": "After being contained on the first two of the first-team offense's eight drives ...",
              "topic_id": "1400912307655073792"}}
```
- `metadata` keys vary by source: rotowire → `title, description, analysis, topic_id` (no url); rotoballer → `title, description, url, topic_id`; fantasy_pros items carry `source_key` = the FantasyPros news id (e.g. 605832).
- `source_key` is the provider's story id and is shared across feeds: RotoWire 636010 = RSS guid `nfl636010` = ESPN news/injury item id 636010 (verified). Use `(source, source_key)` as the dedupe key.
- Freshness: Swift's "Believed to be dealing with cramp" item is `published` 2026-09-04T00:32:02Z; RotoWire's own RSS shows the same story at "Thu, 03 Sep 2026 5:32:00 PM PDT" (= 00:32Z). The FantasyPros items for Swift/Odunze landed at 22:00:09Z after RotoWire's first items at 21:20Z/21:31Z, so Sleeper carries both providers within the hour.
- Risk: undocumented and unsupported — the same footing as the undocumented REST stats/projection endpoints we already use (sleeper-api.md §4). The recommend-only decision covered **writes** (login + mutations); this is an anonymous read. It can still change without notice, so isolate it behind a provider interface with ESPN as fallback.

### REST `/v1/players/nfl` as the change detector (verified)
- `news_updated` (epoch ms) is present on 67% of 12,226 records. Checked 2026-09-04 ~07:00Z: 175 players updated in the last 24h, 521 in 72h, 1,049 in 7d.
- Lag behind the news item: Swift 01:20:16Z vs item 00:32:02Z (48 min); Odunze 23:00:10Z vs 22:57:05Z (3 min); Gibbs 16:20:31Z vs 16:15:12Z (5 min). Fine as a "fetch news for these players" trigger; we already cache this file.
- Injury fields the same evening: Swift `injury_status` Questionable / `injury_body_part` Undisclosed; Odunze Questionable / Leg. Fill across all records: `injury_status` 785, `injury_body_part` 708, `injury_notes` 92, `practice_participation` 1, `injury_start_date` 0. There is also the undocumented `GET /v1/players/nfl/injuries`.
- Cross ids on the 853 active QB/RB/WR/TE/K: `rotowire_id` 840, `fantasy_data_id` 849, `sportradar_id` ~all, `espn_id` 211, `yahoo_id` 218, `gsis_id` 165 (Gibbs has no `espn_id` in Sleeper). For ESPN / Yahoo / FantasyPros ids use dynastyprocess `https://raw.githubusercontent.com/dynastyprocess/data/master/files/db_playerids.csv` (columns incl. `sleeper_id, espn_id, yahoo_id, fantasypros_id, rotowire_id, gsis_id, sportradar_id, mfl_id` — verified).

---

## ESPN (verified live, no auth)
- Host note: `site.api.espn.com` answered every request from curl here with an Akamai "Access Denied" 403 (even the plain NFL news endpoint). `site.web.api.espn.com` serves the same paths — use that host.
- Fantasy player news: `GET https://site.web.api.espn.com/apis/fantasy/v2/games/ffl/news/players?playerId=4429795&days=30&limit=10` → `{timestamp, status, resultsCount, resultsLimit (50), resultsOffset, feed: [...]}`. Item: `id, type ("Rotowire" | "Story" | "Media"), headline, description, story (analysis paragraph), published, lastModified, premium, playerId, links.mobile.href, images, nowId, contentKey, dataSourceIdentifier`. Exactly one `playerId` per call: a comma list → 400, none → 500. `id` on Rotowire items is the RotoWire story id.
- General NFL news `GET https://site.web.api.espn.com/apis/site/v2/sports/football/nfl/news?limit=N` → `articles[]` with `categories[]` of type topic / league / team / athlete. League-level, not fantasy-focused.
- Injuries: `GET https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/teams/{teamId}/injuries?limit=100` → paginated `$ref` list (Lions = team 8: 60 items). Each ref → `{id, date, status ("Active" | "Questionable" | ...), type {name "INJURY_STATUS_ACTIVE", abbreviation "A"}, shortComment, longComment, athlete {$ref}, team {$ref}, source}`. Per-athlete form: `/seasons/2026/athletes/{id}/injuries`. Two-hop fetches; RotoWire text again.
- ESPN ids for the pool: the fantasy player list (`players_wl`, yahoo-espn-apis.md) or the dynastyprocess crosswalk.

## RotoWire RSS (verified)
`GET https://www.rotowire.com/rss/news.php?sport=NFL` → RSS 2.0 with **5 items**; tags `title, link, description, pubDate, guid`.
`link` = `https://www.rotowire.com//football/player/dandre-swift-14394` (trailing number = RotoWire player id = Sleeper
`rotowire_id`; verified for Swift 14394 and Odunze 17020). `guid` = `nfl636216` (story id). Description is the headline
sentence plus a "Visit RotoWire.com…" tail; no analysis paragraph. Too short to poll safely on a busy day; Sleeper carries the
same items with analysis.

## FantasyPros
- Official API (key required; full endpoint list in fantasypros-and-other-sources.md §A). News:
  `GET https://api.fantasypros.com/public/v2/json/nfl/news?limit=25&category=injury&order_by=created&fpid={id}` with
  `category ∈ injury|recap|transaction|rumor|breaking`, `order_by ∈ created|updated` (default created), `limit` default 25.
  Item (spec example): `id, created ("2025-05-12 07:29:02"), created_formated, author, player_id, team_id, title, sport_id, categories[], link, desc, impact` — `impact` is the fantasy-impact paragraph. Injuries: `GET /nfl/injuries?year=&week=&team_id=&player_ids=&include_probabilities=true`.
- Both routes answer `{"message":"Forbidden"}` without a key (route exists) vs `Missing Authentication Token` for nonexistent paths. Free keys get **sample data** ("All endpoints, sample data. Non-production use."); production keys come only with the **HOF** plan ("Use FantasyPros data in your own tools and apps. For personal use only." — $22.99/mo monthly, $11.99/mo semi-annual, $8.99/mo annual = $107.88/yr). MVP does not include the API.
- Website: `/nfl/player-news.php` is an HTML list (no embedded JSON); every RSS URL tried 404s; robots.txt disallows `/api/`, `/json/`, `/xml/`. Sleeper's `fantasy_pros` items give us the same news without scraping.

## Paid / freemium APIs (read from docs and pricing pages on 2026-09-04; none were called)
- **SportsDataIO** — https://sportsdata.io/developers/api-documentation/nfl. `News`, `NewsByDate/{date}`, `NewsByPlayerID/{playerid}`, `NewsByTeam/{team}`, `Injuries`; header `Ocp-Apim-Subscription-Key`. Free trial: 1,000 calls/mo, simulated (scrambled) data, no card, never expires. Paid from ~$25/mo (exact NFL news tier not shown publicly). Content is the Field Level Media wire plus "AI-generated" items, not RotoWire. Sleeper's `fantasy_data_id` is presumably this PlayerID (FantasyData was SportsDataIO's old name) — UNVERIFIED.
- **Tank01 NFL API** (RapidAPI) — https://rapidapi.com/tank01/api/tank01-nfl-live-in-game-real-time-statistics-nfl. `getNFLNews?fantasyNews=true&playerID=&teamID=&maxItems=&recentNews=`; roster/player endpoints carry ESPN/Yahoo/RotoWire-style ids (UNVERIFIED which). Plans: Free 1,000 req/mo; Pro $10/mo, 1,000/day; Ultra $25/mo, 15,000/day; Mega $100/mo. Cheapest real API if we ever need one; syndicated content.
- **Fantasy Nerds** — https://api.fantasynerds.com/docs/nfl (fantasyfootballnerd.com now 301s here). `GET /v1/nfl/news?apikey=` plus injuries / depth / rankings. Pricing page returned 403 to us; historically ~$15/season. UNVERIFIED.
- **MySportsFeeds** — personal plan from $5/mo (pricing page verified), feed list login-gated; injuries yes, news unclear.
- **BALLDONTLIE NFL** — free 5 req/min, $9.99/mo All-Star; stats/odds focus, no news endpoint found.
- **Sportradar** — injuries/depth charts, no news feed; enterprise pricing. **RotoWire** and **RotoBaller** — B2B feeds only (custom quotes). RotoWire syndicates to ESPN/Yahoo/Sleeper; RotoBaller writes 50–150 original pieces/day.

## Other free sources (verified)
- ESPN NFL RSS `https://www.espn.com/espn/rss/nfl/news` (general, ~20 items), Yahoo `https://sports.yahoo.com/nfl/rss/` (huge, mixed sports). ProFootballTalk's feed did not respond.
- nflverse: the `injuries` release has 2009–2025 only as of today (2026 not published yet); `depth_charts` has 2026, weekly cadence. Keyed by `gsis_id` / `espn_id`.
- Reddit r/fantasyfootball (PRAW) and Twitter/X are what hobby bots use for "breaking" news; X API pricing makes it a non-starter.

## What open-source tools do
Survey of 16 projects (Discord/Telegram/IRC bots, MCP servers, scrapers): the only recurring machine feed is the RotoWire RSS
(2+ projects), plus Reddit/Twitter bots. No project uses the official FantasyPros API (keys in public repos), and none use
Sleeper's GraphQL news. Nothing to copy — the Sleeper path above is better than what is out there.

## What this means for the app
1. **Primary feed = Sleeper GraphQL `get_player_news`**, behind a `NewsProvider` interface (Sleeper now; ESPN fallback; FantasyPros API if we ever buy HOF). Store items keyed by `(source, source_key)` so the same RotoWire story from Sleeper / ESPN / RSS dedupes.
2. **Trigger = `news_updated` diff** on the players file we already cache: refresh every 10–15 min, batch the changed players (rostered in either league + waiver candidates + K/DST streamers) into aliased GraphQL requests of ~25 players with `limit: 5`.
3. **Classify locally**: keyword rules over title/description (injury, practice, depth chart, transaction, suspension), since Sleeper items carry no category. FantasyPros' `category` + `impact` are the only structured version and need an HOF key.
4. **Feature hooks**: waiver breakout scoring gets "news in last 72h" and "starter ahead of him is hurt" signals (depth chart + teammate injury items); K/DST streaming gets opponent QB/OL injury items; `get_player_outlook` gives a season blurb for player cards.
5. **Fallback**: ESPN fantasy news per `espn_id` (via the dynastyprocess crosswalk) if the GraphQL query breaks — same RotoWire content.
6. **DECIDED 2026-09-04: Sleeper's GraphQL feed, with ESPN as the fallback.** Anonymous read-only, the
   same footing as the undocumented projection and stats endpoints already in use; `backend/app/news.py`
   holds both providers behind one interface, and `ZFM_NEWS=off` disables them.
7. **DECIDED 2026-09-04: no background polling.** Everything is fetched when a page is opened, so
   nothing runs while the app is closed. If that ever needs to change, the poller belongs alongside
   the cache and would want a delivery channel (desktop, email or webhook) chosen first.
