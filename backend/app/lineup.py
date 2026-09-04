"""Optimal lineup = maximum-weight assignment of players to starting slots (Hungarian algorithm)."""
from __future__ import annotations

from .config import NON_STARTING_SLOTS, SLOT_ELIGIBILITY

INELIGIBLE = -1e9


def starting_slots(roster_positions: list[str]) -> list[str]:
    return [s for s in roster_positions if s not in NON_STARTING_SLOTS]


def eligible(slot: str, positions: list[str]) -> bool:
    allowed = SLOT_ELIGIBILITY.get(slot)
    if allowed is None:
        return slot in positions
    return any(p in allowed for p in positions)


def _hungarian_max(weights: list[list[float]]) -> list[int]:
    """Return assignment[row] = col (or -1) maximizing total weight. Rows are slots, cols are players."""
    n_rows, n_cols = len(weights), len(weights[0]) if weights else 0
    n = max(n_rows, n_cols)
    # Convert to a square min-cost problem.
    big = max((w for row in weights for w in row if w > INELIGIBLE), default=0.0) + 1.0
    cost = [[big] * n for _ in range(n)]
    for i in range(n_rows):
        for j in range(n_cols):
            cost[i][j] = big - weights[i][j] if weights[i][j] > INELIGIBLE else big * 1000
    INF = float("inf")
    u = [0.0] * (n + 1)
    v = [0.0] * (n + 1)
    p = [0] * (n + 1)   # p[j] = row assigned to column j (1-based)
    way = [0] * (n + 1)
    for i in range(1, n + 1):
        p[0] = i
        j0 = 0
        minv = [INF] * (n + 1)
        used = [False] * (n + 1)
        while True:
            used[j0] = True
            i0 = p[j0]
            delta = INF
            j1 = 0
            for j in range(1, n + 1):
                if not used[j]:
                    cur = cost[i0 - 1][j - 1] - u[i0] - v[j]
                    if cur < minv[j]:
                        minv[j] = cur
                        way[j] = j0
                    if minv[j] < delta:
                        delta = minv[j]
                        j1 = j
            for j in range(n + 1):
                if used[j]:
                    u[p[j]] += delta
                    v[j] -= delta
                else:
                    minv[j] -= delta
            j0 = j1
            if p[j0] == 0:
                break
        while True:
            j1 = way[j0]
            p[j0] = p[j1]
            j0 = j1
            if j0 == 0:
                break
    assignment = [-1] * n_rows
    for j in range(1, n + 1):
        row = p[j] - 1
        if 0 <= row < n_rows and j - 1 < n_cols and weights[row][j - 1] > INELIGIBLE:
            assignment[row] = j - 1
    return assignment


def optimal_lineup(slots: list[str], players: list[dict]) -> list[str | None]:
    """players: [{player_id, positions: [...], weight: float, current_slot: int | None}].
    Returns player_id per slot. Maximizes total weight; among equal totals, keeps players in
    the slot they already occupy (weights are scaled so a 0.01-point edge always beats the bonus)."""
    if not slots or not players:
        return [None] * len(slots)
    weights = [
        [
            (round(p["weight"] * 100) * 100 + (1 if p.get("current_slot") == i else 0))
            if eligible(slot, p["positions"]) else INELIGIBLE
            for p in players
        ]
        for i, slot in enumerate(slots)
    ]
    assignment = _hungarian_max(weights)
    return [players[j]["player_id"] if j >= 0 else None for j in assignment]
