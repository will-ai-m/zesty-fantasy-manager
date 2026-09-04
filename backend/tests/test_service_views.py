"""End-to-end over the view builders, on the in-memory league from conftest."""
from __future__ import annotations

import json
import re

import httpx

from app.cache import Cache
from app.news import News
from app.services import Service
from tests.conftest import FakeFantasyPros, FakeSleeper, hours_ago


def by_id(rows, pid):
    return next((r for r in rows if r["player_id"] == pid), None)


async def test_waivers_carry_fantasypros_ranks(service):
    got = await service.waivers("L1", None)
    assert got["fp"]["scoring"] == "HALF" and got["fp"]["experts"] == 25
    waiver_wide = by_id(got["players"], "5")
    assert waiver_wide["fp"]["pos_rank"] == "WR33"
    assert waiver_wide["fp"]["ros_pos_rank"] == 48
    # Ranked WRs project 14.5 / 11.9 / 8.0 / 7.0; the consensus WR33 is the third of four.
    assert waiver_wide["fp_implied"] == 8.0
    assert "9" not in [r["player_id"] for r in got["players"]]  # rostered by the rival


async def test_waiver_board_ranks_targets_and_prices_them(service):
    board = await service.waiver_board("L1", None)

    assert [t["player_id"] for t in board["targets"]][:2] == ["8", "5"]
    handcuff = board["targets"][0]
    assert handcuff["priority"]["score"] > 60
    assert handcuff["opportunity"]["certain"] is True
    assert "Injured Starter (IR)" in handcuff["opportunity"]["reason"]
    assert any("waiver-wire #1" in w for w in handcuff["priority"]["why"])

    # FAAB: budget 100, 30 spent. The league's winning bids are 34/25/12/8/3.
    assert board["faab"]["remaining"] == 70
    assert board["faab"]["market"]["won"] == 5 and board["faab"]["market"]["max"] == 34
    bid = handcuff["faab"]
    assert 0 < bid["low"] <= bid["mid"] <= bid["high"] <= 70
    assert bid["comparables"], "a suggestion should show what similar players went for"
    assert "priority" in bid["basis"]

    # Waivers clear Wednesday at midnight, and a player dropped 12h ago is still on them.
    assert board["clock"]["label"].startswith("Wed 00:00")
    assert board["clock"]["next_run"] > hours_ago(0)
    dropped = by_id(board["targets"], "5")
    assert dropped["on_waivers"] is True and dropped["clears_at"] > board["clock"]["next_run"] - 1

    # The kicker and the defence score nothing under these scoring settings, so they head the list.
    assert {d["player_id"] for d in board["drop_candidates"][:2]} == {"7", "DET"}
    assert all("is_starter" in d for d in board["drop_candidates"])


async def test_waiver_board_does_not_suggest_bids_in_a_priority_league(service, monkeypatch):
    import tests.conftest as fixtures
    monkeypatch.setitem(fixtures.LEAGUE["settings"], "waiver_type", 0)
    board = await service.waiver_board("L1", None)
    assert all("faab" not in t for t in board["targets"])
    monkeypatch.setitem(fixtures.LEAGUE["settings"], "waiver_type", 2)


async def test_lineup_follows_fantasypros_over_the_projection(service):
    got = await service.lineup("L1", None)
    assert got["basis"] == "fantasypros"

    flex = next(s for s in got["slots"] if s["slot"] == "FLEX")
    # Projections prefer Bench Back (9.0) at flex over Second Wide (8.0). FantasyPros has the
    # receiver WR20 against the back's RB40, so the consensus flips the slot.
    assert flex["current"]["player_id"] == "3"
    assert flex["suggested"]["player_id"] == "11"
    assert flex["change"] is True
    assert "FantasyPros has Second Wide WR20 to Bench Back RB40" in flex["reason"]

    assert [m["slot"] for m in got["moves"]] == ["FLEX"]
    assert got["first_kickoff"] == "2026-09-24"
    assert all(s["locked"] is False for s in got["slots"])
    # The swap costs a projected point and gains on the consensus: both are reported.
    assert got["totals"]["gain"] == -1.0
    assert got["totals"]["value_gain"] > 0


async def test_lineup_leaves_a_started_game_alone(service, monkeypatch):
    async def started(season, season_type="regular"):
        return [{"week": 3, "date": "2026-09-24", "home": "DET", "away": "CHI", "status": "in_game"},
                {"week": 3, "date": "2026-09-27", "home": "KC", "away": "BUF", "status": "pre_game"}]

    monkeypatch.setattr(service.s, "schedule", started)
    got = await service.lineup("L1", None)
    detroit_slots = [s for s in got["slots"] if (s["current"] or {}).get("team") == "DET"]
    assert detroit_slots and all(s["locked"] for s in detroit_slots)
    # The flex holds a Lion whose game has kicked off, so the swap is no longer on the table.
    assert got["moves"] == []


async def test_news_feed_names_who_benefits(service, tmp_path):
    def handler(request: httpx.Request) -> httpx.Response:
        query = json.loads(request.content)["query"]
        data = {}
        for alias, pid in re.findall(r'(a\d+): get_player_news\(sport: "nfl", player_id: "([^"]+)"', query):
            data[alias] = [{
                "source": "rotowire", "source_key": "636010", "player_id": pid, "published": hours_ago(2),
                "metadata": {"title": "Injured Starter - Placed on IR with a torn ACL",
                             "description": "He is out for the season.",
                             "analysis": "Handcuff Back becomes the lead back."},
            }] if pid == "9" else []
        return httpx.Response(200, json={"data": data})

    service.news = News(Cache(tmp_path / "news"))
    service.news.http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    got = await service.news_feed()
    await service.news.aclose()

    assert len(got["items"]) == 1
    item = got["items"][0]
    assert item["category"] == "injury" and item["severity"] == 3
    assert item["player"]["name"] == "Injured Starter"
    assert item["seen"] is False and got["unseen"] == 1
    assert [b["player_id"] for b in item["beneficiaries"]] == ["8"]
    benefits = item["beneficiaries"][0]
    assert benefits["player"]["name"] == "Handcuff Back"
    assert benefits["leagues"][0]["status"] == "free"  # and he is available to claim


async def test_news_feed_marks_items_you_have_already_dealt_with(service, tmp_path):
    def handler(request: httpx.Request) -> httpx.Response:
        query = json.loads(request.content)["query"]
        data = {alias: ([{"source": "rotowire", "source_key": "1", "player_id": pid, "published": hours_ago(2),
                          "metadata": {"title": "Injured Starter - Ruled out"}}] if pid == "9" else [])
                for alias, pid in re.findall(r'(a\d+): get_player_news\(sport: "nfl", player_id: "([^"]+)"', query)}
        return httpx.Response(200, json={"data": data})

    service.news = News(Cache(tmp_path / "news2"))
    service.news.http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    got = await service.news_feed(seen={"rotowire:1": 1.0})
    await service.news.aclose()
    assert got["items"][0]["seen"] is True and got["unseen"] == 0


async def test_week_view_gathers_the_whole_routine(service):
    got = await service.week_view()
    assert got["week"] == 3 and got["timezone"]
    league = got["leagues"][0]
    assert league["league"]["name"] == "Test League"
    assert league["clock"]["label"].startswith("Wed 00:00")
    assert league["waivers"]["faab"]["remaining"] == 70
    assert [t["player_id"] for t in league["waivers"]["targets"]][:1] == ["8"]
    assert [m["slot"] for m in league["lineup"]["moves"]] == ["FLEX"]
    assert league["lineup"]["basis"] == "fantasypros"


async def test_everything_still_works_without_fantasypros(tmp_path, monkeypatch):
    import app.services as services

    async def no_nflverse(cache):
        return []

    monkeypatch.setattr(services, "load_nflverse_ids", no_nflverse)
    monkeypatch.setattr(services, "require_username", lambda: "tester")

    class Off(FakeFantasyPros):
        enabled = False

    svc = Service(FakeSleeper(Cache(tmp_path / "c")), None, Off(), None)
    lineup = await svc.lineup("L1", None)
    assert lineup["basis"] == "projections"
    # On projections alone the flex stays with the higher projection, so there is nothing to change.
    flex = next(s for s in lineup["slots"] if s["slot"] == "FLEX")
    assert flex["suggested"]["player_id"] == "3"
    assert lineup["moves"] == []
    board = await svc.waiver_board("L1", None)
    assert board["fp"] is None
    assert board["targets"], "the board still works on platform projections"
    assert all((t["fp"] if "fp" in t else None) is None for t in board["targets"])


async def test_a_broken_fantasypros_page_does_not_break_the_page(tmp_path, monkeypatch):
    import app.services as services

    async def no_nflverse(cache):
        return []

    monkeypatch.setattr(services, "load_nflverse_ids", no_nflverse)
    monkeypatch.setattr(services, "require_username", lambda: "tester")

    class Broken(FakeFantasyPros):
        async def board(self, kind, positions, scoring="HALF", week=None):
            if kind == "weekly":
                return {}, ["weekly rb: 503 Server Error"]
            return await super().board(kind, positions, scoring, week)

    svc = Service(FakeSleeper(Cache(tmp_path / "c2")), None, Broken(), None)
    got = await svc.waivers("L1", None)
    assert got["fp_errors"] == ["weekly rb: 503 Server Error"]
    assert got["players"], "free agents still list"


async def test_recent_news_lifts_a_target_and_rides_along_with_it(service, tmp_path):
    def handler(request: httpx.Request) -> httpx.Response:
        query = json.loads(request.content)["query"]
        data = {alias: ([{"source": "rotowire", "source_key": "77", "player_id": pid, "published": hours_ago(3),
                          "metadata": {"title": "Waiver Wide - Named the starter in Week 3",
                                       "description": "He takes over the slot role."}}] if pid == "5" else [])
                for alias, pid in re.findall(r'(a\d+): get_player_news\(sport: "nfl", player_id: "([^"]+)"', query)}
        return httpx.Response(200, json={"data": data})

    quiet = await service.waiver_board("L1", None)
    before = by_id(quiet["targets"], "5")["priority"]["score"]

    service.news = News(Cache(tmp_path / "board-news"))
    service.news.http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    service.s.cache.invalidate()
    board = await service.waiver_board("L1", None)
    await service.news.aclose()

    target = by_id(board["targets"], "5")
    assert target["priority"]["score"] > before
    assert target["news"][0]["title"].startswith("Waiver Wide")
    assert any("Named the starter" in w for w in target["priority"]["why"])


async def test_a_streamer_the_experts_like_survives_the_shortlist(service, monkeypatch):
    # Waiver Wide's rest-of-season value is nothing special, but he is ranked on the wire page,
    # so trimming the board by roster upgrade alone must not lose him.
    board = await service.waiver_board("L1", None, limit=1)
    assert len(board["targets"]) == 1
    full = await service.waiver_board("L1", None)
    assert "5" in [t["player_id"] for t in full["targets"]]
