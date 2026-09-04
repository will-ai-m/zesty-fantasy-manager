"""FantasyPros expert consensus rankings (ECR), read from the public rankings pages.

Every rankings page renders its table from a `var ecrData = {...}` blob in the HTML, so one GET
per page gives the same rows the site shows: ECR, min/max/std, tier, position rank, weekly
opponent, ownership and the expert's note. See research/fantasypros-and-other-sources.md §B.

Read-only, one page at a time, browser User-Agent, robots.txt's `Crawl-delay: 5` respected
between fetches (the rankings pages themselves are allowed; /api/, /json/ and /ajax/ are not,
and are not used). Personal, non-commercial use — FantasyPros asks that you not republish.
"""
from __future__ import annotations

import asyncio
import json
import re
import time
from typing import Any

import httpx

from .cache import Cache

MIN = 60
HOUR = 3600

ECR_RE = re.compile(r"var\s+ecrData\s*=\s*")
POS_RANK_RE = re.compile(r"(\d+)\s*$")

# Half PPR / PPR / standard variants of the same page. QB, K and DST pages have no scoring variant.
SCORING_SLUG = {"PPR": "ppr-", "HALF": "half-point-ppr-", "STD": ""}
UNSCORED = {"qb", "k", "dst"}
KIND_TTL = {"weekly": 20 * MIN, "ros": 3 * HOUR, "waiver": 20 * MIN}

# FantasyPros team abbreviations that differ from Sleeper's.
TEAM_ALIASES = {"JAC": "JAX", "LA": "LAR", "WSH": "WAS", "OAK": "LV", "SD": "LAC", "STL": "LAR"}
# ecrData spells D/ST as DST; Sleeper calls the position DEF.
POSITION_ALIASES = {"DST": "DEF"}


class FantasyProsError(RuntimeError):
    """A rankings page could not be fetched or did not contain ecrData (e.g. it is paywalled)."""


def scoring_key(rec_points: float | None) -> str:
    """League scoring_settings['rec'] -> the FantasyPros page variant."""
    rec = float(rec_points or 0)
    return "PPR" if rec >= 1 else ("HALF" if rec > 0 else "STD")


def page_url(kind: str, position: str, scoring: str, week: int | None = None) -> str:
    """kind: weekly | ros | waiver. position: qb|rb|wr|te|flex|k|dst|overall."""
    pos = position.lower()
    slug = "" if pos in UNSCORED else SCORING_SLUG[scoring]
    if kind == "weekly":
        name = f"{slug}{pos}"
    elif kind == "ros":
        name = f"ros-{slug}{pos}"
    elif kind == "waiver":
        name = f"waiver-wire-{slug}{pos}"
    else:
        raise ValueError(f"unknown rankings kind: {kind}")
    url = f"https://www.fantasypros.com/nfl/rankings/{name}.php"
    return f"{url}?week={week}" if kind == "weekly" and week else url


def _int(x: Any) -> int | None:
    try:
        return int(float(x))
    except (TypeError, ValueError):
        return None


def _float(x: Any) -> float | None:
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


def parse_pos_rank(pos_rank: Any) -> int | None:
    """'RB12' -> 12."""
    m = POS_RANK_RE.search(str(pos_rank or ""))
    return int(m.group(1)) if m else None


def parse_ecr(html: str) -> dict:
    """Pull `var ecrData = {...};` out of a rankings page and normalize it.

    The object is read with a JSON decoder rather than matched to a closing brace, so nothing on
    the rest of the line can confuse it."""
    m = ECR_RE.search(html)
    start = html.find("{", m.end()) if m else -1
    if start < 0:
        hint = " (page looks paywalled)" if re.search(r"premium|locked", html, re.I) else ""
        raise FantasyProsError(f"no ecrData in page{hint}")
    try:
        data, _ = json.JSONDecoder().raw_decode(html, start)
    except json.JSONDecodeError as e:
        raise FantasyProsError(f"ecrData did not parse: {e}") from e
    players = [_player(p) for p in data.get("players") or []]
    return {
        "scoring": data.get("scoring"),
        "type": data.get("type"),
        "week": _int(data.get("week")),
        "year": _int(data.get("year")),
        "position": (data.get("position_id") or "").upper() or None,
        "total_experts": _int(data.get("total_experts")),
        "last_updated": data.get("last_updated"),
        "count": len(players),
        "players": [p for p in players if p["fp_id"]],
    }


def _player(p: dict) -> dict:
    team = (p.get("player_team_id") or "").strip().upper()
    pos = (p.get("player_position_id") or "").strip().upper()
    return {
        "fp_id": str(p.get("player_id") or "").strip(),
        "name": p.get("player_name"),
        "team": TEAM_ALIASES.get(team, team) or None,
        "position": POSITION_ALIASES.get(pos, pos) or None,
        "rank": _int(p.get("rank_ecr")),
        "pos_rank": p.get("pos_rank") or None,
        "pos_rank_n": parse_pos_rank(p.get("pos_rank")),
        "rank_min": _int(p.get("rank_min")),
        "rank_max": _int(p.get("rank_max")),
        "rank_std": _float(p.get("rank_std")),
        "tier": _int(p.get("tier")),
        "ecr_delta": _float(p.get("player_ecr_delta")),
        "owned_avg": _float(p.get("player_owned_avg")),
        "opponent": p.get("player_opponent") or None,
        "bye": _int(p.get("player_bye_week")),
        "note": (p.get("note") or "").strip() or None,
        "recommendation": (p.get("recommendation") or "").strip() or None,
        "tag": (p.get("tag") or "").strip() or None,
    }


class FantasyPros:
    def __init__(self, cache: Cache, delay: float = 5.0, enabled: bool = True):
        self.cache = cache
        self.delay = delay
        self.enabled = enabled
        self._gate = asyncio.Lock()
        self._last_fetch = 0.0
        self.http = httpx.AsyncClient(
            timeout=httpx.Timeout(45.0, connect=15.0),
            follow_redirects=True,
            headers={
                # The pages return the mobile shell (no ecrData) to unknown agents.
                "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
                              "(KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
                "Accept": "text/html,application/xhtml+xml",
                "Accept-Language": "en-US,en;q=0.9",
            },
        )

    async def aclose(self) -> None:
        await self.http.aclose()

    async def _fetch(self, url: str) -> dict:
        async with self._gate:  # one page at a time, Crawl-delay apart
            wait = self.delay - (time.monotonic() - self._last_fetch)
            if wait > 0:
                await asyncio.sleep(wait)
            try:
                r = await self.http.get(url)
                r.raise_for_status()
            except httpx.HTTPError as e:
                raise FantasyProsError(f"{url}: {e}") from e
            finally:
                self._last_fetch = time.monotonic()
        return {**parse_ecr(r.text), "url": url, "fetched_at": time.time()}

    async def rankings(self, kind: str, position: str, scoring: str = "HALF", week: int | None = None) -> dict:
        """One rankings page, cached (weekly 20 min, waiver 20 min, rest-of-season 3h)."""
        if not self.enabled:
            raise FantasyProsError("FantasyPros is disabled (ZFM_FANTASYPROS=off)")
        url = page_url(kind, position, scoring, week)
        key = f"fp:{kind}:{position.lower()}:{scoring}:{week or 0}"
        return await self.cache.get(key, KIND_TTL.get(kind, 20 * MIN), lambda: self._fetch(url), disk=True)

    async def board(self, kind: str, positions: tuple[str, ...], scoring: str = "HALF", week: int | None = None) -> tuple[dict[str, dict], list[str]]:
        """Several pages at once. Returns (position -> page, errors); a page that fails is skipped
        rather than failing the whole request."""
        results = await asyncio.gather(*(self.rankings(kind, p, scoring, week) for p in positions), return_exceptions=True)
        pages: dict[str, dict] = {}
        errors: list[str] = []
        for pos, res in zip(positions, results):
            if isinstance(res, BaseException):
                errors.append(f"{kind} {pos}: {res}")
            else:
                pages[pos] = res
        return pages, errors
