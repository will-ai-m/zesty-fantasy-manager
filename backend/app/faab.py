"""What to bid.

There is no public feed of FAAB prices, but every league publishes its own: waiver transactions
carry the winning bid, and Sleeper keeps the losing bids too. So a suggestion here is a transparent
rule — how much a player is worth to *this* roster, on a curve — calibrated to what this league has
actually been paying, and always returned with the comparable bids it was calibrated against.
"""
from __future__ import annotations

from dataclasses import dataclass

# Fraction of the season budget the model would spend on a can't-miss add before calibration.
TOP_SHARE = 0.35
CURVE_EXP = 2.2
CALIBRATION_ANCHOR = TOP_SHARE * 0.85 ** CURVE_EXP  # model's bid for a "very strong" (0.85) target


@dataclass(frozen=True)
class Bid:
    player_id: str
    name: str | None
    position: str | None
    bid: int
    won: bool
    week: int | None
    when: int | None


def percentile(values: list[float], p: float) -> float | None:
    """Linear-interpolated percentile of an unsorted list. p in 0..100."""
    if not values:
        return None
    xs = sorted(values)
    if len(xs) == 1:
        return xs[0]
    pos = (len(xs) - 1) * (p / 100.0)
    lo = int(pos)
    hi = min(lo + 1, len(xs) - 1)
    return xs[lo] + (xs[hi] - xs[lo]) * (pos - lo)


def bids(transactions: list[dict], players: dict[str, dict]) -> list[Bid]:
    """Waiver claims with a bid attached, won and lost, newest first."""
    out: list[Bid] = []
    for t in transactions:
        if t.get("type") != "waiver":
            continue
        amount = (t.get("settings") or {}).get("waiver_bid")
        if amount is None:
            continue
        adds = t.get("adds") or {}
        if not adds:
            continue
        won = (t.get("status") or "").lower() == "complete"
        for pid in adds:
            p = players.get(pid) or {}
            out.append(Bid(
                player_id=pid,
                name=p.get("full_name") or (f"{p.get('team')} D/ST" if p.get("position") == "DEF" else pid),
                position=p.get("position"),
                bid=int(amount),
                won=won,
                week=t.get("leg"),
                when=t.get("status_updated") or t.get("created"),
            ))
    out.sort(key=lambda b: -(b.when or 0))
    return out


def market(history: list[Bid], budget: int) -> dict:
    """What this league pays: the shape of its winning bids, as a share of the season budget."""
    won = [b for b in history if b.won and b.bid > 0]
    shares = [b.bid / budget for b in won] if budget else []
    top = sorted(won, key=lambda b: -b.bid)[:5]
    return {
        "budget": budget,
        "claims": len(history),
        "won": len(won),
        "max": max((b.bid for b in won), default=None),
        "median": round(percentile([b.bid for b in won], 50) or 0) if won else None,
        "p75": round(percentile([b.bid for b in won], 75) or 0) if won else None,
        "p90": round(percentile([b.bid for b in won], 90) or 0) if won else None,
        "p90_share": percentile(shares, 90),
        "top": [{"player_id": b.player_id, "name": b.name, "position": b.position, "bid": b.bid, "week": b.week} for b in top],
    }


def pace_multiplier(remaining: int, budget: int, weeks_left: int, total_weeks: int = 17) -> float:
    """Bid up when you are sitting on budget late, down when you have already spent ahead of pace."""
    if not budget or not total_weeks:
        return 1.0
    expected = max(0.05, min(1.0, weeks_left / total_weeks))
    ratio = (remaining / budget) / expected
    return max(0.6, min(1.6, round(ratio, 2)))


def suggest(
    value: float,
    league_market: dict,
    remaining: int,
    bid_min: int = 0,
    pace: float = 1.0,
    position: str | None = None,
    history: list[Bid] | None = None,
) -> dict:
    """`value` is the target's priority, 0–1. Returns a dollar range plus how it got there."""
    budget = int(league_market.get("budget") or 0)
    value = max(0.0, min(1.0, float(value)))
    share = TOP_SHARE * value ** CURVE_EXP

    calibration = 1.0
    p90_share = league_market.get("p90_share")
    if league_market.get("won", 0) >= 5 and p90_share:
        calibration = max(0.4, min(2.5, round(p90_share / CALIBRATION_ANCHOR, 2)))

    mid = share * calibration * pace * budget
    low, high = mid * 0.6, mid * 1.5
    cap = max(0, int(remaining))
    # A minimum bid you cannot afford is not a minimum bid.
    floor = min(max(1, bid_min), cap) if budget else 0

    def clamp(x: float) -> int:
        return max(floor, min(cap, round(x)))

    lo, md, hi = clamp(low), clamp(mid), clamp(high)
    lo, hi = min(lo, md), max(hi, md)

    comps = [b for b in (history or []) if b.won and (position is None or b.position == position)]
    comps.sort(key=lambda b: abs(b.bid - md))
    reasons = [f"priority {round(value * 100)}/100 → {round(share * 100)}% of a ${budget} budget"]
    if calibration != 1.0:
        reasons.append(f"×{calibration} for this league's prices (top bids near ${league_market.get('p90')})")
    if pace != 1.0:
        reasons.append(f"×{pace} for budget pace (${remaining} left)")
    return {
        "low": lo, "mid": md, "high": hi,
        "share_of_remaining": round(md / remaining, 3) if remaining else None,
        "calibrated": calibration != 1.0,
        "basis": "; ".join(reasons),
        "comparables": [{"name": b.name, "bid": b.bid, "week": b.week, "position": b.position} for b in comps[:3]],
    }
