"""Assembles the view models the UI needs. Sleeper is the canonical data source (player ids, schedule,
trending, injuries, projections); other platforms are normalized onto Sleeper's shapes and ids."""
from __future__ import annotations

import asyncio
import math
import time
from datetime import datetime, timezone
from typing import Any

from . import clock, faab, impact, targets
from .config import ESPN_LEAGUE_IDS, ESPN_SWID, FANTASY_POSITIONS, OUT_STATUSES, require_username
from .espn import Espn, normalize_league as espn_normalize_league, normalize_pool as espn_normalize_pool, \
    normalize_transactions as espn_normalize_transactions, stat_id as espn_stat_id
from .fantasypros import FantasyPros, scoring_key as fp_scoring_key
from .ids import Crosswalk, load_nflverse_ids
from .lineup import optimal_lineup, starting_slots
from .news import News
from .ranks import build_curves, disagreement, implied_points, lineup_weight, merge_pages
from .scoring import score
from .sleeper import Sleeper

WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]  # assumption: Sleeper's waiver_day_of_week is 0=Mon
REGULAR_SEASON_WEEKS = 18
PSEUDO_STAT = "_pts"  # lets platform-native point totals flow through score(): stats={"_pts": x}, scoring={"_pts": 1}
FP_WEEKLY_POSITIONS = ("qb", "rb", "wr", "te", "k", "dst")
NEWS_PLAYER_CAP = 300  # your players first, then claimable free agents, then everyone else's


def _f(x: Any) -> float | None:
    return None if x is None else float(x)


def parse_league_id(league_id: str) -> tuple[str, str]:
    """'espn:123' -> ('espn', '123'); bare ids are Sleeper."""
    if ":" in league_id:
        platform, _, raw = league_id.partition(":")
        return platform, raw
    return "sleeper", league_id


class Service:
    def __init__(self, sleeper: Sleeper, espn: Espn | None = None, fp: FantasyPros | None = None, news: News | None = None):
        self.s = sleeper
        self.espn = espn
        self.fp = fp
        self.news = news
        self._xw: tuple[int, Crosswalk] | None = None

    # ------------------------------------------------------------------ basics
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

    async def me(self) -> dict:
        user = await self.s.user(require_username())
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
        return await self._sleeper_bundle(raw, user_id)

    async def _sleeper_bundle(self, league_id: str, user_id: str | None = None) -> dict:
        if user_id is None:
            user_id = (await self.s.user(require_username()))["user_id"]
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
                "wins": mine["settings"].get("wins", 0), "losses": mine["settings"].get("losses", 0), "ties": mine["settings"].get("ties", 0),
                "fpts": _pts(mine["settings"], "fpts"), "waiver_position": mine["settings"].get("waiver_position"),
                "faab_used": faab_used, "faab_remaining": budget - faab_used,
            } if mine else None,
        }

    # ------------------------------------------------------------- week context
    async def _schedule_maps(self, season: str) -> tuple[dict[str, int | None], dict[int, dict[str, str]]]:
        games = await self.s.schedule(season)
        teams_by_week: dict[int, set[str]] = {}
        opp: dict[int, dict[str, str]] = {}
        for g in games:
            w = int(g["week"])
            teams_by_week.setdefault(w, set()).update([g["home"], g["away"]])
            opp.setdefault(w, {})[g["home"]] = f"vs {g['away']}"
            opp[w][g["away"]] = f"@ {g['home']}"
        all_teams: set[str] = set().union(*teams_by_week.values()) if teams_by_week else set()
        byes: dict[str, int | None] = {}
        for t in all_teams:
            missing = [w for w in sorted(teams_by_week) if t not in teams_by_week[w]]
            byes[t] = missing[0] if missing else None
        return byes, opp

    async def _fantasypros(self, scoring_settings: dict, week: int, waiver: bool = False) -> dict:
        """FantasyPros weekly and rest-of-season ranks, keyed by Sleeper player id.

        A failed page is reported rather than raised: the app still works on projections alone."""
        empty = {"by_pid": {}, "errors": [], "meta": None, "waiver_pool": 0}
        if not self.fp or not self.fp.enabled:
            return empty
        scoring = fp_scoring_key(scoring_settings.get("rec"))
        key = f"fp_map:{scoring}:{week}:{int(waiver)}"

        async def loader() -> dict:
            jobs = [self.fp.board("weekly", FP_WEEKLY_POSITIONS, scoring, week), self.fp.board("ros", ("overall",), scoring)]
            if waiver:
                jobs.append(self.fp.board("waiver", ("overall",), scoring))
            results = await asyncio.gather(*jobs)
            (weekly, w_err), (ros, r_err) = results[0], results[1]
            wire, wire_err = results[2] if waiver else ({}, [])
            xw = await self._crosswalk()

            by_pid: dict[str, dict] = {}

            def resolve(row: dict) -> str | None:
                return xw.from_fantasypros(row.get("fp_id"), row.get("name"), row.get("position"), row.get("team"))

            for row in merge_pages(weekly).values():
                pid = resolve(row)
                if pid:
                    by_pid[pid] = {
                        "fp_id": row["fp_id"], "pos_rank": row["pos_rank"], "pos_rank_n": row["pos_rank_n"],
                        "rank": row["rank"], "tier": row["tier"], "ecr_delta": row["ecr_delta"],
                        "rank_std": row["rank_std"], "owned_avg": row["owned_avg"], "opponent": row["opponent"],
                        "note": row["note"], "recommendation": row["recommendation"], "tag": row["tag"],
                        "position": row["position"],
                    }
            for row in merge_pages(ros).values():
                pid = resolve(row)
                if pid:
                    entry = by_pid.setdefault(pid, {"position": row["position"]})
                    entry.update({"ros_rank": row["rank"], "ros_pos_rank": row["pos_rank_n"],
                                  "ros_pos_rank_label": row["pos_rank"], "ros_tier": row["tier"],
                                  "ros_ecr_delta": row["ecr_delta"]})
                    entry.setdefault("owned_avg", row["owned_avg"])
            wire_rows = merge_pages(wire)
            for row in wire_rows.values():
                pid = resolve(row)
                if pid:
                    entry = by_pid.setdefault(pid, {"position": row["position"]})
                    entry.update({"waiver_rank": row["rank"], "waiver_tier": row["tier"],
                                  "waiver_note": row["note"] or row["recommendation"]})
            page = next(iter(weekly.values()), None) or next(iter(ros.values()), None)
            meta = {"scoring": scoring, "week": page.get("week") if page else week, "type": page.get("type") if page else None,
                    "experts": page.get("total_experts") if page else None,
                    "last_updated": page.get("last_updated") if page else None,
                    "fetched_at": page.get("fetched_at") if page else None,
                    "players": len(by_pid)} if page else None
            return {"by_pid": by_pid, "errors": w_err + r_err + wire_err, "meta": meta, "waiver_pool": len(wire_rows)}

        try:
            return await self.s.cache.get(key, 10 * 60, loader)
        except Exception as e:  # a scrape is best-effort; never take the page down with it
            return {**empty, "errors": [str(e)]}

    @staticmethod
    def _fp_curves(fp_by_pid: dict[str, dict], proj_week: dict[str, dict], scoring: dict, players: dict[str, dict]) -> dict[str, list[float]]:
        """Lay each position's ranked players over that position's projections, best on best."""
        items = []
        for pid, fp in fp_by_pid.items():
            rank = fp.get("pos_rank_n")
            position = fp.get("position") or (players.get(pid) or {}).get("position")
            rec = proj_week.get(pid)
            pts = score(rec.get("stats") if rec else None, scoring)
            if rank and position and pts is not None:
                items.append((position, rank, pts))
        return build_curves(items)

    async def _proj_index(self, season: str, week: int) -> dict[str, dict]:
        if week > REGULAR_SEASON_WEEKS:
            return {}
        recs = await self.s.projections(season, week)
        return {r["player_id"]: r for r in recs}

    async def _stats_index(self, season: str, week: int, final: bool) -> dict[str, dict]:
        recs = await self.s.stats(season, week, final=final)
        return {r["player_id"]: r for r in recs}

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

    async def _week_context(self, b: dict, week: int, waiver_ranks: bool = False) -> dict:
        """Everything needed to enrich a player for one league/week."""
        league = b["league"]
        if league.get("platform") == "espn":
            return await self._espn_week_context(b, week, waiver_ranks)
        st = await self.state()
        season = str(league["season"])
        prev_season = str(int(season) - 1)
        scoring = league["scoring_settings"]
        ros_end = self._ros_end_week(league)
        ros_weeks = list(range(week, ros_end + 1))
        past_weeks = list(range(1, week)) if season == st["season"] else list(range(1, REGULAR_SEASON_WEEKS + 1))
        prev_weeks = list(range(1, REGULAR_SEASON_WEEKS + 1))

        players, (byes, opp), research, trending, injuries, proj_by_week, past_stats, prev_stats, fp = await asyncio.gather(
            self.s.players(),
            self._schedule_maps(season),
            self.s.research(season, week),
            self._trending_maps(),
            self.s.injuries(),
            asyncio.gather(*(self._proj_index(season, w) for w in ros_weeks)),
            asyncio.gather(*(self._stats_index(season, w, final=True) for w in past_weeks)),
            asyncio.gather(*(self._stats_index(prev_season, w, final=True) for w in prev_weeks)),
            self._fantasypros(scoring, week, waiver_ranks),
        )
        proj: dict[int, dict[str, dict]] = dict(zip(ros_weeks, proj_by_week))
        next_proj = proj.get(week + 1)
        if next_proj is None:
            next_proj = await self._proj_index(season, week + 1)

        return {
            "platform": "sleeper",
            "season": season, "week": week, "ros_end_week": ros_end, "scoring": scoring,
            "players": players, "byes": byes, "opp": opp, "research": research, "trending": trending,
            "injuries": injuries, "proj": proj, "next_proj": next_proj or {},
            "season_pts": self._points_by_week(past_stats, past_weeks, scoring),
            "prev_pts": self._points_by_week(prev_stats, prev_weeks, scoring),
            "fp": fp["by_pid"], "fp_meta": fp["meta"], "fp_errors": fp["errors"], "fp_waiver_pool": fp["waiver_pool"],
            "fp_curves": self._fp_curves(fp["by_pid"], proj.get(week, {}), scoring, players),
        }

    async def _espn_week_context(self, b: dict, week: int, waiver_ranks: bool = False) -> dict:
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

        players, (byes, opp), trending, injuries, next_proj, past_stats, prev_stats, xw, pro_teams, fa_pool, team_pool, fp = await asyncio.gather(
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
            self._fantasypros(league["scoring_settings"], week, waiver_ranks),
        )
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
            "players": merged_players, "byes": byes, "opp": opp, "research": research, "trending": trending,
            "injuries": injuries, "proj": proj, "next_proj": next_proj or {},
            "season_pts": self._points_by_week(past_stats, past_weeks, scoring),
            "prev_pts": self._points_by_week(prev_stats, prev_weeks, scoring),
            "ros_override": ros_override, "espn": info, "pool_ids": set(info) | rostered,
            "fp": fp["by_pid"], "fp_meta": fp["meta"], "fp_errors": fp["errors"], "fp_waiver_pool": fp["waiver_pool"],
            "fp_curves": self._fp_curves(fp["by_pid"], proj.get(week, {}), scoring, merged_players),
        }

    # --------------------------------------------------------- player builders
    def _base(self, ctx: dict, pid: str) -> dict | None:
        p = ctx["players"].get(pid)
        if p is None:
            return None
        inj = ctx["injuries"].get(pid) or {}
        team = p.get("team")
        week = ctx["week"]
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
            "last_week_pts": last_week,
            "season_pts": round(sp["total"], 1) if sp else None,
            "season_gp": sp["gp"] if sp else 0,
            "season_ppg": round(sp["total"] / sp["gp"], 1) if sp and sp["gp"] else None,
            "prev_season_ppg": round(pp["total"] / pp["gp"], 1) if pp and pp["gp"] else None,
            "prev_season_gp": pp["gp"] if pp else 0,
        })
        fp = (ctx.get("fp") or {}).get(pid)
        if fp:
            row["fp"] = fp
            row["fp_implied"] = implied_points(ctx.get("fp_curves") or {}, fp.get("position") or row["position"], fp.get("pos_rank_n"))
            row["fp_disagreement"] = disagreement(row)
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
    def _pool_rows(self, ctx: dict, b: dict) -> dict:
        """Every fantasy-relevant player, enriched and ranked, split into free agents and mine."""
        rostered = self._rostered(b)
        rows = [r for r in (self._enrich(ctx, pid) for pid in self._pool_ids(ctx)) if r and r["position"] in FANTASY_POSITIONS]
        self._rank_by_position(rows, "proj_week", "proj_week_rank")
        self._rank_by_position(rows, "proj_ros", "proj_ros_rank")
        free = [r for r in rows if r["player_id"] not in rostered]
        # "vs mine": how much better (rest of season) than the weakest player I roster at that position.
        # FLEX-eligible positions compare against my weakest RB/WR/TE so a WR can show as an upgrade over a bad RB.
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
        free.sort(key=lambda r: -(r.get("vs_mine") if r.get("vs_mine") is not None else -1e9))
        return {"rows": rows, "free": free, "mine": mine, "rostered": rostered}

    async def waivers(self, league_id: str, week: int | None) -> dict:
        b = await self._league_bundle(league_id)
        st = await self.state()
        week = week or st["current_week"]
        ctx = await self._week_context(b, week)
        pool = self._pool_rows(ctx, b)
        return {
            "league": self._league_summary(b),
            "week": week,
            "ros_end_week": ctx["ros_end_week"],
            "fp": ctx.get("fp_meta"),
            "fp_errors": ctx.get("fp_errors") or [],
            "players": pool["free"],
        }

    # ------------------------------------------------------- waiver board
    async def _depth_charts(self, teams: list[str]) -> dict[str, dict[str, list[str]]]:
        results = await asyncio.gather(*(self.s.depth_chart(t) for t in teams), return_exceptions=True)
        return {t: r for t, r in zip(teams, results) if not isinstance(r, BaseException) and isinstance(r, dict)}

    async def _season_transactions(self, b: dict, through_week: int) -> list[dict]:
        """Every transaction this season, in the shape both platforms are normalized to."""
        lg = b["league"]
        if lg.get("platform") == "espn":
            assert self.espn is not None
            raw, xw = await asyncio.gather(self.espn.transactions(lg["platform_league_id"], str(lg["season"])), self._crosswalk())
            known = {v: k for k, v in b.get("espn_ids", {}).items()}
            return espn_normalize_transactions(raw, {**xw.espn, **known})
        weeks = range(1, max(1, through_week) + 1)
        results = await asyncio.gather(*(self.s.transactions(lg["platform_league_id"], w) for w in weeks), return_exceptions=True)
        return [t for r in results if not isinstance(r, BaseException) for t in r]

    def _clock(self, league: dict, now: datetime) -> dict:
        settings = league.get("settings", {})
        runs = clock.next_runs(settings, now)
        return {
            "label": clock.describe(settings),
            "timezone": str(clock.zone()),
            "next_runs": [clock.ms(r) for r in runs],
            "next_run": clock.ms(runs[0]) if runs else None,
            "clear_days": settings.get("waiver_clear_days"),
            "daily": bool(settings.get("daily_waivers")),
        }

    def _clear_times(self, transactions: list[dict], league: dict, now: datetime) -> dict[str, int]:
        """player_id -> when he comes off waivers, for players dropped inside the clear window."""
        settings = league.get("settings", {})
        out: dict[str, int] = {}
        for t in transactions:
            if (t.get("status") or "").lower() != "complete":
                continue
            stamp = t.get("status_updated") or t.get("created")
            if not stamp:
                continue
            dropped_at = datetime.fromtimestamp(stamp / 1000, tz=timezone.utc)
            when = clock.clears_at(dropped_at, settings)
            if when and when > now:
                for pid in t.get("drops") or {}:
                    out[pid] = clock.ms(when)
        return out

    async def waiver_board(self, league_id: str, week: int | None = None, limit: int = 60) -> dict:
        """The Tuesday-night view: who to claim, what to bid, what it costs you, and by when."""
        b = await self._league_bundle(league_id)
        st = await self.state()
        week = week or st["current_week"]
        ctx = await self._week_context(b, week, waiver_ranks=True)
        summary = self._league_summary(b)
        league = b["league"]
        now = datetime.now(clock.zone())
        pool = self._pool_rows(ctx, b)
        free, mine = pool["free"], pool["mine"]

        transactions = await self._season_transactions(b, week)
        history = faab.bids(transactions, ctx["players"])
        budget = int(league.get("settings", {}).get("waiver_budget") or 0)
        market = faab.market(history, budget)
        clear_times = self._clear_times(transactions, league, now)

        shortlist = [r for r in free if (r.get("vs_mine") or -99) > -15 or (r.get("adds_24h") or 0) > 0 or (r.get("fp") or {}).get("waiver_rank")]
        shortlist = shortlist[:max(limit * 3, 120)]
        teams = sorted({r["team"] for r in shortlist if r.get("team")})
        depth = await self._depth_charts(teams)
        for r in shortlist:
            chart = depth.get(r.get("team") or "") or {}
            r["opportunity"] = impact.opportunity(chart, ctx["players"], ctx["injuries"], r["player_id"])

        baselines = {
            "starter_proj": targets.starter_baselines(pool["rows"], league["roster_positions"], int(league["total_rosters"])),
            "max_adds": max((r.get("adds_24h") or 0 for r in free), default=1),
            "waiver_pool": ctx.get("fp_waiver_pool") or 56,
        }
        remaining = (summary.get("my_team") or {}).get("faab_remaining", budget)
        weeks_left = max(1, ctx["ros_end_week"] - week + 1)
        pace = faab.pace_multiplier(remaining, budget, weeks_left, REGULAR_SEASON_WEEKS - 1)
        for r in shortlist:
            r["priority"] = targets.priority(r, baselines)
            r["clears_at"] = clear_times.get(r["player_id"]) or r.get("waiver_until")
            r["on_waivers"] = bool(r["clears_at"]) or r.get("platform_status") == "WAIVERS"
            if summary["waiver"]["type_code"] == 2:
                r["faab"] = faab.suggest(r["priority"]["score"] / 100, market, remaining,
                                         summary["waiver"]["bid_min"], pace, r["position"], history)
        shortlist.sort(key=lambda r: -r["priority"]["score"])

        starters = set((b["my_roster"] or {}).get("starters") or [])
        drops = [{**r, "is_starter": r["player_id"] in starters} for r in sorted(mine, key=lambda r: (r.get("proj_ros") or 0.0))]
        return {
            "league": summary,
            "week": week,
            "ros_end_week": ctx["ros_end_week"],
            "clock": self._clock(league, now),
            "faab": {"budget": budget, "remaining": remaining, "pace": pace, "market": market},
            "targets": shortlist[:limit],
            "drop_candidates": drops[:12],
            "fp": ctx.get("fp_meta"),
            "fp_errors": ctx.get("fp_errors") or [],
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
            w = lineup_weight(r)
            if r.get("injury_status") in OUT_STATUSES or r.get("on_bye"):
                w = 0.0
            candidates.append({"player_id": pid, "positions": r["positions"], "weight": w, "current_slot": slot_of.get(pid)})
        optimal = optimal_lineup(slots, candidates)
        optimal_rows = []
        cur_total = 0.0
        opt_total = 0.0
        cur_value = 0.0
        opt_value = 0.0
        for i, slot in enumerate(slots):
            cur = starter_rows[i]["player"]
            opt = enriched.get(optimal[i]) if optimal[i] else None
            cur_pts = (cur or {}).get("proj_week") or 0.0
            opt_pts = (opt or {}).get("proj_week") or 0.0
            cur_total += cur_pts
            opt_total += opt_pts
            cur_value += lineup_weight(cur) if cur else 0.0
            opt_value += lineup_weight(opt) if opt else 0.0
            optimal_rows.append({
                "slot": slot,
                "current": cur, "suggested": opt,
                "change": (cur or {}).get("player_id") != (opt or {}).get("player_id"),
                "delta": round(opt_pts - cur_pts, 2),
            })
        basis = "fantasypros" if any(r and r.get("fp_implied") is not None for r in enriched.values()) else "projections"

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
            # `gain` is in projected points; `value_gain` is on whatever basis picked the lineup, so
            # a FantasyPros-driven swap that costs projected points still reads as an improvement.
            "optimal": {"rows": optimal_rows, "current_total": round(cur_total, 2), "optimal_total": round(opt_total, 2),
                        "gain": round(opt_total - cur_total, 2), "basis": basis,
                        "current_value": round(cur_value, 2), "optimal_value": round(opt_value, 2),
                        "value_gain": round(opt_value - cur_value, 2)},
            "flags": flags,
        }

    async def roster(self, league_id: str, week: int | None) -> dict:
        b = await self._league_bundle(league_id)
        st = await self.state()
        week = week or st["current_week"]
        ctx = await self._week_context(b, week)
        if not b["my_roster"]:
            return {"league": self._league_summary(b), "week": week, "roster": None}
        return {"league": self._league_summary(b), "week": week, "roster": self._roster_view(ctx, b, b["my_roster"])}

    @staticmethod
    def _lineup_reason(current: dict | None, suggested: dict | None) -> str:
        """Why the swap, in the terms the call was actually made on."""
        if suggested is None:
            return "nobody eligible is startable"
        if current is None:
            return f"{suggested['name']} fills an empty slot"
        bits = []
        if current.get("on_bye"):
            bits.append(f"{current['name']} is on bye")
        elif current.get("injury_status") in OUT_STATUSES:
            bits.append(f"{current['name']} is {current['injury_status']}")
        cur_fp, sug_fp = current.get("fp") or {}, suggested.get("fp") or {}
        if cur_fp.get("pos_rank") and sug_fp.get("pos_rank"):
            bits.append(f"FantasyPros has {suggested['name']} {sug_fp['pos_rank']} to {current['name']} {cur_fp['pos_rank']}")
            if sug_fp.get("tier") and cur_fp.get("tier") and sug_fp["tier"] < cur_fp["tier"]:
                bits.append(f"a tier higher (T{sug_fp['tier']} vs T{cur_fp['tier']})")
        delta = round((suggested.get("proj_week") or 0) - (current.get("proj_week") or 0), 1)
        if delta:
            bits.append(f"{'+' if delta > 0 else ''}{delta} projected")
        return "; ".join(bits) or f"{suggested['name']} rates higher"

    async def lineup(self, league_id: str, week: int | None = None) -> dict:
        """This week's start/sit call, FantasyPros first, with what locks when."""
        b = await self._league_bundle(league_id)
        st = await self.state()
        week = week or st["current_week"]
        ctx = await self._week_context(b, week)
        summary = self._league_summary(b)
        if not b["my_roster"]:
            return {"league": summary, "week": week, "slots": [], "moves": [], "watch": [], "bench": [],
                    "totals": None, "issues": [], "fp": ctx.get("fp_meta"), "fp_errors": ctx.get("fp_errors") or []}
        view = self._roster_view(ctx, b, b["my_roster"])
        games = await self.s.schedule(ctx["season"])
        kicks = clock.kickoffs(games, week)

        def lock(row: dict | None) -> dict | None:
            return kicks.get((row or {}).get("team") or "")

        slots = []
        for r in view["optimal"]["rows"]:
            slots.append({**r,
                          "current_lock": lock(r["current"]), "suggested_lock": lock(r["suggested"]),
                          "locked": bool((lock(r["current"]) or {}).get("locked") or (lock(r["suggested"]) or {}).get("locked")),
                          "reason": self._lineup_reason(r["current"], r["suggested"]) if r["change"] else None})
        moves = [r for r in slots if r["change"] and not r["locked"]]
        watch = [{"slot": r["slot"], "player": r["current"],
                  "best_replacement": next((c for c in sorted(view["bench"], key=lambda x: -lineup_weight(x))
                                            if c["position"] in (r["current"] or {}).get("positions", [])), None)}
                 for r in slots
                 if (r["current"] or {}).get("injury_status") in ("Questionable", "Doubtful")]
        return {
            "league": summary,
            "week": week,
            "basis": view["optimal"]["basis"],
            "slots": slots,
            "moves": moves,
            "watch": watch,
            "bench": sorted(view["bench"], key=lambda r: -lineup_weight(r)),
            "totals": {"current": view["optimal"]["current_total"], "optimal": view["optimal"]["optimal_total"],
                       "gain": view["optimal"]["gain"], "value_gain": view["optimal"]["value_gain"]},
            "issues": view["flags"],
            "first_kickoff": clock.first_kickoff(kicks),
            "fp": ctx.get("fp_meta"),
            "fp_errors": ctx.get("fp_errors") or [],
        }

    async def news_feed(self, league_id: str | None = None, limit: int = 60, seen: dict[str, float] | None = None) -> dict:
        """Player news, filtered to players who matter to you, with the follow-on move attached."""
        me = await self.me()
        week = me["state"]["current_week"]
        seen = seen or {}
        if league_id:
            bundles = [await self._league_bundle(league_id, me["user"]["user_id"])]
        else:
            bundles = await self._all_bundles(me)
        if not bundles or not self.news:
            return {"week": week, "items": [], "leagues": [], "provider": None, "errors": ["news is disabled"] if not self.news else []}
        ctxs = await asyncio.gather(*(self._week_context(b, week) for b in bundles))
        base_ctx = next((c for c in ctxs if c.get("platform") == "sleeper"), ctxs[0])

        mine: set[str] = set()
        for b in bundles:
            mine.update((b["my_roster"] or {}).get("players") or [])
            mine.update((b["my_roster"] or {}).get("reserve") or [])
        rostered_maps = [self._rostered(b) for b in bundles]
        pools = [self._pool_rows(ctx, b) for ctx, b in zip(ctxs, bundles)]
        interesting: list[str] = list(mine)
        for pool in pools:
            interesting += [r["player_id"] for r in pool["free"][:30]]
        interesting += list(base_ctx["trending"]["adds_24h"])[:30]
        for rmap in rostered_maps:  # rivals last: their injuries are what free up a handcuff
            interesting += list(rmap)
        ids = list(dict.fromkeys(interesting))[:NEWS_PLAYER_CAP]

        xw = await self._crosswalk()
        wanted = set(ids)
        espn_id_of = {pid: espn_id for espn_id, pid in xw.espn.items() if pid in wanted}
        by_player = await self.news.for_players(ids, espn_id_of or None)

        def where(pid: str) -> list[dict]:
            out = []
            for b, rmap in zip(bundles, rostered_maps):
                r = rmap.get(pid)
                status = "free"
                owner = None
                if r is not None:
                    status = "mine" if (b["my_roster"] and r["roster_id"] == b["my_roster"]["roster_id"]) else "owned"
                    owner = self._owner(b, r)["display_name"]
                out.append({"league_id": b["league"]["league_id"], "league_name": b["league"]["name"], "status": status, "owner": owner})
            return out

        teams = sorted({(base_ctx["players"].get(pid) or {}).get("team") for pid in by_player if (base_ctx["players"].get(pid) or {}).get("team")})
        depth = await self._depth_charts(teams)

        items: list[dict] = []
        for pid, rows in by_player.items():
            player = self._enrich(base_ctx, pid)
            if not player:
                continue
            leagues = where(pid)
            is_mine = any(l["status"] == "mine" for l in leagues)
            for item in rows:
                if not is_mine and item["severity"] < 2:
                    continue
                entry = {**item, "player": player, "leagues": leagues, "mine": is_mine,
                         "seen": item["key"] in seen, "beneficiaries": []}
                if item["direction"] < 0 and item["severity"] >= 2:
                    chart = depth.get(player.get("team") or "") or {}
                    for who in impact.next_in_line(chart, base_ctx["players"], pid):
                        row = self._enrich(base_ctx, who["player_id"])
                        if row:
                            entry["beneficiaries"].append({**who, "player": row, "leagues": where(who["player_id"])})
                items.append(entry)
        items.sort(key=lambda i: (-(i["severity"] if not i["seen"] else 0), -(i.get("published") or 0)))
        return {
            "week": week,
            "leagues": [{"league_id": b["league"]["league_id"], "name": b["league"]["name"], "platform": b["league"].get("platform", "sleeper")} for b in bundles],
            "items": items[:limit],
            "unseen": sum(1 for i in items if not i["seen"]),
            "provider": "sleeper",
            "errors": self.news.errors,
        }

    async def week_view(self, seen: dict[str, float] | None = None) -> dict:
        """One screen for the weekly routine: lineups to fix, claims to file, news to act on."""
        me = await self.me()
        week = me["state"]["current_week"]
        ids = [lg["league_id"] for lg in me["leagues"] if not lg.get("error")]
        boards, lineups, news = await asyncio.gather(
            asyncio.gather(*(self.waiver_board(lid, week, limit=6) for lid in ids), return_exceptions=True),
            asyncio.gather(*(self.lineup(lid, week) for lid in ids), return_exceptions=True),
            self.news_feed(limit=25, seen=seen),
        )
        leagues = []
        for lid, board, lu in zip(ids, boards, lineups):
            summary = next((lg for lg in me["leagues"] if lg["league_id"] == lid), {"league_id": lid})
            entry: dict[str, Any] = {"league": summary}
            if isinstance(board, BaseException):
                entry["waivers"] = {"error": str(board)}
            else:
                entry["clock"] = board["clock"]
                entry["waivers"] = {"faab": board["faab"], "targets": board["targets"][:5],
                                    "drop_candidates": board["drop_candidates"][:5]}
            if isinstance(lu, BaseException):
                entry["lineup"] = {"error": str(lu)}
            else:
                entry["lineup"] = {"moves": lu["moves"], "watch": lu["watch"], "issues": lu["issues"],
                                   "gain": (lu["totals"] or {}).get("gain"), "basis": lu["basis"],
                                   "first_kickoff": lu["first_kickoff"]}
            leagues.append(entry)
        return {
            "week": week,
            "generated_at": int(time.time() * 1000),
            "timezone": str(clock.zone()),
            "leagues": leagues,
            "news": [i for i in news["items"] if not i["seen"] and (i["mine"] or i["severity"] >= 2)][:12],
            "news_errors": news.get("errors") or [],
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

    async def trends(self) -> dict:
        me = await self.me()
        week = me["state"]["current_week"]
        bundles = await self._all_bundles(me)
        ctxs = await asyncio.gather(*(self._week_context(b, week) for b in bundles))
        if not ctxs:
            return {"week": week, "leagues": [], "adds": [], "drops": []}
        base_ctx = next((c for c in ctxs if c.get("platform") == "sleeper"), ctxs[0])
        trending = base_ctx["trending"]
        rostered_maps = [self._rostered(b) for b in bundles]

        def build(kind: str) -> list[dict]:
            key24, key7 = (f"{kind}_24h", f"{kind}_7d")
            ids = set(trending[key24]) | set(trending[key7])
            rows = []
            for pid in ids:
                row = self._enrich(base_ctx, pid)
                if not row:
                    continue
                per_league = []
                for b, ctx, rmap in zip(bundles, ctxs, rostered_maps):
                    e = self._enrich(ctx, pid) or {}
                    r = rmap.get(pid)
                    status = "free"
                    owner = None
                    if r is not None:
                        status = "mine" if (b["my_roster"] and r["roster_id"] == b["my_roster"]["roster_id"]) else "owned"
                        owner = self._owner(b, r)["display_name"]
                    per_league.append({
                        "league_id": b["league"]["league_id"], "league_name": b["league"]["name"],
                        "status": status, "owner": owner,
                        "proj_week": e.get("proj_week"), "proj_ros": e.get("proj_ros"),
                        "platform_status": e.get("platform_status"), "waiver_until": e.get("waiver_until"),
                    })
                row["leagues"] = per_league
                rows.append(row)
            rows.sort(key=lambda r: -(r[key24] or 0))
            return rows

        return {
            "week": week,
            "leagues": [{"league_id": b["league"]["league_id"], "name": b["league"]["name"], "platform": b["league"].get("platform", "sleeper")} for b in bundles],
            "adds": build("adds"),
            "drops": build("drops"),
        }

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
            slots = starting_slots(b["league"]["roster_positions"])
            starters = r.get("starters") or []
            role_of: dict[str, str] = {}
            for i, pid in enumerate(starters):
                if pid and pid != "0":
                    role_of[pid] = slots[i] if i < len(slots) else "START"
            for pid in r.get("reserve") or []:
                role_of[pid] = "IR"
            for pid in r.get("taxi") or []:
                role_of[pid] = "TAXI"
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
        players, proj, stats, prev_stats, (byes, opp) = await asyncio.gather(
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
            "current_season": week_rows(proj, stats, season, True),
            "previous_season": week_rows({}, prev_stats, prev_season, False),
        }


def _pts(settings: dict, key: str) -> float | None:
    if key not in settings:
        return None
    return round(float(settings.get(key, 0)) + float(settings.get(f"{key}_decimal", 0)) / 100, 2)
