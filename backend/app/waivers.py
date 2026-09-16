"""Waiver-wire decisions: who to claim and what to bid, plus weekly K/D-ST streamers.

The waiver page answers two different questions, so this module computes two different things.

**Claim targets** blend four signals into one score. No single one is trustworthy alone: expert
consensus lags a breakout by a week, last week's box score overstates a touchdown fluke, and
opportunity (snaps, targets, carries) leads production but doesn't guarantee it. Roster fit
matters too — the best available player is worthless if he's behind two starters you already own.

**Streamers** are a different question entirely. K and D/ST are matchup plays with almost no
week-to-week carryover, so they rank on Vegas implied totals rather than season-long value:
a defence is good this week if its opponent is projected to score little, and a kicker is good
if his own offence is projected to score a lot.
"""
from __future__ import annotations

import math
from typing import Any

# Blend weights for the claim-target score. Expert consensus carries the most weight because it
# already folds in film and beat reporting we can't see; opportunity is next because it leads
# production. Market (what everyone else is adding) is a tiebreak, not a thesis.
WEIGHTS = {"expert": 0.35, "opportunity": 0.25, "production": 0.15, "fit": 0.15, "market": 0.10}

# Tier cutoffs on the blended score, and the FAAB each tier is worth as a percentage of the
# budget you have LEFT (not the original budget — late-season dollars are scarcer).
# "Balanced": wins most contested claims without leaving you broke for the next injury.
TIERS: list[tuple[str, float, dict[str, int]]] = [
    ("A", 0.78, {"min": 18, "rec": 25, "max": 35}),  # league-winner / every-week starter
    ("B", 0.58, {"min": 8, "rec": 13, "max": 20}),   # immediate starter in most weeks
    ("C", 0.36, {"min": 3, "rec": 5, "max": 9}),     # depth with a path to snaps
    ("D", 0.00, {"min": 1, "rec": 2, "max": 4}),     # speculative stash
]
# A high score alone doesn't make a player a priority claim — in a quiet week the best available
# player is still only depth. Capping the top tiers by rank keeps "spend 25% of your budget"
# rare enough to mean something.
TIER_RANK_CAP = {"A": 3, "B": 10}
TIER_LABEL = {"A": "Priority", "B": "Starter", "C": "Depth", "D": "Flier"}

# Weekly volume that reads as a full-time role, by position. Used to normalise last week's usage
# into 0..1 so a 9-target WR and a 17-carry RB score alike.
FULL_ROLE = {"WR": 9.0, "TE": 7.0, "RB": 16.0, "QB": 32.0}
# Last week's fantasy points that read as a strong week, by position.
BIG_WEEK = {"QB": 22.0, "RB": 16.0, "WR": 15.0, "TE": 12.0, "K": 10.0, "DEF": 12.0}


def _clamp(x: float, lo: float = 0.0, hi: float = 1.0) -> float:
    return max(lo, min(hi, x))


def _expert_score(row: dict, waiver_pool_size: int) -> float:
    """FantasyPros' waiver-wire page is a short, hand-picked shortlist (~50 players), so simply
    appearing on it is most of the signal; rank within it refines. Players absent from it fall
    back to their rest-of-season positional rank, worth much less."""
    wr = row.get("fp_waiver_rank")
    if wr:
        n = max(waiver_pool_size, 1)
        return 0.55 + 0.45 * _clamp(1.0 - (float(wr) - 1) / n)
    ros = row.get("fp_ros_pos_rank")
    if ros:
        # "WR38" -> 38. Beyond ~60 at a position there's no startable value left.
        digits = "".join(c for c in str(ros) if c.isdigit())
        if digits:
            return 0.35 * _clamp(1.0 - (int(digits) - 1) / 60.0)
    return 0.0


def _opportunity_score(row: dict) -> float:
    """Snap share plus role volume from the last completed week. This is the leading indicator —
    a back who just took 70% of snaps matters even if the box score was quiet."""
    pos = row.get("position")
    snap = row.get("lw_snap_pct")
    vol = row.get("lw_volume")
    parts: list[float] = []
    if snap is not None:
        parts.append(_clamp(float(snap)))
    if vol is not None and pos in FULL_ROLE:
        parts.append(_clamp(float(vol) / FULL_ROLE[pos]))
    if not parts:
        return 0.0
    return sum(parts) / len(parts)


def _production_score(row: dict) -> float:
    pts = row.get("last_week_pts")
    if pts is None:
        return 0.0
    return _clamp(float(pts) / BIG_WEEK.get(row.get("position") or "", 14.0))


def _fit_score(row: dict) -> float:
    """How much better, rest-of-season, than the weakest player you already roster at the spot.
    Negative (a downgrade) floors at zero rather than going negative, so fit can only add."""
    vs = row.get("vs_mine")
    if vs is None:
        return 0.0
    return _clamp(float(vs) / 40.0)


def _market_score(row: dict) -> float:
    """Sleeper adds in the last 24h, log-scaled — the difference between 10 and 100 adds matters
    much more than between 5,000 and 50,000."""
    adds = row.get("adds_24h") or 0
    if adds <= 0:
        return 0.0
    return _clamp(math.log10(float(adds) + 1) / 4.5)


def _downgrade_penalty(row: dict) -> float:
    """Scale the score down for a player projected *below* the weakest starter you already have
    at the spot. Snaps and a loud box score can otherwise float a backup QB into the priority
    tiers, but a player you would never actually start is not a claim at any price."""
    vs = row.get("vs_mine")
    if vs is None or vs >= 0:
        return 1.0
    return _clamp(1.0 + float(vs) / 120.0, 0.45, 1.0)


def score_target(row: dict, waiver_pool_size: int) -> dict[str, Any]:
    """Blended 0..1 score for one free agent, with its components kept visible so the table can
    show *why* a player is ranked where he is."""
    comps = {
        "expert": _expert_score(row, waiver_pool_size),
        "opportunity": _opportunity_score(row),
        "production": _production_score(row),
        "fit": _fit_score(row),
        "market": _market_score(row),
    }
    total = sum(comps[k] * w for k, w in WEIGHTS.items()) * _downgrade_penalty(row)
    return {"score": round(total, 4), "components": {k: round(v, 3) for k, v in comps.items()}}


def tier_for(score: float, rank: int | None = None) -> str:
    """Tier from the blended score, demoted if the player is outside the rank cap for that tier.
    `rank` is 1-based position in the sorted target list."""
    for name, cutoff, _ in TIERS:
        if score >= cutoff:
            cap = TIER_RANK_CAP.get(name)
            if cap is not None and rank is not None and rank > cap:
                continue  # good score, but not one of the week's genuine priorities
            return name
    return "D"


def bid_for(tier: str, remaining: int, budget: int, bid_min: int = 0, lead: float = 0.5) -> dict[str, Any] | None:
    """FAAB range for a tier, as dollars out of what's left. Returns None for leagues that don't
    use FAAB at all (rolling priority / reverse standings), where a dollar figure is meaningless.

    The range is deliberately wide: `min` is what it takes to not be embarrassed, `rec` is the
    number to actually enter, `max` is where the player stops being worth it and you walk away.
    """
    if not budget:
        return None
    pct = next((p for name, _, p in TIERS if name == tier), TIERS[-1][2])
    if remaining <= 0:
        return {"min": 0, "rec": 0, "max": 0, "pct": pct["rec"], "note": "no FAAB left"}

    def dollars(p: float) -> int:
        return max(bid_min, min(remaining, round(remaining * p / 100.0)))

    # `lead` (0..1) slides the recommendation within the tier: the standout target in a tier bids
    # near its top, the marginal one near its floor, rather than everyone entering the same number.
    span = pct["max"] - pct["min"]
    rec_pct = pct["min"] + span * (0.25 + 0.6 * _clamp(lead))
    lo, rec, hi = dollars(pct["min"]), dollars(rec_pct), dollars(pct["max"])
    lo, hi = min(lo, rec), max(hi, rec)  # keep the range ordered after clamping
    return {"min": lo, "rec": rec, "max": hi, "pct": round(rec_pct)}


# --------------------------------------------------------------------------- expert columns
EXPERT_FILE = "expert_adds.json"


def load_expert(data_dir) -> dict | None:
    """The hand-curated waiver-column notes, if present."""
    path = data_dir / EXPERT_FILE
    if not path.exists():
        return None
    import json
    try:
        return json.loads(path.read_text())
    except (ValueError, OSError):
        return None


def expert_index(data: dict | None, resolve, season: str, week: int) -> dict[str, dict]:
    """{player_id: note} for this week only.

    Waiver columns are week-specific advice, so a file left over from an earlier week is ignored
    rather than shown as if it were current — stale "add this guy" is worse than no advice.
    """
    if not data or str(data.get("season")) != str(season) or int(data.get("week") or 0) != int(week):
        return {}
    names = {s["id"]: s.get("name", s["id"]) for s in data.get("sources", [])}
    out: dict[str, dict] = {}
    for p in data.get("players", []):
        pid = resolve(p.get("name"), p.get("position"), p.get("team"))
        if not pid:
            continue
        out[pid] = {
            "action": p.get("action", "add"),
            "sources": [names.get(s, s) for s in p.get("sources", [])],
            "faab": p.get("faab"),
            "priority": p.get("priority"),
            "note": p.get("note"),
        }
    return out


# --------------------------------------------------------------------------- streaming
def stream_candidates(rows: list[dict], position: str, week_odds: dict[str, dict], week: int) -> list[dict]:
    """Rank available K or D/ST for one week on Vegas implied totals.

    A defence scores on its *opponent's* implied total (low is good); a kicker on his *own*
    team's (high is good). Teams on bye, or with no line posted yet, are dropped rather than
    ranked at zero — an unpriced game is unknown, not bad.
    """
    out = []
    for r in rows:
        team = r.get("team")
        if not team:
            continue
        g = week_odds.get(team)
        if not g or g.get("implied") is None:
            continue
        own, opp_imp = g["implied"], g.get("opp_implied")
        if position == "DEF":
            if opp_imp is None:
                continue
            # ~28 implied against is about as bad as a matchup gets, ~8 about as good; scaling
            # across that full span keeps distinct matchups distinct instead of clamping to a tie.
            value = _clamp((28.0 - float(opp_imp)) / 20.0)
            basis = round(float(opp_imp), 1)
        else:
            value = _clamp((float(own) - 10.0) / 20.0)
            basis = round(float(own), 1)
        out.append({
            **r,
            "week": week,
            "matchup": g.get("label"),
            "implied": round(float(own), 1),
            "opp_implied": round(float(opp_imp), 1) if opp_imp is not None else None,
            "stream_basis": basis,
            "stream_score": round(value, 3),
        })
    out.sort(key=lambda r: -r["stream_score"])
    return out
