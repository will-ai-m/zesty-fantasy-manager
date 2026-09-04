"""A whole small league in memory, so the view builders can be exercised without a network."""
from __future__ import annotations

import time

import pytest

from app.cache import Cache
from app.services import Service

WEEK = 3
SEASON = "2026"

PLAYERS: dict[str, dict] = {
    "1": {"full_name": "Aaron Arm", "position": "QB", "fantasy_positions": ["QB"], "team": "DET", "status": "Active"},
    "2": {"full_name": "Star Back", "position": "RB", "fantasy_positions": ["RB"], "team": "DET", "status": "Active"},
    "3": {"full_name": "Bench Back", "position": "RB", "fantasy_positions": ["RB"], "team": "DET", "status": "Active"},
    "4": {"full_name": "Alpha Wide", "position": "WR", "fantasy_positions": ["WR"], "team": "KC", "status": "Active"},
    "5": {"full_name": "Waiver Wide", "position": "WR", "fantasy_positions": ["WR"], "team": "KC", "status": "Active"},
    "6": {"full_name": "Tight End", "position": "TE", "fantasy_positions": ["TE"], "team": "KC", "status": "Active"},
    "7": {"full_name": "The Kicker", "position": "K", "fantasy_positions": ["K"], "team": "DET", "status": "Active"},
    "8": {"full_name": "Handcuff Back", "position": "RB", "fantasy_positions": ["RB"], "team": "CHI", "status": "Active"},
    "9": {"full_name": "Injured Starter", "position": "RB", "fantasy_positions": ["RB"], "team": "CHI", "status": "Active"},
    "10": {"full_name": "Rival Receiver", "position": "WR", "fantasy_positions": ["WR"], "team": "CHI", "status": "Active"},
    "11": {"full_name": "Second Wide", "position": "WR", "fantasy_positions": ["WR"], "team": "KC", "status": "Active"},
    "12": {"full_name": "Third Back", "position": "RB", "fantasy_positions": ["RB"], "team": "DET", "status": "Active"},
    "DET": {"first_name": "Detroit", "last_name": "Lions", "position": "DEF", "fantasy_positions": ["DEF"], "team": "DET", "status": "Active"},
}

# Weekly projections, in raw Sleeper stat keys; the league scores them itself.
PROJECTED = {
    "1": {"pass_yd": 250, "pass_td": 2},        # 4 * 2 + 250 * .04 = 18.0
    "2": {"rush_yd": 80, "rush_td": 0.6},       # 8 + 3.6         = 11.6
    "3": {"rush_yd": 55, "rec": 3, "rec_yd": 20},  # 5.5 + 1.5 + 2 = 9.0
    "4": {"rec": 6, "rec_yd": 85, "rec_td": 0.5},  # 3 + 8.5 + 3   = 14.5
    "5": {"rec": 5, "rec_yd": 70, "rec_td": 0.4},  # 2.5 + 7 + 2.4 = 11.9
    "6": {"rec": 4, "rec_yd": 40},              # 2 + 4           = 6.0
    "7": {"fgm": 1.6, "xpm": 2},                # 0 (not scored)  = 0
    "8": {"rush_yd": 60, "rec": 2, "rec_yd": 15},  # 6 + 1 + 1.5  = 8.5
    "9": {"rush_yd": 90, "rush_td": 0.7},       # 9 + 4.2         = 13.2
    "10": {"rec": 4, "rec_yd": 50},             # 2 + 5           = 7.0
    "11": {"rec": 4, "rec_yd": 60},             # 2 + 6           = 8.0
    "12": {"rush_yd": 65, "rec": 1, "rec_yd": 20},  # 6.5 + .5 + 2 = 9.0
    "DET": {"pts_allow_14_20": 1},              # 0 (not scored)
}

SCORING = {"pass_yd": 0.04, "pass_td": 4, "rush_yd": 0.1, "rush_td": 6, "rec": 0.5, "rec_yd": 0.1, "rec_td": 6}

LEAGUE = {
    "league_id": "L1", "name": "Test League", "season": SEASON, "status": "in_season", "avatar": None,
    "total_rosters": 2,
    "roster_positions": ["QB", "RB", "RB", "WR", "TE", "FLEX", "K", "DEF", "BN", "BN"],
    "scoring_settings": SCORING,
    "settings": {"waiver_type": 2, "waiver_budget": 100, "waiver_day_of_week": 2, "waiver_hour": 0,
                 "waiver_clear_days": 2, "waiver_bid_min": 0, "playoff_week_start": 15, "playoff_teams": 6,
                 "reserve_slots": 1, "taxi_slots": 0},
}

MY_ROSTER = {
    "roster_id": 1, "owner_id": "u1", "league_id": "L1",
    "players": ["1", "2", "3", "4", "6", "7", "DET", "11", "12"],
    # Bench Back holds the flex on projections (9.0 to Second Wide's 8.0); FantasyPros disagrees.
    "starters": ["1", "2", "12", "4", "6", "3", "7", "DET"],
    "reserve": [], "taxi": [],
    "settings": {"wins": 2, "losses": 1, "ties": 0, "fpts": 210, "waiver_budget_used": 30, "waiver_position": 1,
                 "total_moves": 4},
}
RIVAL_ROSTER = {
    "roster_id": 2, "owner_id": "u2", "league_id": "L1",
    "players": ["9", "10"], "starters": ["9", "10"], "reserve": [], "taxi": [],
    "settings": {"wins": 1, "losses": 2, "ties": 0, "fpts": 180, "waiver_budget_used": 10, "waiver_position": 2},
}

DEPTH_CHARTS = {
    "DET": {"QB": ["1"], "RB": ["2", "3", "12"], "WR1": [], "K": ["7"]},
    "KC": {"WR1": ["4", "5"], "WR2": ["11"], "TE": ["6"]},
    "CHI": {"RB": ["9", "8"], "WR1": ["10"]},
}


def hours_ago(hours: float) -> int:
    return int((time.time() - hours * 3600) * 1000)


TRANSACTIONS = {
    1: [{"transaction_id": "t1", "type": "waiver", "status": "complete", "leg": 1, "created": hours_ago(400),
         "status_updated": hours_ago(400), "settings": {"waiver_bid": 34}, "adds": {"10": 2}, "drops": {}, "roster_ids": [2]},
        {"transaction_id": "t2", "type": "waiver", "status": "failed", "leg": 1, "status_updated": hours_ago(400),
         "settings": {"waiver_bid": 21}, "adds": {"10": 1}, "drops": {}, "roster_ids": [1]}],
    2: [{"transaction_id": "t3", "type": "waiver", "status": "complete", "leg": 2, "status_updated": hours_ago(200),
         "settings": {"waiver_bid": 12}, "adds": {"6": 1}, "drops": {}, "roster_ids": [1]},
        {"transaction_id": "t4", "type": "waiver", "status": "complete", "leg": 2, "status_updated": hours_ago(200),
         "settings": {"waiver_bid": 8}, "adds": {"7": 1}, "drops": {}, "roster_ids": [1]},
        {"transaction_id": "t5", "type": "waiver", "status": "complete", "leg": 2, "status_updated": hours_ago(200),
         "settings": {"waiver_bid": 3}, "adds": {"3": 1}, "drops": {}, "roster_ids": [1]},
        {"transaction_id": "t6", "type": "waiver", "status": "complete", "leg": 2, "status_updated": hours_ago(200),
         "settings": {"waiver_bid": 25}, "adds": {"2": 1}, "drops": {}, "roster_ids": [1]}],
    # Waiver Wide was dropped 12 hours ago, so he is still sitting on waivers.
    3: [{"transaction_id": "t7", "type": "free_agent", "status": "complete", "leg": 3, "created": hours_ago(12),
         "status_updated": hours_ago(12), "adds": {}, "drops": {"5": 2}, "roster_ids": [2]}],
}


class FakeSleeper:
    """Stands in for the Sleeper client with the same call surface the service uses."""

    def __init__(self, cache: Cache):
        self.cache = cache
        self.calls: list[str] = []

    async def state(self):
        return {"season": SEASON, "week": WEEK, "display_week": WEEK, "season_type": "regular", "league_season": SEASON}

    async def user(self, username_or_id):
        return {"user_id": "u1", "username": "tester", "display_name": "Tester", "avatar": None}

    async def user_leagues(self, user_id, season):
        return [LEAGUE]

    async def league(self, league_id):
        return LEAGUE

    async def rosters(self, league_id):
        return [MY_ROSTER, RIVAL_ROSTER]

    async def users(self, league_id):
        return [{"user_id": "u1", "display_name": "Tester", "metadata": {"team_name": "My Team"}},
                {"user_id": "u2", "display_name": "Rival", "metadata": {"team_name": "Their Team"}}]

    async def players(self):
        return PLAYERS

    async def projections(self, season, week):
        if season != SEASON:
            return []
        return [{"player_id": pid, "stats": stats} for pid, stats in PROJECTED.items()]

    async def stats(self, season, week, final=False):
        if week >= WEEK:
            return []
        return [{"player_id": pid, "stats": {**stats, "gp": 1}} for pid, stats in PROJECTED.items()]

    async def research(self, season, week):
        return {"2": {"owned": 99.0, "started": 95.0}, "5": {"owned": 22.0, "started": 6.0},
                "8": {"owned": 41.0, "started": 9.0}, "10": {"owned": 60.0, "started": 30.0}}

    async def trending(self, kind, lookback_hours=24, limit=100):
        if kind != "add":
            return [{"player_id": "3", "count": 900}]
        return [{"player_id": "8", "count": 18_000}, {"player_id": "5", "count": 2_400}]

    async def injuries(self):
        return {"9": {"injury_status": "IR", "injury_body_part": "Knee", "injury_notes": "Out for the season"}}

    async def schedule(self, season, season_type="regular"):
        return [
            {"week": WEEK, "date": "2026-09-24", "home": "DET", "away": "CHI", "status": "pre_game"},
            {"week": WEEK, "date": "2026-09-27", "home": "KC", "away": "BUF", "status": "pre_game"},
            {"week": WEEK + 1, "date": "2026-10-01", "home": "DET", "away": "KC", "status": "pre_game"},
        ]

    async def depth_chart(self, team):
        self.calls.append(f"depth:{team}")
        return DEPTH_CHARTS.get(team, {})

    async def transactions(self, league_id, week):
        return TRANSACTIONS.get(week, [])


def fp_row(fp_id, name, team, position, pos_rank_n, rank=None, **over):
    row = {
        "fp_id": str(fp_id), "name": name, "team": team, "position": position,
        "rank": rank or pos_rank_n, "pos_rank": f"{position}{pos_rank_n}", "pos_rank_n": pos_rank_n,
        "rank_min": None, "rank_max": None, "rank_std": 1.0, "tier": 1 + (pos_rank_n - 1) // 6,
        "ecr_delta": None, "owned_avg": None, "opponent": None, "bye": None,
        "note": None, "recommendation": None, "tag": None,
    }
    row.update(over)
    return row


# FantasyPros ranks Alpha Wide above Waiver Wide, and — against the projections — Bench Back
# below Alpha Wide, so the flex should end up with the receiver.
FP_WEEKLY = {
    "qb": [fp_row(101, "Aaron Arm", "DET", "QB", 1)],
    "rb": [fp_row(102, "Star Back", "DET", "RB", 4), fp_row(103, "Bench Back", "DET", "RB", 40),
           fp_row(108, "Handcuff Back", "CHI", "RB", 26), fp_row(109, "Injured Starter", "CHI", "RB", 9),
           fp_row(112, "Third Back", "DET", "RB", 35)],
    "wr": [fp_row(104, "Alpha Wide", "KC", "WR", 8), fp_row(105, "Waiver Wide", "KC", "WR", 33),
           fp_row(110, "Rival Receiver", "CHI", "WR", 44), fp_row(111, "Second Wide", "KC", "WR", 20)],
    "te": [fp_row(106, "Tight End", "KC", "TE", 14)],
    "k": [fp_row(107, "The Kicker", "DET", "K", 12)],
    "dst": [fp_row(120, "Detroit Lions", "DET", "DEF", 6)],
}
FP_ROS = {"overall": [fp_row(108, "Handcuff Back", "CHI", "RB", 30, rank=61),
                      fp_row(105, "Waiver Wide", "KC", "WR", 48, rank=95)]}
FP_WAIVER = {"overall": [fp_row(108, "Handcuff Back", "CHI", "RB", 1, rank=1, note="Starter is on IR"),
                         fp_row(105, "Waiver Wide", "KC", "WR", 2, rank=9)]}


class FakeFantasyPros:
    enabled = True

    def __init__(self):
        self.requested: list[tuple] = []

    async def board(self, kind, positions, scoring="HALF", week=None):
        self.requested.append((kind, positions, scoring, week))
        source = {"weekly": FP_WEEKLY, "ros": FP_ROS, "waiver": FP_WAIVER}[kind]
        pages = {pos: {"players": source.get(pos, []), "week": week, "type": kind, "total_experts": 25,
                       "last_updated": "2026-09-24 09:00:00", "fetched_at": time.time()}
                 for pos in positions if pos in source}
        return pages, []


@pytest.fixture
def service(tmp_path, monkeypatch):
    """A Service wired to the fake league, with no network anywhere."""
    import app.services as services

    async def no_nflverse(cache):
        return []

    monkeypatch.setattr(services, "load_nflverse_ids", no_nflverse)
    monkeypatch.setattr(services, "require_username", lambda: "tester")
    cache = Cache(tmp_path / "cache")
    sleeper = FakeSleeper(cache)
    svc = Service(sleeper, None, FakeFantasyPros(), None)
    return svc
