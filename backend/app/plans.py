"""Moves planner: adds/drops/bids you intend to make in Sleeper, tracked in a JSON file.
Sleeper's public API is read-only, so nothing here touches Sleeper."""
from __future__ import annotations

import asyncio
import json
import time
import uuid
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field

PlanStatus = Literal["planned", "done", "skipped"]


class PlanIn(BaseModel):
    league_id: str
    add_player_id: str | None = None
    drop_player_id: str | None = None
    bid: int | None = Field(default=None, ge=0)
    note: str = ""
    target_week: int | None = None


class PlanPatch(BaseModel):
    add_player_id: str | None = None
    drop_player_id: str | None = None
    bid: int | None = Field(default=None, ge=0)
    note: str | None = None
    status: PlanStatus | None = None
    target_week: int | None = None


class Plan(PlanIn):
    id: str
    status: PlanStatus = "planned"
    created_at: float
    updated_at: float


class PlanStore:
    def __init__(self, path: Path):
        self.path = path
        self.lock = asyncio.Lock()

    def _read(self) -> list[dict]:
        if not self.path.exists():
            return []
        return json.loads(self.path.read_text() or "[]")

    def _write(self, plans: list[dict]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(plans, indent=2))
        tmp.replace(self.path)

    async def list(self) -> list[Plan]:
        async with self.lock:
            return [Plan(**p) for p in self._read()]

    async def create(self, data: PlanIn) -> Plan:
        async with self.lock:
            plans = self._read()
            now = time.time()
            plan = Plan(id=uuid.uuid4().hex[:12], created_at=now, updated_at=now, **data.model_dump())
            plans.append(plan.model_dump())
            self._write(plans)
            return plan

    async def patch(self, plan_id: str, data: PlanPatch) -> Plan | None:
        async with self.lock:
            plans = self._read()
            for i, p in enumerate(plans):
                if p["id"] == plan_id:
                    updates = {k: v for k, v in data.model_dump().items() if v is not None}
                    # Allow explicitly clearing the drop/bid by sending empty string / -1? Keep simple: None means "no change".
                    p.update(updates)
                    p["updated_at"] = time.time()
                    plans[i] = p
                    self._write(plans)
                    return Plan(**p)
            return None

    async def delete(self, plan_id: str) -> bool:
        async with self.lock:
            plans = self._read()
            new = [p for p in plans if p["id"] != plan_id]
            if len(new) == len(plans):
                return False
            self._write(new)
            return True
