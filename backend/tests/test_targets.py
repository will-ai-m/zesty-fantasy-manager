from app.targets import priority, starter_baselines

BASELINES = {"starter_proj": {"RB": 10.0, "WR": 9.0}, "max_adds": 20_000, "waiver_pool": 56}


def base(**over):
    row = {"player_id": "1", "position": "RB", "vs_mine": 0, "adds_24h": 0, "proj_week": 0, "fp": {}}
    row.update(over)
    return row


def test_a_clear_upgrade_with_expert_and_market_backing_outranks_a_dart():
    strong = priority(base(vs_mine=28, adds_24h=15_000, proj_week=12.0,
                           fp={"waiver_rank": 2, "pos_rank": "RB22", "pos_rank_n": 22}), BASELINES)
    dart = priority(base(vs_mine=-4, adds_24h=12, proj_week=2.0), BASELINES)
    assert strong["score"] > 70 > dart["score"]
    assert strong["parts"]["upgrade"] > 0.9
    assert strong["parts"]["expert"] > 0.9


def test_the_score_explains_itself():
    got = priority(base(vs_mine=18, adds_24h=19_000, proj_week=11.0,
                        fp={"waiver_rank": 4}), BASELINES)
    assert any("rest-of-season" in w for w in got["why"])
    assert any("waiver-wire #4" in w for w in got["why"])
    assert any("adds in 24h" in w for w in got["why"])
    assert any("starter" in w for w in got["why"])
    assert set(got["parts"]) == {"upgrade", "expert", "trend", "role", "opportunity"}


def test_a_cleared_path_lifts_the_score_and_says_why():
    quiet = priority(base(vs_mine=5, proj_week=6.0), BASELINES)
    opened = priority(base(vs_mine=5, proj_week=6.0,
                           opportunity={"certain": True, "reason": "Starter Back (IR) is ahead of him on the depth chart"}),
                      BASELINES)
    assert opened["score"] > quiet["score"]
    assert opened["parts"]["opportunity"] == 1.0
    assert "IR" in opened["why"][-1]
    soft = priority(base(vs_mine=5, proj_week=6.0, opportunity={"certain": False, "reason": "Questionable ahead"}), BASELINES)
    assert quiet["score"] < soft["score"] < opened["score"]


def test_rest_of_season_rank_stands_in_when_the_waiver_page_has_not_ranked_him():
    ranked = priority(base(fp={"ros_pos_rank": 20, "ros_pos_rank_label": "RB20"}), BASELINES)
    unranked = priority(base(fp={"ros_pos_rank": 58, "ros_pos_rank_label": "RB58"}), BASELINES)
    assert ranked["parts"]["expert"] > unranked["parts"]["expert"] >= 0
    assert priority(base(), BASELINES)["parts"]["expert"] == 0.0


def test_starter_baselines_scale_with_what_the_league_starts():
    rows = [{"position": "RB", "proj_week": float(30 - i)} for i in range(30)]
    rows += [{"position": "QB", "proj_week": float(25 - i)} for i in range(25)]
    # 10 teams starting 2 RB + 1 FLEX -> RB demand 2.33 * 10 = 23 startable RBs.
    got = starter_baselines(rows, ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "K", "DEF", "BN"], teams=10)
    assert got["RB"] == 30 - 22
    assert got["QB"] == 25 - 9  # 10 startable QBs
