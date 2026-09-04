"""League-specific fantasy points: sum(stat * weight) over the league's scoring_settings.
Sleeper's stat records already contain the bucket flags (pts_allow_14_20, bonus_rec_yd_100, ...)
so a plain weighted sum reproduces Sleeper's own scoring."""
from __future__ import annotations


def score(stats: dict[str, float] | None, scoring: dict[str, float]) -> float | None:
    if not stats:
        return None
    total = 0.0
    for key, value in stats.items():
        weight = scoring.get(key)
        if weight and value:
            total += value * weight
    return round(total, 2)
