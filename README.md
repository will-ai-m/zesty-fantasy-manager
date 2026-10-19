# Zesty Fantasy Manager

Personal fantasy football manager for Sleeper, ESPN and Yahoo leagues, read across all of them at once.
Read-only against every platform: it shows you the wire, the trends and your rosters, and records what you
mean to do; you make the actual moves on the platform. Yahoo goes through the logged-in website rather than
its API, which needs an approved app (the application is still pending) — see **Layout** below.

Every page except **League** reads across all your leagues at once, so the sidebar is a status panel, not a
selector: it reports each league's record, FAAB left, waiver position and waiver day. The two views that
are about one league carry their own switcher — the League page header, and the roster card on Waivers.

## What it does

- **Waivers** — the waiver wire across every league at once. FantasyPros' waiver list is the spine, in
  their order; each player carries what he did last week (half-PPR points, snap share, targets, carries),
  his FantasyPros rest-of-season rank, and a column per league saying where he is open and how many places
  he sits above the player of yours he would replace (**vs mine**). The same columns run under each
  platform's trends list (Sleeper adds/drops, ESPN ownership change, Yahoo transaction trends). Beside it,
  your roster in any league — with open spots, empty starting slots and IR — your pending claims, and the
  claims you have planned. Clicking a league's FA / W cell plans a claim there; the plan carries the bid and
  the drop, and says "yours" once the player turns up on your roster. A ☆ beside a name marks the players
  you are after and lights the row. **Browse all** is every player claimable in at least one league —
  searchable, with the same per-league columns, and nobody rostered everywhere, since nobody can have them.
- **Streaming D/ST + K** — every K and D/ST with the next four weeks of matchups, and where each one is
  yours, open or taken in every league at once. The number is the Vegas implied total where a book has
  priced the week; past that (about two weeks out) it falls back to the season's points per game, shown in
  dotted italics so it never passes for a line. Kickers carry the weather — dome or retractable roof for
  any week, wind, gusts, rain and freezing temperatures within a week of kickoff — and defences get a tag
  only for extreme weather, since ordinary weather is already in the line. Order by any week, or by
  FantasyPros' weekly or rest-of-season rank. Clicking a name shows how the rest of the league has fared
  against the opponent it meets that week. Click a cell to make that unit your pick for a league and week;
  the picks board says what each still takes (add, claim, start) and ticks itself off once it is in your
  lineup. Stored in `data/stream_picks.json`.
- **Plan** — everything you mean to do, league by league: the roster as it stands, the streaming picks
  that still need a move, and the claims planned on the waivers page with their bid and drop. Each row
  says whether it is still outstanding, done, or gone to somebody else, worked out from the rosters now
  rather than from when you planned it. Stored in `data/waiver_plans.json` and `data/stream_picks.json`.
- **League** — your lineup by slot with bye/injury flags and an optimal-lineup suggestion (Hungarian
  assignment over projections), then standings with FAAB remaining and waiver order, every other roster
  (expandable), and recent transactions including winning FAAB bids. An **All leagues** toggle shows every
  player you own across leagues. The league switcher lives in this page's header.
- **Games** (no tab; the sidebar's week list links to it) — the week's games with kickoff, lines, implied
  totals and weather.
- **Player panel** — opens from any name: FantasyPros consensus, this season's game log and last season's,
  and for a K or D/ST how the rest of the league has done against this week's opponent. Points are shown in
  one league's scoring, picked from the row you clicked and changeable in the panel.

## Configure

```bash
cp .env.example .env    # then fill in SLEEPER_USERNAME and, optionally, the ESPN and Yahoo values
```

`.env` is gitignored. Environment variables override it.

- **Sleeper** needs only `SLEEPER_USERNAME` — a username, or the numeric user id, which survives renames.
- **ESPN** needs each league id plus the `espn_s2` and `SWID` cookies from your browser (the `onboard-espn`
  skill walks through it).
- **Yahoo** needs each league id plus `YAHOO_COOKIE`, the whole `Cookie:` header from a logged-in page. It
  expires every day or two.

A league whose credentials have gone stale shows as a red error in the sidebar, and the cross-league pages
leave it out until you paste fresh values and restart (`.env` is read once, at startup).

## Run

Backend (FastAPI, Python 3.12+):

```bash
python3 -m venv backend/.venv && backend/.venv/bin/pip install -r backend/requirements.txt
backend/.venv/bin/uvicorn app.main:app --app-dir backend --port 8000 --reload
```

Frontend (Vite + React + TypeScript):

```bash
pnpm --dir frontend install
pnpm --dir frontend dev      # http://localhost:5173, proxies /api to :8000
```

Cached data lives in `data/cache/`: the Sleeper players file and the nflverse crosswalk daily, projections
and stats every 10–30 minutes, rosters every minute, betting lines every 15, weather hourly. Yahoo pages are
cached in memory only, never on disk. The ↻ button in the header drops the cache. What you record — streaming
picks and planned claims — lives in `data/` beside it and is not cache.

## Layout

- `backend/app/sleeper.py` — Sleeper client (documented `/v1` endpoints plus the projections, stats,
  research, schedule, depth-chart and injury endpoints the Sleeper app uses).
- `backend/app/espn.py` — ESPN client (undocumented v3 "lm-api") and normalizers that reshape ESPN leagues,
  rosters, the player pool and transactions into the Sleeper-shaped structures the service layer uses.
- `backend/app/yahoo.py` — Yahoo client that reads the logged-in `football.fantasysports.yahoo.com` HTML
  pages (authenticated by the browser session cookie) and parses them with BeautifulSoup. Yahoo has no
  projections, so the service layer scores Sleeper's projections with each league's translated Yahoo scoring;
  Yahoo supplies the pool and ownership. Known gaps on this path: each team's record and FAAB balance read as
  0-0 and a full budget, because the parser looks for them on the league home and standings pages, which are
  client-rendered — both are in fact on each team's own page (`5-1-0`, `Waiver Budget: $89`) and are not
  parsed yet. Yahoo's pool rows also carry no free-agent/waiver split, so every open Yahoo player reads FA.
- `backend/app/ids.py` — player identity: Sleeper `player_id` is canonical; ESPN/Yahoo ids map onto it via
  Sleeper's cross-ids, the nflverse crosswalk, then a name + position match.
- `backend/app/fantasypros.py` — the only writer of `data/cache/fantasypros.json`; scrapes the five ranking
  sets (see the `update-fantasypros-data` skill).
- `backend/app/odds.py` — the week's games and Vegas lines: ESPN's scoreboard, with nflverse backfilling.
- `backend/app/weather.py` — stadium coordinates and roof types, plus Open-Meteo forecasts for the kickoff
  hours of open-air games within a week.
- `backend/app/teamstats.py` — team offensive efficiency (red-zone split, third and fourth down, FG rate),
  the context behind a kicker's implied total.
- `backend/app/waivers.py` — the streaming table and the waiver-column digest.
- `backend/app/services.py` — builds the view models (the waiver board and pool, streaming, the plan,
  rosters, transactions, the player panel).
- `backend/app/scoring.py` — league points = Σ stat × scoring_settings weight.
- `backend/app/lineup.py` — optimal lineup assignment.
- `backend/app/picks.py` — what you mean to do: streaming picks and planned waiver claims, each a JSON file
  in `data/`. Whether a pick or claim still needs doing is never stored; it is read off the rosters.
- `backend/app/main.py` — the FastAPI app: every route is a thin call into `services.py`, plus the two
  intent stores. `config.py` reads `.env` once at startup; `cache.py` is the TTL cache (memory, with
  JSON on disk for the big slow-moving files).
- `frontend/src/pages/*` — one file per page; `components/DataTable.tsx` is the shared sortable table.
- `research/` — API research notes (Sleeper, FantasyPros, other sources).

## How ESPN leagues are scored

ESPN only publishes the current week's projection and a season projection through the league endpoint, both
already scored with the league's settings. So for ESPN leagues: this week's projection, rest-of-season
(season projection minus points scored), ownership and availability come from ESPN; next week's projection,
last-season and season-to-date points come from Sleeper's data scored with the league's scoring rules
translated to Sleeper stat keys (`espn.py:STAT_TO_SLEEPER`). Bucketed D/ST stats are mapped to the nearest
Sleeper bucket. League ids are prefixed by platform (`sleeper:…`, `espn:…`).

## Notes and assumptions

- Sleeper's public API is read-only. Writing (add/drop, waiver claims, lineups) exists only in Sleeper's
  internal GraphQL API behind a password login; this project deliberately does not use it. ESPN has no
  supported write API either; see `research/yahoo-espn-apis.md`.
- `waiver_day_of_week` is assumed to be 0 = Monday (so 2 = Wednesday, matching Sleeper's default).
- **ROS** in the interface means FantasyPros' rest-of-season rank within position (`WR11`), not a points
  projection, and **vs mine** is measured in places on their overall list. Projected points still run under
  the hood (the optimal lineup, the relevance filter) and are scored per league.
- Projected rest-of-season points run from the current week through the last fantasy playoff week.
- Books price about two weeks ahead, so the later streaming weeks stand on season averages, and weather
  forecasts reach seven days. Both are marked where they show.
- FantasyPros' weekly ranks are thin early in the week (about a dozen experts on a Tuesday, 45+ by Sunday)
  and the rest-of-season page runs on a handful all season. The app shows the expert count where it matters.
- Data is for personal, non-commercial use per Sleeper's API terms.
