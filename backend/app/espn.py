"""ESPN Fantasy Football (undocumented v3 "lm-api") client plus normalizers that turn ESPN's league,
roster, player-pool and transaction payloads into the Sleeper-shaped structures the service layer uses.
Read-only. See research/yahoo-espn-apis.md."""
from __future__ import annotations

import json
from typing import Any

import httpx

from .cache import Cache
from .ids import ESPN_TEAM_ALIASES, Crosswalk

MIN = 60
HOUR = 3600

POSITION_BY_ID = {1: "QB", 2: "RB", 3: "WR", 4: "TE", 5: "K", 16: "DEF"}
# lineupSlotId -> Sleeper roster_positions vocabulary
SLOT_BY_ID = {0: "QB", 2: "RB", 4: "WR", 6: "TE", 23: "FLEX", 3: "WRRB_FLEX", 5: "REC_FLEX", 7: "SUPER_FLEX",
              16: "DEF", 17: "K", 20: "BN", 21: "IR", 25: "SUPER_FLEX"}
SLOT_ORDER = [0, 2, 4, 6, 23, 3, 5, 7, 25, 17, 16]
BENCH_SLOT, IR_SLOT = 20, 21
POOL_SLOT_IDS = [0, 2, 4, 6, 16, 17, 23]
INJURY_MAP = {"ACTIVE": None, "QUESTIONABLE": "Questionable", "DOUBTFUL": "Doubtful", "OUT": "Out",
              "INJURY_RESERVE": "IR", "SUSPENSION": "Sus", "PHYSICALLY_UNABLE_TO_PERFORM": "PUP", "DAY_TO_DAY": "Questionable"}

# ESPN statId -> Sleeper scoring keys. Bucketed stats that don't line up exactly are mapped to the
# nearest Sleeper bucket(s). Source for names: cwendt94/espn-api constant.py.
STAT_TO_SLEEPER: dict[int, tuple[str, ...]] = {
    3: ("pass_yd",), 4: ("pass_td",), 19: ("pass_2pt",), 20: ("pass_int",),
    15: ("pass_td_40p",), 16: ("pass_td_50p",), 17: ("bonus_pass_yd_300",), 18: ("bonus_pass_yd_400",),
    24: ("rush_yd",), 25: ("rush_td",), 26: ("rush_2pt",), 27: ("rush_td_40p",), 28: ("rush_td_50p",),
    29: ("bonus_rush_yd_100",), 30: ("bonus_rush_yd_200",),
    42: ("rec_yd",), 43: ("rec_td",), 44: ("rec_2pt",), 45: ("rec_td_40p",), 46: ("rec_td_50p",),
    47: ("bonus_rec_yd_100",), 48: ("bonus_rec_yd_200",), 53: ("rec",),
    68: ("fum",), 72: ("fum_lost",), 63: ("fum_rec_td",),
    74: ("fgm_50p",), 198: ("fgm_50p",), 201: ("fgm_50p",), 77: ("fgm_40_49",),
    80: ("fgm_0_19", "fgm_20_29", "fgm_30_39"), 83: ("fgm",), 85: ("fgmiss",), 86: ("xpm",), 88: ("xpmiss",),
    # D/ST
    89: ("pts_allow_0",), 90: ("pts_allow_1_6",), 91: ("pts_allow_7_13",), 92: ("pts_allow_14_20",),
    121: ("pts_allow_21_27",), 122: ("pts_allow_21_27",), 123: ("pts_allow_28_34",), 124: ("pts_allow_35p",), 125: ("pts_allow_35p",),
    93: ("blk_kick_ret_td",), 94: ("def_td",), 95: ("int",), 96: ("fum_rec",), 97: ("blk_kick",), 98: ("safe",), 99: ("sack",),
    101: ("def_st_td",), 102: ("def_st_td",), 103: ("def_td",), 104: ("def_td",), 106: ("ff",),
    128: ("yds_allow_0_100",), 129: ("yds_allow_100_199",), 130: ("yds_allow_200_299",), 131: ("yds_allow_300_349",),
    132: ("yds_allow_350_399",), 133: ("yds_allow_400_449",), 134: ("yds_allow_450_499",), 135: ("yds_allow_500_549",), 136: ("yds_allow_550p",),
}
DST_POSITION_ID = "16"
TE_POSITION_ID = "4"


def translate_scoring(scoring_items: list[dict]) -> dict[str, float]:
    """ESPN scoringItems -> Sleeper-style {stat_key: points}. D/ST items usually carry their points in
    pointsOverrides["16"]; TE reception overrides become Sleeper's bonus_rec_te."""
    out: dict[str, float] = {}
    for item in scoring_items:
        sid = item.get("statId")
        keys = STAT_TO_SLEEPER.get(sid)
        if not keys:
            continue
        pts = float(item.get("points") or 0)
        overrides = item.get("pointsOverrides") or {}
        if DST_POSITION_ID in overrides and (sid >= 89 or pts == 0):
            pts = float(overrides[DST_POSITION_ID])
        if sid == 53 and TE_POSITION_ID in overrides:
            out["bonus_rec_te"] = float(overrides[TE_POSITION_ID]) - pts
        if pts:
            for k in keys:
                out[k] = pts
    return out


def stat_id(source: int, split: int, season: str, week: int | None = None) -> str:
    """ESPN's composite stat ids: {source}{split}{season}[{week}] e.g. 1120261 = projected, week 1, 2026."""
    return f"{source}{split}{season}{week if week is not None else ''}"


class Espn:
    BASE = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl"

    def __init__(self, cache: Cache, s2: str, swid: str):
        self.cache = cache
        self.swid = swid
        headers = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36",
                   "Accept": "application/json"}
        cookies = {"espn_s2": s2, "SWID": swid} if s2 and swid else None
        self.http = httpx.AsyncClient(base_url=self.BASE, timeout=httpx.Timeout(90.0, connect=15.0), headers=headers, cookies=cookies)

    async def aclose(self) -> None:
        await self.http.aclose()

    async def _get(self, path: str, views: list[str] | None = None, flt: dict | None = None, params: dict | None = None) -> Any:
        q: list[tuple[str, str]] = [("view", v) for v in (views or [])]
        for k, v in (params or {}).items():
            q.append((k, str(v)))
        headers = {"X-Fantasy-Filter": json.dumps(flt)} if flt else None
        r = await self.http.get(path, params=q, headers=headers)
        r.raise_for_status()
        return r.json()

    async def league(self, league_id: str, season: str) -> dict:
        return await self.cache.get(
            f"espn:league:{league_id}:{season}", 1 * MIN,
            lambda: self._get(f"/seasons/{season}/segments/0/leagues/{league_id}", ["mSettings", "mTeam", "mRoster", "mStatus"]),
        )

    async def pool(self, league_id: str, season: str, statuses: tuple[str, ...], limit: int, stat_ids: list[str]) -> list[dict]:
        flt = {"players": {
            "filterStatus": {"value": list(statuses)},
            "filterSlotIds": {"value": POOL_SLOT_IDS},
            "limit": limit, "offset": 0,
            "sortPercOwned": {"sortPriority": 1, "sortAsc": False},
            "filterStatsForTopScoringPeriodIds": {"value": 2, "additionalValue": stat_ids},
        }}
        key = f"espn:pool:{league_id}:{season}:{','.join(statuses)}:{limit}:{','.join(stat_ids)}"
        async def loader():
            d = await self._get(f"/seasons/{season}/segments/0/leagues/{league_id}", ["kona_player_info"], flt)
            return d.get("players", [])
        return await self.cache.get(key, 10 * MIN, loader)

    async def transactions(self, league_id: str, season: str) -> list[dict]:
        async def loader():
            d = await self._get(f"/seasons/{season}/segments/0/leagues/{league_id}", ["mTransactions2"])
            return d.get("transactions", []) or []
        return await self.cache.get(f"espn:tx:{league_id}:{season}", 1 * MIN, loader)

    async def pro_teams(self, season: str) -> dict[int, dict]:
        async def loader():
            d = await self._get(f"/seasons/{season}", ["proTeamSchedules_wl"])
            return {int(t["id"]): {"abbrev": t.get("abbrev"), "bye_week": t.get("byeWeek")} for t in d["settings"]["proTeams"] if t.get("id")}
        raw = await self.cache.get(f"espn:proteams:{season}", HOUR, loader)
        return {int(k): v for k, v in raw.items()}


# ----------------------------------------------------------------------------- normalizers
def _player_pid(xw: Crosswalk, pro_teams: dict[int, dict], p: dict) -> tuple[str, dict | None]:
    """Return (canonical pid, synthetic Sleeper-like record if unmapped)."""
    pos = POSITION_BY_ID.get(p.get("defaultPositionId"))
    team = (pro_teams.get(int(p.get("proTeamId") or 0)) or {}).get("abbrev")
    pid = xw.from_espn(int(p["id"]), p.get("fullName"), pos, team)
    if pid:
        return pid, None
    abbr = ESPN_TEAM_ALIASES.get(team, team) if team else None
    synthetic = {
        "player_id": f"espn:{p['id']}", "full_name": p.get("fullName"), "first_name": p.get("firstName"), "last_name": p.get("lastName"),
        "position": pos, "fantasy_positions": [pos] if pos else [], "team": abbr, "status": "Active" if p.get("active", True) else "Inactive",
        "injury_status": INJURY_MAP.get(p.get("injuryStatus")), "search_rank": 9999,
    }
    return synthetic["player_id"], synthetic


def normalize_league(raw: dict, league_id: str, season: str, my_swid: str, xw: Crosswalk, pro_teams: dict[int, dict]) -> dict:
    """ESPN league payload (mSettings+mTeam+mRoster+mStatus) -> bundle {league, rosters, users_by_id, my_roster, synthetic}."""
    s = raw["settings"]
    rs = s.get("rosterSettings", {})
    counts = {int(k): int(v) for k, v in (rs.get("lineupSlotCounts") or {}).items() if int(v) > 0}
    roster_positions: list[str] = []
    for slot_id in SLOT_ORDER:
        roster_positions += [SLOT_BY_ID[slot_id]] * counts.get(slot_id, 0)
    roster_positions += ["BN"] * counts.get(BENCH_SLOT, 0)
    reserve_slots = counts.get(IR_SLOT, 0)

    acq = s.get("acquisitionSettings", {})
    sched = s.get("scheduleSettings", {})
    matchup_periods = {int(k): [int(x) for x in v] for k, v in (sched.get("matchupPeriods") or {}).items()}
    regular_periods = int(sched.get("matchupPeriodCount") or 14)
    ros_end = max((w for ws in matchup_periods.values() for w in ws), default=17)
    day_order = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"]
    process_days = sorted(acq.get("waiverProcessDays") or [], key=lambda d: day_order.index(d) if d in day_order else 99)
    daily = len(process_days) >= 6
    trade = s.get("tradeSettings", {})
    settings = {
        "waiver_type": 2 if acq.get("isUsingAcquisitionBudget") else 0,
        "waiver_budget": int(acq.get("acquisitionBudget") or 0),
        "waiver_bid_min": int(acq.get("minimumBid") or 0),
        "waiver_clear_days": round((acq.get("waiverHours") or 0) / 24, 1),
        "daily_waivers": 1 if daily else 0,
        "waiver_days": [d.title()[:3] for d in process_days],
        "waiver_hour": acq.get("waiverProcessHour"),
        "waiver_day_of_week": None,
        "reserve_slots": reserve_slots, "taxi_slots": 0, "type": 0,
        "num_teams": int(s.get("size") or len(raw.get("teams", []))),
        "playoff_week_start": regular_periods + 1,
        "playoff_teams": int(sched.get("playoffTeamCount") or 0),
        "trade_deadline": None,
        "trade_deadline_date": trade.get("deadlineDate"),
        "leg": int(raw.get("scoringPeriodId") or 1),
    }
    league = {
        "platform": "espn", "platform_league_id": league_id,
        "league_id": f"espn:{league_id}", "name": s.get("name") or f"ESPN {league_id}", "season": str(raw.get("seasonId") or season),
        "status": "in_season" if (raw.get("status") or {}).get("isActive", True) else "complete",
        "avatar": None, "total_rosters": settings["num_teams"],
        "roster_positions": roster_positions, "scoring_settings": translate_scoring(s.get("scoringSettings", {}).get("scoringItems", [])),
        "scoring_type": s.get("scoringSettings", {}).get("scoringType"),
        "settings": settings, "ros_end_week": ros_end,
    }

    users_by_id: dict[str, dict] = {}
    for m in raw.get("members", []):
        users_by_id[m["id"]] = {"user_id": m["id"], "display_name": m.get("displayName") or m.get("firstName") or m["id"], "avatar": None,
                                "is_owner": bool(m.get("isLeagueManager")), "metadata": {}}

    synthetic: dict[str, dict] = {}
    espn_ids: dict[str, int] = {}
    rosters = []
    for t in raw.get("teams", []):
        owners = t.get("owners") or []
        name = t.get("name") or f"{t.get('location', '')} {t.get('nickname', '')}".strip()
        if owners:
            users_by_id.setdefault(owners[0], {"user_id": owners[0], "display_name": owners[0], "avatar": None, "is_owner": False, "metadata": {}})
            users_by_id[owners[0]]["metadata"]["team_name"] = name
        entries = (t.get("roster") or {}).get("entries") or []
        players, reserve = [], []
        by_slot: dict[int, list[str]] = {}
        for e in entries:
            p = (e.get("playerPoolEntry") or {}).get("player") or {"id": e["playerId"]}
            pid, synth = _player_pid(xw, pro_teams, p)
            if synth:
                synthetic[pid] = synth
            espn_ids[pid] = int(p["id"])
            players.append(pid)
            slot = int(e.get("lineupSlotId", BENCH_SLOT))
            if slot == IR_SLOT:
                reserve.append(pid)
            elif slot != BENCH_SLOT:
                by_slot.setdefault(slot, []).append(pid)
        starters: list[str] = []
        for slot_id in SLOT_ORDER:
            for _ in range(counts.get(slot_id, 0)):
                queue = by_slot.get(slot_id, [])
                starters.append(queue.pop(0) if queue else "0")
        rec = (t.get("record") or {}).get("overall") or {}
        tc = t.get("transactionCounter") or {}
        rosters.append({
            "roster_id": int(t["id"]), "owner_id": owners[0] if owners else None, "co_owners": owners[1:],
            "league_id": league["league_id"], "players": players, "starters": starters, "reserve": reserve, "taxi": [],
            "settings": {
                "wins": int(rec.get("wins") or 0), "losses": int(rec.get("losses") or 0), "ties": int(rec.get("ties") or 0),
                "fpts": float(rec.get("pointsFor") or 0), "fpts_decimal": 0, "fpts_against": float(rec.get("pointsAgainst") or 0), "fpts_against_decimal": 0,
                "waiver_position": t.get("waiverRank"), "waiver_budget_used": int(tc.get("acquisitionBudgetSpent") or 0),
                "total_moves": int(tc.get("acquisitions") or 0) + int(tc.get("drops") or 0) + int(tc.get("trades") or 0),
            },
            "metadata": {"team_name": name, "abbrev": t.get("abbrev")},
        })
    mine = next((r for r in rosters if any((o or "").lower() == my_swid.lower() for o in [r["owner_id"], *r["co_owners"]])), None)
    return {"league": league, "rosters": rosters, "users_by_id": users_by_id, "my_roster": mine, "user_id": my_swid,
            "synthetic": synthetic, "espn_ids": espn_ids}


def normalize_pool(entries: list[dict], season: str, week: int, xw: Crosswalk, pro_teams: dict[int, dict]) -> tuple[dict[str, dict], dict[str, dict]]:
    """kona_player_info entries -> ({pid: info}, {pid: synthetic player}). info carries ESPN's league-scored
    projections, ownership and availability status."""
    proj_week_id = stat_id(1, 1, season, week)
    season_proj_id = stat_id(1, 0, season)
    season_act_id = stat_id(0, 0, season)
    prev_act_id = stat_id(0, 0, str(int(season) - 1))
    info: dict[str, dict] = {}
    synthetic: dict[str, dict] = {}
    for e in entries:
        p = e.get("player") or {}
        if not p.get("id"):
            continue
        pid, synth = _player_pid(xw, pro_teams, p)
        if synth:
            synthetic[pid] = synth
        stats = {s.get("id"): s for s in p.get("stats", [])}
        own = p.get("ownership") or {}
        prev = stats.get(prev_act_id) or {}
        info[pid] = {
            "espn_id": int(p["id"]),
            "position": POSITION_BY_ID.get(p.get("defaultPositionId")),
            "status": e.get("status"),  # FREEAGENT | WAIVERS | ONTEAM
            "on_team_id": e.get("onTeamId"),
            "waiver_until": e.get("waiverProcessDate"),
            "proj_week": (stats.get(proj_week_id) or {}).get("appliedTotal"),
            "season_proj": (stats.get(season_proj_id) or {}).get("appliedTotal"),
            "season_actual": (stats.get(season_act_id) or {}).get("appliedTotal"),
            "prev_season_total": prev.get("appliedTotal"),
            "prev_season_avg": prev.get("appliedAverage"),
            "owned": own.get("percentOwned"),
            "started": own.get("percentStarted"),
            "owned_change": own.get("percentChange"),
            "injury_status": INJURY_MAP.get(p.get("injuryStatus"), p.get("injuryStatus")),
            "rank_position": ((e.get("ratings") or {}).get("0") or {}).get("positionalRanking"),
        }
    return info, synthetic


TX_TYPE = {"FREEAGENT": "free_agent", "WAIVER": "waiver", "TRADE": "trade", "TRADE_ACCEPT": "trade", "TRADE_PROPOSAL": "trade"}
TX_STATUS = {"EXECUTED": "complete", "PENDING": "pending", "PROPOSED": "pending", "FAILED_INVALIDPLAYERSOURCE": "failed",
             "FAILED_ROSTERLIMIT": "failed", "CANCELED": "failed", "REJECTED": "failed", "VETOED": "failed"}


def normalize_transactions(raw: list[dict], espn_id_to_pid: dict[int, str]) -> list[dict]:
    """mTransactions2 -> [{type, status, week, created, status_updated, bid, adds{pid: roster_id}, drops{pid: roster_id}, roster_ids, notes}].
    Draft picks and pure lineup moves are skipped."""
    out = []
    for t in raw:
        ttype = TX_TYPE.get(t.get("type"))
        if not ttype:
            continue
        adds: dict[str, int] = {}
        drops: dict[str, int] = {}
        for item in t.get("items") or []:
            pid = espn_id_to_pid.get(int(item.get("playerId") or 0), f"espn:{item.get('playerId')}")
            if item.get("type") == "ADD":
                adds[pid] = int(item.get("toTeamId") or t.get("teamId") or 0)
            elif item.get("type") == "DROP":
                drops[pid] = int(item.get("fromTeamId") or t.get("teamId") or 0)
        rosters = sorted({*adds.values(), *drops.values(), *( [int(t["teamId"])] if t.get("teamId") else [] )})
        raw_status = t.get("status") or ""
        out.append({
            "transaction_id": t.get("id"), "type": ttype,
            "status": TX_STATUS.get(raw_status, "failed" if raw_status.startswith("FAILED") else raw_status.lower()),
            "leg": t.get("scoringPeriodId"), "created": t.get("proposedDate"), "status_updated": t.get("processDate") or t.get("proposedDate"),
            "settings": {"waiver_bid": t.get("bidAmount")} if t.get("bidAmount") else None,
            "metadata": {"notes": raw_status.replace("_", " ").title() if raw_status not in ("EXECUTED",) else None},
            "adds": adds, "drops": drops, "roster_ids": rosters, "draft_picks": [], "waiver_budget": [],
        })
    return out
