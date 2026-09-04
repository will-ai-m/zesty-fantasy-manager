"""Putting FantasyPros ranks and platform projections on one scale.

A rank says who is better; a projection says by how much. To start the FantasyPros consensus
without throwing away the league's own scoring, each position's ranked players are laid over that
position's projections in order: the player FantasyPros calls RB7 is credited with the 7th-highest
projection among ranked RBs. The result is in league points, so a flex slot can still weigh a WR
against a RB, and a player FantasyPros has not ranked keeps his own projection.
"""
from __future__ import annotations

from bisect import bisect_left
from collections.abc import Iterable

# Rank pages that cover several positions ("overall", "flex") only fill gaps; a player's own
# position page wins.
PAGE_PRIORITY = {"overall": 0, "flex": 1}


def merge_pages(pages: dict[str, dict]) -> dict[str, dict]:
    """Several rankings pages -> one row per FantasyPros player id."""
    out: dict[str, dict] = {}
    seen_from: dict[str, int] = {}
    for page_pos, page in pages.items():
        rank = PAGE_PRIORITY.get(page_pos.lower(), 2)
        for row in page.get("players") or []:
            fp_id = row["fp_id"]
            if fp_id not in out or rank > seen_from.get(fp_id, -1):
                out[fp_id] = row
                seen_from[fp_id] = rank
    return out


def build_curves(items: Iterable[tuple[str, int, float]]) -> dict[str, dict]:
    """(position, rank, projection) -> per position, the ranks seen and the projections they share.

    Pairing is by order rather than by rank number, so a position FantasyPros ranks 1, 4, 9 (because
    the others have no projection) still lines up cleanly against the three projections."""
    by_pos: dict[str, list[tuple[int, float]]] = {}
    for position, rank, proj in items:
        if position and rank and proj is not None:
            by_pos.setdefault(position, []).append((int(rank), float(proj)))
    return {
        pos: {"ranks": sorted(r for r, _ in pairs), "points": sorted((p for _, p in pairs), reverse=True)}
        for pos, pairs in by_pos.items()
    }


def implied_points(curves: dict[str, dict], position: str | None, rank: int | None) -> float | None:
    """What a player ranked `rank` at `position` is worth on the projection scale."""
    if not position or not rank:
        return None
    curve = curves.get(position)
    if not curve or not curve["points"]:
        return None
    index = min(bisect_left(curve["ranks"], int(rank)), len(curve["points"]) - 1)
    return round(curve["points"][index], 2)


def lineup_weight(row: dict) -> float:
    """Points a player is credited with when filling starting slots: FantasyPros' opinion where it
    exists, the league-scored projection otherwise."""
    implied = row.get("fp_implied")
    return float(implied if implied is not None else (row.get("proj_week") or 0.0))


def disagreement(row: dict, threshold: float = 2.5) -> float | None:
    """How far FantasyPros' opinion sits from the projection, in league points. Positive means the
    experts are higher on him than the numbers are."""
    implied, proj = row.get("fp_implied"), row.get("proj_week")
    if implied is None or proj is None:
        return None
    delta = round(implied - proj, 1)
    return delta if abs(delta) >= threshold else None
