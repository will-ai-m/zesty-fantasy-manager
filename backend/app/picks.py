"""What you mean to do, in JSON files: the K and D/ST you want to start in each league, and the
waiver claims you intend to put in. Every platform's public API is read-only here, so nothing in
this module touches a league — the moves are yours to make, these are the notes."""
from __future__ import annotations

import asyncio
import json
import time
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field


class PickIn(BaseModel):
    """The K or D/ST you want in one league for one week. Intent only: a pick carries no add, drop
    or bid, because whether it still needs a move is read off the rosters each time it is shown
    rather than recorded here."""
    league_id: str
    position: Literal["K", "DEF"]
    week: int = Field(ge=1, le=18)
    player_id: str


class Pick(PickIn):
    season: str
    updated_at: float


class WaiverPlanIn(BaseModel):
    """A claim you mean to put in: the player, in which league, for which week's run. `bid` is the
    FAAB you plan to spend and `drop_player_id` who you would drop for him, both optional — a plan
    is worth keeping before either is settled. Whether he is still available is read off the pool
    each time it is shown, never stored."""
    league_id: str
    week: int = Field(ge=1, le=18)
    player_id: str
    bid: int | None = Field(default=None, ge=0)
    drop_player_id: str | None = None


class WaiverPlan(WaiverPlanIn):
    season: str
    updated_at: float


class JsonStore:
    def __init__(self, path: Path):
        self.path = path
        self.lock = asyncio.Lock()

    def _read(self) -> list[dict]:
        if not self.path.exists():
            return []
        return json.loads(self.path.read_text() or "[]")

    def _write(self, rows: list[dict]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(rows, indent=2))
        tmp.replace(self.path)


class PickStore(JsonStore):
    """Streaming picks, at most one per league, position and week: picking another unit replaces
    the pick rather than adding a second. Keyed by season too, so week 3 of next year starts empty."""

    @staticmethod
    def _key(p: dict) -> tuple:
        return p["season"], p["league_id"], p["position"], p["week"]

    async def list(self, season: str) -> list[Pick]:
        async with self.lock:
            return [Pick(**p) for p in self._read() if p["season"] == season]

    async def set(self, season: str, data: PickIn) -> None:
        async with self.lock:
            pick = Pick(season=season, updated_at=time.time(), **data.model_dump()).model_dump()
            self._write([p for p in self._read() if self._key(p) != self._key(pick)] + [pick])

    async def clear(self, season: str, league_id: str, position: str, week: int) -> None:
        async with self.lock:
            key = (season, league_id, position, week)
            self._write([p for p in self._read() if self._key(p) != key])


class WaiverPlanStore(JsonStore):
    """Planned claims, at most one per league, week and player — planning the same man twice is
    the same plan, so a second call updates the first rather than adding a row. Keyed by season
    too, so next year starts empty."""

    @staticmethod
    def _key(p: dict) -> tuple:
        return p["season"], p["league_id"], p["week"], p["player_id"]

    async def list(self, season: str) -> list[WaiverPlan]:
        async with self.lock:
            return [WaiverPlan(**p) for p in self._read() if p["season"] == season]

    async def set(self, season: str, data: WaiverPlanIn) -> None:
        """Upsert, merging on the fields actually sent: a page that only changes the bid leaves
        the drop alone, and vice versa, so two edits in flight cannot undo one another."""
        async with self.lock:
            sent = data.model_dump(exclude_unset=True)
            rows = self._read()
            plan = WaiverPlan(season=season, updated_at=time.time(), **data.model_dump()).model_dump()
            key = self._key(plan)
            existing = next((p for p in rows if self._key(p) == key), None)
            if existing:
                plan = {**existing, **sent, "updated_at": plan["updated_at"]}
            self._write([p for p in rows if self._key(p) != key] + [plan])

    async def clear(self, season: str, league_id: str, week: int, player_id: str) -> None:
        async with self.lock:
            key = (season, league_id, week, player_id)
            self._write([p for p in self._read() if self._key(p) != key])
