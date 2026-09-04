"""Player identity across platforms. Sleeper's player_id is the canonical id; ESPN, Yahoo and
FantasyPros ids are mapped onto it using, in order: Sleeper's own cross-ids, the
nflverse/DynastyProcess crosswalk, and finally a normalized name + position match."""
from __future__ import annotations

import csv
import io
import re
import unicodedata
from collections import defaultdict

import httpx

from .cache import Cache

NFLVERSE_IDS_URL = "https://github.com/dynastyprocess/data/raw/master/files/db_playerids.csv"
DAY = 86400

# ESPN abbreviations that differ from Sleeper's.
ESPN_TEAM_ALIASES = {"WSH": "WAS"}


def normalize_name(name: str) -> str:
    n = unicodedata.normalize("NFKD", name or "").encode("ascii", "ignore").decode().lower()
    n = re.sub(r"\b(jr|sr|ii|iii|iv|v)\b\.?", "", n)
    return re.sub(r"[^a-z]", "", n)


async def load_nflverse_ids(cache: Cache) -> list[dict]:
    async def loader() -> list[dict]:
        async with httpx.AsyncClient(follow_redirects=True, timeout=60) as http:
            r = await http.get(NFLVERSE_IDS_URL)
            r.raise_for_status()
        rows = []
        for row in csv.DictReader(io.StringIO(r.text)):
            if row.get("sleeper_id"):
                rows.append({k: row.get(k) or None for k in ("sleeper_id", "espn_id", "yahoo_id", "fantasypros_id", "name", "position")})
        return rows
    return await cache.get("nflverse_ids", DAY, loader, disk=True)


class Crosswalk:
    def __init__(self, sleeper_players: dict[str, dict], nflverse_rows: list[dict]):
        self.players = sleeper_players
        self.espn: dict[int, str] = {}
        self.yahoo: dict[int, str] = {}
        self.fp: dict[str, str] = {}
        self.by_name: dict[tuple[str, str], list[str]] = defaultdict(list)
        for pid, p in sleeper_players.items():
            for key, table in (("espn_id", self.espn), ("yahoo_id", self.yahoo)):
                v = p.get(key)
                if v:
                    try:
                        table[int(v)] = pid
                    except (TypeError, ValueError):
                        pass
            position = p.get("position")
            if not position:
                continue
            # Team defenses have no full_name in Sleeper's file; index them as "City Nickname".
            names = {p.get("full_name"), f"{p.get('first_name') or ''} {p.get('last_name') or ''}".strip()}
            for name in filter(None, names):
                key = (normalize_name(name), position)
                if pid not in self.by_name[key]:
                    self.by_name[key].append(pid)
        # nflverse fills gaps but never overrides Sleeper's own ids.
        for row in nflverse_rows:
            sid = row.get("sleeper_id")
            if not sid or sid not in sleeper_players:
                continue
            for key, table in (("espn_id", self.espn), ("yahoo_id", self.yahoo)):
                v = row.get(key)
                if v:
                    try:
                        table.setdefault(int(float(v)), sid)
                    except (TypeError, ValueError):
                        pass
            fp_id = row.get("fantasypros_id")
            if fp_id:
                self.fp.setdefault(str(fp_id).strip(), sid)

    def from_espn(self, espn_id: int, name: str | None, position: str | None, team_abbrev: str | None) -> str | None:
        if position == "DEF" or espn_id <= -16000:
            if team_abbrev:
                abbr = ESPN_TEAM_ALIASES.get(team_abbrev, team_abbrev)
                return abbr if abbr in self.players else None
            return None
        pid = self.espn.get(espn_id)
        if pid:
            return pid
        if name and position:
            cands = self.by_name.get((normalize_name(name), position), [])
            if len(cands) == 1:
                return cands[0]
        return None

    def from_yahoo(self, yahoo_id: int, name: str | None, position: str | None) -> str | None:
        pid = self.yahoo.get(yahoo_id)
        if pid:
            return pid
        if name and position:
            cands = self.by_name.get((normalize_name(name), position), [])
            if len(cands) == 1:
                return cands[0]
        return None

    def from_fantasypros(self, fp_id: str | None, name: str | None, position: str | None, team: str | None) -> str | None:
        """FantasyPros ids come from the crosswalk; D/ST rows resolve to Sleeper's team-abbreviation ids."""
        if position == "DEF":
            if team and team in self.players:
                return team
            if name:
                cands = self.by_name.get((normalize_name(name), "DEF"), [])
                if len(cands) == 1:
                    return cands[0]
            return None
        if fp_id:
            pid = self.fp.get(str(fp_id).strip())
            if pid:
                return pid
        if name and position:
            cands = self.by_name.get((normalize_name(name), position), [])
            if len(cands) == 1:
                return cands[0]
            if team:
                same_team = [pid for pid in cands if (self.players.get(pid) or {}).get("team") == team]
                if len(same_team) == 1:
                    return same_team[0]
        return None
