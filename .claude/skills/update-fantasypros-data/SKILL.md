---
name: update-fantasypros-data
description: Refresh the FantasyPros expert consensus rankings (weekly half-PPR by position, rest-of-season overall, rest-of-season K and D/ST, waiver wire) that the app reads from data/cache/fantasypros.json. Use when the user asks to update, refresh, or re-scrape FantasyPros rankings or ECR, when the rankings look stale or a new NFL week has started, or when a ranking set is reported missing or marked stale in the app.
---

# Update FantasyPros data

Scrapes five sets of half-PPR expert consensus rankings and writes them where the backend
reads them. Nothing else in the app fetches FantasyPros — this script is the only writer.

## Run it

```bash
backend/.venv/bin/python -m app.fantasypros
```

Takes ~50s: ten pages with a 5s crawl delay between them, per FantasyPros' robots.txt.
Exit code is 1 if any page failed. Output goes to `data/cache/fantasypros.json` (gitignored,
like every other cache file — do not commit it).

## The pages it scrapes

Every URL is `https://www.fantasypros.com/nfl/rankings/<slug>.php`, defined by `PAGES` in
`backend/app/fantasypros.py`. Row counts are from the week 2, 2026 run.

| Set | Key | URL | Rows | Experts |
|---|---|---|---|---|
| `weekly` | qb | https://www.fantasypros.com/nfl/rankings/qb.php | 72 | 65 |
| `weekly` | rb | https://www.fantasypros.com/nfl/rankings/half-point-ppr-rb.php | 122 | 65 |
| `weekly` | wr | https://www.fantasypros.com/nfl/rankings/half-point-ppr-wr.php | 195 | 65 |
| `weekly` | te | https://www.fantasypros.com/nfl/rankings/half-point-ppr-te.php | 125 | 65 |
| `weekly` | k | https://www.fantasypros.com/nfl/rankings/k.php | 33 | 35 |
| `weekly` | dst | https://www.fantasypros.com/nfl/rankings/dst.php | 32 | 37 |
| `ros` | overall | https://www.fantasypros.com/nfl/rankings/ros-half-point-ppr-overall.php | 408 | 6 |
| `ros_k` | k | https://www.fantasypros.com/nfl/rankings/ros-k.php | 38 | 4 |
| `ros_dst` | dst | https://www.fantasypros.com/nfl/rankings/ros-dst.php | 32 | 5 |
| `waiver` | overall | https://www.fantasypros.com/nfl/rankings/waiver-wire-half-point-ppr-overall.php | 47 | 12 |

Why each set exists:

- **weekly** — this week's start/sit view, one page per position. The K and D/ST pages cover
  only the current week, which is why the two ROS pages below exist.
- **ros** — one cross-position page. The rest-of-season value read, used on the roster views.
- **ros_k** / **ros_dst** — the standing view of a kicker or defence, read beside the Vegas line
  on the Streaming tab for the weeks past the one the weekly pages cover. Kept as their own
  sets, *not* as extra pages on `ros`: these rank within a position and `ros` ranks across all
  of them, so merging would leave one set whose `rank_ecr` means different things per row.
- **waiver** — the pickup shortlist only, ~50 rows, and the ordering behind the FantasyPros
  panel on the Waivers tab.

To add a page: append a `Page(set_name, key, slug)` to `PAGES`. A new set name also needs
adding to `SET_NAMES` or `indexes()` will not build an index for it.

## What it writes

`data/cache/fantasypros.json`:

```
fetched_at, fetched_at_iso, scoring: "HALF", errors: []
sets:
  weekly   6 pages (qb, rb, wr, te, k, dst) — ~580 players
  ros      1 page  (overall)                — ~410 players
  ros_k    1 page  (k)                      — ~38 players
  ros_dst  1 page  (dst)                    — 32 players
  waiver   1 page  (overall)                — ~50 players
```

Each player row: `sleeper_id`, `fantasypros_id`, `name`, `position`, `team`, `rank_ecr`,
`pos_rank`, `rank_min`, `rank_max`, `rank_ave`, `rank_std`, `tier`, `ecr_delta`, `owned_avg`,
`opponent`, `bye`, `note`. Positions and teams are in Sleeper's vocabulary (DEF not DST,
JAX not JAC), so rows join straight onto the rest of the app.

## Reading it from the app

```python
from .fantasypros import load, by_sleeper_id, ROS_POSITION_SETS

data = load()                            # None if never scraped
ros = by_sleeper_id(data, "ros")         # {sleeper_id: row}
row = ros.get(player_id)

by_sleeper_id(data, ROS_POSITION_SETS["DEF"])   # the ros_dst set
```

`rank_ecr` is **within-position** on any single-position page (all six weekly pages, `ros_k`,
`ros_dst`) and **overall** on the cross-position ones (`ros`, `waiver`). Compare `pos_rank`
across sets instead.

## Checking the result

A healthy run prints 100% matched for all five sets:

```
weekly: 579 players, 579 matched to Sleeper (100%)
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
