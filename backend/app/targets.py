"""How badly you want a free agent.

Five things make a waiver target worth a claim: he beats what you already have, the experts rate
him, the market is moving on him, he projects like a starter, and something has opened up his
role. Each is scored 0–1 from data the app already has, then weighted into one number so a board
of 300 free agents sorts by "claim this first" — and every score comes back with the parts it was
built from, because a number you can't argue with is a number you can't trust.
"""
from __future__ import annotations

import math

WEIGHTS = {"upgrade": 0.30, "expert": 0.22, "trend": 0.18, "role": 0.18, "opportunity": 0.12}
UPGRADE_CEILING = 30.0  # rest-of-season points over your weakest starter that counts as a full upgrade


def _clamp(x: float) -> float:
    return max(0.0, min(1.0, x))


def _expert(row: dict, waiver_pool: int) -> tuple[float, str | None]:
    fp = row.get("fp") or {}
    if fp.get("waiver_rank"):
        share = 1.0 - (fp["waiver_rank"] - 1) / max(1, waiver_pool)
        return _clamp(share), f"FantasyPros waiver-wire #{fp['waiver_rank']}"
    if fp.get("ros_pos_rank"):
        # Being your position's ROS 25 is roughly a starter; past 60 the experts have no interest.
        return _clamp(1.0 - (fp["ros_pos_rank"] - 1) / 60.0), f"ROS {fp['ros_pos_rank_label'] or fp['ros_pos_rank']}"
    if fp.get("pos_rank"):
        return _clamp(1.0 - ((fp.get("pos_rank_n") or 99) - 1) / 60.0), f"week {fp['pos_rank']}"
    return 0.0, None


def priority(row: dict, baselines: dict) -> dict:
    """`baselines`: {'starter_proj': {pos: pts}, 'max_adds': int, 'waiver_pool': int}."""
    parts: dict[str, float] = {}
    why: list[str] = []

    vs_mine = row.get("vs_mine")
    parts["upgrade"] = _clamp((vs_mine or 0) / UPGRADE_CEILING)
    if vs_mine and vs_mine > 0:
        why.append(f"+{round(vs_mine)} rest-of-season over your weakest {row.get('position')}")

    parts["expert"], expert_why = _expert(row, int(baselines.get("waiver_pool") or 56))
    if expert_why and parts["expert"] > 0.4:
        why.append(expert_why)

    max_adds = max(1, int(baselines.get("max_adds") or 1))
    adds = int(row.get("adds_24h") or 0)
    parts["trend"] = _clamp(math.log1p(adds) / math.log1p(max_adds))
    if parts["trend"] > 0.5:
        why.append(f"{adds:,} adds in 24h across Sleeper")

    baseline = (baselines.get("starter_proj") or {}).get(row.get("position")) or 0.0
    parts["role"] = _clamp((row.get("proj_week") or 0.0) / baseline) if baseline else 0.0
    if parts["role"] >= 0.95:
        why.append("projects like a starter this week")

    opp = row.get("opportunity")
    news = row.get("news_signal") or {}
    score = 0.0
    if opp:
        score = 1.0 if opp.get("certain") else 0.55
        why.append(opp["reason"])
    if news.get("direction", 0) > 0 and news.get("severity", 0) >= 2:
        score = max(score, 0.8)
        why.append(news.get("title") or "recent news in his favour")
    parts["opportunity"] = score

    total = sum(WEIGHTS[k] * v for k, v in parts.items())
    return {
        "score": round(100 * total),
        "parts": {k: round(v, 3) for k, v in parts.items()},
        "why": why[:4],
    }


def starter_baselines(rows: list[dict], roster_positions: list[str], teams: int) -> dict[str, float]:
    """The weekly projection of the last startable player at each position: the Nth best, where N is
    how many the league starts in total. Anything at or above it is a startable body."""
    demand: dict[str, float] = {}
    for slot in roster_positions:
        if slot in ("QB", "RB", "WR", "TE", "K", "DEF"):
            demand[slot] = demand.get(slot, 0) + 1
        elif slot in ("FLEX", "WRRB_FLEX", "REC_FLEX", "SUPER_FLEX"):
            for pos in ("RB", "WR", "TE"):  # a flex is shared demand across the three
                demand[pos] = demand.get(pos, 0) + 1 / 3
    out: dict[str, float] = {}
    by_pos: dict[str, list[float]] = {}
    for r in rows:
        if r.get("proj_week") is not None:
            by_pos.setdefault(r["position"], []).append(float(r["proj_week"]))
    for pos, values in by_pos.items():
        n = max(1, round(demand.get(pos, 1) * teams))
        values.sort(reverse=True)
        out[pos] = values[min(n, len(values)) - 1]
    return out
