"""The endpoints, over real HTTP, so anything that will not serialize shows up here."""
from __future__ import annotations

import json
import re

import httpx
import pytest
from fastapi.testclient import TestClient

import app.main as main
import app.services as services
from app.cache import Cache
from app.news import News, SeenStore
from app.services import Service
from tests.conftest import FakeFantasyPros, FakeSleeper, hours_ago


def news_handler(request: httpx.Request) -> httpx.Response:
    query = json.loads(request.content)["query"]
    data = {alias: ([{"source": "rotowire", "source_key": "9001", "player_id": pid, "published": hours_ago(1),
                      "metadata": {"title": "Injured Starter - Placed on IR", "description": "Out for the season."}}]
                    if pid == "9" else [])
            for alias, pid in re.findall(r'(a\d+): get_player_news\(sport: "nfl", player_id: "([^"]+)"', query)}
    return httpx.Response(200, json={"data": data})


@pytest.fixture
def client(tmp_path, monkeypatch):
    async def no_nflverse(cache):
        return []

    monkeypatch.setattr(services, "load_nflverse_ids", no_nflverse)
    monkeypatch.setattr(services, "require_username", lambda: "tester")
    monkeypatch.setattr(main, "DATA_DIR", tmp_path)
    with TestClient(main.app) as c:
        cache = Cache(tmp_path / "cache")
        news = News(cache)
        news.http = httpx.AsyncClient(transport=httpx.MockTransport(news_handler))
        main.app.state.service = Service(FakeSleeper(cache), None, FakeFantasyPros(), news)
        main.app.state.news_seen = SeenStore(tmp_path / "seen.json")
        yield c


def test_health_and_me(client):
    assert client.get("/api/health").json() == {"ok": True}
    me = client.get("/api/me").json()
    assert me["user"]["username"] == "tester"
    assert me["leagues"][0]["waiver"]["day_of_week"] == "Wed"


def test_waiver_board_endpoint(client):
    board = client.get("/api/leagues/sleeper:L1/waiver-board").json()
    assert board["targets"][0]["player_id"] == "8"
    assert isinstance(board["clock"]["next_run"], int)
    assert board["targets"][0]["faab"]["mid"] >= 1
    assert board["faab"]["market"]["max"] == 34


def test_lineup_endpoint(client):
    lineup = client.get("/api/leagues/sleeper:L1/lineup").json()
    assert lineup["basis"] == "fantasypros"
    assert [m["slot"] for m in lineup["moves"]] == ["FLEX"]


def test_week_endpoint(client):
    week = client.get("/api/week").json()
    assert week["week"] == 3
    assert week["leagues"][0]["waivers"]["faab"]["remaining"] == 70


def test_news_endpoint_and_marking_an_item_handled(client):
    feed = client.get("/api/news").json()
    assert feed["items"][0]["player"]["name"] == "Injured Starter"
    assert feed["items"][0]["seen"] is False
    key = feed["items"][0]["key"]

    assert client.post("/api/news/seen", json={"keys": [key]}).json()["ok"] is True
    assert client.get("/api/news").json()["items"][0]["seen"] is True
    client.post("/api/news/seen", json={"keys": [key], "seen": False})
    assert client.get("/api/news").json()["unseen"] == 1


def test_plans_keep_the_claim_order(client):
    first = client.post("/api/plans", json={"league_id": "sleeper:L1", "add_player_id": "8", "bid": 22, "priority": 2}).json()
    second = client.post("/api/plans", json={"league_id": "sleeper:L1", "add_player_id": "5", "bid": 4, "priority": 1}).json()
    plans = client.get("/api/plans").json()
    assert [p["id"] for p in plans] == [second["id"], first["id"]]
    assert plans[0]["add_player"]["name"] == "Waiver Wide"

    client.patch(f"/api/plans/{first['id']}", json={"priority": 1})
    client.patch(f"/api/plans/{second['id']}", json={"priority": 2})
    assert [p["id"] for p in client.get("/api/plans").json()] == [first["id"], second["id"]]
    assert client.delete(f"/api/plans/{first['id']}").status_code == 204
