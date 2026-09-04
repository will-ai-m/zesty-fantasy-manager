from app import faab

PLAYERS = {
    "1": {"full_name": "Bucky Irving", "position": "RB"},
    "2": {"full_name": "Jauan Jennings", "position": "WR"},
    "3": {"full_name": "Cade Otton", "position": "TE"},
}


def waiver(pid, bid, status="complete", leg=3, stamp=1_700_000_000_000):
    return {"type": "waiver", "status": status, "leg": leg, "status_updated": stamp,
            "settings": {"waiver_bid": bid}, "adds": {pid: 1}, "drops": {}}


def test_bids_reads_winning_and_losing_claims():
    txs = [
        waiver("1", 42),
        waiver("1", 31, status="failed"),
        {"type": "free_agent", "status": "complete", "adds": {"2": 1}},          # no bid
        {"type": "waiver", "status": "complete", "adds": {}, "settings": {"waiver_bid": 5}},  # nothing added
        {"type": "trade", "status": "complete", "adds": {"3": 2}},
    ]
    got = faab.bids(txs, PLAYERS)
    assert [(b.name, b.bid, b.won) for b in got] == [("Bucky Irving", 42, True), ("Bucky Irving", 31, False)]
    assert got[0].position == "RB"


def test_market_summarizes_only_the_winning_bids():
    history = [faab.Bid("1", "A", "RB", 40, True, 2, 1), faab.Bid("2", "B", "WR", 20, True, 3, 2),
               faab.Bid("3", "C", "TE", 4, True, 4, 3), faab.Bid("4", "D", "RB", 90, False, 4, 4)]
    m = faab.market(history, budget=100)
    assert m["won"] == 3 and m["claims"] == 4
    assert m["max"] == 40 and m["median"] == 20
    assert m["top"][0]["bid"] == 40
    assert 0.3 < m["p90_share"] <= 0.4


def test_percentile_interpolates():
    assert faab.percentile([10, 20, 30], 50) == 20
    assert faab.percentile([10, 20], 50) == 15
    assert faab.percentile([], 50) is None
    assert faab.percentile([7], 90) == 7


def test_suggest_scales_with_priority_and_never_exceeds_what_you_have():
    quiet_market = faab.market([], budget=100)
    top = faab.suggest(0.95, quiet_market, remaining=100)
    mid = faab.suggest(0.5, quiet_market, remaining=100)
    dart = faab.suggest(0.1, quiet_market, remaining=100)
    assert top["mid"] > mid["mid"] > dart["mid"] >= 1
    assert top["low"] <= top["mid"] <= top["high"]
    assert faab.suggest(0.95, quiet_market, remaining=7)["high"] <= 7
    assert faab.suggest(0.05, quiet_market, remaining=100, bid_min=3)["low"] >= 3


def test_suggest_calibrates_to_a_league_that_bids_big():
    cheap = faab.market([faab.Bid(str(i), "x", "RB", 3, True, 1, i) for i in range(8)], budget=100)
    rich = faab.market([faab.Bid(str(i), "x", "RB", 55, True, 1, i) for i in range(8)], budget=100)
    assert faab.suggest(0.8, rich, 100)["mid"] > faab.suggest(0.8, cheap, 100)["mid"]
    assert faab.suggest(0.8, rich, 100)["calibrated"] is True
    # Under five claims there is nothing to calibrate on, so the plain curve stands.
    thin = faab.market([faab.Bid("1", "x", "RB", 90, True, 1, 1)], budget=100)
    assert faab.suggest(0.8, thin, 100)["calibrated"] is False


def test_suggest_returns_same_position_comparables_and_its_reasoning():
    history = [faab.Bid("1", "A RB", "RB", 30, True, 2, 1), faab.Bid("2", "A WR", "WR", 12, True, 3, 2),
               faab.Bid("3", "Lost", "RB", 80, False, 3, 3)]
    out = faab.suggest(0.7, faab.market(history, 100), remaining=60, position="RB", history=history)
    assert [c["name"] for c in out["comparables"]] == ["A RB"]  # winners only, position matched
    assert "priority 70/100" in out["basis"]


def test_pace_multiplier_rewards_unspent_budget_late():
    assert faab.pace_multiplier(100, 100, 17, 17) == 1.0
    assert faab.pace_multiplier(80, 100, 4, 17) > 1.2   # lots left, season nearly over
    assert faab.pace_multiplier(10, 100, 15, 17) < 1.0  # spent early
    assert faab.pace_multiplier(0, 0, 5, 17) == 1.0
