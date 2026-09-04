"""Async Sleeper API client. Read-only. Documented endpoints live under /v1; the stats,
projections, research, schedule, depth-chart and injury endpoints are the undocumented
ones the Sleeper app itself uses (see docs/research/sleeper-api.md)."""
from __future__ import annotations

from typing import Any

import httpx

from .cache import Cache
from .config import FANTASY_POSITIONS, SPORT

MIN = 60
HOUR = 3600
DAY = 86400


class Sleeper:
    BASE = "https://api.sleeper.app"

    def __init__(self, cache: Cache):
        self.cache = cache
        self.http = httpx.AsyncClient(
            base_url=self.BASE,
            timeout=httpx.Timeout(60.0, connect=15.0),
            headers={"User-Agent": "zesty-fantasy-manager/0.1 (personal, non-commercial)"},
        )

    async def aclose(self) -> None:
        await self.http.aclose()

    async def _get(self, path: str, params: dict[str, Any] | None = None) -> Any:
        r = await self.http.get(path, params=params)
        r.raise_for_status()
        return r.json()

    # ---- documented -------------------------------------------------------
    async def state(self) -> dict:
        return await self.cache.get("state", 5 * MIN, lambda: self._get(f"/v1/state/{SPORT}"))

    async def user(self, username_or_id: str) -> dict:
        return await self.cache.get(f"user:{username_or_id}", DAY, lambda: self._get(f"/v1/user/{username_or_id}"))

    async def user_leagues(self, user_id: str, season: str) -> list[dict]:
        return await self.cache.get(
            f"user_leagues:{user_id}:{season}", 10 * MIN,
            lambda: self._get(f"/v1/user/{user_id}/leagues/{SPORT}/{season}"),
        )

    async def league(self, league_id: str) -> dict:
        return await self.cache.get(f"league:{league_id}", 5 * MIN, lambda: self._get(f"/v1/league/{league_id}"))

    async def rosters(self, league_id: str) -> list[dict]:
        return await self.cache.get(f"rosters:{league_id}", 1 * MIN, lambda: self._get(f"/v1/league/{league_id}/rosters"))

    async def users(self, league_id: str) -> list[dict]:
        return await self.cache.get(f"users:{league_id}", 10 * MIN, lambda: self._get(f"/v1/league/{league_id}/users"))

    async def matchups(self, league_id: str, week: int) -> list[dict]:
        return await self.cache.get(
            f"matchups:{league_id}:{week}", 1 * MIN, lambda: self._get(f"/v1/league/{league_id}/matchups/{week}")
        )

    async def transactions(self, league_id: str, week: int) -> list[dict]:
        return await self.cache.get(
            f"transactions:{league_id}:{week}", 1 * MIN,
            lambda: self._get(f"/v1/league/{league_id}/transactions/{week}"),
        )

    async def players(self) -> dict[str, dict]:
        """Full player database (~15 MB). Sleeper asks for at most one fetch per day."""
        return await self.cache.get("players", DAY, lambda: self._get(f"/v1/players/{SPORT}"), disk=True)

    async def trending(self, kind: str, lookback_hours: int = 24, limit: int = 100) -> list[dict]:
        # The endpoint caps results at 100 regardless of `limit`.
        return await self.cache.get(
            f"trending:{kind}:{lookback_hours}", 5 * MIN,
            lambda: self._get(f"/v1/players/{SPORT}/trending/{kind}", {"lookback_hours": lookback_hours, "limit": limit}),
        )

    # ---- undocumented (used by the Sleeper app) -----------------------------
    def _pos_params(self, extra: dict[str, Any]) -> dict[str, Any]:
        return {"season_type": "regular", "position[]": list(FANTASY_POSITIONS), **extra}

    async def projections(self, season: str, week: int) -> list[dict]:
        return await self.cache.get(
            f"projections:{season}:{week}", 30 * MIN,
            lambda: self._get(f"/projections/{SPORT}/{season}/{week}", self._pos_params({"order_by": "pts_half_ppr"})),
        )

    async def stats(self, season: str, week: int, final: bool = False) -> list[dict]:
        """Weekly actuals. `final=True` means the week is over, so cache to disk for a day."""
        return await self.cache.get(
            f"stats:{season}:{week}", DAY if final else 10 * MIN,
            lambda: self._get(f"/stats/{SPORT}/{season}/{week}", self._pos_params({"order_by": "pts_half_ppr"})),
            disk=final,
        )

    async def player_projections(self, player_id: str, season: str) -> dict:
        return await self.cache.get(
            f"pproj:{player_id}:{season}", 30 * MIN,
            lambda: self._get(f"/projections/{SPORT}/player/{player_id}", {"season": season, "season_type": "regular", "grouping": "week"}),
        )

    async def player_stats(self, player_id: str, season: str) -> dict:
        return await self.cache.get(
            f"pstats:{player_id}:{season}", 10 * MIN,
            lambda: self._get(f"/stats/{SPORT}/player/{player_id}", {"season": season, "season_type": "regular", "grouping": "week"}),
        )

    async def research(self, season: str, week: int) -> dict[str, dict]:
        """Sleeper-wide % rostered / % started: {player_id: {owned, started}}."""
        return await self.cache.get(
            f"research:{season}:{week}", 10 * MIN,
            lambda: self._get(f"/players/{SPORT}/research/regular/{season}/{week}"),
        )

    async def schedule(self, season: str, season_type: str = "regular") -> list[dict]:
        return await self.cache.get(
            f"schedule:{season}:{season_type}", HOUR,
            lambda: self._get(f"/schedule/{SPORT}/{season_type}/{season}"),
        )

    async def injuries(self) -> dict[str, dict]:
        return await self.cache.get("injuries", 10 * MIN, lambda: self._get(f"/players/{SPORT}/injuries"))

    async def depth_chart(self, team: str) -> dict[str, list[str]]:
        return await self.cache.get(f"depth:{team}", HOUR, lambda: self._get(f"/players/{SPORT}/{team}/depth_chart"))
