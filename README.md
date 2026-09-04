# Zesty Fantasy Manager

Personal fantasy football manager for Sleeper leagues (Yahoo/ESPN later). Read-only against Sleeper:
it shows you the waiver wire, trends, and your rosters across leagues and lets you plan moves; you make
the actual moves in Sleeper.

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

Set `SLEEPER_USERNAME` to use a different Sleeper account (defaults to `dubyu`). Cached Sleeper data lives
in `data/cache/` (players file refreshed daily; projections/stats every 10–30 min; rosters every minute).
The ↻ button in the header drops the cache.

## Layout

- `backend/app/sleeper.py` — Sleeper client (documented `/v1` endpoints plus the projections, stats,
  research, schedule, depth-chart and injury endpoints the Sleeper app uses).
- `backend/app/services.py` — builds the view models (waivers, roster, trends, transactions).
- `backend/app/scoring.py` — league points = Σ stat × scoring_settings weight.
- `backend/app/lineup.py` — optimal lineup assignment.
- `backend/app/plans.py` — moves planner store.
- `frontend/src/pages/*` — one file per page; `components/DataTable.tsx` is the shared sortable table.
- `docs/research/` — API research notes (Sleeper, FantasyPros, other sources).

## Notes and assumptions

- Sleeper's public API is read-only. Writing (add/drop, waiver claims, lineups) exists only in Sleeper's
  internal GraphQL API behind a password login; this project deliberately does not use it.
- `waiver_day_of_week` is assumed to be 0 = Monday (so 2 = Wednesday, matching Sleeper's default).
- Rest-of-season runs from the current week through the last fantasy playoff week of each league.
- Data is for personal, non-commercial use per Sleeper's API terms.
