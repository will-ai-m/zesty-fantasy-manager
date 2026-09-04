import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


class ConfigError(RuntimeError):
    """Raised when required local configuration is missing."""


def _load_dotenv(path: Path) -> None:
    """Minimal .env loader: KEY=VALUE per line, '#' comments, no override of real env vars."""
    if not path.exists():
        return
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


_load_dotenv(ROOT / ".env")

DATA_DIR = Path(os.environ.get("ZFM_DATA_DIR", ROOT / "data"))
SLEEPER_USERNAME = os.environ.get("SLEEPER_USERNAME", "").strip()
SPORT = "nfl"


def require_username() -> str:
    if not SLEEPER_USERNAME:
        raise ConfigError("SLEEPER_USERNAME is not set. Copy .env.example to .env and fill in your Sleeper username.")
    return SLEEPER_USERNAME

# Fantasy-relevant positions for the waiver pool. IDP positions are not used by the
# current leagues; add DL/LB/DB here if a league ever needs them.
FANTASY_POSITIONS = ("QB", "RB", "WR", "TE", "K", "DEF")

# Slot -> eligible fantasy positions (Sleeper roster_positions vocabulary).
SLOT_ELIGIBILITY: dict[str, tuple[str, ...]] = {
    "QB": ("QB",),
    "RB": ("RB",),
    "WR": ("WR",),
    "TE": ("TE",),
    "K": ("K",),
    "DEF": ("DEF",),
    "FLEX": ("RB", "WR", "TE"),
    "WRRB_FLEX": ("RB", "WR"),
    "REC_FLEX": ("WR", "TE"),
    "SUPER_FLEX": ("QB", "RB", "WR", "TE"),
    "DL": ("DL", "DE", "DT"),
    "LB": ("LB",),
    "DB": ("DB", "CB", "S"),
    "IDP_FLEX": ("DL", "DE", "DT", "LB", "DB", "CB", "S"),
}
NON_STARTING_SLOTS = ("BN", "IR", "TAXI")

# Injury designations that mean the player will not play this week.
OUT_STATUSES = ("Out", "IR", "PUP", "Sus", "COV", "NA", "DNR")
