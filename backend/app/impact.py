"""Who benefits.

The point of an injury story is rarely the injured player — it is whoever is now first in line.
Sleeper publishes a per-team depth chart (`{"QB": [ids], "RB": [...], "WR1": [...], ...}`), so
"next man up" is the player behind him in his own group, and the reverse question — is this free
agent stuck behind somebody who is hurt — falls out of the same lists.
"""
from __future__ import annotations

from .config import OUT_STATUSES

# Depth chart groups whose members compete for the same fantasy touches.
GROUP_POSITION = {"QB": "QB", "RB": "RB", "TE": "TE", "WR1": "WR", "WR2": "WR", "WR3": "WR", "WR": "WR", "K": "K"}
DOUBTFUL = ("Doubtful", "Questionable")


def groups_of(depth: dict[str, list[str]], player_id: str) -> list[tuple[str, list[str]]]:
    return [(name, ids) for name, ids in (depth or {}).items() if name in GROUP_POSITION and player_id in ids]


def _label(players: dict[str, dict], pid: str) -> str:
    p = players.get(pid) or {}
    return p.get("full_name") or (f"{p.get('team')} D/ST" if p.get("position") == "DEF" else pid)


def next_in_line(depth: dict[str, list[str]], players: dict[str, dict], player_id: str, limit: int = 3) -> list[dict]:
    """Players who move up if `player_id` misses time, best candidate first."""
    groups = groups_of(depth, player_id)
    out: list[dict] = []
    seen = {player_id}
    for group, ids in groups:
        idx = ids.index(player_id)
        for step, pid in enumerate(ids[idx + 1:], start=1):
            if pid in seen:
                continue
            seen.add(pid)
            out.append({"player_id": pid, "name": _label(players, pid), "group": group, "steps": step,
                        "reason": f"{group}{idx + 1 + step} behind {_label(players, player_id)}"})
    if not groups:  # not on the depth chart at all: fall back to same-position teammates
        p = players.get(player_id) or {}
        team, position = p.get("team"), p.get("position")
        if team and position:
            mates = [(pid, q) for pid, q in players.items()
                     if pid != player_id and q.get("team") == team and q.get("position") == position and q.get("status") == "Active"]
            mates.sort(key=lambda kv: (kv[1].get("depth_chart_order") or 99))
            out = [{"player_id": pid, "name": _label(players, pid), "group": position, "steps": i,
                    "reason": f"{position} on {team} behind {_label(players, player_id)}"}
                   for i, (pid, _) in enumerate(mates, start=1)]
    out.sort(key=lambda b: b["steps"])
    return out[:limit]


def ahead_of(depth: dict[str, list[str]], player_id: str) -> list[str]:
    """Teammates listed above him in his own depth chart group."""
    out: list[str] = []
    for _, ids in groups_of(depth, player_id):
        out.extend(ids[:ids.index(player_id)])
    return list(dict.fromkeys(out))


def opportunity(depth: dict[str, list[str]], players: dict[str, dict], injuries: dict[str, dict], player_id: str) -> dict | None:
    """Is this player's path clearing? Returns the blocker who is hurt, if any."""
    blockers = []
    for pid in ahead_of(depth, player_id):
        status = (injuries.get(pid) or {}).get("injury_status") or (players.get(pid) or {}).get("injury_status")
        if status in OUT_STATUSES:
            blockers.append({"player_id": pid, "name": _label(players, pid), "injury_status": status, "certain": True})
        elif status in DOUBTFUL:
            blockers.append({"player_id": pid, "name": _label(players, pid), "injury_status": status, "certain": False})
    if not blockers:
        return None
    certain = any(b["certain"] for b in blockers)
    lead = blockers[0]
    return {
        "blockers": blockers,
        "certain": certain,
        "reason": f"{lead['name']} ({lead['injury_status']}) is ahead of him on the depth chart",
    }
