"""NFL schedule and Vegas lines for a week.

ESPN's public scoreboard is the primary source: no auth, per-week query, and — unlike the
nflverse CSV — it carries lines for weeks far ahead (verified 2026-09-08: nflverse had totals
only through ~week 5, ESPN through week 14+). Lookahead is the whole point for K/DST
streaming, so ESPN leads and nflverse backfills any game ESPN leaves without odds.

Sign convention here matches ESPN's: `spread` is the **home** team's line, so negative means
the home team is favoured. nflverse's `spread_line` is the opposite (home margin), and is
negated on the way in. Implied team totals follow from total and spread:
    home = total/2 - spread/2      away = total/2 + spread/2
"""
from __future__ import annotations

import csv
import io
from datetime import datetime
from typing import Any, Iterable
from zoneinfo import ZoneInfo

import httpx

from .cache import Cache
from .ids import ESPN_TEAM_ALIASES

ESPN_SCOREBOARD = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard"
NFLVERSE_GAMES = "https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv"
MIN = 60
HOUR = 3600
DAY = 86400
EASTERN = ZoneInfo("America/New_York")

# nflverse abbreviations that differ from Sleeper's. ESPN's only difference (WSH) is already
# covered by ids.ESPN_TEAM_ALIASES.
NFLVERSE_TEAM_ALIASES = {"LA": "LAR"}


def _f(v: Any) -> float | None:
    if v in (None, "", "NA"):
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _i(v: Any) -> int | None:
    n = _f(v)
    return int(n) if n is not None else None


def date_et(kickoff: str | None) -> str | None:
    """Kickoff's calendar day in the NFL's own timezone. A 8:15pm ET Monday kickoff is stamped
    Tuesday in UTC, so the raw ISO date would put half of Monday Night Football on the wrong day."""
    if not kickoff:
        return None
    try:
        return datetime.fromisoformat(kickoff.replace("Z", "+00:00")).astimezone(EASTERN).date().isoformat()
    except ValueError:
        return None


def today_et() -> str:
    return datetime.now(EASTERN).date().isoformat()


def implied(total: float | None, spread: float | None) -> tuple[float | None, float | None]:
    """(away, home) implied team totals. Both None unless we have a total and a spread."""
    if total is None or spread is None:
        return None, None
    return round(total / 2 + spread / 2, 2), round(total / 2 - spread / 2, 2)


class Odds:
    def __init__(self, cache: Cache):
        self.cache = cache
        # Deliberately no User-Agent override. ESPN's scoreboard host 403s both custom
        # agents and anything browser-shaped ("Mozilla/..."), but answers httpx's own default.
        # Verified 2026-09-08: python-httpx and curl get 200; a Chrome UA gets 403.
        self.http = httpx.AsyncClient(
            timeout=httpx.Timeout(30.0, connect=10.0),
            follow_redirects=True,
        )

    async def aclose(self) -> None:
        await self.http.aclose()

    # ---- sources ----------------------------------------------------------
    async def _espn(self, season: int, week: int) -> dict:
        async def loader() -> dict:
            r = await self.http.get(
                ESPN_SCOREBOARD, params={"dates": season, "seasontype": 2, "week": week}
            )
            r.raise_for_status()
            return r.json()
        return await self.cache.get(f"espn_scoreboard:{season}:{week}", 15 * MIN, loader)

    async def _nflverse(self) -> list[dict]:
        async def loader() -> list[dict]:
            r = await self.http.get(NFLVERSE_GAMES)
            r.raise_for_status()
            rows = []
            for row in csv.DictReader(io.StringIO(r.text)):
                rows.append({
                    k: row.get(k) for k in (
                        "season", "week", "away_team", "home_team", "gameday", "gametime",
                        "spread_line", "total_line", "away_moneyline", "home_moneyline",
                    )
                })
            return rows
        return await self.cache.get("nflverse_games", DAY, loader, disk=True)

    async def _nflverse_week(self, season: int, week: int) -> dict[tuple[str, str], dict]:
        rows = await self._nflverse()
        out: dict[tuple[str, str], dict] = {}
        for r in rows:
            if _i(r.get("season")) != season or _i(r.get("week")) != week:
                continue
            away = NFLVERSE_TEAM_ALIASES.get(r["away_team"], r["away_team"])
            home = NFLVERSE_TEAM_ALIASES.get(r["home_team"], r["home_team"])
            out[(away, home)] = r
        return out

    # ---- normalization ----------------------------------------------------
    @staticmethod
    def _team(abbrev: str | None) -> str | None:
        if not abbrev:
            return None
        return ESPN_TEAM_ALIASES.get(abbrev, abbrev)

    def _from_espn(self, event: dict) -> dict:
        comp = event["competitions"][0]
        sides = {c["homeAway"]: c for c in comp["competitors"]}
        home, away = sides.get("home", {}), sides.get("away", {})
        status = (event.get("status") or {}).get("type") or {}
        book = (comp.get("odds") or [{}])[0]
        spread, total = _f(book.get("spread")), _f(book.get("overUnder"))
        away_imp, home_imp = implied(total, spread)
        weather = event.get("weather") or {}
        home_abbr = self._team((home.get("team") or {}).get("abbreviation"))
        away_abbr = self._team((away.get("team") or {}).get("abbreviation"))
        favorite = None
        if spread is not None and spread != 0:
            favorite = home_abbr if spread < 0 else away_abbr
        return {
            "game_id": event.get("id"),
            "kickoff": event.get("date"),
            "date_et": date_et(event.get("date")),
            "state": status.get("state"),  # pre | in | post
            "status_detail": status.get("shortDetail"),
            "away": away_abbr,
            "home": home_abbr,
            "away_name": (away.get("team") or {}).get("displayName"),
            "home_name": (home.get("team") or {}).get("displayName"),
            "away_record": next((r.get("summary") for r in away.get("records") or []), None),
            "home_record": next((r.get("summary") for r in home.get("records") or []), None),
            "away_score": _i(away.get("score")),
            "home_score": _i(home.get("score")),
            "spread": spread,
            "favorite": favorite,
            "total": total,
            "away_moneyline": _i((book.get("awayTeamOdds") or {}).get("moneyLine")),
            "home_moneyline": _i((book.get("homeTeamOdds") or {}).get("moneyLine")),
            "away_implied": away_imp,
            "home_implied": home_imp,
            "odds_provider": (book.get("provider") or {}).get("name"),
            "odds_source": "espn" if spread is not None or total is not None else None,
            "venue": (comp.get("venue") or {}).get("fullName"),
            "broadcast": next((n for b in comp.get("broadcasts") or [] for n in b.get("names") or []), None),
            "weather": {"summary": weather.get("displayValue"), "temperature": _i(weather.get("temperature"))}
                       if weather.get("displayValue") else None,
        }

    def _from_nflverse(self, row: dict, away: str, home: str, season: int, week: int) -> dict:
        # nflverse spread_line is the home margin; ours is the home line.
        spread = _f(row.get("spread_line"))
        spread = -spread if spread is not None else None
        total = _f(row.get("total_line"))
        away_imp, home_imp = implied(total, spread)
        kickoff = None
        day, at = row.get("gameday"), row.get("gametime")
        if day and at:
            try:
                kickoff = (datetime.fromisoformat(f"{day}T{at}")
                           .replace(tzinfo=EASTERN).astimezone(ZoneInfo("UTC"))
                           .isoformat().replace("+00:00", "Z"))
            except ValueError:
                kickoff = None
        favorite = None
        if spread is not None and spread != 0:
            favorite = home if spread < 0 else away
        return {
            "game_id": f"nflverse:{season}-{week}-{away}-{home}",
            "kickoff": kickoff,
            "date_et": day or date_et(kickoff),
            "state": "pre",
            "status_detail": None,
            "away": away, "home": home,
            "away_name": None, "home_name": None,
            "away_record": None, "home_record": None,
            "away_score": None, "home_score": None,
            "spread": spread,
            "favorite": favorite,
            "total": total,
            "away_moneyline": _i(row.get("away_moneyline")),
            "home_moneyline": _i(row.get("home_moneyline")),
            "away_implied": away_imp,
            "home_implied": home_imp,
            "odds_provider": None,
            "odds_source": "nflverse" if total is not None else None,
            "venue": None, "broadcast": None, "weather": None,
        }

    # ---- public -----------------------------------------------------------
    async def week(self, season: int, week: int) -> dict:
        """Every game that week, chronological. ESPN for schedule + odds; nflverse backfills
        odds ESPN is missing, and stands in wholesale if ESPN is unreachable."""
        source = "espn"
        try:
            payload = await self._espn(season, week)
            games = [self._from_espn(e) for e in payload.get("events") or []]
        except (httpx.HTTPError, KeyError, ValueError):
            games, source = [], "nflverse"

        try:
            fallback = await self._nflverse_week(season, week)
        except (httpx.HTTPError, ValueError):
            fallback = {}

        if games:
            for g in games:
                row = fallback.get((g["away"], g["home"])) if fallback else None
                if not row:
                    continue
                filled = self._from_nflverse(row, g["away"], g["home"], season, week)
                if not g["odds_source"] and filled["odds_source"]:
                    g.update({k: filled[k] for k in (
                        "spread", "favorite", "total",
                        "away_implied", "home_implied", "odds_source",
                    )})
                # ESPN's scoreboard carries spread and total but no moneylines; nflverse has
                # them for weeks that are already priced.
                for k in ("away_moneyline", "home_moneyline"):
                    if g[k] is None and filled[k] is not None:
                        g[k] = filled[k]
        else:
            games = [self._from_nflverse(row, away, home, season, week)
                     for (away, home), row in fallback.items()]

        games.sort(key=lambda g: (g["kickoff"] is None, g["kickoff"] or "", g["away"] or ""))
        return {
            "season": season,
            "week": week,
            "today": today_et(),
            "source": source,
            "priced": sum(1 for g in games if g["odds_source"]),
            "games": games,
        }
