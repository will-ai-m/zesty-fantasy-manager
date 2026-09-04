# Zesty Fantasy Manager

Personal fantasy football manager for Sleeper and ESPN leagues (Yahoo once its API application is
approved). Read-only against every platform: it shows you the waiver wire, trends, and your rosters across
leagues and lets you plan moves; you make the actual moves on the platform.

## What it does

- **Waivers** — every free agent in a league with Sleeper-wide % rostered / % started, adds and drops
  (24h / 7d), this-week and next-week projections and rest-of-season projections under *that league's*
  scoring, position ranks, last season PPG, depth chart, opponent and bye. The **vs mine** column is the
  rest-of-season gap to the weakest player you roster at that position, so upgrades sort to the top.
- **Trends** — Sleeper's top-100 adds/drops with, for each of your leagues, whether the player is free,
  yours, or owned (by whom), plus projections under that league's scoring. One click to plan a pickup.
- **Roster** — your lineup by slot with bye/injury flags, an optimal-lineup suggestion (Hungarian
  assignment over projections), IR housekeeping hints, and an all-leagues view of every player you own.
- **League** — standings with FAAB remaining and waiver order, every roster (expandable), and recent
  transactions including winning FAAB bids.
- **Planner** — queue adds/drops/bids per league, see FAAB after planned bids, mark done once you make
  the move in Sleeper. Stored in `data/plans.json`.

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

Cached Sleeper data lives in `data/cache/` (players file refreshed daily; projections/stats every 10–30 min; rosters every minute).
The ↻ button in the header drops the cache.

## Layout

- `backend/app/sleeper.py` — Sleeper client (documented `/v1` endpoints plus the projections, stats,
  research, schedule, depth-chart and injury endpoints the Sleeper app uses).
- `backend/app/espn.py` — ESPN client (undocumented v3 "lm-api") and normalizers that reshape ESPN leagues,
  rosters, the player pool and transactions into the Sleeper-shaped structures the service layer uses.
- `backend/app/ids.py` — player identity: Sleeper `player_id` is canonical; ESPN/Yahoo ids map onto it via
  Sleeper's cross-ids, the nflverse crosswalk, then a name + position match.
- `backend/app/services.py` — builds the view models (waivers, roster, trends, transactions).
- `backend/app/scoring.py` — league points = Σ stat × scoring_settings weight.
- `backend/app/lineup.py` — optimal lineup assignment.
- `backend/app/plans.py` — moves planner store.
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
- Rest-of-season runs from the current week through the last fantasy playoff week of each league.
- Data is for personal, non-commercial use per Sleeper's API terms.
