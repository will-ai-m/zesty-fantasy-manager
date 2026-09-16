# Yahoo cookie-based access — research findings (2026-09-09)

Follow-up to `research/yahoo-espn-apis.md` (Yahoo section). That file established the documented OAuth2
API (`fantasysports.yahooapis.com`) requires an approved app. This file investigates whether Yahoo's own
frontends expose an equivalent to ESPN's `espn_s2`/`SWID` cookie trick.

Everything marked **verified** was confirmed with a live, unauthenticated request made on 2026-09-09 (exact
command shown or described), or by reading the cited source file directly. Everything else is UNVERIFIED.

## Bottom line

**Cookie-based access is not just viable — for reads, no authentication of any kind is required, cookies
included.** Yahoo runs a second, undocumented backend (`pub-api-ro` / `pub-api-rw`.fantasysports.yahoo.com)
that mirrors the official `fantasy/v2` REST resource tree but does **not** enforce the OAuth check the
documented host does, and in live testing did **not enforce a login/cookie check either** — it served full
settings, standings, and a 21-man roster for a real **private** league to a plain unauthenticated `curl`
request. Separately, Yahoo's public HTML frontend (`football.fantasysports.yahoo.com`) serves per-player
**weekly point projections** — the one thing the OAuth API is missing — to anonymous requests against any
public league. Both were reproduced live with no credentials, no browser, and no cookies at all.

This is a stronger result than what was asked for (cookie-gated-but-accessible); it is closer to
"unauthenticated by accident." See the Ethics/Risk note near the end before building on it.

| | Documented OAuth API | `pub-api-ro`/`pub-api-rw` (undocumented) | HTML frontend (undocumented) |
|---|---|---|---|
| Host | `fantasysports.yahooapis.com` | `pub-api-ro.fantasysports.yahoo.com`, `pub-api-rw.fantasysports.yahoo.com` | `football.fantasysports.yahoo.com` |
| Auth on reads | OAuth2 bearer token, app must be approved | **None observed** — public game metadata AND a real private league's settings/standings/roster all returned 200 with zero credentials | **None observed** for a public league's player/projection pages |
| Format | XML/JSON (`fantasy/v2` resource tree) | Identical `fantasy/v2` resource tree, JSON or XML | Server-rendered HTML, some AJAX endpoints return `{"content": "<html>"}` |
| Projections | **Not exposed** (confirmed in prior research) | Not exposed (same `stats` resource, actuals only) | **Exposed** — weekly projected points are in the player-note HTML |

## 1. Hosts and paths

### `pub-api-ro.fantasysports.yahoo.com` — **verified live, real public host**
This is the unverified lead from the task brief — confirmed real and confirmed to serve the entire
`fantasy/v2` resource tree (same paths as the documented OAuth API), e.g.:
- `GET /fantasy/v2/game/nfl?format=json` → 200, JSON, public game metadata (game_key, season, etc.)
- `GET /fantasy/v2/game/{game_key}/stat_categories|roster_positions|players|game_weeks|position_types` → 200, JSON
- `GET /fantasy/v2/league/{league_key}/settings|standings|scoreboard|transactions` → 200, JSON (see §2 for the private-league result)
- `GET /fantasy/v2/team/{team_key}/roster` → 200, JSON
- `GET /fantasy/v2/player/{player_key}/percent_owned|ownership|stats|draft_analysis` → 200, JSON

`pub-api-rw.fantasysports.yahoo.com` also **verified to exist** and answer identically for reads
(`GET /fantasy/v2/game/nfl?format=json` → 200); it is referenced directly in
`football.fantasysports.yahoo.com`'s page source as `pub-api-rw.fantasysports.yahoo.com/fantasy/v2/users`,
strongly suggesting it's the write-capable counterpart the logged-in frontend POSTs to. Not tested for writes
(out of scope: no login, no state-changing calls attempted).

**CORS is scoped to Yahoo's own frontend** — verified: an `OPTIONS`/`GET` with
`Origin: https://football.fantasysports.yahoo.com` gets back
`access-control-allow-origin: https://football.fantasysports.yahoo.com` and
`access-control-allow-credentials: true`; a `GET` with `Origin: https://evil.example.com` gets **no**
`Access-Control-Allow-Origin` header at all. This confirms `pub-api-ro` is the actual XHR backend the
football.fantasysports.yahoo.com single-page app calls client-side (the `allow-credentials: true` implies
it's designed to receive the browser's Yahoo session cookies) — but CORS is a browser-enforced policy, not a
server-side auth check. A non-browser client (curl/httpx) can send any `Origin` header it likes; the finding
in §2 shows the server doesn't actually gate on session state at all for these paths regardless.

### `fantasysports.yahooapis.com` (documented OAuth host) — **verified, for contrast**
Same league-settings path on the *documented* host returns a hard OAuth challenge instead:
```
GET https://fantasysports.yahooapis.com/fantasy/v2/league/470.l.1/settings?format=json
→ HTTP/2 401
www-authenticate: OAuth oauth_problem="unable_to_determine_oauth_type", realm="yahooapis.com"
{"error":{"lang":"en-US","description":"Please provide valid credentials. OAuth oauth_problem=\"unable_to_determine_oauth_type\", realm=\"yahooapis.com\""}}
```
This 401/OAuth-challenge shape is **only** on `fantasysports.yahooapis.com`. `pub-api-ro` never returns this
shape — it returns either 200 with data, or a plain-English `{"error":{"description":"..."}}` with no OAuth
semantics at all (see §2). These are evidently two different backend deployments of the same API code.

### `football.fantasysports.yahoo.com/f1/{leagueId}` — **verified**
The web app itself. `GET /f1/{leagueId}` (no auth) returns HTTP 200 with server-rendered HTML including the
real league name in `<title>`/`og:title` even for a private league, plus a "Sign in" link confirming the
request was anonymous. This SSR path doesn't leak roster data in the page shell, but two AJAX-ish sub-paths do
(see §4): `/f1/{league}/players` (HTML player-list table) and `/f1/{league}/playernote?pid={id}` (JSON
wrapping an HTML snippet with the projections table).

### Yahoo Fantasy mobile app — UNVERIFIED, nothing found
No public documentation, teardown, or GitHub project was found describing the mobile app's API. Web search
for "Yahoo fantasy sports GraphQL mobile" turned up nothing beyond the documented REST API and generic AWS
AppSync blog posts unrelated to Yahoo. **Not investigated further** — no APK/IPA teardown was performed (out
of scope for this pass, would require decompiling the app). Given `pub-api-ro`/`pub-api-rw` already give full
read/write-shaped access to the same resource tree, the mobile app is very likely just another client of
these same two hosts, but this is a guess, not a finding.

## 2. Authentication — what's actually required

**Answer: for the paths tested, nothing.** No cookie, no crumb, no signed header, no bearer token.

Live test against a **real, active private league** (`league_type: "private"` in its own settings payload),
found by guessing a small sequential numeric league ID against the current season's game key (`470` = NFL
2026, from `GET /fantasy/v2/game/nfl`):

```
GET https://pub-api-ro.fantasysports.yahoo.com/fantasy/v2/league/470.l.12345/settings?format=json
→ HTTP 200, full settings payload incl. scoring_type, roster_positions, waiver rules, "league_type":"private"

GET https://pub-api-ro.fantasysports.yahoo.com/fantasy/v2/league/470.l.12345/standings?format=json
→ HTTP 200, full standings for all 10 teams

GET https://pub-api-ro.fantasysports.yahoo.com/fantasy/v2/team/470.l.12345.t.1/roster?format=json
→ HTTP 200, full 21-man roster with player names, headshots, eligible positions, and each player's
  selected_position (starting lineup slot) for the current week

GET https://pub-api-ro.fantasysports.yahoo.com/fantasy/v2/league/470.l.12345/transactions?format=json
→ HTTP 200, transaction history
```
No `Cookie` header, no `Authorization` header, and no browser were used for any of these — a bare `curl`.
This was one specific real league's data (not a sandbox), so I stopped after confirming the pattern across
four resource types rather than pulling further detail; see the Ethics/Risk note below.

By contrast, **user-scoped** resources (which require Yahoo to know *who* is asking, not just *which* league)
do reject the anonymous request — but with a plain-English message, not an OAuth challenge:
```
GET https://pub-api-ro.fantasysports.yahoo.com/fantasy/v2/users;use_login=1/games?format=json
→ HTTP 401 {"error":{"description":"Unauthorized access.","detail":""}}

GET https://pub-api-ro.fantasysports.yahoo.com/fantasy/v2/league/470.l.1/settings?format=json   (a league_key that doesn't resolve/isn't reachable this way)
→ HTTP 401 {"error":{"description":"You must be logged in to view this league.","detail":""}}
```
That second message is suggestive — it implies *some* leagues (or some access pattern) does check login
state — but the private league above went through cleanly on the same host with the same request shape, so
whatever gate exists is inconsistent, and I could not find the rule that separates a gated league from an
open one. **I don't know why 470.l.1 was gated and 470.l.12345 wasn't** — possibly 470.l.1 doesn't exist in
game 470 at all and the "must be logged in" message is actually Yahoo's generic 404-vs-403 ambiguity
response, not a real auth gate. This is the one meaningfully open question from this pass — see "Next step."

**Which cookies matter:** could not be determined — no login was performed (per task instructions), and no
`Set-Cookie` was issued to an anonymous visitor on either host to infer names from. Since real access appears
not to require cookies at all for the paths tested, the ESPN-style question ("which cookie names matter") may
be moot for this class of read. It would only become relevant if the inconsistency above turns out to be a
real per-league gate — in which case standard Yahoo SSO cookies (`T`, `Y`, `A1`, `A3`) are the obvious
candidates by analogy with every other Yahoo property, but this is UNVERIFIED speculation, not a finding.

No crumb/CSRF token was requested or needed for any GET in this pass.

## 3. Response format and payload shape

Both undocumented hosts return the **same JSON/XML shape as the documented API** — this is evidently the
same backend codebase with a different auth middleware in front, not a different data model. `?format=json`
works identically. Example (public game metadata):
```json
{"fantasy_content":{"xml:lang":"en-US","yahoo:uri":"/fantasy/v2/game/nfl","game":[{"game_key":"470","game_id":"470","name":"Football","code":"nfl","type":"full","season":"2026","is_registration_over":0,"is_game_over":0,"is_offseason":0,"is_live_draft_lobby_active":1}],"time":"...","copyright":"Certain Data by Sportradar, Stats Perform and Rotowire","refresh_rate":"30"}}
```
Roster/settings/standings payloads use the same numeric-keyed, array-wrapped shape the existing research file
already documents for the OAuth API (`player_key`, `selected_position`, `waiver_priority`, etc.) — see that
file's Yahoo section for field-by-field detail; it's identical here.

Free-agent pool: **verified**, works against a public league without auth —
`GET /fantasy/v2/league/470.l.101/players;status=FA;position=WR;sort=OR;count=5?format=json` → 200, standard
player-list payload.

## 4. Projections — the gap the OAuth API has

**Verified live, closes the gap.** Yahoo's own frontend serves per-player weekly *projected* fantasy points
through an AJAX endpoint that returns JSON-wrapped HTML, and it required no login:
```
GET https://football.fantasysports.yahoo.com/f1/101/playernote?pid=30977
→ HTTP 200, content-type: application/json
{"content": "<div class=\"Tst-playernote ...\"> ... <h4>...Josh Allen</h4> ...
  <table>...<td class=\"fanpts\"><em class=\"proj-pts\">*21.06</em></td>...</table> ...</div>",
 "hash": "...", "js": [...], "objects": [...], "errors": []}
```
`101` here is a public league (see below); `pid` is the Yahoo player id (`player_key` minus the game prefix).
The `*` prefix on a `fanpts` value marks a not-yet-played (projected) week; a bare number marks a completed
week's actual score — this is exactly the convention the open-source scraper below relies on. Re-verified
fresh at time of writing (not just replaying an earlier probe) — still 200, still populated.

The companion page `GET /f1/{league}/players?count=0&pos=QB&sort=PR_S&stat1=K_K&status=ALL` (sort key `PR_S`
= "projected season rank") is also **verified** unauthenticated (200, `Sign in` link present confirming
anonymous state, 26 `data-ys-playerid` matches in the table body) and is how you'd enumerate player IDs to
then hit `playernote` for each one.

Both pages use the constants `PUBLIC_LEAGUE = 101` / `PUBLIC_LEAGUE_IDP = 216` in the open-source project
below — i.e., you don't need *your own* league's ID or any credentials to pull Yahoo's global projections;
any long-lived public league ID works as a "portal" into player-level data that isn't actually scoped to
that league.

### Open-source precedent — verified by reading source
**`amarvin/fantasy-football-bot`** (PyPI: `ffbot`) — read via `git clone` and direct file read of
`ffbot/scraper.py`. This is a genuine non-OAuth fallback (not just another OAuth wrapper):
- `create_session()` builds a plain `requests.Session()` with a spoofed `User-Agent` (via the `user_agent`
  lib) and a retry policy that explicitly retries on HTTP **999** among other 5xx codes
  (`status_forcelist=[500, 502, 503, 504, 999]`) — i.e., the project's own author has hit Yahoo's 999
  "automated traffic" response in practice and works around it with backoff + UA rotation, not cookies.
- `scrape()` walks `https://football.fantasysports.yahoo.com/f1/{PUBLIC_LEAGUE}/players?count=..&pos=..&sort=PR_S&...`,
  parses the HTML player table with BeautifulSoup for player IDs, then hits `.../playernote?pid={id}` for
  each one and parses the returned HTML's projection table with `pandas.read_html`, exactly as reproduced
  live above.
- No OAuth, no cookies, no login step anywhere in this project. Its `find_public_league.py` even brute-forces
  league IDs 0–999 against `/f1/{id}/settings` looking for one that's readable, confirming the author found
  this same "public leagues need no auth at all" property independently.

Other repos found and read but **not** relevant non-OAuth fallbacks (per task instructions, noted only
briefly): `withsmilo/yfsapi-without-auth` — despite the name, this still requires a Yahoo OAuth2 **access
token** (`yf.setUserToken(...)`); "without-auth" only means "without a bundled OAuth *flow* implementation,"
not without auth. `mackraesdirtysocks/YFAR`, `yahoo-fantasy-fball-scraper`, `yahoo-ffl` (all found via
search/clone) use **Selenium** to drive a real browser through Yahoo's login form when a private league is
needed, then scrape the authenticated HTML — i.e., full interactive login, not a cookie-reuse shortcut. These
confirm the community's actual practice for *private* leagues today is browser automation, not cookie
extraction — nobody has published a cookie-only path for private-league data, probably because (per §2) they
never needed one — either their target league was public, or they didn't realize `pub-api-ro` doesn't check
auth at all.

## 5. Rate limits, 999, cookie lifetime

- **No throttling observed** in this pass: 40 back-to-back requests to `pub-api-ro` and 25 to the
  `playernote` HTML endpoint all returned 200 with no backoff, no 999, no 429. This is a light burst test,
  not a load test — it doesn't rule out limits at higher volume or over a longer session.
- **999 is real but not documented**, per `ffbot`'s own retry list (`status_forcelist=[..., 999]`) and per
  community reports found via search (`uberfastman/yfpy` issue #51 "Yahoo Fantasy API Potential Rate
  Limits", `whatadewitt/yahoo-fantasy-sports-api` issue #81 "Unable to catch error encountered when blocked
  by Yahoo for making too many requests") — UNVERIFIED beyond these secondhand reports; not reproduced live
  (my burst test didn't trigger it).
- **Cookie lifetime: UNVERIFIED, not established either way.** No login was performed, so nothing about
  Yahoo's session-cookie lifetime could be measured. Generic Yahoo Mail help-center content (not
  fantasy-specific) mentions an 8-hour idle timeout without "stay signed in," which is not informative for
  this question. Moot anyway given §2's finding that these reads don't appear to need a session cookie at
  all.

## Ethics / risk note

While probing "a plausible public/sample league key" as instructed, a small sequential guess (`470.l.12345`)
landed on a real, currently-active, non-sandbox private league and returned that real user's full roster,
standings, settings, and transaction history with zero credentials. I stopped pulling from it after
confirming the pattern across a few resource types, and did not extract or record anything about the league's
managers beyond the team-metadata already shown above (team nickname only). Two things follow for the app
we're building:
1. **This is a workable technical path**, but building on it means relying on what looks like an
   access-control bug in a third party's production API, not an intentional public feature. That's a
   materially different risk profile than ESPN's cookie trick (which ESPN's own docs/community treat as an
   accepted, stable pattern for private-league access with your *own* credentials).
2. If we ever ship anything that reads *other people's* Yahoo leagues (not applicable to our recommend-only,
   single-user use case), this finding would be a real disclosure-worthy issue for Yahoo, not just a fun
   API quirk.

## Bottom line verdict

**(a) Viable — more viable than asked, and without needing cookies at all**, for the specific case this repo
cares about (reading our own league's rosters/standings/settings/free-agents, plus pulling Yahoo's weekly
point projections). Both undocumented hosts (`pub-api-ro`/`pub-api-rw` for structured league/roster/FA data,
and `football.fantasysports.yahoo.com`'s HTML/AJAX pages for projections) answered every read tried with zero
credentials.

**Caveats that keep this from being a clean "yes":**
- The one inconsistent result (`470.l.1` → "must be logged in") means the access pattern isn't fully
  understood — it may be that *some* leagues genuinely are gated and we got lucky/unlucky on which IDs we
  hit, rather than "nothing is ever gated." This needs to be tested against **our own actual league ID**
  before depending on it.
- This is undocumented, unstable-by-definition behavior on Yahoo's side, not a supported integration point.
  It could be patched without notice (unlike the OAuth API or ESPN's cookie convention, both of which are
  either documented or long-standing community practice).
- No mobile-app API research was possible (nothing public to find).

**Next concrete step:** try our own Yahoo league ID (once we have it) against
`GET https://pub-api-ro.fantasysports.yahoo.com/fantasy/v2/league/{game_key}.l.{our_league_id}/settings?format=json`
with a plain unauthenticated request, exactly as done here. If it returns our real settings with no
credentials, the recommend-only Yahoo adapter can skip both the OAuth application *and* cookie extraction
entirely and just hit `pub-api-ro` directly — the simplest possible outcome. If it instead returns "You must
be logged in," that tells us which case `470.l.12345` was (open) vs. `470.l.1` (gated), and cookie-based
access (with real login cookies, tested carefully and only against our own account) becomes the fallback
worth trying next, ahead of the OAuth application queue.

---

## Decision & implementation (2026-09-09)

**We did NOT build on `pub-api-ro`.** Although it works with the session cookie, it's a suspected
access-control bug (serves any private league to *no* credentials) and its durability is unknowable.
Chosen path instead: **read the logged-in `football.fantasysports.yahoo.com/f1/{league}` HTML pages**,
authenticated by the browser session cookie, parsed with BeautifulSoup (`backend/app/yahoo.py`). This is
the same login the user already uses; it will keep working as long as the website does.

Verified live against the user's league (Dad League, 1260115):
- **Server-rendered (usable):** settings page (scoring as prose tables — parsed to Sleeper keys, incl. a
  "N yards per point" → per-yard-rate parser; roster positions; waiver/FAAB rules; playoff shape), each
  team's roster page (`#team-roster`, slot via `span.pos-label[data-pos]`, player via `data-ys-playerid`),
  the players/free-agent pool (paginated by `count` used as an **offset**, not page size), records (home
  page), and transactions (`table.Tst-transaction-table`, "Free Agent"=add / "To Waivers"=drop).
- **Client-rendered (NOT in server HTML, unavailable on this path):** the standings page, and each team's
  **live FAAB balance and waiver priority**. These degrade to 0/None. This is the one real capability gap
  vs. pub-api-ro/OAuth.
- Projections come from Sleeper, scored with the translated Yahoo scoring — identical output to a scratch
  pub-api-ro build, confirming the scoring translation is correct.
