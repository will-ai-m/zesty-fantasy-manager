"""Waiver-wire decisions: three separate reads on the free-agent pool, plus weekly K/D-ST streamers.

The pool is deliberately *not* collapsed into one ranking. Blending expert consensus, scoring and
usage into a single number buries the disagreements, and the disagreements are the interesting
part — a player the experts like who saw no snaps is a different proposition from one who led his
team in targets but nobody has ranked yet. So each signal gets its own ordered list and you read
them against each other:

  by_fantasypros  their waiver shortlist, in their order — the forward-looking expert view.
  by_production   what happened on the field last week: points first, then volume, then snap
                  share, each as the tie-break on the one before it.

Production reads down that order because the three answer progressively softer questions. Points
are the result and settle it outright where they differ. They rarely tie above zero — but a large
part of any waiver pool scored nothing at all, and that is exactly where the other two earn their
place: among players who put up nothing, the one who ran a route on 80% of the snaps and saw six
targets is a different proposition from the one who took two snaps. Volume is the touch that
defines the role — targets for a receiver or tight end, carries *and* targets for a back, since a
back who catches is being used either way — and snap share is the last word on whether the staff
put him on the field.

**Streamers** are a different question entirely. K and D/ST are matchup plays with almost no
week-to-week carryover, so the matchup carries most of the weight: a defence is good this week if
its opponent is projected to score little, and a kicker is good if his own offence is projected to
score a lot, both read off Vegas implied totals.

FantasyPros' K and D/ST rankings sit in their own columns rather than being folded into that
number — the weekly rank and the rest-of-season rank both, since "best this Sunday" and "worth
holding" are different questions and the gap between them is the interesting part. Neither
touches the ordering, which is Vegas alone.

Each row runs the next four weeks of matchups across it, because the good matchup three weeks
out is claimed by whoever looks that far ahead.
"""
from __future__ import annotations

from typing import Any

# The touches that define a role at each position. A back's receiving work counts towards his
# volume as much as his carries do; a receiver has only the one kind of touch.
VOLUME_STATS = {"WR": ("lw_targets",), "TE": ("lw_targets",), "RB": ("lw_carries", "lw_targets")}


def volume(row: dict) -> float | None:
    """Last week's defining touches: targets for a receiver or tight end, carries plus targets
    for a back. None when the position has no such touch, or when none were recorded."""
    stats = VOLUME_STATS.get(row.get("position") or "")
    if not stats:
        return None
    counts = [row.get(k) for k in stats]
    return float(sum(c for c in counts if c)) if any(c is not None for c in counts) else None


def rank_by_production(rows: list[dict]) -> list[dict]:
    """Order by last week's points, breaking ties on volume and then on snap share.

    Strictly in that order rather than blended into a score. Points are the outcome and outrank
    the inputs wherever they separate two players at all; volume and snap share decide the rest,
    which in a waiver pool is most of it, since so much of the pool scored nothing. Reading them
    as a fixed order rather than a weighted sum keeps every row explicable from the columns on
    screen — you can see which number put a player where he is.

    Players with nothing recorded at all last week are dropped; there is no reading to give.
    """
    out = []
    for r in rows:
        vol = volume(r)
        if r.get("last_week_pts") is None and vol is None and r.get("lw_snap_pct") is None:
            continue
        out.append({**r, "lw_volume": vol})
    out.sort(key=lambda r: (-(r.get("last_week_pts") or 0.0), -(r["lw_volume"] or 0.0),
                            -(r.get("lw_snap_pct") or 0.0)))
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


def stream_table(rows: list[dict], position: str, odds_by_week: dict[int, dict[str, dict]],
                 weeks: list[int], fp_week: int | None = None, ros_ranks: dict[str, int] | None = None,
                 starters: set[str] | None = None, factors: dict[str, dict] | None = None) -> list[dict]:
    """One row per available K or D/ST, carrying the next few weeks of matchups across it.

    A streaming decision is never about one week in isolation — the good matchup three weeks out
    gets claimed by whoever looks that far, and a unit worth holding is one with two or three
    good weeks in a row. So the schedule runs across the row rather than down three separate
    tables, and you read a defence's next month at a glance.

    Ordering is on the current week only: a defence by its opponent's implied total, ascending,
    because it scores off the other team failing; a kicker by his own team's, descending. Rows
    with no game or no line this week sort last rather than being dropped — the team is still on
    the board for the weeks after it.

    FantasyPros' weekly rank and its rest-of-season rank both ride along, in separate fields.
    They answer different questions — who is best this Sunday, and who is worth holding — and
    neither is folded into the ordering, which is Vegas alone.

    `starters` restricts the pool to players who hold the job, which matters for kickers: a
    backup shares his starter's implied total exactly and would otherwise rank beside him.
    `factors` attaches team offensive efficiency, the context that says whether a team's points
    tend to arrive as touchdowns or as field goals.
    """
    ros_ranks, factors = ros_ranks or {}, factors or {}
    this_week = weeks[0]
    use_fp = fp_week is not None and fp_week == this_week
    out = []
    for r in rows:
        team = r.get("team")
        if not team:
            continue
        if starters is not None and r["player_id"] not in starters:
            continue
        schedule = []
        for w in weeks:
            g = (odds_by_week.get(w) or {}).get(team)
            schedule.append({
                "week": w,
                # No entry at all means no game that week — a bye, not an unpriced one.
                "matchup": g.get("label") if g else None,
                "implied": g.get("implied") if g else None,
                "opp_implied": g.get("opp_implied") if g else None,
                "weather": g.get("weather") if g else None,
            })
        now = schedule[0]
        basis = now["opp_implied"] if position == "DEF" else now["implied"]
        out.append({
            **r,
            "weeks": schedule,
            "matchup": now["matchup"],
            "stream_basis": round(float(basis), 1) if basis is not None else None,
            "fp_rank": _fp_rank(r) if use_fp else None,
            "fp_ros_rank": ros_ranks.get(r["player_id"]),
            "factors": factors.get(team) if position == "K" else None,
        })
    # Lower implied against is a better defensive spot; higher implied for is a better kicking
    # spot. Either way a row with nothing priced this week goes to the bottom.
    worst = float("inf")
    if position == "DEF":
        out.sort(key=lambda r: r["stream_basis"] if r["stream_basis"] is not None else worst)
    else:
        out.sort(key=lambda r: -r["stream_basis"] if r["stream_basis"] is not None else worst)
    return out
