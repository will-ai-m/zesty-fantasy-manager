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
week-to-week carryover, so the matchup carries most of the weight: a defence is good this week if
its opponent is projected to score little, and a kicker is good if his own offence is projected to
score a lot, both read off Vegas implied totals.

FantasyPros' K and D/ST rankings sit in the next column rather than being folded into that
number. The two disagree often — the experts weigh a defence's own quality, the line only weighs
who it is playing — and which one to trust is a judgement worth making per player, not one to
average away. The weekly rankings cover one week at a time, so the current week shows those and
the weeks after it fall back to the rest-of-season ranking, which is a standing view of the unit
rather than a stale copy of last week's matchup call. Each row records which of the two it is.
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
    """Order by snap share first, then by volume as the tie-break.

    Snap share leads: it says whether the coaching staff is putting him on the field at all, which
    is the thing that has to be true before volume can follow. Volume — targets for a receiver or
    tight end, carries for a back — separates the players who are out there and being used from
    the ones who are merely out there.

    The two are ranked rather than blended, so a 90%-snap receiver always sits above a 60%-snap
    one no matter how the target counts fall. Volume is compared within position, since 9 targets
    and 9 carries are not the same week's work.

    Quarterbacks are excluded outright: they play every snap and throw every pass their team
    throws, so both numbers are constants that say nothing about whether to add one.
    """
    pool = [r for r in rows if r.get("position") in VOLUME_STAT and r.get("position") != "QB"]
    vol_rank = _percentile_within(pool, _volume_count)
    out = []
    for r in pool:
        if r.get("lw_snap_pct") is None and _volume_count(r) is None:
            continue  # didn't play last week; nothing to rank
        out.append({**r, "volume_rank": round(vol_rank.get(r["player_id"], 0.0), 3)})
    out.sort(key=lambda r: (-(r.get("lw_snap_pct") or 0.0), -r["volume_rank"]))
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
    # Adds first, then the speculative stashes, then the buy-low/sell/hold calls, which are
    # commentary rather than claims.
    order = {"add": 0, "stash": 1, "buy": 2, "hold": 3, "sell": 4}
    items.sort(key=lambda i: (order.get(i["action"], 9), i["priority"] == "low"))
    # Name-only groups — handcuff tiers, drop lists. They carry no reasoning per player, so
    # they stay out of `items`, where every row is a claim with a note behind it.
    lists = [{
        "label": g.get("label"),
        "action": g.get("action", "stash"),
        "names": g.get("names", []),
        "sources": [names.get(x, x) for x in g.get("sources", [])],
    } for g in data.get("lists", []) if g.get("names")]
    return {"week": week, "sources": data.get("sources", []), "items": items, "lists": lists}


# --------------------------------------------------------------------------- streaming
def _fp_rank(row: dict) -> int | None:
    """FantasyPros' weekly positional rank as a plain number. "DST1" -> 1."""
    digits = "".join(c for c in str(row.get("fp_pos_rank") or "") if c.isdigit())
    return int(digits) if digits else None


def stream_candidates(rows: list[dict], position: str, week_odds: dict[str, dict], week: int,
                      fp_week: int | None = None, ros_ranks: dict[str, int] | None = None,
                      starters: set[str] | None = None) -> list[dict]:
    """Rank available K or D/ST for one week on the matchup, carrying FantasyPros' rank alongside.

    A defence scores on its *opponent's* implied total (low is good); a kicker on his *own*
    team's (high is good). FantasyPros' rank is attached for comparison but kept out of the
    ordering — the two measure different things and where they disagree is worth seeing, not
    averaging. The week FantasyPros has actually ranked gets its weekly rank; the weeks past it
    get the rest-of-season rank instead, and `fp_basis` says which, because "3rd this week" and
    "3rd the rest of the way" are not the same claim. Teams on bye, or with no line posted yet,
    are dropped rather than ranked at zero — an unpriced game is unknown, not bad.

    `starters` restricts the pool to players who hold the job. It matters for kickers: every
    team carries one, but a backup sitting on the practice squad shares his starter's implied
    total exactly, so ranking on the matchup alone floats him up beside the man actually taking
    the kicks. FantasyPros ranking a kicker for the week is the cheapest available read on who
    that is. Left as None for D/ST, where a unit cannot be second string.
    """
    use_fp = fp_week is not None and week == fp_week
    ros_ranks = ros_ranks or {}
    out = []
    for r in rows:
        team = r.get("team")
        if not team:
            continue
        if starters is not None and r["player_id"] not in starters:
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
        if use_fp:
            fp_rank, fp_basis = _fp_rank(r), "week"
        else:
            fp_rank, fp_basis = ros_ranks.get(r["player_id"]), "ros"
        out.append({
            **r,
            "week": week,
            "matchup": g.get("label"),
            "implied": round(float(own), 1),
            "opp_implied": round(float(opp_imp), 1) if opp_imp is not None else None,
            "stream_basis": basis,
            "fp_rank": fp_rank,
            "fp_basis": fp_basis if fp_rank is not None else None,
            "stream_score": round(value, 3),
        })
    out.sort(key=lambda r: -r["stream_score"])
    return out
