"""Player news, and what a story means.

Sleeper's public GraphQL read endpoint aggregates RotoWire (with its analysis paragraph),
FantasyPros and RotoBaller, keyed by the same player ids used everywhere else in this app — the
same wire the paid feeds sell (research/player-news-apis.md). ESPN's fantasy news host carries the
same RotoWire stories and stands in if that query ever changes.

Items carry no category, so headlines are classified here with keyword rules: enough to answer
"is this an injury, and does it move somebody up a depth chart", which is what the app acts on.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import re
import time
from datetime import datetime
from pathlib import Path

import httpx

from .cache import Cache

MIN = 60
SLEEPER_GRAPHQL = "https://sleeper.com/graphql"
ESPN_NEWS = "https://site.web.api.espn.com/apis/fantasy/v2/games/ffl/news/players"
BATCH = 25
HOT_MS = 72 * 3600 * 1000

# (pattern, category, severity 0-3, direction). First match wins, so the decisive lines come first.
RULES: list[tuple[str, str, int, int]] = [
    (r"\b(torn|tears?|ruptur\w*|acl|achilles|season[- ]ending|out for the season|injured reserve|\bto ir\b|placed on ir)\b", "injury", 3, -1),
    (r"\b(ruled out|will (not|n't) play|won't play|declared out|out (for|on) (sunday|monday|thursday|week)|inactive)\b", "injury", 3, -1),
    (r"\b(suspend\w+)\b", "suspension", 3, -1),
    (r"\b(released|waived|cut by|traded (to|for)|dealt to|designated for)\b", "transaction", 2, 0),
    (r"\b(doubtful)\b", "injury", 2, -1),
    (r"\b(carted off|left the game|exits?|exited|did not return|leaves? (the )?game|undergo\w* surgery|surgery)\b", "injury", 3, -1),
    (r"\b(questionable|limited (practice|participant)|did not practice|dnp|missed practice|non[- ]participant)\b", "practice", 1, -1),
    (r"\b(injur\w+|sprain\w*|strain\w*|concussion|fracture\w*|hamstring|ankle|knee|shoulder|groin|quad|calf|hip)\b", "injury", 2, -1),
    (r"\b(named (the )?(starter|starting)|will start|takes over|starting (job|role)|promot\w+|first[- ]team|elevated|lead back|bell cow|workhorse|every[- ]down)\b", "depth", 2, 1),
    (r"\b(activated|cleared|returns?|returning|full (practice|participant)|expected to play|good to go|off the injury report|practicing)\b", "return", 1, 1),
    (r"\b(signed|claimed|promoted from|activated from|reinstated)\b", "transaction", 1, 0),
    (r"\b(targets?|carries|touches|snap (share|count)|usage|role|workload|red[- ]zone)\b", "usage", 1, 0),
]
COMPILED = [(re.compile(p, re.I), cat, sev, dirn) for p, cat, sev, dirn in RULES]


class NewsError(RuntimeError):
    """News could not be fetched from any provider."""


def classify(title: str | None, description: str | None = None) -> dict:
    text = f"{title or ''}. {description or ''}"
    for pattern, category, severity, direction in COMPILED:
        if pattern.search(text):
            return {"category": category, "severity": severity, "direction": direction}
    return {"category": "other", "severity": 0, "direction": 0}


def _item(source: str, source_key: str, player_id: str, published: int | None, meta: dict) -> dict:
    title = meta.get("title")
    description = meta.get("description")
    now_ms = time.time() * 1000
    return {
        "key": f"{source}:{source_key}",
        "source": source,
        "source_key": str(source_key),
        "player_id": player_id,
        "published": published,
        "title": title,
        "description": description,
        "analysis": meta.get("analysis"),
        "url": meta.get("url"),
        "hot": bool(published and now_ms - published <= HOT_MS),
        **classify(title, description),
    }


class SleeperNews:
    """Anonymous read against Sleeper's GraphQL endpoint, many players per request via aliases."""
    name = "sleeper"

    def __init__(self, http: httpx.AsyncClient):
        self.http = http

    async def fetch(self, player_ids: list[str], limit: int = 5) -> dict[str, list[dict]]:
        out: dict[str, list[dict]] = {}
        for start in range(0, len(player_ids), BATCH):
            chunk = player_ids[start:start + BATCH]
            fields = " ".join(
                f'a{i}: get_player_news(sport: "nfl", player_id: "{pid}", limit: {limit}) '
                "{ source source_key player_id published metadata }"
                for i, pid in enumerate(chunk)
            )
            r = await self.http.post(SLEEPER_GRAPHQL, json={"query": "{ %s }" % fields})
            r.raise_for_status()
            body = r.json()
            if body.get("errors") and not body.get("data"):
                raise NewsError(f"Sleeper GraphQL: {body['errors'][:1]}")
            for i, pid in enumerate(chunk):
                for raw in (body.get("data") or {}).get(f"a{i}") or []:
                    meta = raw.get("metadata") or {}
                    out.setdefault(raw.get("player_id") or pid, []).append(
                        _item(raw.get("source") or "sleeper", raw.get("source_key") or "", raw.get("player_id") or pid,
                              raw.get("published"), meta)
                    )
        return out


class EspnNews:
    """Fallback: ESPN's fantasy news feed. One player per request, keyed by ESPN athlete id."""
    name = "espn"

    def __init__(self, http: httpx.AsyncClient, espn_id_of: dict[str, int]):
        self.http = http
        self.espn_id_of = espn_id_of

    async def fetch(self, player_ids: list[str], limit: int = 5) -> dict[str, list[dict]]:
        targets = [(pid, self.espn_id_of[pid]) for pid in player_ids if pid in self.espn_id_of]
        sem = asyncio.Semaphore(6)

        async def one(pid: str, espn_id: int) -> tuple[str, list[dict]]:
            async with sem:
                r = await self.http.get(ESPN_NEWS, params={"playerId": espn_id, "days": 30, "limit": limit})
                r.raise_for_status()
            items = []
            for f in r.json().get("feed") or []:
                published = f.get("published")
                stamp = None
                if published:
                    try:
                        stamp = int(datetime.fromisoformat(published.replace("Z", "+00:00")).timestamp() * 1000)
                    except ValueError:
                        stamp = None
                items.append(_item("rotowire", str(f.get("id") or ""), pid, stamp, {
                    "title": f.get("headline"), "description": f.get("description"),
                    "analysis": f.get("story"), "url": ((f.get("links") or {}).get("mobile") or {}).get("href"),
                }))
            return pid, items

        results = await asyncio.gather(*(one(pid, eid) for pid, eid in targets), return_exceptions=True)
        out: dict[str, list[dict]] = {}
        for res in results:
            if not isinstance(res, BaseException):
                pid, items = res
                out[pid] = items
        return out


class News:
    """Primary provider with a fallback, cached, deduped by (source, story id)."""

    def __init__(self, cache: Cache, enabled: bool = True):
        self.cache = cache
        self.enabled = enabled
        self.http = httpx.AsyncClient(
            timeout=httpx.Timeout(45.0, connect=15.0),
            headers={"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
                                   "(KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
                     "Content-Type": "application/json"},
        )
        self.errors: list[str] = []

    async def aclose(self) -> None:
        await self.http.aclose()

    async def for_players(self, player_ids: list[str], espn_id_of: dict[str, int] | None = None, limit: int = 5) -> dict[str, list[dict]]:
        """player_id -> newest items first. Never raises: a dead provider yields no news and an
        entry in `self.errors`."""
        if not self.enabled or not player_ids:
            return {}
        ids = sorted(set(player_ids))
        digest = hashlib.sha1(",".join(ids).encode()).hexdigest()[:16]
        key = f"news:{limit}:{len(ids)}:{digest}"

        async def loader() -> dict[str, list[dict]]:
            providers: list = [SleeperNews(self.http)]
            if espn_id_of:
                providers.append(EspnNews(self.http, espn_id_of))
            errors = []
            for provider in providers:
                try:
                    return {"items": await provider.fetch(ids, limit), "provider": provider.name, "errors": errors}
                except (httpx.HTTPError, NewsError, ValueError) as e:
                    errors.append(f"{provider.name}: {e}")
            return {"items": {}, "provider": None, "errors": errors}

        result = await self.cache.get(key, 10 * MIN, loader, disk=True)
        self.errors = result.get("errors") or []
        items = result.get("items") or {}
        for rows in items.values():
            rows.sort(key=lambda i: -(i.get("published") or 0))
        return items


class SeenStore:
    """Which stories you have already dealt with, so the feed can show what is new."""

    def __init__(self, path: Path):
        self.path = path
        self.lock = asyncio.Lock()

    def _read(self) -> dict[str, float]:
        if not self.path.exists():
            return {}
        try:
            return json.loads(self.path.read_text() or "{}")
        except json.JSONDecodeError:
            return {}

    def _write(self, data: dict[str, float]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, indent=2))
        tmp.replace(self.path)

    async def all(self) -> dict[str, float]:
        async with self.lock:
            return self._read()

    async def ack(self, keys: list[str], seen: bool = True) -> dict[str, float]:
        async with self.lock:
            data = self._read()
            for key in keys:
                if seen:
                    data[key] = time.time()
                else:
                    data.pop(key, None)
            # Keep the file small: the newest 2,000 acknowledgements are plenty.
            if len(data) > 2000:
                data = dict(sorted(data.items(), key=lambda kv: -kv[1])[:2000])
            self._write(data)
            return data
