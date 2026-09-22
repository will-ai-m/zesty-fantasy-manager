"""Streaming picks: the K and D/ST you mean to start in each league, tracked in a JSON file.
Every platform's public API is read-only here, so nothing in this module touches a league."""
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
