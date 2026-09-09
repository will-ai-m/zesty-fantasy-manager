"""FantasyPros expert consensus rankings (ECR).

Scraped from the public rankings pages, each of which embeds its whole ranking table as a
`var ecrData = {...}` blob in the HTML. There is no free machine-readable alternative: the
official API (api.fantasypros.com) serves sample data without a paid key, and every /api/,
/ajax/ and /json/ path answers 403 and is robots-disallowed. The rankings pages themselves
are allowed; robots.txt asks for Crawl-delay: 5, which `_fetch` honours.

Nothing here runs during a request. `python -m app.fantasypros` scrapes the pages and writes
data/cache/fantasypros.json; the app reads that file with `load()`.

Three sets, and `rank_ecr` does not mean the same thing in each:
  weekly  one page per position, so rank_ecr is the rank *within* that position (Lamar = 1).
          80ish experts. Half PPR for RB/WR/TE; QB/K/DST have no PPR variant.
  ros     one cross-position page, so rank_ecr is the *overall* rank (Lamar = 36). 3 experts.
  waiver  one cross-position page of pickup candidates only, ~57 rows, 4 experts.
`pos_rank` ("QB1") is the within-position rank in every set and is the safer field to compare.
"""
from __future__ import annotations

import asyncio
import json
import re
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

import httpx

from .cache import Cache
from .config import DATA_DIR
from .ids import FP_TEAM_ALIASES, Crosswalk, load_nflverse_ids
from .sleeper import Sleeper

BASE = "https://www.fantasypros.com/nfl/rankings"
CACHE_FILE = "fantasypros.json"
CRAWL_DELAY = 5.0  # robots.txt
# The pages 403 a default client; they render for anything that looks like a browser.
USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
)
ECR_RE = re.compile(r"var ecrData = (\{.*?\});\s*\n", re.DOTALL)
# A live page returns dozens to hundreds of rows. A handful means the page rendered but the
# table was withheld (FantasyPros paywalls a ranking set from time to time).
MIN_ROWS = 5

FP_POSITIONS = {"DST": "DEF"}


@dataclass(frozen=True)
class Page:
    set_name: str  # weekly | ros | waiver
    key: str  # unique within the set
    slug: str


# Weekly is per position: one page each, covering every rostered player.
# ROS and waiver are single cross-position pages.
PAGES: tuple[Page, ...] = (
    Page("weekly", "qb", "qb"),
    Page("weekly", "rb", "half-point-ppr-rb"),
    Page("weekly", "wr", "half-point-ppr-wr"),
    Page("weekly", "te", "half-point-ppr-te"),
    Page("weekly", "k", "k"),
    Page("weekly", "dst", "dst"),
    Page("ros", "overall", "ros-half-point-ppr-overall"),
    Page("waiver", "overall", "waiver-wire-half-point-ppr-overall"),
)


def _num(v: Any) -> float | None:
    if v in (None, "", "-"):
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _int(v: Any) -> int | None:
    n = _num(v)
    return int(n) if n is not None else None


def _row(p: dict, crosswalk: Crosswalk) -> dict:
    """One ecrData player -> our shape, in Sleeper's position/team vocabulary."""
    position = FP_POSITIONS.get(p.get("player_position_id"), p.get("player_position_id"))
    team = p.get("player_team_id") or None
    if team == "FA":
        team = None
    if team:
        team = FP_TEAM_ALIASES.get(team, team)
    fp_id = _int(p.get("player_id"))
    return {
        "sleeper_id": crosswalk.from_fantasypros(fp_id, p.get("player_name"), position, team),
        "fantasypros_id": fp_id,
        "name": p.get("player_name"),
        "position": position,
        "team": team,
        "rank_ecr": _int(p.get("rank_ecr")),
        "pos_rank": p.get("pos_rank") or None,
        "rank_min": _int(p.get("rank_min")),
        "rank_max": _int(p.get("rank_max")),
        "rank_ave": _num(p.get("rank_ave")),
        # Spread of expert opinion. The one signal here that projections don't already give us.
        "rank_std": _num(p.get("rank_std")),
        # Both of these are in the payload but have been null all preseason; they are expected
        # to fill in once there is a prior week to diff against. Carried through as-is.
        "tier": _int(p.get("tier")),
        "ecr_delta": _int(p.get("player_ecr_delta")),
        "owned_avg": _num(p.get("player_owned_avg")),
        "opponent": p.get("player_opponent") or None,
        "bye": _int(p.get("player_bye_week")),
        "note": p.get("note") or None,
    }


async def _fetch(http: httpx.AsyncClient, page: Page) -> dict:
    url = f"{BASE}/{page.slug}.php"
    r = await http.get(url)
    r.raise_for_status()
    m = ECR_RE.search(r.text)
    if not m:
        raise ValueError(f"no ecrData block at {url} (page structure changed?)")
    data = json.loads(m.group(1))
    rows = data.get("players") or []
    if len(rows) < MIN_ROWS:
        raise ValueError(f"only {len(rows)} rows at {url} (paywalled?)")
    return {"url": url, "data": data}


def _page_payload(page: Page, fetched: dict, crosswalk: Crosswalk) -> dict:
    data = fetched["data"]
    players = [_row(p, crosswalk) for p in data["players"]]
    return {
        "key": page.key,
        "url": fetched["url"],
        "scoring": data.get("scoring"),
        "week": _int(data.get("week")),
        "type": data.get("type"),
        "experts": _int(data.get("total_experts")),
        "last_updated": data.get("last_updated"),
        "count": len(players),
        "matched": sum(1 for p in players if p["sleeper_id"]),
        "stale_since": None,
        "players": players,
    }


def _carry_forward(previous: dict | None, set_name: str, key: str, error: str) -> dict | None:
    """Keep the last good rows for a page that failed this run, marked stale, rather than
    blanking the app's data on one bad fetch."""
    if not previous:
        return None
    old = ((previous.get("sets") or {}).get(set_name) or {}).get("pages", {}).get(key)
    if not old:
        return None
    carried = dict(old)
    carried["stale_since"] = old.get("stale_since") or previous.get("fetched_at")
    carried["error"] = error
    return carried


async def scrape(pages: Iterable[Page] = PAGES, data_dir: Path = DATA_DIR) -> dict:
    """Fetch every page, join to Sleeper ids, and write data/cache/fantasypros.json."""
    cache = Cache(data_dir / "cache")
    sleeper = Sleeper(cache)
    try:
        players, nflverse = await asyncio.gather(sleeper.players(), load_nflverse_ids(cache))
    finally:
        await sleeper.aclose()
    crosswalk = Crosswalk(players, nflverse)

    path = data_dir / "cache" / CACHE_FILE
    previous = json.loads(path.read_text()) if path.exists() else None

    sets: dict[str, dict] = {}
    errors: list[str] = []
    async with httpx.AsyncClient(
        timeout=httpx.Timeout(60.0, connect=15.0), headers={"User-Agent": USER_AGENT}, follow_redirects=True
    ) as http:
        for i, page in enumerate(pages):
            if i:
                await asyncio.sleep(CRAWL_DELAY)
            bucket = sets.setdefault(page.set_name, {"pages": {}})
            try:
                payload = _page_payload(page, await _fetch(http, page), crosswalk)
                print(f"  {page.set_name}/{page.key}: {payload['count']} players, "
                      f"{payload['matched']} matched, {payload['experts']} experts")
            except (httpx.HTTPError, ValueError, json.JSONDecodeError) as exc:
                error = f"{type(exc).__name__}: {exc}"
                errors.append(f"{page.set_name}/{page.key}: {error}")
                carried = _carry_forward(previous, page.set_name, page.key, error)
                if carried is None:
                    print(f"  {page.set_name}/{page.key}: FAILED ({error})", file=sys.stderr)
                    continue
                print(f"  {page.set_name}/{page.key}: FAILED ({error}) — kept previous rows, marked stale",
                      file=sys.stderr)
                payload = carried
            bucket["pages"][page.key] = payload

    now = time.time()
    out = {
        "fetched_at": now,
        "fetched_at_iso": datetime.fromtimestamp(now, timezone.utc).isoformat(timespec="seconds"),
        "source": "fantasypros.com public rankings pages (embedded ecrData)",
        "scoring": "HALF",
        "sets": sets,
        "errors": errors,
    }
    for name, bucket in sets.items():
        pages_ = bucket["pages"].values()
        bucket["count"] = sum(p["count"] for p in pages_)
        bucket["matched"] = sum(p["matched"] for p in pages_)
        weeks = {p["week"] for p in pages_ if p.get("week")}
        bucket["week"] = min(weeks) if weeks else None

    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(out, indent=1))
    tmp.replace(path)
    return out


def load(data_dir: Path = DATA_DIR) -> dict | None:
    """Read the scraped rankings. None if `python -m app.fantasypros` has never run."""
    path = data_dir / "cache" / CACHE_FILE
    if not path.exists():
        return None
    return json.loads(path.read_text())


def by_sleeper_id(data: dict | None, set_name: str) -> dict[str, dict]:
    """{sleeper_id: row} for one ranking set. Unmatched players are dropped; where two pages
    of a set rank the same player (they don't today), the better ECR wins."""
    out: dict[str, dict] = {}
    if not data:
        return out
    for page in ((data.get("sets") or {}).get(set_name) or {}).get("pages", {}).values():
        for row in page["players"]:
            pid = row.get("sleeper_id")
            if not pid:
                continue
            cur = out.get(pid)
            if cur is None or (row.get("rank_ecr") or 9999) < (cur.get("rank_ecr") or 9999):
                out[pid] = row
    return out


if __name__ == "__main__":
    print("Scraping FantasyPros rankings (half PPR)...")
    result = asyncio.run(scrape())
    for name, bucket in result["sets"].items():
        print(f"{name}: {bucket['count']} players, {bucket['matched']} matched to Sleeper "
              f"({100 * bucket['matched'] // max(bucket['count'], 1)}%)")
    print(f"Wrote {DATA_DIR / 'cache' / CACHE_FILE} at {result['fetched_at_iso']}")
    if result["errors"]:
        print(f"{len(result['errors'])} page(s) failed:", file=sys.stderr)
        for e in result["errors"]:
            print(f"  {e}", file=sys.stderr)
        sys.exit(1)


def indexes(data: dict | None) -> dict[str, dict[str, dict]]:
    """{set_name: {sleeper_id: row}} for all three sets."""
    return {name: by_sleeper_id(data, name) for name in ("weekly", "ros", "waiver")}


def experts(data: dict | None, set_name: str, position: str | None = None) -> int | None:
    """Expert count behind a set. Weekly is per-position pages, so it varies (49 for K,
    ~80 for skill positions); ros and waiver each have a single page."""
    if not data:
        return None
    pages = ((data.get("sets") or {}).get(set_name) or {}).get("pages") or {}
    if set_name == "weekly" and position:
        page = pages.get({"DEF": "dst"}.get(position, position.lower()))
        return page.get("experts") if page else None
    return next((p.get("experts") for p in pages.values()), None)
