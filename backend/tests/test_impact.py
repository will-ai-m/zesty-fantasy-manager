from app import impact

DEPTH = {
    "QB": ["qb1", "qb2"],
    "RB": ["rb1", "rb2", "rb3"],
    "WR1": ["wr1", "wr4"],
    "WR2": ["wr2"],
    "LDE": ["dl1"],
}
PLAYERS = {
    "rb1": {"full_name": "Starter Back", "team": "DET", "position": "RB", "status": "Active"},
    "rb2": {"full_name": "Backup Back", "team": "DET", "position": "RB", "status": "Active"},
    "rb3": {"full_name": "Third Back", "team": "DET", "position": "RB", "status": "Active"},
    "wr1": {"full_name": "Split End", "team": "DET", "position": "WR", "status": "Active"},
    "wr4": {"full_name": "Rookie Receiver", "team": "DET", "position": "WR", "status": "Active"},
    "te9": {"full_name": "Undrafted Tight End", "team": "DET", "position": "TE", "status": "Active",
            "depth_chart_order": 2},
    "te8": {"full_name": "Starting Tight End", "team": "DET", "position": "TE", "status": "Active",
            "depth_chart_order": 1},
}


def test_next_in_line_walks_down_the_depth_chart():
    got = impact.next_in_line(DEPTH, PLAYERS, "rb1")
    assert [b["player_id"] for b in got] == ["rb2", "rb3"]
    assert got[0]["steps"] == 1
    assert "Starter Back" in got[0]["reason"]


def test_next_in_line_uses_the_players_own_group_not_the_whole_position():
    assert [b["player_id"] for b in impact.next_in_line(DEPTH, PLAYERS, "wr1")] == ["wr4"]
    assert impact.next_in_line(DEPTH, PLAYERS, "wr4") == []  # last in his group


def test_next_in_line_falls_back_to_teammates_when_he_is_not_on_the_chart():
    got = impact.next_in_line(DEPTH, PLAYERS, "te8")
    assert [b["player_id"] for b in got] == ["te9"]


def test_ahead_of_lists_the_blockers():
    assert impact.ahead_of(DEPTH, "rb3") == ["rb1", "rb2"]
    assert impact.ahead_of(DEPTH, "rb1") == []


def test_opportunity_fires_when_a_blocker_is_out_and_flags_how_certain_it_is():
    out = impact.opportunity(DEPTH, PLAYERS, {"rb1": {"injury_status": "IR"}}, "rb2")
    assert out["certain"] is True
    assert "Starter Back (IR)" in out["reason"]

    soft = impact.opportunity(DEPTH, PLAYERS, {"rb1": {"injury_status": "Questionable"}}, "rb2")
    assert soft["certain"] is False

    assert impact.opportunity(DEPTH, PLAYERS, {}, "rb2") is None
    assert impact.opportunity(DEPTH, PLAYERS, {"rb1": {"injury_status": "Out"}}, "rb1") is None


def test_opportunity_reads_the_players_file_when_the_injury_feed_is_quiet():
    players = {**PLAYERS, "rb1": {**PLAYERS["rb1"], "injury_status": "Out"}}
    assert impact.opportunity(DEPTH, players, {}, "rb2")["certain"] is True
