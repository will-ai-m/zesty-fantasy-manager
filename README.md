# Zesty Fantasy Manager

Personal fantasy football manager for Sleeper and ESPN leagues (Yahoo once its API application is
approved). Read-only against every platform: it shows you the waiver wire, trends, and your rosters across
leagues and lets you plan moves; you make the actual moves on the platform.

## The weekly routine

Three things decide a season, and the app has a page for each:

- **Week** — the whole routine on one screen: lineup changes to make in each league, claims to file
  before waivers run (with a countdown), and the news that needs a decision. Start here.
- **Board** — the waiver wire ranked by *claim priority*, not by projection: how much a player
  upgrades your roster, where the experts rank him, whether the market is moving on him, whether he
  projects like a starter, and whether his path just cleared — somebody ahead of him got hurt, or
  there is news saying he has the job. Every score shows its parts, and the leaders carry their
  headlines. For FAAB leagues it suggests a bid range, calibrated against the winning bids your league
  has actually paid, with those comparables attached, and it shows when each player comes off
  waivers — league-wide or player by player.
- **Lineup** — the start/sit call for the week. Slots go to the highest FantasyPros consensus rank;
  league-scored projections break ties and cover the players nobody has ranked. Shows the tier, the
  reason for each swap, which slots have already locked because the game kicked off, and which
  questionable starters to re-check before then.
- **News** — RotoWire, FantasyPros and RotoBaller items for every player who matters to you, sorted
  by what needs a decision. An injury is walked down the depth chart to whoever is next in line,
  with whether he is free in each of your leagues and a button to queue the claim. Mark one done and
  it drops out of the way.

## What else it does

- **Waivers** — every free agent in a league with Sleeper-wide % rostered / % started, adds and drops
  (24h / 7d), this-week and next-week projections and rest-of-season projections under *that league's*
  scoring, position ranks, last season PPG, depth chart, opponent and bye. The **vs mine** column is the
  rest-of-season gap to the weakest player you roster at that position, so upgrades sort to the top.
- **Trends** — Sleeper's top-100 adds/drops with, for each of your leagues, whether the player is free,
  yours, or owned (by whom), plus projections under that league's scoring. One click to plan a pickup.
- **Roster** — your lineup by slot with bye/injury flags, an optimal-lineup suggestion (Hungarian
  assignment, over consensus ranks where FantasyPros has them and projections everywhere else), IR
  housekeeping hints, and an all-leagues view of every player you own.
- **League** — standings with FAAB remaining and waiver order, every roster (expandable), and recent
  transactions including winning FAAB bids.
- **Planner** — queue adds/drops/bids per league in claim order (waivers run your claims in the order
  you set), see FAAB after planned bids, mark done once you make the move in Sleeper. Stored in
  `data/plans.json`.

## Configure

```bash
cp .env.example .env    # then fill in SLEEPER_USERNAME and, optionally, the ESPN values
```

`.env` is gitignored. Environment variables override it. ESPN needs each league id plus the `espn_s2` and
`SWID` cookies from your browser (see `.env.example`); if a cookie expires the ESPN league shows as an error
chip in the header until you paste fresh values.

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

Cached data lives in `data/cache/` (players file refreshed daily; projections/stats every 10–30 min;
rosters every minute; FantasyPros pages 20 min for weekly and waiver ranks, 3h for rest-of-season;
news 10 min). The ↻ button in the header drops the cache.

Everything is fetched when you open a page — nothing runs in the background. The first load after a
cold cache pulls about seven FantasyPros pages five seconds apart, so give it half a minute; after
that it is instant until the cache expires.

Run the tests with `backend/.venv/bin/python -m pytest` from `backend/`.

## Layout

- `backend/app/sleeper.py` — Sleeper client (documented `/v1` endpoints plus the projections, stats,
  research, schedule, depth-chart and injury endpoints the Sleeper app uses).
- `backend/app/espn.py` — ESPN client (undocumented v3 "lm-api") and normalizers that reshape ESPN leagues,
  rosters, the player pool and transactions into the Sleeper-shaped structures the service layer uses.
- `backend/app/ids.py` — player identity: Sleeper `player_id` is canonical; ESPN/Yahoo ids map onto it via
  Sleeper's cross-ids, the nflverse crosswalk, then a name + position match.
- `backend/app/fantasypros.py` — expert consensus ranks (weekly, rest-of-season, waiver wire) read
  from the public rankings pages, which embed the table's own JSON.
- `backend/app/ranks.py` — puts a consensus rank on the projection scale, so a rank can fill a flex
  slot alongside a projection.
- `backend/app/news.py` — player news (Sleeper's feed, ESPN as fallback) plus the keyword classifier.
- `backend/app/impact.py` — depth charts: who is next in line, and whose path just cleared.
- `backend/app/clock.py` — when waivers process, when a dropped player clears, when a lineup locks.
- `backend/app/faab.py` — bid suggestions from your league's own bid history.
- `backend/app/targets.py` — the claim-priority score and its parts.
- `backend/app/services.py` — builds the view models (week, board, lineup, news, waivers, roster,
  trends, transactions).
- `backend/app/scoring.py` — league points = Σ stat × scoring_settings weight.
- `backend/app/lineup.py` — optimal lineup assignment.
- `backend/app/plans.py` — moves planner store.
- `backend/tests/` — `pytest` from `backend/`; the view builders run against an in-memory league.
- `frontend/src/pages/*` — one file per page; `components/DataTable.tsx` is the shared sortable table.
- `research/` — API research notes (Sleeper, FantasyPros, other sources).

## How ESPN leagues are scored

ESPN only publishes the current week's projection and a season projection through the league endpoint, both
already scored with the league's settings. So for ESPN leagues: this week's projection, rest-of-season
(season projection minus points scored), ownership and availability come from ESPN; next week's projection,
last-season and season-to-date points come from Sleeper's data scored with the league's scoring rules
translated to Sleeper stat keys (`espn.py:STAT_TO_SLEEPER`). Bucketed D/ST stats are mapped to the nearest
Sleeper bucket. League ids are prefixed by platform (`sleeper:…`, `espn:…`).

## Where the numbers come from

- **Expert ranks** — FantasyPros publishes each rankings page with its table's data in a
  `var ecrData = {...}` block, which is what this reads: consensus rank, tier, min/max/std, the move
  since last week, and the expert's note. One page at a time, browser User-Agent, five seconds apart
  per their robots.txt (the rankings pages are allowed; `/api/`, `/json/` and `/ajax/` are not, and
  are not touched). Their terms ask that you not republish, so this is personal use only, on your
  machine. `ZFM_FANTASYPROS=off` turns it off and everything falls back to projections.
- **A rank is not a number of points**, so ranks and projections are joined by laying each position's
  ranked players over that position's projections in order: the consensus RB7 is credited with the
  7th-best projection among ranked RBs. That keeps the consensus in charge of the ordering while
  leaving the numbers in your league's scoring, which is what lets a flex slot weigh a WR against a
  RB. A player FantasyPros has not ranked keeps his own projection.
- **Bid suggestions** are a curve over the claim-priority score, scaled to what your league pays —
  the 90th percentile of its winning bids this season — and nudged by how much budget you are still
  sitting on this late. Under five winning bids there is nothing to calibrate against and the plain
  curve stands. The comparables and the reasoning ride along with every suggestion; treat the number
  as a starting point, not an oracle.
- **News** comes from Sleeper's public feed, which aggregates RotoWire (with its analysis paragraph),
  FantasyPros and RotoBaller keyed by the same player ids used everywhere else here. Items carry no
  category, so headlines are classified locally with keyword rules — good enough to tell an injury
  from a practice report, which is what decides whether to go looking for the next man up.

## Notes and assumptions

- Sleeper's public API is read-only. Writing (add/drop, waiver claims, lineups) exists only in Sleeper's
  internal GraphQL API behind a password login; this project deliberately does not use it. ESPN has no
  supported write API either; see `research/yahoo-espn-apis.md`.
- `waiver_day_of_week` is assumed to be 0 = Monday (so 2 = Wednesday, matching Sleeper's default).
  The resolved weekday is shown on the Board, so a wrong guess is visible rather than silent.
- Sleeper stores waiver hours with no timezone; they are read in `ZFM_TIMEZONE` (default US Eastern).
- A dropped player is taken to clear at the first waiver run after his league's `waiver_clear_days`
  have passed. ESPN publishes a per-player clear time and that is used directly.
- Lineup locks come from the game's status in Sleeper's schedule (a team is locked once its game
  leaves `pre_game`), since the schedule carries no kickoff time.
- Sleeper's news query is undocumented, like the projection and stats endpoints already in use. It is
  an anonymous read; if it ever changes, ESPN's fantasy news host serves the same RotoWire stories
  and is used automatically.
- Rest-of-season runs from the current week through the last fantasy playoff week of each league.
- Data is for personal, non-commercial use per Sleeper's API terms.
