from app.lineup import optimal_lineup
from app.ranks import build_curves, disagreement, implied_points, lineup_weight, merge_pages


def row(fp_id, pos, rank):
    return {"fp_id": fp_id, "position": pos, "pos_rank": f"{pos}{rank}", "pos_rank_n": rank, "rank": rank}


def test_merge_pages_prefers_the_position_page_over_overall():
    pages = {
        "overall": {"players": [dict(row("1", "RB", 40), tier=9)]},
        "rb": {"players": [dict(row("1", "RB", 4), tier=1)]},
    }
    assert merge_pages(pages)["1"]["tier"] == 1


def test_build_curves_and_implied_points_put_ranks_on_the_projection_scale():
    # Three ranked RBs projected 18, 12 and 4: the consensus RB1 is worth the best projection.
    curves = build_curves([("RB", 3, 4.0), ("RB", 1, 18.0), ("RB", 2, 12.0)])
    assert curves["RB"] == {"ranks": [1, 2, 3], "points": [18.0, 12.0, 4.0]}
    assert implied_points(curves, "RB", 1) == 18.0
    assert implied_points(curves, "RB", 3) == 4.0
    assert implied_points(curves, "RB", 99) == 4.0  # past the end, worth the last ranked player
    assert implied_points(curves, "WR", 1) is None  # no curve for that position
    assert implied_points(curves, "RB", None) is None


def test_ranks_pair_by_order_so_gaps_in_the_projections_do_not_compress_everyone():
    # FantasyPros ranked WR2, WR14 and WR30; only those three have projections here.
    curves = build_curves([("WR", 2, 20.0), ("WR", 14, 12.0), ("WR", 30, 6.0)])
    assert implied_points(curves, "WR", 2) == 20.0
    assert implied_points(curves, "WR", 14) == 12.0
    assert implied_points(curves, "WR", 30) == 6.0
    assert implied_points(curves, "WR", 20) == 6.0   # between 14 and 30: worth the next one down
    assert implied_points(curves, "WR", 1) == 20.0


def test_lineup_weight_falls_back_to_the_projection():
    assert lineup_weight({"fp_implied": 15.0, "proj_week": 9.0}) == 15.0
    assert lineup_weight({"proj_week": 9.0}) == 9.0
    assert lineup_weight({}) == 0.0


def test_disagreement_only_reports_meaningful_gaps():
    assert disagreement({"fp_implied": 15.0, "proj_week": 9.0}) == 6.0
    assert disagreement({"fp_implied": 9.5, "proj_week": 9.0}) is None
    assert disagreement({"proj_week": 9.0}) is None


def test_fantasypros_ranks_decide_the_flex_when_projections_disagree():
    # Projections like the WR; FantasyPros ranks the RB well ahead of him.
    players = [
        {"player_id": "rb", "positions": ["RB"], "weight": lineup_weight({"fp_implied": 14.0, "proj_week": 9.0})},
        {"player_id": "wr", "positions": ["WR"], "weight": lineup_weight({"fp_implied": 8.0, "proj_week": 11.0})},
    ]
    assert optimal_lineup(["FLEX"], players) == ["rb"]
