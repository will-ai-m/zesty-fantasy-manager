"""Team-level offensive efficiency, from ESPN's public core API.

This exists for the kicker view. A kicker's week is decided almost entirely by what the offence
in front of him does, and "how many points will they score" — the Vegas implied total — is a poor
proxy on its own, because it cannot tell apart the two ways of scoring them. A team that punches
it in from the five hands its kicker a one-point extra point; a team that stalls at the twenty
hands him three. Same implied total, opposite weeks.

So the numbers here are the ones that separate those cases:

  rz_td_pct      share of red-zone trips ending in a touchdown. **Low is good for the kicker.**
  rz_fg_pct      share ending in a field-goal attempt. The same split read from the other side.
  third_pct      third-down conversion rate — sustained drives are drives that reach field-goal
                 range at all, so high is good.
  fourth_att     fourth-down attempts. Coaching aggressiveness: every fourth down a staff goes
                 for is a field goal the kicker did not attempt, so low is good.
  fg_*           the attempts themselves, split by distance, because leagues that pay more for
                 longer kicks make the distribution matter and not just the count.

Nothing here is folded into a ranking. It is surfaced as columns to be read.

**Sample size.** These are season-to-date rates, and `games` says how many games that is. Early
in a season a red-zone rate rests on three or four trips and will swing wildly; the column is
worth little until the sample builds. `games` travels with the numbers so the view can say so.
"""
from __future__ import annotations

import asyncio
from typing import Any

import httpx

from .cache import Cache
from .ids import ESPN_TEAM_ALIASES

TEAMS_URL = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams"
STATS_URL = ("https://sports.core.api.espn.com/v2/sports/football/leagues/nfl"
             "/seasons/{season}/types/2/teams/{team_id}/statistics")
HOUR = 3600
# ESPN answers httpx's own default agent; a browser-shaped one gets 403 on these hosts (see odds.py).
CONCURRENCY = 8

# {our field: (ESPN category, ESPN stat name)}
FIELDS: dict[str, tuple[str, str]] = {
    "games": ("general", "gamesPlayed"),
    "rz_td_pct": ("miscellaneous", "redzoneTouchdownPct"),
    "rz_fg_pct": ("miscellaneous", "redzoneFieldGoalPct"),
    "rz_score_pct": ("miscellaneous", "redzoneScoringPct"),
    "third_pct": ("miscellaneous", "thirdDownConvPct"),
    "third_att": ("miscellaneous", "thirdDownAttempts"),
    "fourth_att": ("miscellaneous", "fourthDownAttempts"),
    "points_pg": ("scoring", "totalPointsPerGame"),
    "fg_att": ("kicking", "fieldGoalAttempts"),
    "fg_made": ("kicking", "fieldGoalsMade"),
    "fg_long": ("kicking", "longFieldGoalMade"),
    "_fg_a_0_19": ("kicking", "fieldGoalAttempts1_19"),
    "_fg_a_20_29": ("kicking", "fieldGoalAttempts20_29"),
    "_fg_a_30_39": ("kicking", "fieldGoalAttempts30_39"),
    "_fg_a_40_49": ("kicking", "fieldGoalAttempts40_49"),
    "_fg_a_50_59": ("kicking", "fieldGoalAttempts50_59"),
    "_fg_a_60_99": ("kicking", "fieldGoalAttempts60_99"),
}


def _num(v: Any) -> float | None:
    if v in (None, "", "-"):
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _extract(payload: dict) -> dict:
    """One team's statistics payload -> our fields. ESPN nests stats under named categories."""
    by_cat: dict[str, dict[str, Any]] = {}
    for c in (payload.get("splits") or {}).get("categories") or []:
        by_cat[c.get("name")] = {s.get("name"): s.get("value", s.get("displayValue")) for s in c.get("stats") or []}
    row = {ours: _num((by_cat.get(cat) or {}).get(name)) for ours, (cat, name) in FIELDS.items()}
    # Attempts from 40 out are the ones league scoring usually pays extra for, so the split is
    # carried as short/long rather than as six near-empty buckets.
    short = sum(row.pop(k) or 0.0 for k in ("_fg_a_0_19", "_fg_a_20_29", "_fg_a_30_39"))
    long_ = sum(row.pop(k) or 0.0 for k in ("_fg_a_40_49", "_fg_a_50_59", "_fg_a_60_99"))
    row["fg_att_short"] = short or None
    row["fg_att_long"] = long_ or None
    games = row.get("games") or 0
    row["fg_att_pg"] = round(row["fg_att"] / games, 1) if row.get("fg_att") is not None and games else None
    row["fourth_att_pg"] = round(row["fourth_att"] / games, 1) if row.get("fourth_att") is not None and games else None
    return row


async def load(cache: Cache, season: str) -> dict[str, dict]:
    """{team abbreviation: efficiency row}. Empty dict if ESPN is unreachable — these are extra
    columns on a view that works without them, never a reason to fail the request."""
    async def loader() -> dict[str, dict]:
        async with httpx.AsyncClient(timeout=httpx.Timeout(30.0, connect=10.0), follow_redirects=True) as http:
            r = await http.get(TEAMS_URL, params={"limit": 32})
            r.raise_for_status()
            teams = [t["team"] for t in r.json()["sports"][0]["leagues"][0]["teams"]]
            sem = asyncio.Semaphore(CONCURRENCY)

            async def one(team: dict) -> tuple[str, dict] | None:
                abbrev = ESPN_TEAM_ALIASES.get(team.get("abbreviation"), team.get("abbreviation"))
                if not abbrev:
                    return None
                async with sem:
                    try:
                        resp = await http.get(STATS_URL.format(season=season, team_id=team["id"]))
                        resp.raise_for_status()
                    except httpx.HTTPError:
                        return None
                return abbrev, _extract(resp.json())

            done = await asyncio.gather(*(one(t) for t in teams))
        return {abbrev: row for r in done if r for abbrev, row in [r]}

    try:
        return await cache.get(f"espn:teamstats:{season}", 3 * HOUR, loader, disk=True)
    except Exception:
        return {}
