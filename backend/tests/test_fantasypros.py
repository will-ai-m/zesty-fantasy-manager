import json

import pytest

from app.fantasypros import FantasyProsError, page_url, parse_ecr, parse_pos_rank, scoring_key


def page(**over):
    data = {
        "sport": "NFL", "year": 2026, "week": 3, "type": "weekly", "scoring": "HALF",
        "position_id": "RB", "total_experts": 25, "last_updated": "2026-09-04 07:00:00",
        "players": [
            {"player_id": 17240, "player_name": "Jahmyr Gibbs", "player_team_id": "DET", "player_position_id": "RB",
             "player_positions": "RB", "rank_ecr": 1, "pos_rank": "RB1", "rank_min": 1, "rank_max": 3,
             "rank_ave": "1.4", "rank_std": "0.6", "tier": 1, "player_ecr_delta": -2, "player_owned_avg": 99.8,
             "player_opponent": "vs. CHI", "player_bye_week": "8", "note": "", "recommendation": "", "tag": ""},
            {"player_id": 19631, "player_name": "Tyrone Tracy Jr.", "player_team_id": "JAC", "player_position_id": "RB",
             "rank_ecr": 24, "pos_rank": "RB24", "tier": 5, "player_ecr_delta": 6, "player_owned_avg": 41.2,
             "player_opponent": "at PIT", "player_bye_week": 14, "note": " Startable flex ", "tag": "hot"},
        ],
    }
    data.update(over)
    return "<html><body><script>\nvar ecrData = %s;\nvar other = 1;\n</script></body></html>" % json.dumps(data)


def test_page_urls_cover_every_variant():
    assert page_url("weekly", "rb", "HALF", 3) == "https://www.fantasypros.com/nfl/rankings/half-point-ppr-rb.php?week=3"
    assert page_url("weekly", "flex", "PPR", 1) == "https://www.fantasypros.com/nfl/rankings/ppr-flex.php?week=1"
    assert page_url("weekly", "qb", "HALF", 3) == "https://www.fantasypros.com/nfl/rankings/qb.php?week=3"
    assert page_url("weekly", "dst", "PPR", 2) == "https://www.fantasypros.com/nfl/rankings/dst.php?week=2"
    assert page_url("ros", "overall", "HALF") == "https://www.fantasypros.com/nfl/rankings/ros-half-point-ppr-overall.php"
    assert page_url("ros", "k", "STD") == "https://www.fantasypros.com/nfl/rankings/ros-k.php"
    assert page_url("waiver", "overall", "HALF") == "https://www.fantasypros.com/nfl/rankings/waiver-wire-half-point-ppr-overall.php"
    assert page_url("weekly", "wr", "STD", 5) == "https://www.fantasypros.com/nfl/rankings/wr.php?week=5"
    with pytest.raises(ValueError):
        page_url("nonsense", "rb", "HALF")


def test_scoring_key_from_league_reception_points():
    assert scoring_key(1) == "PPR"
    assert scoring_key(0.5) == "HALF"
    assert scoring_key(0) == "STD"
    assert scoring_key(None) == "STD"


def test_parse_ecr_normalizes_rows():
    got = parse_ecr(page())
    assert got["week"] == 3 and got["scoring"] == "HALF" and got["total_experts"] == 25
    assert got["count"] == 2
    first, second = got["players"]
    assert first["fp_id"] == "17240"
    assert (first["pos_rank"], first["pos_rank_n"], first["tier"]) == ("RB1", 1, 1)
    assert first["rank_std"] == 0.6 and first["ecr_delta"] == -2.0
    assert first["team"] == "DET" and first["position"] == "RB"
    assert first["note"] is None  # empty strings collapse to None
    # Jacksonville is JAC on FantasyPros and JAX on Sleeper.
    assert second["team"] == "JAX"
    assert second["note"] == "Startable flex" and second["tag"] == "hot"
    assert second["bye"] == 14


def test_parse_ecr_maps_dst_to_sleepers_position_name():
    got = parse_ecr(page(position_id="DST", players=[
        {"player_id": 20000, "player_name": "Baltimore Ravens", "player_team_id": "BAL",
         "player_position_id": "DST", "rank_ecr": 2, "pos_rank": "DST2"}]))
    assert got["players"][0]["position"] == "DEF"
    assert got["players"][0]["pos_rank_n"] == 2


def test_parse_ecr_ignores_trailing_script_on_the_same_line():
    html = "<script>var ecrData = %s;var x = {\"a\": 1};</script>" % json.dumps({"players": [], "week": 4})
    assert parse_ecr(html)["week"] == 4


def test_parse_ecr_reports_a_paywalled_page():
    with pytest.raises(FantasyProsError, match="paywalled"):
        parse_ecr("<html>this content is premium, please upgrade</html>")
    with pytest.raises(FantasyProsError):
        parse_ecr("<html>nothing here</html>")


def test_parse_pos_rank():
    assert parse_pos_rank("WR12") == 12
    assert parse_pos_rank("DST2") == 2
    assert parse_pos_rank(None) is None
    assert parse_pos_rank("") is None
