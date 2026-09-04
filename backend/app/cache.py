"""Tiny TTL cache: in-memory for everything, optional JSON-on-disk for large or slow-changing payloads."""
from __future__ import annotations

import asyncio
import json
import re
import time
from pathlib import Path
from typing import Any, Awaitable, Callable


def _safe(key: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]+", "_", key)


class Cache:
    def __init__(self, disk_dir: Path):
        self.disk_dir = disk_dir
        self.disk_dir.mkdir(parents=True, exist_ok=True)
        self._mem: dict[str, tuple[float, Any]] = {}
        self._locks: dict[str, asyncio.Lock] = {}

    async def get(self, key: str, ttl: float, loader: Callable[[], Awaitable[Any]], disk: bool = False) -> Any:
        now = time.time()
        hit = self._mem.get(key)
        if hit and hit[0] > now:
            return hit[1]
        lock = self._locks.setdefault(key, asyncio.Lock())
        async with lock:
            hit = self._mem.get(key)
            if hit and hit[0] > now:
                return hit[1]
            path = self.disk_dir / f"{_safe(key)}.json"
            if disk and path.exists():
                age = now - path.stat().st_mtime
                if age < ttl:
                    value = json.loads(path.read_text())
                    self._mem[key] = (now + (ttl - age), value)
                    return value
            value = await loader()
            self._mem[key] = (now + ttl, value)
            if disk:
                tmp = path.with_suffix(".tmp")
                tmp.write_text(json.dumps(value))
                tmp.replace(path)
            return value

    def invalidate(self, prefix: str = "") -> None:
        for k in [k for k in self._mem if k.startswith(prefix)]:
            del self._mem[k]
