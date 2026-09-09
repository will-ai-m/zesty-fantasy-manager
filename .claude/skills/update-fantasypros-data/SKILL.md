---
name: update-fantasypros-data
description: Refresh the FantasyPros expert consensus rankings (weekly half-PPR by position, rest-of-season overall, waiver wire) that the app reads from data/cache/fantasypros.json. Use when the user asks to update, refresh, or re-scrape FantasyPros rankings or ECR, when the rankings look stale or a new NFL week has started, or when a ranking set is reported missing or marked stale in the app.
---

# Update FantasyPros data

Scrapes three sets of half-PPR expert consensus rankings and writes them where the backend
reads them. Nothing else in the app fetches FantasyPros — this script is the only writer.

## Run it

```bash
backend/.venv/bin/python -m app.fantasypros
```

Takes ~40s: eight pages with a 5s crawl delay between them, per FantasyPros' robots.txt.
Exit code is 1 if any page failed. Output goes to `data/cache/fantasypros.json` (gitignored,
like every other cache file — do not commit it).

## What it writes

`data/cache/fantasypros.json`:

```
fetched_at, fetched_at_iso, scoring: "HALF", errors: []
sets:
  weekly  6 pages (qb, rb, wr, te, k, dst) — ~650 players, ~80 experts
  ros     1 page (overall)                 — ~410 players, 3 experts
  waiver  1 page (overall)                 — ~57 players, 4 experts
```

Each player row: `sleeper_id`, `fantasypros_id`, `name`, `position`, `team`, `rank_ecr`,
`pos_rank`, `rank_min`, `rank_max`, `rank_ave`, `rank_std`, `tier`, `ecr_delta`, `owned_avg`,
`opponent`, `bye`, `note`. Positions and teams are in Sleeper's vocabulary (DEF not DST,
JAX not JAC), so rows join straight onto the rest of the app.

## Reading it from the app

```python
from .fantasypros import load, by_sleeper_id

data = load()                            # None if never scraped
ros = by_sleeper_id(data, "ros")         # {sleeper_id: row}
row = ros.get(player_id)
```

`rank_ecr` is **within-position** on the weekly pages but **overall** on the ros and waiver
pages. Compare `pos_rank` across sets instead.

## Checking the result

A healthy run prints 100% matched for all three sets:

```
weekly: 651 players, 651 matched to Sleeper (100%)
```

If matched drops well below that, the nflverse crosswalk join is failing — check that
`data/cache/nflverse_ids_v2.json` is present and current (it is refetched daily by
`ids.load_nflverse_ids`).

## When a page fails

A page that errors or returns fewer than 5 rows keeps its **previous** rows, marked
`stale_since` with the error attached, rather than blanking that set. The run still exits 1
and names the page. Two causes worth telling apart:

- **Paywalled.** FantasyPros has withheld a ranking set before — `ros-half-point-ppr-flex`
  returned 0 players in early Sep 2026 and was open again days later. Usually transient;
  re-run later. If it persists, derive that set from the overall page instead.
- **Page structure changed.** `no ecrData block` means the `var ecrData = {...}` blob is gone
  or reshaped. Fetch the page with a browser User-Agent and look at the HTML before editing
  the regex in `backend/app/fantasypros.py`.

Do not work around a failure by adding `/api/`, `/ajax/` or `/json/` paths — they all return
403 and are robots-disallowed. The rankings pages are the only sanctioned free path.

## Fields that are currently always null

`tier` and `ecr_delta` are present in the payload but have been null on every page through
preseason 2026 — `ecr_delta` needs a prior week to diff against. They are carried through
untouched. Do not build a UI column on either without first confirming it has data in the
current file.
