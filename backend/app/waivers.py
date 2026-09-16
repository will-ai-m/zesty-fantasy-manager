"""Waiver-wire decisions: three separate reads on the free-agent pool, plus weekly K/D-ST streamers.

The pool is deliberately *not* collapsed into one ranking. Blending expert consensus, scoring and
usage into a single number buries the disagreements, and the disagreements are the interesting
part — a player the experts like who saw no snaps is a different proposition from one who led his
team in targets but nobody has ranked yet. So each signal gets its own ordered list and you read
them against each other:

  by_fantasypros  their waiver shortlist, in their order — the forward-looking expert view.
  by_points       what players actually scored last week, in this league's scoring.
  by_usage        snap share and volume, the leading indicator. Quarterbacks are left out: they
                  take every snap and their attempts say nothing about whether to add them.

Volume is read per position, because the touch that matters differs: targets for a receiver or
tight end, carries for a back.

**Streamers** are a different question entirely. K and D/ST are matchup plays with almost no
week-to-week carryover, so they rank on Vegas implied totals rather than season-long value:
a defence is good this week if its opponent is projected to score little, and a kicker is good
if his own offence is projected to score a lot.
"""
from __future__ import annotations

from typing import Any

# The touch that defines a role at each position. Counts are compared against other players at
# the same position rather than against a fixed threshold (see _percentile_within).
VOLUME_STAT = {"WR": "lw_targets", "TE": "lw_targets", "RB": "lw_carries"}


def _clamp(x: float, lo: float = 0.0, hi: float = 1.0) -> float:
    return max(lo, min(hi, x))


def _percentile_within(rows: list[dict], value) -> dict[str, float]:
    """{player_id: 0..1} by rank of `value` among the players at the same position who have one.

    Raw counts don't compare across positions — a quarterback throwing 35 times and a receiver
    seeing 9 targets are both full-time roles, and a quarterback's 25 points is an ordinary week
    where a tight end's would be a great one. Ranking each position against itself is what makes
    "best available" mean the same thing in every row.
    """
    by_pos: dict[str, list[tuple[str, float]]] = {}
    for r in rows:
        v = value(r)
        if v is None:
            continue
        by_pos.setdefault(r.get("position") or "", []).append((r["player_id"], float(v)))
    out: dict[str, float] = {}
    for group in by_pos.values():
        group.sort(key=lambda kv: kv[1])
        n = len(group)
        for i, (pid, _) in enumerate(group):
            out[pid] = 1.0 if n == 1 else i / (n - 1)
    return out


def _volume_count(row: dict) -> float | None:
    stat = VOLUME_STAT.get(row.get("position") or "")
    return row.get(stat) if stat else None


def rank_by_usage(rows: list[dict]) -> list[dict]:
    """Order by snap share and volume together, each ranked against the other available players
    at the same position — 9 targets means something different for a receiver than 9 carries does
    for a back, and neither compares to a quarterback's 35 attempts.

    Quarterbacks are excluded outright: they play every snap and throw every pass their team
    throws, so both numbers are constants that say nothing about whether to add one.
    """
    pool = [r for r in rows if r.get("position") in VOLUME_STAT and r.get("position") != "QB"]
    snaps = _percentile_within(pool, lambda r: r.get("lw_snap_pct"))
    vol = _percentile_within(pool, _volume_count)
    out = []
    for r in pool:
        pid = r["player_id"]
        if r.get("lw_snap_pct") is None and _volume_count(r) is None:
            continue  # didn't play last week; nothing to rank
        r = {**r, "usage_score": round((snaps.get(pid, 0.0) + vol.get(pid, 0.0)) / 2, 3)}
        out.append(r)
    out.sort(key=lambda r: -r["usage_score"])
    return out


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


def article_digest(data: dict | None, season: str, week: int) -> dict | None:
    """This week's waiver columns as a readable list, kept deliberately separate from the ranked
    table: the table is numbers only, and these are somebody's opinion, which is a different kind
    of claim and belongs in its own block.

    Columns are week-specific advice, so a file left over from an earlier week is dropped rather
    than shown as if it were current — stale "add this guy" is worse than no advice at all.
    """
    if not data or str(data.get("season")) != str(season) or int(data.get("week") or 0) != int(week):
        return None
    names = {s["id"]: s.get("name", s["id"]) for s in data.get("sources", [])}
    items = [{
        "name": p.get("name"),
        "position": p.get("position"),
        "team": p.get("team"),
        "action": p.get("action", "add"),
        "faab": p.get("faab"),
        "priority": p.get("priority"),
        "note": p.get("note"),
        "sources": [names.get(x, x) for x in p.get("sources", [])],
    } for p in data.get("players", [])]
    # Adds first, then the buy-low/sell/hold calls, which are commentary rather than claims.
    order = {"add": 0, "buy": 1, "hold": 2, "sell": 3}
    items.sort(key=lambda i: (order.get(i["action"], 9), i["priority"] == "low"))
    return {"week": week, "sources": data.get("sources", []), "items": items}


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
