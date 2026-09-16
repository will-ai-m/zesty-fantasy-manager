# Yahoo browser-automation fallback & projections — research findings (2026-09-09)

Scope: this file covers the browser-automation/scraping fallback for reading a personal Yahoo league while
the official API application is pending, plus the projections question. It does **not** cover whether Yahoo's
internal frontend endpoints accept plain session cookies (a hit-or-miss JSON API vs. HTML scraping) — that is
a separate, parallel investigation. Builds on `research/yahoo-espn-apis.md` (read first).

Items marked **verified** were confirmed by reading actual source in cloned repos, or by live unauthenticated
`curl` requests against `football.fantasysports.yahoo.com` on 2026-09-09. Everything else is cited inline and
marked UNVERIFIED.

## Bottom line

- **Browser automation works and is not exotic** — Yahoo's fantasy football web app is legacy, server-rendered
  HTML (no login-gated JSON blob to lift), so Playwright/Selenium + an HTML parser is the correct shape for a
  scraping fallback, and one actively-maintained, well-engineered Playwright example already does almost exactly
  this. But it only replaces the parts of the official API we're missing (nothing today, since the API covers
  rosters/settings/free agents/FAAB) — it exists purely to bypass the **application-approval wait**.
- **Projections are not worth chasing.** Yahoo's own projections are a third-party blend (RotoWire + The BLITZ +
  FTN, plus a fourth free-tier provider), not a Yahoo-proprietary model, are never delivered as clean structured
  data (HTML table cells, no JSON), and the app already has Sleeper's free per-week projections and FantasyPros'
  expert consensus, cross-mapped via `yahoo_id`/name matching. Recovering Yahoo's specific blend would mean
  fragile scraping for a number that is strictly less useful than what's already cached. **Don't build it.**
- **Risk is low but not zero**, and it's about the account, not the data. Yahoo's ToS flatly prohibits automated
  collection without permission and reserves the right to suspend/terminate on any ToS violation "for any reason,
  without notice." No documented case of a personal account actually being suspended for scraping was found in
  this research; the only real-world enforcement pattern found is Yahoo temporarily throttling ("Request denied",
  "999" errors) at the *application/App-ID* level, not the account level, and one repo's own testing found Yahoo
  starts throttling **page reloads faster than ~1 per 10 seconds**. A handful of requests a few times a day is far
  under any threshold anyone has hit.

---

## 1. Browser-automation state of the art

Six repos were cloned and read directly (not just READMEs). Push dates below are `pushed_at` from the GitHub API,
checked 2026-09-09.

### Actively maintained (2026)

**`SysAdminDoc/FantasyLeagueFootball`** — https://github.com/SysAdminDoc/FantasyLeagueFootball — last push
**2026-08-16** (v0.3.0), 0★ (small personal project, MIT, 337 tests, well-engineered), Python 3.11+, optional
`[yahoo]` extra needs `playwright>=1.60`. **Verified by reading `src/fantasyleague/sync/yahoo.py` in full (446
lines).** This is the best available reference implementation:
- **Pages loaded:** `/f1/{league}/{n}/team` (one team's roster page, looped `n = 1..max_teams`) and
  `/f1/{league}/draftresults` (every draft pick). It does **not** touch the free-agent/players page or
  transactions — see "what it deliberately skips" below.
- **What it extracts:** per-team roster (slot, player name, Yahoo player id from `data-ys-playerid`, NFL team,
  position, injury status), waiver priority (regex on "Waiver Priority: N" in the page text), which team is the
  signed-in user's own (`"Edit Team Settings" in page_html`), and league name (parsed out of `<title>`). Draft
  results give every pick with round/pick/manager/player.
- **Login/session handling:** `playwright.chromium.launch_persistent_context(user_data_dir=...)` against a
  profile directory under `~/.fantasyleague/yahoo-profile` — a real, reusable Chrome/Edge profile, so login is a
  **one-time interactive step** (`headless=False`, human completes Yahoo's login/2FA in a real browser window);
  every subsequent run reuses the saved cookies/session in that profile with no code-level session handling at
  all. It tries `channel="msedge"` then `"chrome"` then falls back to bundled Chromium, explicitly commented:
  *"a real Edge/Chrome build looks like a person to Yahoo's login; the bundled Chromium is the fallback."* It also
  blocks `**/draftclient/**` requests via `page.route(...).abort()` to stop league pages from auto-redirecting
  into the live draft-room websocket client.
- **Parsing brittleness:** low-to-moderate. It uses Python's built-in `HTMLParser` (no BeautifulSoup dependency)
  over `statTable*`-id tables and `data-ys-playerid` attributes, which are DOM structure/ids rather than visible
  text positions — more resilient than text-offset scraping, but still tied to Yahoo's markup and will break
  silently if Yahoo renames those classes/ids. It has escape hatches: if `"statTable" not in content` or
  `"not in this league"` / `"was not found"` appears, it stops rather than mis-parsing.
  Parsers are unit-tested against saved HTML fixtures without a browser (`tests/` — separate from the Playwright
  smoke test that needs a real Chromium).
- **Rate-limit note (concrete, first-party):** a comment in the live-draft poller states plainly: *"Yahoo
  rate-limits reloads faster than ~10s (\"Request denied\")"* — this is a specific, unprompted operational
  data point about Yahoo's own throttling behavior on page reloads (`DEFAULT_POLL_SECONDS = 12.0`).
- **What it deliberately skips:** notably, its `waivers` feature does **not** scrape Yahoo's free-agent page at
  all. Per its CHANGELOG: *"free agents ranked by how much your best lineup improves... the pool is everyone
  Sleeper projects, so a breakout backup who was never on the draft board still shows up."* i.e. this project
  independently reached the same conclusion this research recommends — pull rosters from Yahoo, get the rest
  (projections, the free-agent pool, trending adds) from Sleeper.

**`andrewrgoss/yahoo-fantasy-fball-scraper`** — https://github.com/andrewrgoss/yahoo-fantasy-fball-scraper —
last push **2026-08-22**, 11★, Selenium + BeautifulSoup + pandas. **Verified by reading `player_season_projections.py`
and `helper.py` in full.**
- **Pages loaded:** `https://football.fantasysports.yahoo.com/f1/{league}/players?sort=PTS&sdir=1&status=A&pos=O&
  stat1=S_PS_{year}&count={0,25,50,...,275}` — the season-long player-projections table, paged 25 rows at a time
  up to 300 players. A companion script hits the pre-draft auction-values page and another hits draft results.
- **What it extracts:** name, team, position, status, GP, bye, fantasy points, preseason/actual rank, % rostered,
  and per-stat-category season projections (passing/rushing/receiving/etc.), written to CSV.
- **Login:** direct **username+password** submission into Yahoo's own login form via Selenium
  (`browser.get('https://login.yahoo.com')`, fills `#login-username`/`#login-passwd`-style selectors with a
  fallback list of alternate selectors for different Yahoo login-page variants), or a `--manual-login` mode that
  opens the browser and waits for `input()` before proceeding. **No persistent profile/cookie reuse across runs**
  — it logs in fresh (or waits for manual login) every invocation.
  The README states explicitly, and this is a real risk-relevant fact: *"It's not designed to work with Yahoo
  2-step verification (2sv) and this should be disabled, at least temporarily."* — i.e. the credential-based
  flavor of this pattern requires **weakening account security** to work headlessly, which is a bad trade for a
  personal account.
- **Parsing brittleness: high.** It reads the whole rendered table via `.get_attribute("innerText")`, hardcodes
  `rows[39:]` to skip a fixed number of header lines, then walks the remaining lines with a hand-rolled state
  machine (`step` counter, string markers like `"Video Forecast"`/`"New Player Note"` to detect status codes) that
  assumes a fixed number of lines per player record and re-detects "Fan Pts" as a repeated-header marker on every
  paged reload. This is fragile in the way pure text-position scraping always is — a layout tweak, an extra promo
  banner row, or a stat column reorder (the most recent commit, "Correct Yahoo projection stat order," was fixing
  exactly this) breaks it silently.

**`amarvin/fantasy-football-bot` (`ffbot`, on PyPI)** — https://github.com/amarvin/fantasy-football-bot — last
push **2026-09-01** (v1.2.12), 56★, published on PyPI, has CI + codecov. **Verified by reading `ffbot/scraper.py`
and `find_public_league.py` in full, and by independently reproducing its requests live.** This is the most
interesting entry because **it uses no browser at all** — plain `requests` + BeautifulSoup + pandas, and needs
**no login**:
- It builds the full NFL player pool and Yahoo's own weekly projections from a **fixed public league ID
  (`PUBLIC_LEAGUE = 101`)** — Yahoo allows public leagues' `/players` listing and the `/playernote?pid=N` AJAX
  partial (an HTML fragment returned as JSON: `{"content": "<div class=\"playerinfo\">..."}`) to be fetched by
  anyone, no cookies. `find_public_league.py` is a helper that brute-force-scans league ids 0–999 for one that's
  public and has the right roster shape (DEF vs. IDP).
  **Verified live** (2026-09-09): `curl` (rotating desktop User-Agent, no cookies) against
  `https://football.fantasysports.yahoo.com/f1/101/players?count=0&pos=QB&sort=PR_S&stat1=K_K&status=ALL` →
  HTTP 200, a full HTML table with `data-ys-playerid` attributes; and against
  `https://football.fantasysports.yahoo.com/f1/101/playernote?pid=30977` → HTTP 200, `{"content": "...Josh
  Allen... Rank 35... Pass Yds..."}` including Yahoo's own season rank and per-stat projections, unauthenticated.
- **Notable adjacent finding (belongs to the sibling endpoint-auth investigation, flagging here since it turned up
  while checking page auth for this task):** calling `playernote?pid=X` against a league id whose main pages
  *do* redirect to login (`/f1/1/1` → 302 to `login.yahoo.com`, confirmed private) **still returned HTTP 200**
  with that player's **owner team name inside league 1** ("Hail Mary Larry") and % rostered — i.e. Yahoo's
  `playernote` AJAX endpoint does not appear to check league-privacy/auth the way the full page routes do. This
  is a real information-disclosure quirk worth the sibling investigation's attention; it wasn't explored further
  here since it's plain-HTML "content" text rather than a JSON API surface, and enumerating every player id for
  every roster spot would be a lot of requests for what it returns.
- To attach this pool to *your* league's ownership, `scrape(league)` takes your real league ID and calls
  `playernote` against it per player — which per the finding above appears to work without a login, though this
  was not re-verified against a genuinely private league the tester controls, so treat it as UNVERIFIED for a
  truly private league (Yahoo may be treating league id 1 as a stale/reclaimed/effectively-public id).
- **Parsing brittleness:** moderate — CSS selectors (`.playerinfo .name`, `dd.owner`, `dd.owned`) plus
  `pandas.read_html` on an embedded table for the weekly-points grid, all somewhat more resilient than raw text
  splitting but still tied to Yahoo's class names.
- No login/session handling exists in this repo at all — by design it never needs one for player pool/projection
  data, only your league id for ownership context.

### Abandoned — flag as stale

- **`dangoldin/yahoo-ffl`** — https://github.com/dangoldin/yahoo-ffl — last push **2023-08-28**. Selenium +
  XPath scraping of the stats/projections table. Its own README admits: *"the set of columns displayed on the
  page vary due to differences in league settings... you should be able to update the code in scrape.py to come
  up with a new set of xpath expressions"* — brittleness acknowledged by the author, and it's three years stale
  against a site that has visibly changed since (our live fetch shows a different DOM shape than what its XPath
  expressions target). **Abandoned, do not use.**
- **`sbma44/yahoofantasyfootball`** — https://github.com/sbma44/yahoofantasyfootball — last push **2023-01-20**,
  Python 2 (`print` statements), depends on **PhantomJS**, which has been unmaintained since 2018 and doesn't
  run against modern TLS/JS on most sites any more. **Fully abandoned, unusable as-is.**

### Not actually a scraping example (checked and ruled out)

- **`uberfastman/fantasy-football-metrics-weekly-report`** — https://github.com/uberfastman/fantasy-football-metrics-weekly-report
  — last push **2025-10-01**, 227★, by far the most popular multi-platform (Yahoo/ESPN/CBS/Sleeper/Fleaflicker)
  community tool. **Verified by reading `ffmwr/dao/platforms/yahoo.py`**: for Yahoo it uses the official `yfpy`
  library over OAuth2 (`YahooFantasySportsQuery`), not scraping. `selenium` is a dependency of this repo, but
  **verified** (grep) it's used only in `ffmwr/dao/platforms/espn.py` to drive a login and lift ESPN's `espn_s2`/
  `SWID` cookies — never for Yahoo. Worth citing as negative evidence: the most-used community tool in this space
  doesn't bother scraping Yahoo either, because the official read API is sufficient once you have API access —
  which is exactly our situation once approval comes through.

### Verdict on Q1

Playwright is the right tool if we build this, and `SysAdminDoc/FantasyLeagueFootball`'s `yahoo.py` is a directly
reusable pattern (persistent browser profile → one manual login → HTML-attribute parsing, not raw text splitting).
Given this project already has the `playwright-cli` skill, standing up a similar login-once/reuse-profile scraper
for rosters + draft results is straightforward. It should **not** attempt username/password automation (the
andrewrgoss pattern) — that requires disabling 2FA, which is a real security regression for a personal account,
and gains nothing a persistent-profile + one manual login doesn't already give.

---

## 2. Which pages carry the data, and is it HTML or a JS-loaded JSON blob?

**Verified live, 2026-09-09**, unauthenticated `curl` (desktop Chrome UA) against
`football.fantasysports.yahoo.com` — this is Yahoo's actual fantasy-football web app; there is no separate
"new" React/Next.js fantasy site at a different host serving this data:

| Page | URL pattern | Auth required (private league) | Data format |
|---|---|---|---|
| League homepage | `/f1/{league}` | Yes — unauth request **302**s to `login.yahoo.com` (verified against league id 1) | Server-rendered HTML |
| Team roster | `/f1/{league}/{team_n}` or `/{team_n}/team` | Yes (same 302) | Server-rendered HTML, `<table id="statTable...">`, players carry `data-ys-playerid` |
| Players / free agents | `/f1/{league}/players?sort=PTS&pos=O&status=A&count=N` | Yes for a private league (302); **verified not required for a public league** (HTTP 200, full table, on league id 101) | Server-rendered HTML `<table>`, no pagination via JS — `count=` query param pages it server-side |
| Transactions/waivers | `/f1/{league}/transactions` | Yes (302 verified against league id 1) | Server-rendered HTML `<table>` (verified shape on public league 101: multiple `<table>` elements, no JSON) |
| Player detail/projection popover | `/f1/{league}/playernote?pid=N` | **No** — returns 200 even against a league whose main pages require login (see §1, ffbot finding) | AJAX **HTML-in-JSON**: `{"content": "<div class=playerinfo>...</div>"}` — not structured JSON, just an HTML fragment wrapped in a JSON envelope |

**No `root.App.main`, `__PRELOADED_STATE__`, `__NUXT__`, or any other embedded state blob exists anywhere in these
pages** (grepped the full HTML of the league homepage, players page, team page, and transactions page — none
found). The largest inline `<script>` blocks on these pages are legacy `YAHOO.namespace(...)` / `YSF, YFB, YMedia`
globals and ad/analytics bootstrapping (`window.$_mod_ybar`, bid-a-thon ad code) — i.e. this is old-generation
Yahoo front-end tech (YUI-era), not a modern SPA. That's good news for scraping: there is no client-side
rendering step to wait through, and no JSON to reverse-engineer beyond the small `playernote` HTML fragment — it's
plain, immediately-available server HTML, exactly what both `BeautifulSoup`/`HTMLParser` -based scrapers above
target. The tradeoff is the opposite of a JSON API: table-cell/DOM-structure parsing instead of a stable schema,
which is why "verified working, recently updated" repo selection mattered more here than usual.

---

## 3. Projections

**Where Yahoo's UI projections come from (verified via Yahoo's own help page and a Yahoo Sports article):**
- https://help.yahoo.com/kb/fantasy-football/player-projections-yahoo-fantasy-football-sln37135.html — non-subscribers
  get "consensus projections powered by multiple industry-leading data providers"; named partners across the two
  sources are **RotoWire, The BLITZ (Derek Carty), FTN Fantasy, and a BAKER prediction-engine model**. Fantasy Plus
  subscribers can additionally select a specific model and see ceiling/floor projections.
- https://sports.yahoo.com/fantasy/article/yahoo-fantasys-player-projections-have-gotten-an-upgrade--heres-what-to-know-132003466.html
  confirms this is "a proprietary **consensus blend** that combines inputs from Rotowire, The BLITZ and FTN,"
  rolled out for the 2025 season — i.e. Yahoo does not run its own projection model; it licenses and blends
  third-party ones, the same category of provider FantasyPros already aggregates into its own consensus (ECR).

**Are they recoverable?** Only by scraping (see §2 — `playernote` fragment, or the paged `/players` table), and
only as a rendered number with no visibility into which of the 3–4 underlying providers or what weighting
produced it — there's no API, documented or undocumented, exposing Yahoo's projections directly (confirmed absent
from every field in `research/yahoo-espn-apis.md`'s Yahoo API section, and no `/projections` route exists in
`yahoo_fantasy_api`'s or `yfpy`'s coverage).

**Does it matter given what we already have?** No. The app already caches:
- Sleeper's `/projections/nfl/{season}/{week}` — free, no auth, per-week, per-stat-category, JSON, already the
  documented `research/sleeper-api.md` data source, and Sleeper's player table already carries `yahoo_id` for
  every player (`research/sleeper-api.md` line 34) — the crosswalk this project already plans to use per
  `research/yahoo-espn-apis.md`'s "What this means for the app" section is free and already built.
- FantasyPros expert consensus rankings (already scraped weekly per `update-fantasypros-data` skill in this repo).

Both of those are: (a) already structured JSON/cached, not scraped HTML; (b) drawn from a comparable or broader
set of expert/model sources than Yahoo's 3–4-provider blend; (c) usable across every platform (Sleeper, ESPN, and
Yahoo leagues alike), keeping the recommendation engine's numbers consistent league-to-league instead of Yahoo
users seeing a different, unrelated projection source than everyone else in the app.

**Honest opinion: Yahoo's own projections are not worth any engineering effort.** They're a third-party consensus
blend, not a Yahoo edge; the only way to get them requires scraping brittle HTML for a number that's redundant
with two data sources already in the app, correctly licensed/free, structured, and platform-agnostic. This
conclusion is independently corroborated by `SysAdminDoc/FantasyLeagueFootball` (§1) — a project built by someone
else solving the identical problem (recommend-only Yahoo league manager) — which reads Yahoo for rosters/draft
results only and explicitly uses Sleeper for projections and the free-agent pool instead of scraping Yahoo's.
Reusing Sleeper/FantasyPros numbers for a Yahoo league is strictly better.

---

## 4. Risk

**What Yahoo's ToS actually says** (verified by fetching the documents live, 2026-09-09; both redirected through
several legacy-domain hops — `guce.yahoo.com` → `legal.yahoo.com/.../terms/otos/index.html`, and
`football.fantasysports.yahoo.com/f1/tos` → `legal.yahoo.com/.../product-atos/fantasy-football/general/index.html`):

- Main Yahoo ToS, §2.4(i): prohibits users from *"access[ing] or collect[ing] data, or attempt[ing] to access or
  collect data, from our Services using any automated means, devices, programs, algorithms or methodologies,
  including but not limited to robots, spiders, scrapers, data mining tools, or data gathering or extraction
  tools, for any purpose without our express, prior permission."* This is a blanket prohibition with no carve-out
  for "your own data" or low request rates — it is written to cover any automation, not specifically abusive
  scraping. Matches what `research/yahoo-espn-apis.md` already found for the same clause elsewhere.
- §7(c) (consequences): *"we may temporarily or permanently suspend or terminate your account or impose limits on
  or restrict your access to parts or all of the Services at any time, without notice and for any reason,
  including, but not limited to, violation of these Terms."* Yahoo Fantasy Football's own additional ToS
  (`legal.yahoo.com/.../product-atos/fantasy-football/general/`) separately reserves the right to suspend/cancel
  for "cheating or manipulation of the Service" or acting "inconsistent with the spirit or the letter" of the
  terms, again "at any time... without notice."
- Net legal position: automated access to your own league without Yahoo's permission is a literal ToS violation,
  and the stated consequence (account suspension) is broad and fully discretionary. There is no meaningfully
  different or narrower risk for "read-only, low-volume, personal account" use — the clause doesn't distinguish.

**What community experience actually reports** (no documented account-ban cases found for fantasy scraping
specifically):
- The only concrete enforcement pattern found anywhere is **API throttling tied to the App ID**, not the user
  account: https://github.com/whatadewitt/yahoo-fantasy-sports-api/issues/81 — Yahoo returns a "Request denied"
  response (which some client libraries fail to parse, causing an uncaught error) when a *registered developer
  app* exceeds some undocumented request threshold; the block is described as temporary and tied to "the app ID
  we have registered on their developer portal," not the signing-in Yahoo account. A second issue,
  https://github.com/uberfastman/yfpy/issues/51, reports connection drops (`RemoteDisconnected`) after heavy
  historical-data pulls across many seasons/weeks, again with no confirmed permanent block and no published rate
  limit numbers from Yahoo.
- The one first-party operational data point found for the *scraping* (not official-API) path is
  `SysAdminDoc/FantasyLeagueFootball`'s own comment that Yahoo starts rejecting page reloads with "Request denied"
  **faster than roughly one request per 10 seconds** during live-draft polling — i.e. sustained rapid polling
  trips a soft throttle within seconds, but it's a temporary "slow down" response, not a ban, and the project's
  default poll interval (12s) was chosen specifically to stay under it.
- No forum, GitHub issue, or write-up surfaced in this research documents a Yahoo Fantasy **account** (as opposed
  to an API app or an IP address) being suspended or banned for personal-use scraping or API polling.

**Realistic practical assessment for "a handful of requests a few times a day":** this is orders of magnitude
below every threshold anyone has actually hit in the reports above (those all involve either sustained rapid
polling — many requests per second/minute — or bulk historical pulls across many seasons). At that volume the
practical risk is negligible; the ToS risk is nonzero-but-theoretical (a literal violation, broad discretionary
enforcement power, zero documented cases of it being exercised against a low-volume personal user found in this
research). This is a judgment call, not a legal one — see the answer, not advice, framing at the top of this
report.

---

## Recommendation

- **Do not build the browser-automation fallback right now.** The official Yahoo API application is the correct
  and only fully-ToS-compliant path, it covers every field this project needs (rosters, league scoring settings,
  free-agent pool + ownership %, FAAB/waiver state — all confirmed in `research/yahoo-espn-apis.md`), and the
  approval wait is the only thing scraping would buy time on. If the wait becomes genuinely blocking, the
  `SysAdminDoc/FantasyLeagueFootball` pattern (Playwright + persistent profile + one manual login + attribute-based
  HTML parsing, via this project's existing `playwright-cli` skill) is a good template to adapt — but scope it to
  rosters + draft results only (what the API can't give you anyway isn't different between now and after
  approval), not the free-agent/projections pages, since those numbers are already covered better by Sleeper.
- **Projections: skip entirely, permanently — not just "for now."** Yahoo's own weekly projections are a
  third-party blend of the same class of provider FantasyPros already aggregates, are never available as clean
  data (HTML-fragment scraping only), and are redundant with the Sleeper projections + FantasyPros ECR this app
  already caches and cross-maps via `yahoo_id`. There's no scenario where scraping them is worth it.
