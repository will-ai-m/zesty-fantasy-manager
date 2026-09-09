"""Verify the ESPN credentials in .env against ESPN's read API.

Usage: backend/.venv/bin/python .claude/skills/onboard-espn/scripts/check_espn.py [--season YYYY]

Reads ESPN_LEAGUE_IDS / ESPN_S2 / ESPN_SWID from the repo .env (real env vars win, same as
backend/app/config.py) and reports, per league: reachable, whose team the SWID owns, team count.
Never prints a whole credential. Exit code 1 if any league fails.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import sys
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[4]
BASE = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl"
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/128.0 Safari/537.36")


def load_dotenv(path: Path) -> None:
    if not path.exists():
        return
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key, value = key.strip(), value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


def mask(value: str) -> str:
    if len(value) <= 12:
        return value[:4] + "…"
    return f"{value[:6]}…{value[-4:]} ({len(value)} chars)"


def mask_swid(value: str) -> str:
    return f"{value[:10]}…{value[-5:]}" if len(value) > 20 else value[:6] + "…"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--season", default=None, help="season year (default: current, or last year before March)")
    args = ap.parse_args()

    load_dotenv(ROOT / ".env")
    league_ids = [x.strip() for x in os.environ.get("ESPN_LEAGUE_IDS", "").split(",") if x.strip()]
    s2 = os.environ.get("ESPN_S2", "").strip()
    swid = os.environ.get("ESPN_SWID", "").strip()

    today = dt.date.today()
    season = args.season or str(today.year if today.month >= 3 else today.year - 1)

    problems = 0
    print(f"repo .env: {ROOT / '.env'}")
    print(f"season:    {season}")
    print(f"ESPN_LEAGUE_IDS: {', '.join(league_ids) if league_ids else '(empty)'}")
    print(f"ESPN_S2:         {mask(s2) if s2 else '(empty)'}")
    print(f"ESPN_SWID:       {mask_swid(swid) if swid else '(empty)'}")
    print()

    if not league_ids:
        print("FAIL  ESPN_LEAGUE_IDS is empty — nothing to check. Add the leagueId from the league URL.")
        return 1
    for lid in league_ids:
        if not lid.isdigit():
            print(f"WARN  league id {lid!r} is not all digits — ESPN league ids are numeric.")
            problems += 1
    if swid and not re.fullmatch(r"\{[0-9A-Fa-f-]{36}\}", swid):
        print("WARN  ESPN_SWID should look like {XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX}, braces included.")
        problems += 1
    if bool(s2) != bool(swid):
        print("WARN  ESPN_S2 and ESPN_SWID must both be set (or both empty, for a public league).")
        problems += 1

    cookies = {"espn_s2": s2, "SWID": swid} if s2 and swid else None
    with httpx.Client(base_url=BASE, timeout=30.0, headers={"User-Agent": UA, "Accept": "application/json"},
                      cookies=cookies) as http:
        for lid in league_ids:
            print(f"league {lid}:")
            try:
                r = http.get(f"/seasons/{season}/segments/0/leagues/{lid}",
                             params=[("view", "mSettings"), ("view", "mTeam"), ("view", "mStatus")])
            except httpx.HTTPError as e:
                print(f"  FAIL  request failed: {e}")
                problems += 1
                continue
            if r.status_code == 401:
                detail = ""
                try:
                    detail = (r.json().get("details") or [{}])[0].get("message", "")
                except (json.JSONDecodeError, AttributeError, IndexError, TypeError):
                    detail = r.text[:120]
                print(f"  FAIL  401 {detail or 'not authorized'}")
                print("        Private league and the cookies are missing, expired, or from an account that "
                      "is not in this league. Re-copy espn_s2 and SWID while logged in to fantasy.espn.com.")
                problems += 1
                continue
            if r.status_code == 404:
                print(f"  FAIL  404 — no league {lid} in season {season}. Check the leagueId in the league URL, "
                      "or pass --season for an older year.")
                problems += 1
                continue
            if r.status_code != 200:
                print(f"  FAIL  HTTP {r.status_code}: {r.text[:160]}")
                problems += 1
                continue

            d = r.json()
            if isinstance(d, list):  # leagueHistory shape
                d = d[0]
            settings = d.get("settings") or {}
            teams = d.get("teams") or []
            members = d.get("members") or []
            name = settings.get("name") or "(unnamed)"
            print(f"  OK    \"{name}\" — {len(teams)} teams, scoringPeriodId {d.get('scoringPeriodId')}")

            mine = None
            if swid:
                for t in teams:
                    owners = [o for o in (t.get("owners") or []) if o]
                    if any(o.lower() == swid.lower() for o in owners):
                        mine = t
                        break
            if mine is not None:
                label = mine.get("name") or f"{mine.get('location','')} {mine.get('nickname','')}".strip()
                print(f"  OK    your team: {label or mine.get('id')} (teamId {mine.get('id')})")
            elif not swid:
                print("  WARN  no ESPN_SWID set — the league reads fine (public), but the app cannot tell "
                      "which team is yours.")
                problems += 1
            else:
                names = ", ".join(sorted(
                    (m.get("displayName") or m.get("firstName") or m.get("id", "")) for m in members)) or "none listed"
                print("  FAIL  the SWID does not own a team in this league. It belongs to a different ESPN "
                      "account than the one that plays here.")
                print(f"        league members: {names}")
                problems += 1

    print()
    if problems:
        print(f"{problems} problem(s) found.")
        return 1
    print("All ESPN leagues reachable and matched to your team.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
