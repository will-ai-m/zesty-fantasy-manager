"""Deadlines: when waivers process, when a specific dropped player clears, and when a lineup locks.

Sleeper stores waiver timing as a weekday plus a bare hour with no timezone, so hours are read in
`ZFM_TIMEZONE` (default US Eastern). `waiver_day_of_week` is taken as 0 = Monday, matching the
league default of 2 = Wednesday.
"""
from __future__ import annotations

from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from .config import TIMEZONE

WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
ALL_DAYS = frozenset(range(7))
LOCKED_GAME_STATUSES = ("in_game", "complete", "final")


def zone() -> ZoneInfo:
    try:
        return ZoneInfo(TIMEZONE)
    except Exception:  # unknown zone name in .env
        return ZoneInfo("UTC")


def ms(dt: datetime | None) -> int | None:
    return None if dt is None else int(dt.timestamp() * 1000)


def _hour(settings: dict) -> int:
    for key in ("waiver_hour", "daily_waivers_hour"):
        v = settings.get(key)
        if v is not None:
            try:
                return max(0, min(23, int(v)))
            except (TypeError, ValueError):
                pass
    return 0


def run_days(settings: dict) -> frozenset[int]:
    """Weekdays (0 = Monday) waivers process on. Empty means the league has no scheduled run."""
    if settings.get("daily_waivers"):
        mask = settings.get("daily_waivers_days")
        if isinstance(mask, int) and mask > 0:
            # Assumed little-endian from Monday; a mask that decodes to nothing falls back to daily.
            days = {i for i in range(7) if mask >> i & 1}
            if days:
                return frozenset(days)
        return ALL_DAYS
    dow = settings.get("waiver_day_of_week")
    if dow is None:
        return frozenset()
    try:
        return frozenset({int(dow) % 7})
    except (TypeError, ValueError):
        return frozenset()


def next_runs(settings: dict, now: datetime, count: int = 3) -> list[datetime]:
    """The next `count` waiver processing times, in league-local time."""
    days = run_days(settings)
    if not days:
        return []
    tz = zone()
    hour = _hour(settings)
    start = now.astimezone(tz)
    out: list[datetime] = []
    day: date = start.date()
    for i in range(15):
        cur = day + timedelta(days=i)
        if cur.weekday() in days:
            when = datetime.combine(cur, time(hour), tzinfo=tz)
            if when > start:
                out.append(when)
                if len(out) == count:
                    break
    return out


def clears_at(dropped_at: datetime, settings: dict) -> datetime | None:
    """When a player dropped at `dropped_at` comes off waivers: the first processing run after his
    league's waiver_clear_days have elapsed."""
    clear_days = settings.get("waiver_clear_days")
    try:
        days = max(0, int(clear_days))
    except (TypeError, ValueError):
        days = 1
    eligible = dropped_at.astimezone(zone()) + timedelta(days=days)
    runs = next_runs(settings, eligible, count=1)
    return runs[0] if runs else eligible


def describe(settings: dict) -> str:
    """Short human label, e.g. 'Wed 00:00 ET · 2d clear' or 'Daily 03:00 ET'."""
    days = run_days(settings)
    if not days:
        return "No scheduled waiver run"
    hour = _hour(settings)
    tz_label = datetime.now(zone()).strftime("%Z")
    when = "Daily" if days == ALL_DAYS else " / ".join(WEEKDAYS[d] for d in sorted(days))
    clear = settings.get("waiver_clear_days")
    tail = f" · {clear}d clear" if clear else ""
    return f"{when} {hour:02d}:00 {tz_label}{tail}"


def kickoffs(games: list[dict], week: int) -> dict[str, dict]:
    """team -> {'date', 'status', 'locked'} for one week of the Sleeper schedule.

    Sleeper's schedule carries a date and a game status but no kickoff time, so a lineup is treated
    as locked once that team's game leaves `pre_game`."""
    out: dict[str, dict] = {}
    for g in games:
        try:
            if int(g.get("week")) != week:
                continue
        except (TypeError, ValueError):
            continue
        status = (g.get("status") or "").lower()
        info = {"date": g.get("date"), "status": status or None, "locked": status in LOCKED_GAME_STATUSES}
        for team in (g.get("home"), g.get("away")):
            if team:
                out[team] = info
    return out


def first_kickoff(kickoff_map: dict[str, dict]) -> str | None:
    """Earliest game date of the week that has not started yet."""
    dates = sorted({k["date"] for k in kickoff_map.values() if k.get("date") and not k["locked"]})
    return dates[0] if dates else None
