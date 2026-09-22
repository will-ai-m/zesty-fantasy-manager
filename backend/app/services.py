"""Assembles the view models the UI needs. Sleeper is the canonical data source (player ids, schedule,
trending, injuries, projections); other platforms are normalized onto Sleeper's shapes and ids."""
from __future__ import annotations

import asyncio
import math
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

from .config import DATA_DIR, ESPN_LEAGUE_IDS, ESPN_SWID, FANTASY_POSITIONS, OUT_STATUSES, \
    YAHOO_LEAGUE_IDS, ConfigError, require_username
from . import fantasypros as fp
from . import teamstats
from .espn import Espn, normalize_league as espn_normalize_league, normalize_pool as espn_normalize_pool, \
    normalize_transactions as espn_normalize_transactions, stat_id as espn_stat_id
from .yahoo import Yahoo, normalize_league as yahoo_normalize_league, normalize_pool as yahoo_normalize_pool, \
    normalize_buzz as yahoo_normalize_buzz, normalize_pending as yahoo_normalize_pending, \
    normalize_transactions as yahoo_normalize_transactions
from .ids import Crosswalk, load_nflverse_ids
from .lineup import optimal_lineup, starting_slots
from .scoring import score
from .sleeper import Sleeper
from . import waivers as wv

WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]  # assumption: Sleeper's waiver_day_of_week is 0=Mon
REGULAR_SEASON_WEEKS = 18
PSEUDO_STAT = "_pts"  # lets platform-native point totals flow through score(): stats={"_pts": x}, scoring={"_pts": 1}
# "Today" for game-day purposes is the NFL's own day. A Sunday-night game is still Sunday's
# game to a viewer in Los Angeles, and a Monday-nighter is still Monday's in Honolulu, so the
# league's scheduling timezone beats the server's (or the browser's) local date here.
EASTERN = ZoneInfo("America/New_York")


def today_et() -> str:
    """Today's date in the NFL's scheduling timezone, as Sleeper's schedule writes it."""
    return datetime.now(EASTERN).date().isoformat()


def _f(x: Any) -> float | None:
    return None if x is None else float(x)


def parse_league_id(league_id: str) -> tuple[str, str]:
    """'espn:123' -> ('espn', '123'); bare ids are Sleeper."""
    if ":" in league_id:
        platform, _, raw = league_id.partition(":")
        return platform, raw
    return "sleeper", league_id


class Service:
    def __init__(self, sleeper: Sleeper, espn: Espn | None = None, yahoo: Yahoo | None = None, odds=None):
        self.s = sleeper
        self.espn = espn
        self.yahoo = yahoo
        self.odds = odds
        self._expert_stamp: float | None = None
        self._expert_raw: dict | None = None
        self._xw: tuple[int, Crosswalk] | None = None
        self._fp_stamp: float | None = None
        self._fp_cache: tuple[dict | None, dict[str, dict[str, dict]]] = (None, {})

    # ------------------------------------------------------------------ basics
    def _fp(self) -> tuple[dict | None, dict[str, dict[str, dict]]]:
        """FantasyPros rankings, reloaded when `update-fantasypros-data` rewrites the file."""
        path = DATA_DIR / "cache" / fp.CACHE_FILE
        stamp = path.stat().st_mtime if path.exists() else None
        if stamp != self._fp_stamp:
            data = fp.load()
            self._fp_cache = (data, fp.indexes(data))
            self._fp_stamp = stamp
        return self._fp_cache

    def _fp_fields(self, pid: str) -> dict:
        """Compact FantasyPros fields for table rows. `fp_pos_rank` is the weekly
        within-position ECR ("WR24"); `fp_waiver_rank` is the player's place on the
        waiver-wire shortlist, which only ~50 players appear on at all."""
        _, idx = self._fp()
        weekly = (idx.get("weekly") or {}).get(pid) or {}
        waiver = (idx.get("waiver") or {}).get(pid) or {}
        ros_ = (idx.get("ros") or {}).get(pid) or {}
        return {
            "fp_pos_rank": weekly.get("pos_rank"),
            "fp_rank_std": weekly.get("rank_std"),
            "fp_waiver_rank": waiver.get("rank_ecr"),
            "fp_waiver_pos_rank": waiver.get("pos_rank"),
            "fp_ros_pos_rank": ros_.get("pos_rank"),
        }

    def _fp_detail(self, pid: str, position: str | None) -> dict | None:
        """Everything we have on one player, for the drawer. Expert counts are carried per
        set because they differ wildly — ~80 on the weekly pages, 3 on rest-of-season."""
        data, idx = self._fp()
        if not data:
            return None
        sets = {}
        for name in ("weekly", "ros", "waiver"):
            row = (idx.get(name) or {}).get(pid)
            if not row:
                continue
            sets[name] = {
                "rank_ecr": row.get("rank_ecr"),
                "pos_rank": row.get("pos_rank"),
                "rank_min": row.get("rank_min"),
                "rank_max": row.get("rank_max"),
                "rank_ave": row.get("rank_ave"),
                "rank_std": row.get("rank_std"),
                "tier": row.get("tier"),
                "ecr_delta": row.get("ecr_delta"),
                "owned_avg": row.get("owned_avg"),
                "experts": fp.experts(data, name, position),
            }
        if not sets:
            return None
        return {"fetched_at_iso": data.get("fetched_at_iso"), "scoring": data.get("scoring"), "sets": sets}

    async def state(self) -> dict:
        st = await self.s.state()
        week = int(st.get("display_week") or st.get("week") or 1)
        if st.get("season_type") == "pre":
            week = 1
        week = max(1, min(REGULAR_SEASON_WEEKS, week))
        return {**st, "current_week": week}

    async def _crosswalk(self) -> Crosswalk:
        players, rows = await asyncio.gather(self.s.players(), load_nflverse_ids(self.s.cache))
        if self._xw is None or self._xw[0] != id(players):
            self._xw = (id(players), Crosswalk(players, rows))
        return self._xw[1]

    async def _sleeper_user(self) -> dict:
        name = require_username()
        user = await self.s.user(name)
        if not user:
            # Sleeper answers a bare `null` for an unknown name (usernames can be changed); drop it from the
            # cache so a corrected .env takes effect without waiting out the day-long TTL.
            self.s.cache.invalidate(f"user:{name}")
            raise ConfigError(f"Sleeper has no user '{name}'. If you renamed your Sleeper account, set SLEEPER_USERNAME "
                              "in .env to the new username, or to your numeric user id, which survives renames.")
        return user

    async def me(self) -> dict:
        user = await self._sleeper_user()
        st = await self.state()
        season = st["league_season"] if st.get("league_season") else st["season"]
        leagues = await self.s.user_leagues(user["user_id"], season)
        sleeper_bundles = await asyncio.gather(*(self._sleeper_bundle(lg["league_id"], user["user_id"]) for lg in leagues))
        summaries = [self._league_summary(b) for b in sleeper_bundles]
        if self.espn:
            results = await asyncio.gather(*(self._espn_bundle(lid, season) for lid in ESPN_LEAGUE_IDS), return_exceptions=True)
            for lid, res in zip(ESPN_LEAGUE_IDS, results):
                if isinstance(res, Exception):
                    summaries.append({"league_id": f"espn:{lid}", "platform": "espn", "platform_league_id": lid, "name": f"ESPN league {lid}",
                                      "error": f"ESPN request failed: {res}"})
                else:
                    summaries.append(self._league_summary(res))
        if self.yahoo:
            results = await asyncio.gather(*(self._yahoo_bundle(lid) for lid in YAHOO_LEAGUE_IDS), return_exceptions=True)
            for lid, res in zip(YAHOO_LEAGUE_IDS, results):
                if isinstance(res, Exception):
                    summaries.append({"league_id": f"yahoo:{lid}", "platform": "yahoo", "platform_league_id": lid, "name": f"Yahoo league {lid}",
                                      "error": f"Yahoo request failed: {res}"})
                else:
                    summaries.append(self._league_summary(res))
        return {
            "user": {"user_id": user["user_id"], "username": user["username"], "display_name": user["display_name"], "avatar": user.get("avatar")},
            "state": st,
            "leagues": summaries,
        }

    # ----------------------------------------------------------- league bundles
    async def _league_bundle(self, league_id: str, user_id: str | None = None) -> dict:
        platform, raw = parse_league_id(league_id)
        if platform == "espn":
            if not self.espn:
                raise RuntimeError("ESPN is not configured (set ESPN_S2 / ESPN_SWID / ESPN_LEAGUE_IDS in .env)")
            st = await self.state()
            return await self._espn_bundle(raw, st["season"])
        if platform == "yahoo":
            if not self.yahoo:
                raise RuntimeError("Yahoo is not configured (set YAHOO_COOKIE / YAHOO_LEAGUE_IDS in .env)")
            return await self._yahoo_bundle(raw)
        return await self._sleeper_bundle(raw, user_id)

    async def _sleeper_bundle(self, league_id: str, user_id: str | None = None) -> dict:
        if user_id is None:
            user_id = (await self._sleeper_user())["user_id"]
        league, rosters, users = await asyncio.gather(
            self.s.league(league_id), self.s.rosters(league_id), self.s.users(league_id)
        )
        league = {**league, "platform": "sleeper", "platform_league_id": league_id, "league_id": f"sleeper:{league_id}"}
        users_by_id = {u["user_id"]: u for u in users}
        mine = next((r for r in rosters if r.get("owner_id") == user_id or user_id in (r.get("co_owners") or [])), None)
        return {"league": league, "rosters": rosters, "users_by_id": users_by_id, "my_roster": mine, "user_id": user_id, "synthetic": {}}

    async def _espn_bundle(self, league_id: str, season: str) -> dict:
        assert self.espn is not None
        raw, pro_teams, xw = await asyncio.gather(self.espn.league(league_id, season), self.espn.pro_teams(season), self._crosswalk())
        return espn_normalize_league(raw, league_id, season, ESPN_SWID, xw, pro_teams)

    async def _yahoo_bundle(self, league_id: str) -> dict:
        assert self.yahoo is not None
        st = await self.state()
        raw, xw = await asyncio.gather(self.yahoo.league(league_id), self._crosswalk())
        return yahoo_normalize_league(raw, league_id, st["season"], xw)

    def _owner(self, bundle: dict, roster: dict) -> dict:
        u = bundle["users_by_id"].get(roster.get("owner_id"), {})
        return {
            "user_id": roster.get("owner_id"),
            "display_name": u.get("display_name") or "Unknown",
            "team_name": (u.get("metadata") or {}).get("team_name") or (roster.get("metadata") or {}).get("team_name") or u.get("display_name") or f"Roster {roster['roster_id']}",
            "avatar": u.get("avatar"),
        }

    def _ros_end_week(self, league: dict) -> int:
        if league.get("ros_end_week"):
            return int(league["ros_end_week"])
        s = league.get("settings", {})
        start = int(s.get("playoff_week_start") or 15)
        teams = int(s.get("playoff_teams") or 6)
        rounds = max(1, math.ceil(math.log2(teams))) if teams > 1 else 1
        return min(REGULAR_SEASON_WEEKS, start + rounds - 1)

    def _league_summary(self, b: dict) -> dict:
        lg, mine = b["league"], b["my_roster"]
        s = lg.get("settings", {})
        sc = lg.get("scoring_settings", {})
        rec = sc.get("rec", 0)
        fmt = "PPR" if rec >= 1 else ("Half PPR" if rec > 0 else "Standard")
        budget = int(s.get("waiver_budget") or 0)
        faab_used = int((mine or {}).get("settings", {}).get("waiver_budget_used") or 0)
        waiver_type = {0: "Rolling priority", 1: "Reverse standings", 2: "FAAB"}.get(s.get("waiver_type"), str(s.get("waiver_type")))
        return {
            "league_id": lg["league_id"],
            "platform": lg.get("platform", "sleeper"),
            "platform_league_id": lg.get("platform_league_id"),
            "name": lg["name"],
            "season": lg["season"],
            "status": lg["status"],
            "avatar": lg.get("avatar"),
            "total_rosters": lg["total_rosters"],
            "roster_positions": lg["roster_positions"],
            "scoring_format": fmt,
            "pass_td": sc.get("pass_td"),
            "waiver": {
                "type": waiver_type,
                "type_code": s.get("waiver_type"),
                "budget": budget,
                "clear_days": s.get("waiver_clear_days"),
                "day_of_week": WEEKDAYS[s["waiver_day_of_week"]] if s.get("waiver_day_of_week") is not None else None,
                "days": s.get("waiver_days"),
                "hour": s.get("waiver_hour"),
                "daily": bool(s.get("daily_waivers")),
                "bid_min": s.get("waiver_bid_min", 0),
            },
            "reserve_slots": s.get("reserve_slots", 0),
            "taxi_slots": s.get("taxi_slots", 0),
            "trade_deadline": s.get("trade_deadline"),
            "trade_deadline_date": s.get("trade_deadline_date"),
            "playoff_week_start": s.get("playoff_week_start"),
            "ros_end_week": self._ros_end_week(lg),
            "my_roster_id": mine["roster_id"] if mine else None,
            "my_team": {
                # _owner falls back through user metadata -> roster metadata -> display name, so
                # team_name is always something a human recognises even in leagues nobody renamed.
                "team_name": self._owner(b, mine)["team_name"] if mine else None,
                "wins": mine["settings"].get("wins", 0), "losses": mine["settings"].get("losses", 0), "ties": mine["settings"].get("ties", 0),
                "fpts": _pts(mine["settings"], "fpts"), "waiver_position": mine["settings"].get("waiver_position"),
                "faab_used": faab_used, "faab_remaining": budget - faab_used,
            } if mine else None,
        }

    # ------------------------------------------------------------- week context
    async def _schedule_maps(self, season: str) -> tuple[dict[str, int | None], dict[int, dict[str, str]], dict[int, dict[str, dict]]]:
        """(byes, opponent labels, per-team game info) keyed by week.

        Canceled games are skipped throughout: the 2026 schedule carries one (DAL-SEA, week 6),
        and counting it would both invent an opponent and hide the bye it created.
        """
        games = await self.s.schedule(season)
        teams_by_week: dict[int, set[str]] = {}
        opp: dict[int, dict[str, str]] = {}
        info: dict[int, dict[str, dict]] = {}
        for g in games:
            if g.get("status") == "canceled":
                continue
            w = int(g["week"])
            teams_by_week.setdefault(w, set()).update([g["home"], g["away"]])
            opp.setdefault(w, {})[g["home"]] = f"vs {g['away']}"
            opp[w][g["away"]] = f"@ {g['home']}"
            row = {"game_id": g.get("game_id"), "date": g.get("date"), "status": g.get("status")}
            info.setdefault(w, {})[g["home"]] = row
            info[w][g["away"]] = row
        all_teams: set[str] = set().union(*teams_by_week.values()) if teams_by_week else set()
        byes: dict[str, int | None] = {}
        for t in all_teams:
            missing = [w for w in sorted(teams_by_week) if t not in teams_by_week[w]]
            byes[t] = missing[0] if missing else None
        return byes, opp, info

    async def _proj_index(self, season: str, week: int) -> dict[str, dict]:
        if week > REGULAR_SEASON_WEEKS:
            return {}
        recs = await self.s.projections(season, week)
        return {r["player_id"]: r for r in recs}

    async def _stats_index(self, season: str, week: int, final: bool) -> dict[str, dict]:
        recs = await self.s.stats(season, week, final=final)
        return {r["player_id"]: r for r in recs}

    async def _usage_index(self, season: str, week: int) -> dict[str, dict]:
        """Last completed week's opportunity, not points: snap share and the volume that drives
        a role. This is what separates a genuine breakout from one loud box score — a back who
        took 70% of snaps is a different asset from one who scored on his only carry."""
        if week < 1:
            return {}
        recs = await self._stats_index(season, week, final=True)
        out: dict[str, dict] = {}
        for pid, rec in recs.items():
            st = rec.get("stats") or {}
            if not st:
                continue
            off, tm = st.get("off_snp"), st.get("tm_off_snp")
            tgt, car = st.get("rec_tgt"), st.get("rush_att")
            row = {
                "lw_snap_pct": round(float(off) / float(tm), 3) if off and tm else None,
                "lw_snaps": int(off) if off else None,
                "lw_targets": int(tgt) if tgt else None,
                "lw_carries": int(car) if car else None,
                "lw_rec": int(st["rec"]) if st.get("rec") else None,
                "lw_rz": (int(st.get("rec_rz_tgt") or 0) + int(st.get("rush_rz_att") or 0)) or None,
            }
            # The scorer picks whichever of these defines the player's position (targets for a
            # receiver, carries for a back, attempts for a quarterback), so all three are kept.
            row["lw_pass_att"] = int(st["pass_att"]) if st.get("pass_att") else None
            row["lw_volume"] = ((int(tgt) if tgt else 0) + (int(car) if car else 0)) or row["lw_pass_att"]
            out[pid] = row
        return out

    def _expert(self) -> dict | None:
        """Curated waiver-column notes, reloaded when the file changes on disk."""
        path = DATA_DIR / wv.EXPERT_FILE
        stamp = path.stat().st_mtime if path.exists() else None
        if stamp != self._expert_stamp:
            self._expert_raw = wv.load_expert(DATA_DIR)
            self._expert_stamp = stamp
        return self._expert_raw

    def _articles(self, season: str, week: int) -> dict | None:
        """This week's waiver-column summary. Shown as its own block, never mixed into the
        ranked table — that table is numbers only."""
        return wv.article_digest(self._expert(), season, week)

    async def _trending_maps(self) -> dict[str, dict[str, int]]:
        a24, a168, d24, d168 = await asyncio.gather(
            self.s.trending("add", 24), self.s.trending("add", 168),
            self.s.trending("drop", 24), self.s.trending("drop", 168),
        )
        conv = lambda rows: {r["player_id"]: int(r["count"]) for r in rows}  # noqa: E731
        return {"adds_24h": conv(a24), "adds_7d": conv(a168), "drops_24h": conv(d24), "drops_7d": conv(d168)}

    @staticmethod
    def _points_by_week(indexes: list[dict[str, dict]], weeks: list[int], scoring: dict) -> dict[str, dict]:
        out: dict[str, dict] = {}
        for w, idx in zip(weeks, indexes):
            for pid, rec in idx.items():
                pts = score(rec.get("stats"), scoring)
                if pts is None or not rec.get("stats", {}).get("gp"):
                    continue
                e = out.setdefault(pid, {"total": 0.0, "gp": 0, "weeks": {}})
                e["total"] += pts
                e["gp"] += 1
                e["weeks"][w] = pts
        return out

    async def _week_points(self, season: str, week: int, scoring: dict) -> dict[str, float]:
        """Points scored in the week being viewed, which may still be in progress.

        Kept apart from `season_pts`, which only covers completed weeks: folding a live week into
        the season total would make points-per-game lurch around during the games. Cached for ten
        minutes rather than a day, since the number is still moving.
        """
        recs = await self._stats_index(season, week, final=False)
        out: dict[str, float] = {}
        for pid, rec in recs.items():
            st = rec.get("stats") or {}
            pts = score(st, scoring) if st else None
            if pts is not None:
                out[pid] = pts
        return out

    async def _week_context(self, b: dict, week: int) -> dict:
        """Everything needed to enrich a player for one league/week."""
        league = b["league"]
        if league.get("platform") == "espn":
            return await self._espn_week_context(b, week)
        if league.get("platform") == "yahoo":
            return await self._yahoo_week_context(b, week)
        st = await self.state()
        season = str(league["season"])
        prev_season = str(int(season) - 1)
        scoring = league["scoring_settings"]
        ros_end = self._ros_end_week(league)
        ros_weeks = list(range(week, ros_end + 1))
        past_weeks = list(range(1, week)) if season == st["season"] else list(range(1, REGULAR_SEASON_WEEKS + 1))
        prev_weeks = list(range(1, REGULAR_SEASON_WEEKS + 1))

        players, (byes, opp, sched), research, trending, injuries, proj_by_week, past_stats, prev_stats = await asyncio.gather(
            self.s.players(),
            self._schedule_maps(season),
            self.s.research(season, week),
            self._trending_maps(),
            self.s.injuries(),
            asyncio.gather(*(self._proj_index(season, w) for w in ros_weeks)),
            asyncio.gather(*(self._stats_index(season, w, final=True) for w in past_weeks)),
            asyncio.gather(*(self._stats_index(prev_season, w, final=True) for w in prev_weeks)),
        )
        usage, week_pts = await asyncio.gather(self._usage_index(season, week - 1),
                                               self._week_points(season, week, scoring))
        proj: dict[int, dict[str, dict]] = dict(zip(ros_weeks, proj_by_week))
        next_proj = proj.get(week + 1)
        if next_proj is None:
            next_proj = await self._proj_index(season, week + 1)

        return {
            "platform": "sleeper",
            "season": season, "week": week, "ros_end_week": ros_end, "scoring": scoring,
            "players": players, "byes": byes, "opp": opp, "sched": sched, "research": research, "trending": trending,
            "injuries": injuries, "proj": proj, "next_proj": next_proj or {},
            "season_pts": self._points_by_week(past_stats, past_weeks, scoring),
            "week_pts": week_pts,
            "prev_pts": self._points_by_week(prev_stats, prev_weeks, scoring),
            "usage": usage,
        }

    async def _espn_week_context(self, b: dict, week: int) -> dict:
        """ESPN leagues: ESPN supplies league-scored current-week and season projections, ownership and
        availability; Sleeper supplies identity, schedule, trending, injuries, next-week projections and
        actual stats (scored with the league's translated scoring settings)."""
        assert self.espn is not None
        st = await self.state()
        league = b["league"]
        raw_id = league["platform_league_id"]
        season = str(league["season"])
        prev_season = str(int(season) - 1)
        scoring = {**league["scoring_settings"], PSEUDO_STAT: 1.0}
        ros_end = self._ros_end_week(league)
        past_weeks = list(range(1, week)) if season == st["season"] else list(range(1, REGULAR_SEASON_WEEKS + 1))
        prev_weeks = list(range(1, REGULAR_SEASON_WEEKS + 1))
        stat_ids = [espn_stat_id(1, 1, season, week), espn_stat_id(1, 0, season), espn_stat_id(0, 0, season), espn_stat_id(0, 0, prev_season)]

        players, (byes, opp, sched), trending, injuries, next_proj, past_stats, prev_stats, xw, pro_teams, fa_pool, team_pool = await asyncio.gather(
            self.s.players(),
            self._schedule_maps(season),
            self._trending_maps(),
            self.s.injuries(),
            self._proj_index(season, week + 1),
            asyncio.gather(*(self._stats_index(season, w, final=True) for w in past_weeks)),
            asyncio.gather(*(self._stats_index(prev_season, w, final=True) for w in prev_weeks)),
            self._crosswalk(),
            self.espn.pro_teams(season),
            self.espn.pool(raw_id, season, ("FREEAGENT", "WAIVERS"), 600, stat_ids),
            self.espn.pool(raw_id, season, ("ONTEAM",), 400, stat_ids),
        )
        usage, week_pts = await asyncio.gather(self._usage_index(season, week - 1),
                                               self._week_points(season, week, scoring))
        info_fa, syn_fa = espn_normalize_pool(fa_pool, season, week, xw, pro_teams)
        info_team, syn_team = espn_normalize_pool(team_pool, season, week, xw, pro_teams)
        info = {**info_fa, **info_team}
        merged_players = dict(players)
        merged_players.update(b.get("synthetic", {}))
        merged_players.update(syn_fa)
        merged_players.update(syn_team)

        proj = {week: {pid: {"stats": {PSEUDO_STAT: i["proj_week"]}} for pid, i in info.items() if i.get("proj_week") is not None}}
        research = {pid: {"owned": i.get("owned") or 0.0, "started": i.get("started") or 0.0} for pid, i in info.items()}
        ros_override = {pid: round(max(0.0, (i["season_proj"] or 0.0) - (i.get("season_actual") or 0.0)), 1)
                        for pid, i in info.items() if i.get("season_proj") is not None}
        rostered = {pid for r in b["rosters"] for pid in (r.get("players") or []) + (r.get("reserve") or [])}

        return {
            "platform": "espn",
            "season": season, "week": week, "ros_end_week": ros_end, "scoring": scoring,
            "players": merged_players, "byes": byes, "opp": opp, "sched": sched, "research": research, "trending": trending,
            "injuries": injuries, "proj": proj, "next_proj": next_proj or {},
            "season_pts": self._points_by_week(past_stats, past_weeks, scoring),
            "week_pts": week_pts,
            "prev_pts": self._points_by_week(prev_stats, prev_weeks, scoring),
            "ros_override": ros_override, "espn": info, "pool_ids": set(info) | rostered,
            "usage": usage,
        }

    async def _yahoo_week_context(self, b: dict, week: int) -> dict:
        """Yahoo leagues: Yahoo has no projections, so Sleeper supplies identity, schedule, trending,
        injuries, projections and actual stats (scored with the league's translated Yahoo scoring), and
        Yahoo supplies the free-agent/waiver pool with its own ownership."""
        assert self.yahoo is not None
        st = await self.state()
        league = b["league"]
        season = str(league["season"])
        prev_season = str(int(season) - 1)
        scoring = league["scoring_settings"]
        ros_end = self._ros_end_week(league)
        ros_weeks = list(range(week, ros_end + 1))
        past_weeks = list(range(1, week)) if season == st["season"] else list(range(1, REGULAR_SEASON_WEEKS + 1))
        prev_weeks = list(range(1, REGULAR_SEASON_WEEKS + 1))

        players, (byes, opp, sched), research0, trending, injuries, proj_by_week, past_stats, prev_stats, xw, pool = await asyncio.gather(
            self.s.players(),
            self._schedule_maps(season),
            self.s.research(season, week),
            self._trending_maps(),
            self.s.injuries(),
            asyncio.gather(*(self._proj_index(season, w) for w in ros_weeks)),
            asyncio.gather(*(self._stats_index(season, w, final=True) for w in past_weeks)),
            asyncio.gather(*(self._stats_index(prev_season, w, final=True) for w in prev_weeks)),
            self._crosswalk(),
            self.yahoo.pool(league["platform_league_id"]),
        )
        proj: dict[int, dict[str, dict]] = dict(zip(ros_weeks, proj_by_week))
        next_proj = proj.get(week + 1)
        if next_proj is None:
            next_proj = await self._proj_index(season, week + 1)

        usage, week_pts = await asyncio.gather(self._usage_index(season, week - 1),
                                               self._week_points(season, week, scoring))
        info, syn = yahoo_normalize_pool(pool, xw)
        merged_players = dict(players)
        merged_players.update(b.get("synthetic", {}))
        merged_players.update(syn)

        # Sleeper's league-wide ownership is the base; Yahoo's own percentages override where we have them.
        research = {pid: {"owned": r.get("owned") or 0.0, "started": r.get("started") or 0.0} for pid, r in research0.items()}
        for pid, i in info.items():
            if i.get("owned") is not None:
                research.setdefault(pid, {"owned": 0.0, "started": 0.0})["owned"] = i["owned"]
        rostered = {pid for r in b["rosters"] for pid in (r.get("players") or []) + (r.get("reserve") or [])}

        return {
            "platform": "yahoo",
            "season": season, "week": week, "ros_end_week": ros_end, "scoring": scoring,
            "players": merged_players, "byes": byes, "opp": opp, "sched": sched, "research": research, "trending": trending,
            "injuries": injuries, "proj": proj, "next_proj": next_proj or {},
            "season_pts": self._points_by_week(past_stats, past_weeks, scoring),
            "week_pts": week_pts,
            "prev_pts": self._points_by_week(prev_stats, prev_weeks, scoring),
            "yahoo": info,
            # Deliberately no pool_ids: availability is "not on anyone's roster here", the same
            # definition the Sleeper path uses. Yahoo paginates its player list 25 rows at a time
            # and this league alone has 414 available receivers, so scoping the pool to whatever
            # the scrape reached silently hid real free agents (a rank-154 receiver, in practice).
            # The scrape still supplies Yahoo's own ownership and FA/waiver status where it got
            # that far; beyond it, Sleeper's league-wide ownership stands in.
            "usage": usage,
        }

    # --------------------------------------------------------- player builders
    def _base(self, ctx: dict, pid: str) -> dict | None:
        p = ctx["players"].get(pid)
        if p is None:
            return None
        inj = ctx["injuries"].get(pid) or {}
        team = p.get("team")
        week = ctx["week"]
        game = (ctx.get("sched") or {}).get(week, {}).get(team) if team else None
        name = p.get("full_name") or f"{p.get('first_name', '')} {p.get('last_name', '')}".strip() or pid
        if p.get("position") == "DEF":
            name = f"{team} D/ST" if team else name
        return {
            "player_id": pid,
            "name": name,
            "position": p.get("position"),
            "positions": p.get("fantasy_positions") or ([p["position"]] if p.get("position") else []),
            "team": team,
            "number": p.get("number"),
            "age": p.get("age"),
            "years_exp": p.get("years_exp"),
            "status": p.get("status"),
            "injury_status": inj.get("injury_status", p.get("injury_status")),
            "injury_body_part": inj.get("injury_body_part", p.get("injury_body_part")),
            "injury_notes": inj.get("injury_notes", p.get("injury_notes")),
            "practice_participation": p.get("practice_participation"),
            "depth_chart_position": p.get("depth_chart_position"),
            "depth_chart_order": p.get("depth_chart_order"),
            "news_updated": p.get("news_updated"),
            "bye_week": ctx["byes"].get(team) if team else None,
            "opponent": ctx["opp"].get(week, {}).get(team) if team else None,
            "on_bye": bool(team) and ctx["byes"].get(team) == week,
            "game_date": (game or {}).get("date"),
            "game_status": (game or {}).get("status"),
            # Answered against the NFL's own calendar day, not the browser's, so every client
            # agrees on which players are in action right now. See today_et().
            "playing_today": bool(game) and game.get("date") == today_et(),
            **self._fp_fields(pid),
        }

    def _enrich(self, ctx: dict, pid: str) -> dict | None:
        row = self._base(ctx, pid)
        if row is None:
            return None
        scoring = ctx["scoring"]
        week = ctx["week"]
        cur = ctx["proj"].get(week, {}).get(pid)
        nxt = ctx["next_proj"].get(pid)
        ros = 0.0
        ros_any = False
        for w, idx in ctx["proj"].items():
            rec = idx.get(pid)
            pts = score(rec.get("stats") if rec else None, scoring)
            if pts is not None:
                ros += pts
                ros_any = True
        if "ros_override" in ctx:
            ov = ctx["ros_override"].get(pid)
            ros, ros_any = (ov, True) if ov is not None else (0.0, False)
        r = ctx["research"].get(pid) or {}
        sp = ctx["season_pts"].get(pid)
        pp = ctx["prev_pts"].get(pid)
        last_week = sp["weeks"].get(week - 1) if sp else None
        t = ctx["trending"]
        row.update({
            "owned": r.get("owned", 0.0),
            "started": r.get("started", 0.0),
            "adds_24h": t["adds_24h"].get(pid, 0),
            "adds_7d": t["adds_7d"].get(pid, 0),
            "drops_24h": t["drops_24h"].get(pid, 0),
            "drops_7d": t["drops_7d"].get(pid, 0),
            "proj_week": score(cur.get("stats") if cur else None, scoring),
            "proj_next": score(nxt.get("stats") if nxt else None, scoring),
            "proj_ros": round(ros, 1) if ros_any else None,
            "week_pts": ctx.get("week_pts", {}).get(pid),
            "last_week_pts": last_week,
            "season_pts": round(sp["total"], 1) if sp else None,
            "season_gp": sp["gp"] if sp else 0,
            "season_ppg": round(sp["total"] / sp["gp"], 1) if sp and sp["gp"] else None,
            "prev_season_ppg": round(pp["total"] / pp["gp"], 1) if pp and pp["gp"] else None,
            "prev_season_gp": pp["gp"] if pp else 0,
            **(ctx.get("usage", {}).get(pid) or {}),
        })
        espn = ctx.get("espn", {}).get(pid) if ctx.get("espn") else None
        if espn:
            # Sleeper lists some ESPN "RB"s as FB and some D/ST-eligible players as DT/LB; use ESPN's position there.
            if row["position"] not in FANTASY_POSITIONS and espn.get("position"):
                row["position"] = espn["position"]
                row["positions"] = [espn["position"]]
            row["platform_status"] = espn.get("status")
            row["waiver_until"] = espn.get("waiver_until")
            row["owned_change"] = espn.get("owned_change")
            row["proj_season"] = espn.get("season_proj")
            if espn.get("season_actual") is not None and sp:
                row["season_pts"] = round(float(espn["season_actual"]), 1)
                row["season_ppg"] = round(float(espn["season_actual"]) / sp["gp"], 1) if sp["gp"] else None
            if espn.get("prev_season_avg") is not None:
                row["prev_season_ppg"] = round(float(espn["prev_season_avg"]), 1)
            if row.get("injury_status") is None and espn.get("injury_status"):
                row["injury_status"] = espn["injury_status"]
        yh = ctx.get("yahoo", {}).get(pid) if ctx.get("yahoo") else None
        if yh:
            if row["position"] not in FANTASY_POSITIONS and yh.get("position"):
                row["position"] = yh["position"]
                row["positions"] = [yh["position"]]
            row["platform_status"] = yh.get("status")
            row["waiver_until"] = yh.get("waiver_until")
            row["owned_change"] = yh.get("owned_change")
            row["rank_preseason"] = yh.get("rank_preseason")
            row["rank_actual"] = yh.get("rank_actual")
            pre, act = yh.get("rank_preseason"), yh.get("rank_actual")
            # Ranks count upward, so preseason minus actual is positive for a player who has
            # climbed: Yahoo's own read on who is breaking out.
            row["rank_delta"] = round(pre - act) if pre and act else None
            if row.get("injury_status") is None and yh.get("injury_status"):
                row["injury_status"] = yh["injury_status"]
        return row

    def _rank_by_position(self, rows: list[dict], key: str, out_key: str) -> None:
        by_pos: dict[str, list[dict]] = {}
        for r in rows:
            by_pos.setdefault(r["position"], []).append(r)
        for pos, group in by_pos.items():
            group.sort(key=lambda r: -(r.get(key) or 0.0))
            for i, r in enumerate(group, 1):
                r[out_key] = f"{pos}{i}" if r.get(key) else None

    def _pool_ids(self, ctx: dict) -> list[str]:
        """All fantasy-relevant players (rostered or not) for ranking purposes."""
        if "pool_ids" in ctx:
            return sorted(ctx["pool_ids"])
        ids = []
        week = ctx["week"]
        for pid, p in ctx["players"].items():
            pos = p.get("position")
            if pos not in FANTASY_POSITIONS or not p.get("team"):
                continue
            if pos == "DEF" or p.get("status") == "Active" or pid in ctx["proj"].get(week, {}) or pid in ctx["research"]:
                ids.append(pid)
        return ids

    @staticmethod
    def _rostered(bundle: dict) -> dict[str, dict]:
        """player_id -> roster (players + reserve + taxi) across the league."""
        out: dict[str, dict] = {}
        for r in bundle["rosters"]:
            for pid in (r.get("players") or []) + (r.get("reserve") or []) + (r.get("taxi") or []):
                out[pid] = r
        return out

    # ------------------------------------------------------------------ views
    async def _espn_movers(self, b: dict, ctx: dict, week: int, rostered: dict) -> list[dict]:
        """ESPN's biggest ownership swings, fetched sorted by change rather than filtered out of
        the ownership-sorted pool — the players being added hardest are usually the ones that pool
        cuts off."""
        assert self.espn is not None
        league = b["league"]
        season = str(league["season"])
        stat_ids = [espn_stat_id(1, 1, season, week), espn_stat_id(1, 0, season),
                    espn_stat_id(0, 0, season), espn_stat_id(0, 0, str(int(season) - 1))]
        raw, xw, pro_teams = await asyncio.gather(
            self.espn.movers(league["platform_league_id"], season, stat_ids),
            self._crosswalk(), self.espn.pro_teams(season))
        info, _ = espn_normalize_pool(raw, season, week, xw, pro_teams)
        out = []
        for pid, i in info.items():
            if pid in rostered or i.get("owned_change") in (None, 0):
                continue
            row = self._enrich(ctx, pid)
            if not row or row["position"] in ("K", "DEF"):
                continue
            out.append({**row, "owned_change": i["owned_change"], "owned": i.get("owned") or row.get("owned")})
        out.sort(key=lambda r: -(r["owned_change"] or 0))
        return out

    async def _yahoo_movers(self, b: dict, pool: list[dict]) -> list[dict]:
        """Yahoo's Transaction Trends counts, joined onto the pool rows we already have."""
        assert self.yahoo is not None
        raw, xw = await asyncio.gather(self.yahoo.buzz(b["league"]["platform_league_id"]), self._crosswalk())
        counts = yahoo_normalize_buzz(raw, xw)
        out = [{**r, **counts[r["player_id"]]} for r in pool if r["player_id"] in counts]
        out.sort(key=lambda r: -(r.get("adds") or 0))
        return out

    async def _pending_claims(self, b: dict, week: int) -> list[dict]:
        """Waiver claims you have submitted that have not run yet.

        Every platform treats these as private to the manager who made them, so this is always
        "mine", never the league's. Worth surfacing next to the pool: the thing you most want to
        know while reading a waiver page is what you have already bid on, and for how much.
        """
        lg = b["league"]
        platform, raw_id = lg.get("platform", "sleeper"), lg["platform_league_id"]
        mine = b.get("my_roster") or {}
        players = await self.s.players()

        def name_of(pid: str | None) -> str | None:
            p = players.get(pid) if pid else None
            return (p or {}).get("full_name") or (b.get("synthetic", {}).get(pid) or {}).get("full_name") or pid

        try:
            if platform == "yahoo" and self.yahoo:
                xw = await self._crosswalk()
                rows = await self.yahoo.pending(raw_id, str(mine.get("roster_id") or ""))
                return yahoo_normalize_pending(rows, xw)
            if platform == "espn" and self.espn:
                raw, xw = await asyncio.gather(
                    self.espn.pending(raw_id, str(lg["season"])), self._crosswalk())
                resolver = {**{eid: pid for eid, pid in xw.espn.items()},
                            **{v: k for k, v in b.get("espn_ids", {}).items()}}
                out = []
                for t in espn_normalize_transactions(raw, resolver):
                    if mine and t["roster_ids"] and mine["roster_id"] not in t["roster_ids"]:
                        continue
                    for pid in t["adds"]:
                        out.append({"player_id": pid, "name": name_of(pid),
                                    "bid": (t.get("settings") or {}).get("waiver_bid"),
                                    "priority": None, "runs_on": None,
                                    "drop_player_id": next(iter(t["drops"]), None)})
                return out
            if platform == "sleeper":
                txs = await self.s.transactions(raw_id, week)
                out = []
                for t in txs:
                    if t.get("status") != "pending":
                        continue
                    if mine and mine["roster_id"] not in (t.get("roster_ids") or []):
                        continue
                    for pid in (t.get("adds") or {}):
                        out.append({"player_id": pid, "name": name_of(pid),
                                    "bid": (t.get("settings") or {}).get("waiver_bid"),
                                    "priority": None, "runs_on": None,
                                    "drop_player_id": next(iter(t.get("drops") or {}), None)})
                return out
        except Exception:
            # A pending-claims lookup failing should never take the waiver page with it.
            return []
        return []

    async def _team_odds(self, season: str, week: int) -> dict[str, dict]:
        """team -> {implied, opp_implied, label, weather} for one week. A team missing from the
        result has no game that week. Weather is only ever present for the current week — ESPN
        publishes no forecast further out than a few days."""
        if not self.odds:
            return {}
        try:
            payload = await self.odds.week(int(season), week)
        except Exception:
            return {}
        out: dict[str, dict] = {}
        for g in payload.get("games") or []:
            away, home = g.get("away"), g.get("home")
            ai, hi = g.get("away_implied"), g.get("home_implied")
            wx = g.get("weather")
            if away:
                out[away] = {"implied": ai, "opp_implied": hi, "label": f"@ {home}", "weather": wx}
            if home:
                out[home] = {"implied": hi, "opp_implied": ai, "label": f"vs {away}", "weather": wx}
        return out

    async def waivers(self, league_id: str, week: int | None) -> dict:
        """Several reads on the pool, not one ranking.

        The claimable pool is ordered three separate ways — by FantasyPros' waiver shortlist, by
        what players actually scored last week, and by the snap share and volume that lead
        scoring — so that where those disagree stays visible instead of averaging out.
        K and D/ST are left out: they are matchup plays rather than assets, and `streaming`
        handles them across every league at once.
        """
        b = await self._league_bundle(league_id)
        week = week or self._claim_week(await self.state())
        ctx = await self._week_context(b, week)
        rostered = self._rostered(b)
        rows = [r for r in (self._enrich(ctx, pid) for pid in self._pool_ids(ctx)) if r and r["position"] in FANTASY_POSITIONS]
        self._rank_by_position(rows, "proj_week", "proj_week_rank")
        self._rank_by_position(rows, "proj_ros", "proj_ros_rank")
        free = [r for r in rows if r["player_id"] not in rostered]

        # "vs mine": how much better (rest of season) than the weakest player I roster at that
        # position. FLEX-eligible positions compare against my weakest RB/WR/TE so a WR can show
        # as an upgrade over a bad RB.
        my_ids = set((b["my_roster"] or {}).get("players") or [])
        mine = [r for r in rows if r["player_id"] in my_ids]
        flex = {"RB", "WR", "TE"}

        def weakest(pos: str) -> float | None:
            group = [r for r in mine if (r["position"] in flex if pos in flex else r["position"] == pos)]
            vals = [r.get("proj_ros") or 0.0 for r in group]
            return min(vals) if vals else None
        weakest_by_pos = {pos: weakest(pos) for pos in FANTASY_POSITIONS}
        for r in free:
            base = weakest_by_pos.get(r["position"])
            r["vs_mine"] = round((r.get("proj_ros") or 0.0) - base, 1) if base is not None and r.get("proj_ros") is not None else None

        season = str(b["league"]["season"])
        lg = self._league_summary(b)

        # Two reads on the same pool rather than one blended ranking: the expert shortlist, which
        # looks forward, and what actually happened on the field last week, which looks back.
        # Kept separate so the places they disagree stay visible. K and D/ST belong to the
        # streamers below.
        pool = [r for r in free if r["position"] not in ("K", "DEF")]
        by_fantasypros = sorted(
            [r for r in pool if r.get("fp_waiver_rank")], key=lambda r: r["fp_waiver_rank"])
        by_production = wv.rank_by_production(pool)
        # Each platform publishes its own read on which way a player is moving, and each means
        # something different, so the panel is labelled per platform rather than pretending they
        # are one metric: Sleeper counts adds and drops league-wide, ESPN gives the change in the
        # percentage of teams rostering a player, and Yahoo gives the gap between where it ranked
        # him before the season and where he sits now.
        platform = lg.get("platform")
        if platform == "sleeper":
            movers = sorted([r for r in pool if (r.get("adds_24h") or 0) > 0 or (r.get("drops_24h") or 0) > 0],
                            key=lambda r: -(r.get("adds_24h") or 0))
            movement = {"kind": "sleeper", "label": "Sleeper adds and drops",
                        "blurb": "What every Sleeper manager is doing right now, league-wide. The fastest signal here and the noisiest — it moves on news before the box score does, and just as hard on hype."}
        elif platform == "espn":
            movers = await self._espn_movers(b, ctx, week, rostered)
            movement = {"kind": "espn", "label": "ESPN most added and dropped",
                        "blurb": "ESPN publishes no add counts, only the shift in how many teams roster a player — so this is that shift, which is what drives its own most-added list. Sort ascending for the drops."}
        elif platform == "yahoo":
            movers = await self._yahoo_movers(b, pool)
            movement = {"kind": "yahoo", "label": "Yahoo transaction trends",
                        "blurb": "Yahoo's own count of adds and drops across every Yahoo league, from its Transaction Trends page."}
        else:
            movers, movement = [], None
        by_trending = movers if movement else None

        return {
            "league": lg,
            "week": week,
            "ros_end_week": ctx["ros_end_week"],
            "by_fantasypros": by_fantasypros[:40],
            "by_production": by_production[:150],
            "by_trending": by_trending[:40] if by_trending is not None else None,
            "movement": movement,
            "pending": await self._pending_claims(b, week),
            "articles": self._articles(season, week),
            "players": free,
        }

    @staticmethod
    def _claim_week(st: dict) -> int:
        """The week a claim made now processes into. Sleeper advances its `week` field once a
        slate is done while `display_week` can still read the week just played, so the later of
        the two is the week you are actually claiming into."""
        return min(REGULAR_SEASON_WEEKS, max(int(st["current_week"]), int(st.get("week") or 0)))

    @staticmethod
    def _roles(b: dict) -> dict[str, str]:
        """player_id -> where my roster has him: the starting slot he fills, else BN, IR or TAXI."""
        r = b["my_roster"] or {}
        slots = starting_slots(b["league"]["roster_positions"])
        role_of: dict[str, str] = {}
        for i, pid in enumerate(r.get("starters") or []):
            if pid and pid != "0":
                role_of[pid] = slots[i] if i < len(slots) else "START"
        for pid in r.get("reserve") or []:
            role_of[pid] = "IR"
        for pid in r.get("taxi") or []:
            role_of[pid] = "TAXI"
        for pid in r.get("players") or []:
            role_of.setdefault(pid, "BN")
        return role_of

    def _availability(self, b: dict, ctx: dict, rostered: dict[str, dict], roles: dict[str, str], pid: str) -> dict:
        """Where one player stands in one league: mine (and in which slot), someone else's, or
        claimable — split into free agent and waivers where the platform says which. Sleeper does
        not publish that split, so a Sleeper player off every roster is simply `free`."""
        r = rostered.get(pid)
        mine = b["my_roster"]
        if r is not None and mine is not None and r.get("roster_id") == mine.get("roster_id"):
            return {"status": "mine", "role": roles.get(pid, "BN")}
        if r is not None:
            return {"status": "taken", "owner": self._owner(b, r)["team_name"]}
        info = (ctx.get("espn") or ctx.get("yahoo") or {}).get(pid) or {}
        if info.get("status") == "WAIVERS":
            return {"status": "waivers", "until": info.get("waiver_until")}
        return {"status": "free"}

    async def streaming(self, week: int | None) -> dict:
        """Kickers and defences across every league at once.

        Streaming is one decision spread over several leagues: the same handful of good matchups
        is on offer everywhere, and what differs is only which of them is still open where. So
        this is one table per position with a row per unit — the next four weeks of lines across
        it, then its standing in each league — rather than a table per league that leaves you
        cross-referencing them. Ordering is Vegas alone, as `waivers.stream_table` describes;
        which league it is available in never moves a row.

        Every unit I roster anywhere is in the table whether or not anything else would put it
        there, so the one I have is always on the page beside the ones I could have.
        """
        me = await self.me()
        st = me["state"]
        week = week or self._claim_week(st)
        season = str(st["season"])
        bundles = await self._all_bundles(me)
        ctxs = await asyncio.gather(*(self._week_context(b, week) for b in bundles))

        # Four weeks: the schedule runs across each row, and a month is about as far as a claim
        # made now is worth planning against.
        weeks = list(range(week, min(REGULAR_SEASON_WEEKS, week + 3) + 1))
        odds_by_week = dict(zip(weeks, await asyncio.gather(*(self._team_odds(season, w) for w in weeks))))
        fp_data, fp_idx = self._fp()
        fp_week = ((fp_data or {}).get("sets", {}).get("weekly") or {}).get("week")
        # Kickers are cut to the ones FantasyPros ranks for the week — its K page runs about one
        # row per team, so being on it is the closest thing to a published starter list. Without
        # that cut a backup inherits his starter's implied total and ranks alongside him, which
        # is how a 0.1%-rostered practice-squad kicker ends up second on the list. Defences need
        # no equivalent; there is only one per team.
        k_starters = {pid for pid, row in (fp_idx.get("weekly") or {}).items() if row.get("position") == "K"} or None
        # Offensive efficiency for the kicker view — whether a team's points arrive as touchdowns
        # or as field goals, which the implied total cannot tell you. Columns, not ordering.
        team_factors = await teamstats.load(self.s.cache, season)

        # One row per unit, enriched from the first league that knows him. Sleeper leagues go
        # first because their context is Sleeper's own; nothing on these rows is league-scored.
        order = sorted(range(len(bundles)), key=lambda i: bundles[i]["league"].get("platform") != "sleeper")
        rows: dict[str, dict] = {}
        for i in order:
            ctx = ctxs[i]
            for pid in self._pool_ids(ctx):
                if pid in rows or (ctx["players"].get(pid) or {}).get("position") not in ("K", "DEF"):
                    continue
                row = self._enrich(ctx, pid)
                if row and row["position"] in ("K", "DEF"):
                    rows[pid] = row

        standing: dict[str, dict[str, dict]] = {}
        my_ids: set[str] = set()
        for b, ctx in zip(bundles, ctxs):
            lid = b["league"]["league_id"]
            rostered, roles = self._rostered(b), self._roles(b)
            my_ids.update((b["my_roster"] or {}).get("players") or [])
            for pid in rows:
                standing.setdefault(pid, {})[lid] = self._availability(b, ctx, rostered, roles, pid)

        tables: dict[str, list[dict]] = {}
        for pos in ("DEF", "K"):
            ros_ranks = {pid: row["rank_ecr"] for pid, row in (fp_idx.get(fp.ROS_POSITION_SETS[pos]) or {}).items()
                         if row.get("rank_ecr")}
            table = wv.stream_table([r for r in rows.values() if r["position"] == pos], pos, odds_by_week, weeks,
                                    fp_week, ros_ranks, k_starters if pos == "K" else None, team_factors, my_ids)
            tables[pos] = [{**r, "leagues": standing[r["player_id"]]} for r in table]

        return {
            "week": week,
            "weeks": weeks,
            "leagues": [{
                "league_id": b["league"]["league_id"],
                "name": b["league"]["name"],
                "platform": b["league"].get("platform", "sleeper"),
                "slots": {pos: b["league"]["roster_positions"].count(pos) for pos in ("K", "DEF")},
            } for b in bundles],
            "DEF": tables["DEF"],
            "K": tables["K"],
        }

    def _roster_view(self, ctx: dict, b: dict, roster: dict) -> dict:
        lg = b["league"]
        slots = starting_slots(lg["roster_positions"])
        starters = roster.get("starters") or []
        reserve = roster.get("reserve") or []
        taxi = roster.get("taxi") or []
        all_ids = roster.get("players") or []
        bench_ids = [pid for pid in all_ids if pid not in starters and pid not in reserve and pid not in taxi]

        def rows(ids: list[str]) -> list[dict]:
            return [r for r in (self._enrich(ctx, pid) for pid in ids) if r]

        starter_rows = []
        for i, slot in enumerate(slots):
            pid = starters[i] if i < len(starters) else None
            row = self._enrich(ctx, pid) if pid and pid != "0" else None
            starter_rows.append({"slot": slot, "player": row})

        # Optimal lineup from active (non-IR, non-taxi) players.
        active_ids = [pid for pid in all_ids if pid not in reserve and pid not in taxi]
        candidates = []
        enriched = {pid: self._enrich(ctx, pid) for pid in active_ids}
        slot_of = {pid: i for i, pid in enumerate(starters) if pid and pid != "0"}
        for pid, r in enriched.items():
            if not r:
                continue
            w = r.get("proj_week") or 0.0
            if r.get("injury_status") in OUT_STATUSES or r.get("on_bye"):
                w = 0.0
            candidates.append({"player_id": pid, "positions": r["positions"], "weight": w, "current_slot": slot_of.get(pid)})
        optimal = optimal_lineup(slots, candidates)
        optimal_rows = []
        cur_total = 0.0
        opt_total = 0.0
        for i, slot in enumerate(slots):
            cur = starter_rows[i]["player"]
            opt = enriched.get(optimal[i]) if optimal[i] else None
            cur_pts = (cur or {}).get("proj_week") or 0.0
            opt_pts = (opt or {}).get("proj_week") or 0.0
            cur_total += cur_pts
            opt_total += opt_pts
            optimal_rows.append({
                "slot": slot,
                "current": cur, "suggested": opt,
                "change": (cur or {}).get("player_id") != (opt or {}).get("player_id"),
                "delta": round(opt_pts - cur_pts, 2),
            })

        flags = []
        for sr in starter_rows:
            p = sr["player"]
            if p is None:
                flags.append({"level": "error", "text": f"{sr['slot']} slot is empty"})
            elif p.get("on_bye"):
                flags.append({"level": "error", "text": f"{p['name']} ({sr['slot']}) is on bye"})
            elif p.get("injury_status") in OUT_STATUSES:
                flags.append({"level": "error", "text": f"{p['name']} ({sr['slot']}) is {p['injury_status']}"})
            elif p.get("injury_status") in ("Doubtful", "Questionable"):
                flags.append({"level": "warn", "text": f"{p['name']} ({sr['slot']}) is {p['injury_status']}"})
        reserve_rows = rows(reserve)
        for r in reserve_rows:
            if not r.get("injury_status"):
                flags.append({"level": "warn", "text": f"{r['name']} is on IR but has no injury designation; may need to be activated"})
        ir_free = int(lg["settings"].get("reserve_slots", 0)) - len(reserve)
        if ir_free > 0:
            for r in rows(bench_ids):
                if r.get("injury_status") in ("IR", "PUP", "Out", "Sus", "COV"):
                    flags.append({"level": "info", "text": f"{r['name']} ({r['injury_status']}) could move to an open IR slot"})

        s = roster.get("settings", {})
        budget = int(lg["settings"].get("waiver_budget") or 0)
        return {
            "roster_id": roster["roster_id"],
            "owner": self._owner(b, roster),
            "is_mine": b["my_roster"] is not None and roster["roster_id"] == b["my_roster"]["roster_id"],
            "record": {"wins": s.get("wins", 0), "losses": s.get("losses", 0), "ties": s.get("ties", 0)},
            "fpts": _pts(s, "fpts"), "fpts_against": _pts(s, "fpts_against"), "ppts": _pts(s, "ppts"),
            "waiver_position": s.get("waiver_position"),
            "faab_used": int(s.get("waiver_budget_used") or 0),
            "faab_remaining": budget - int(s.get("waiver_budget_used") or 0),
            "total_moves": s.get("total_moves", 0),
            "starters": starter_rows,
            "bench": rows(bench_ids),
            "reserve": reserve_rows,
            "taxi": rows(taxi),
            "optimal": {"rows": optimal_rows, "current_total": round(cur_total, 2), "optimal_total": round(opt_total, 2),
                        "gain": round(opt_total - cur_total, 2)},
            "flags": flags,
        }

    async def rosters(self, league_id: str, week: int | None) -> dict:
        b = await self._league_bundle(league_id)
        st = await self.state()
        week = week or st["current_week"]
        ctx = await self._week_context(b, week)
        views = [self._roster_view(ctx, b, r) for r in b["rosters"]]
        views.sort(key=lambda v: (-v["record"]["wins"], -(v["fpts"] or 0)))
        return {"league": self._league_summary(b), "week": week, "rosters": views}

    async def transactions(self, league_id: str, weeks: int = 3) -> dict:
        b = await self._league_bundle(league_id)
        st = await self.state()
        week = st["current_week"]
        players = await self.s.players()
        wk_list = list(range(max(1, week - weeks + 1), week + 1))
        platform = b["league"].get("platform", "sleeper")
        if platform == "espn":
            assert self.espn is not None
            raw, xw = await asyncio.gather(self.espn.transactions(b["league"]["platform_league_id"], str(b["league"]["season"])), self._crosswalk())
            known = {v: k for k, v in b.get("espn_ids", {}).items()}
            resolver = {**{eid: pid for eid, pid in xw.espn.items()}, **known}
            txs_all = espn_normalize_transactions(raw, resolver)
            txs_all = [t for t in txs_all if (t.get("leg") or week) in wk_list]
            results = [txs_all]
        elif platform == "yahoo":
            assert self.yahoo is not None
            raw, xw = await asyncio.gather(self.yahoo.transactions(b["league"]["platform_league_id"]), self._crosswalk())
            resolver = {str(yid): pid for yid, pid in xw.yahoo.items()}
            resolver.update({v: k for k, v in b.get("yahoo_ids", {}).items()})
            results = [yahoo_normalize_transactions(raw, resolver)]
        else:
            results = await asyncio.gather(*(self.s.transactions(b["league"]["platform_league_id"], w) for w in wk_list))
        by_roster = {r["roster_id"]: self._owner(b, r) for r in b["rosters"]}
        names = dict(players)
        names.update(b.get("synthetic", {}))

        def pl(pid: str) -> dict:
            p = names.get(pid, {})
            return {"player_id": pid, "name": p.get("full_name") or (f"{pid} D/ST" if p.get("position") == "DEF" else pid),
                    "position": p.get("position"), "team": p.get("team")}

        out = []
        for txs in results:
            for t in txs:
                out.append({
                    "transaction_id": t["transaction_id"],
                    "type": t["type"], "status": t["status"], "week": t.get("leg"),
                    "created": t.get("created"), "status_updated": t.get("status_updated"),
                    "bid": (t.get("settings") or {}).get("waiver_bid"),
                    "notes": (t.get("metadata") or {}).get("notes"),
                    "adds": [{**pl(pid), "roster": by_roster.get(rid)} for pid, rid in (t.get("adds") or {}).items()],
                    "drops": [{**pl(pid), "roster": by_roster.get(rid)} for pid, rid in (t.get("drops") or {}).items()],
                    "rosters": [by_roster.get(rid) for rid in t.get("roster_ids") or []],
                    "draft_picks": t.get("draft_picks") or [],
                    "faab_moved": t.get("waiver_budget") or [],
                })
        out.sort(key=lambda t: -(t.get("status_updated") or t.get("created") or 0))
        return {"league": self._league_summary(b), "weeks": wk_list, "transactions": out}

    async def _all_bundles(self, me: dict) -> list[dict]:
        ids = [lg["league_id"] for lg in me["leagues"] if not lg.get("error")]
        return list(await asyncio.gather(*(self._league_bundle(lid, me["user"]["user_id"]) for lid in ids)))

    async def my_players(self, week: int | None) -> dict:
        me = await self.me()
        week = week or me["state"]["current_week"]
        bundles = await self._all_bundles(me)
        ctxs = await asyncio.gather(*(self._week_context(b, week) for b in bundles))
        merged: dict[str, dict] = {}
        for b, ctx in zip(bundles, ctxs):
            r = b["my_roster"]
            if not r:
                continue
            role_of = self._roles(b)
            for pid in r.get("players") or []:
                e = self._enrich(ctx, pid)
                if not e:
                    continue
                m = merged.setdefault(pid, {**e, "leagues": []})
                m["leagues"].append({
                    "league_id": b["league"]["league_id"], "league_name": b["league"]["name"],
                    "role": role_of.get(pid, "BN"), "proj_week": e.get("proj_week"), "proj_ros": e.get("proj_ros"),
                })
        rows = sorted(merged.values(), key=lambda r: (-len(r["leagues"]), -(r.get("proj_ros") or 0)))
        return {"week": week, "leagues": [{"league_id": b["league"]["league_id"], "name": b["league"]["name"], "platform": b["league"].get("platform", "sleeper")} for b in bundles], "players": rows}

    async def player_detail(self, player_id: str, league_id: str | None) -> dict:
        st = await self.state()
        season = st["season"]
        prev_season = str(int(season) - 1)
        scoring: dict[str, float] = {}
        if league_id:
            b = await self._league_bundle(league_id)
            scoring = b["league"]["scoring_settings"]
        if player_id.startswith("espn:"):
            return {"player": {"player_id": player_id, "name": player_id, "position": None, "team": None}, "scoring_league_id": league_id,
                    "current_season": [], "previous_season": [], "note": "No Sleeper record for this player; stats unavailable."}
        players, proj, stats, prev_stats, (byes, opp, _sched) = await asyncio.gather(
            self.s.players(), self.s.player_projections(player_id, season), self.s.player_stats(player_id, season),
            self.s.player_stats(player_id, prev_season), self._schedule_maps(season),
        )
        p = players.get(player_id, {})
        team = p.get("team")

        def week_rows(proj_map: dict, stat_map: dict, season_label: str, with_opp: bool) -> list[dict]:
            rows = []
            for w in range(1, REGULAR_SEASON_WEEKS + 1):
                pr = (proj_map or {}).get(str(w)) or {}
                sr = (stat_map or {}).get(str(w)) or {}
                if not pr and not sr:
                    continue
                rows.append({
                    "season": season_label, "week": w,
                    "opponent": (opp.get(w, {}).get(team) if with_opp and team else None) or sr.get("opponent") or pr.get("opponent"),
                    "proj_pts": score(pr.get("stats"), scoring) if scoring else _f((pr.get("stats") or {}).get("pts_half_ppr")),
                    "actual_pts": score(sr.get("stats"), scoring) if scoring else _f((sr.get("stats") or {}).get("pts_half_ppr")),
                    "proj": pr.get("stats") or {}, "stats": sr.get("stats") or {},
                })
            return rows

        return {
            "player": {"player_id": player_id, "name": p.get("full_name") or (f"{team} D/ST" if p.get("position") == "DEF" else player_id),
                       "position": p.get("position"), "team": team, "age": p.get("age"), "years_exp": p.get("years_exp"),
                       "college": p.get("college"), "height": p.get("height"), "weight": p.get("weight"), "number": p.get("number"),
                       "injury_status": p.get("injury_status"), "injury_body_part": p.get("injury_body_part"), "injury_notes": p.get("injury_notes"),
                       "depth_chart_position": p.get("depth_chart_position"), "depth_chart_order": p.get("depth_chart_order"),
                       "bye_week": byes.get(team) if team else None, "status": p.get("status")},
            "scoring_league_id": league_id,
            "fantasypros": self._fp_detail(player_id, p.get("position")),
            "current_season": week_rows(proj, stats, season, True),
            "previous_season": week_rows({}, prev_stats, prev_season, False),
        }


def _pts(settings: dict, key: str) -> float | None:
    if key not in settings:
        return None
    return round(float(settings.get(key, 0)) + float(settings.get(f"{key}_decimal", 0)) / 100, 2)
