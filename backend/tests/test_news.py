import json

import httpx
import pytest

from app.cache import Cache
from app.news import News, SeenStore, SleeperNews, classify


@pytest.mark.parametrize("headline,category,direction", [
    ("Jahmyr Gibbs - Tears ACL, out for the season", "injury", -1),
    ("Player X - Ruled out for Sunday's game", "injury", -1),
    ("Player X - Suspended six games", "suspension", -1),
    ("Player X - Traded to Chicago", "transaction", 0),
    ("Player X - Doubtful to play Sunday", "injury", -1),
    ("Player X - Carted off with knee injury", "injury", -1),
    ("Player X - Questionable with a hamstring", "practice", -1),
    ("Player X - Named the starter in Week 4", "depth", 1),
    ("Player X - Returns to full practice", "return", 1),
    ("Player X - Signed to the active roster", "transaction", 0),
    ("Player X - Sees season-high nine targets", "usage", 0),
    ("Player X - Enjoys the bye week", "other", 0),
])
def test_classify_reads_the_headline(headline, category, direction):
    got = classify(headline)
    assert (got["category"], got["direction"]) == (category, direction)


def test_severity_ranks_ruled_out_above_questionable():
    assert classify("Ruled out Sunday")["severity"] > classify("Questionable Sunday")["severity"]
    assert classify("Placed on IR")["severity"] == 3
    assert classify("Nothing notable")["severity"] == 0


async def test_sleeper_news_batches_players_into_aliased_queries(tmp_path):
    seen_queries = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen_queries.append(json.loads(request.content)["query"])
        return httpx.Response(200, json={"data": {
            "a0": [{"source": "rotowire", "source_key": "636010", "player_id": "9221", "published": 1788365712000,
                    "metadata": {"title": "Jahmyr Gibbs - Ruled out with a hamstring strain",
                                 "description": "Gibbs will not play Sunday.", "analysis": "Backup takes over."}}],
            "a1": [],
        }})

    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    got = await SleeperNews(http).fetch(["9221", "6790"], limit=3)
    await http.aclose()

    assert 'a0: get_player_news(sport: "nfl", player_id: "9221", limit: 3)' in seen_queries[0]
    assert 'a1: get_player_news(sport: "nfl", player_id: "6790"' in seen_queries[0]
    assert len(seen_queries) == 1  # one request for both players
    item = got["9221"][0]
    assert item["key"] == "rotowire:636010"
    assert item["category"] == "injury" and item["severity"] == 3
    assert item["analysis"] == "Backup takes over."


async def test_news_falls_back_to_espn_when_sleeper_fails(tmp_path):
    def handler(request: httpx.Request) -> httpx.Response:
        if "sleeper" in str(request.url):
            return httpx.Response(500, text="nope")
        return httpx.Response(200, json={"feed": [
            {"id": 636010, "headline": "Player X - Ruled out", "description": "Out Sunday.",
             "story": "Analysis.", "published": "2026-09-04T00:32:02Z", "links": {"mobile": {"href": "https://e/1"}}}]})

    news = News(Cache(tmp_path / "cache"))
    news.http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    got = await news.for_players(["9221"], espn_id_of={"9221": 4429795})
    await news.aclose()

    assert got["9221"][0]["title"] == "Player X - Ruled out"
    assert got["9221"][0]["url"] == "https://e/1"
    assert got["9221"][0]["published"] == 1788481922000
    assert any("sleeper" in e for e in news.errors)


async def test_news_records_the_error_rather_than_raising(tmp_path):
    news = News(Cache(tmp_path / "cache"))
    news.http = httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(503)))
    assert await news.for_players(["9221"]) == {}
    assert news.errors
    await news.aclose()


async def test_news_is_skipped_when_disabled(tmp_path):
    news = News(Cache(tmp_path / "cache"), enabled=False)
    assert await news.for_players(["9221"]) == {}
    await news.aclose()


async def test_seen_store_round_trips(tmp_path):
    store = SeenStore(tmp_path / "seen.json")
    assert await store.all() == {}
    await store.ack(["rotowire:1", "rotowire:2"])
    assert set(await store.all()) == {"rotowire:1", "rotowire:2"}
    await store.ack(["rotowire:1"], seen=False)
    assert set(await store.all()) == {"rotowire:2"}
