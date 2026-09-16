"""Yahoo Fantasy Football client plus normalizers that turn Yahoo's league pages into the Sleeper-shaped
structures the service layer uses.

Yahoo's official OAuth API needs an approved app, and its clean JSON host (pub-api-ro) does not enforce
auth in a way we're willing to rely on. Instead we read the same pages the user's own browser loads on
`football.fantasysports.yahoo.com`, authenticated by the browser session cookie in `.env` (`YAHOO_COOKIE`).
Those pages are server-rendered HTML, so this module parses them with BeautifulSoup, keyed on stable
anchors (`data-ys-playerid`, `span.pos-label[data-pos]`, the settings tables). Read-only, no writes.

Yahoo exposes no projections, so the service layer scores Sleeper's projection stats with each league's
translated Yahoo scoring, exactly as it does for Sleeper-native leagues. Two fields the logged-in site
renders client-side (via JS) are NOT in the server HTML and are therefore unavailable on this path: each
team's live FAAB balance and waiver priority. They degrade to unknown; everything else (rosters, the
free-agent/waiver pool with ownership, scoring, records, transactions) comes from the server HTML.
See research/yahoo-cookie-access.md."""
from __future__ import annotations

import asyncio
import re
from typing import Any

import httpx
from bs4 import BeautifulSoup

from .cache import Cache
from .ids import Crosswalk

MIN = 60
HOUR = 3600

# Yahoo roster-slot label -> Sleeper roster_positions vocabulary.
SLOT_MAP = {
    "QB": "QB", "RB": "RB", "WR": "WR", "TE": "TE", "K": "K", "DEF": "DEF",
    "W/R/T": "FLEX", "W/R": "WRRB_FLEX", "W/T": "REC_FLEX", "R/W/T": "FLEX",
    "Q/W/R/T": "SUPER_FLEX", "BN": "BN", "IR": "IR",
}

# Yahoo player injury codes -> Sleeper injury_status vocabulary.
INJURY_MAP = {"Q": "Questionable", "D": "Doubtful", "O": "Out", "IR": "IR", "IR-R": "IR", "PUP-R": "PUP",
              "PUP-P": "PUP", "SUSP": "Sus", "SUS": "Sus", "NA": "NA", "NFI-R": "NA", "P": None, "": None}

# Yahoo team abbreviation (upper-cased) -> Sleeper abbreviation, where they differ. Yahoo writes mixed case
# ("Was", "Jax"); once upper-cased almost everything matches Sleeper, so only real differences belong here.
YAHOO_TEAM_ALIASES: dict[str, str] = {"JAC": "JAX", "WSH": "WAS"}

# Yahoo scoring category NAME (the settings page uses the long name) -> Sleeper scoring keys. A weight on a
# Yahoo category that lumps several Sleeper stats (2-point conversions) is written onto each; only one is
# ever non-zero for a given player-week, so the weighted sum stays correct. Yardage categories are handled
# separately (see YARDAGE_BASE) because Yahoo renders them as prose ("25 yards per point; 1 points at ...").
NAME_TO_SLEEPER: dict[str, tuple[str, ...]] = {
    "Passing Touchdowns": ("pass_td",), "Interceptions": ("pass_int",),
    "Rushing Touchdowns": ("rush_td",), "Receptions": ("rec",), "Receiving Touchdowns": ("rec_td",),
    "2-Point Conversions": ("pass_2pt", "rush_2pt", "rec_2pt"), "Fumbles Lost": ("fum_lost",),
    "Offensive Fumble Return TD": ("fum_rec_td",),
    "40+ Yard Completions": ("pass_cmp_40p",), "40+ Yard Passing Touchdowns": ("pass_td_40p",),
    "40+ Yard Run": ("rush_40p",), "40+ Yard Rushing Touchdowns": ("rush_td_40p",),
    "40+ Yard Receptions": ("rec_40p",), "40+ Yard Receiving Touchdowns": ("rec_td_40p",),
    "Passing 1st Downs": ("pass_fd",), "Receiving 1st Downs": ("rec_fd",), "Rushing 1st Downs": ("rush_fd",),
    "Field Goals 0-19 Yards": ("fgm_0_19",), "Field Goals 20-29 Yards": ("fgm_20_29",),
    "Field Goals 30-39 Yards": ("fgm_30_39",), "Field Goals 40-49 Yards": ("fgm_40_49",),
    "Field Goals 50+ Yards": ("fgm_50p",),
    "Field Goals Missed 0-19 Yards": ("fgmiss_0_19",), "Field Goals Missed 20-29 Yards": ("fgmiss_20_29",),
    "Field Goals Missed 30-39 Yards": ("fgmiss_30_39",), "Field Goals Missed 40-49 Yards": ("fgmiss_40_49",),
    "Point After Attempt Made": ("xpm",), "Point After Attempt Missed": ("xpmiss",),
    "Sack": ("sack",), "Interception": ("int",), "Fumble Recovery": ("fum_rec",), "Touchdown": ("def_td",),
    "Safety": ("safe",), "Block Kick": ("blk_kick",), "Kickoff and Punt Return Touchdowns": ("def_st_td",),
    "Points Allowed 0 points": ("pts_allow_0",), "Points Allowed 1-6 points": ("pts_allow_1_6",),
    "Points Allowed 7-13 points": ("pts_allow_7_13",), "Points Allowed 14-20 points": ("pts_allow_14_20",),
    "Points Allowed 21-27 points": ("pts_allow_21_27",), "Points Allowed 28-34 points": ("pts_allow_28_34",),
    "Points Allowed 35+ points": ("pts_allow_35p",),
    # Deliberately unmapped (no clean Sleeper projection key): "Return Touchdowns", "Extra Point Returned".
}
# Yardage category NAME -> Sleeper base key. Rate = 1 / "N yards per point"; distance bonuses become
# bonus_{stem}_yd_{N} for the buckets Sleeper actually carries.
YARDAGE_BASE = {"Passing Yards": "pass_yd", "Rushing Yards": "rush_yd", "Receiving Yards": "rec_yd"}
BONUS_BUCKETS = {100, 200, 300, 400}

_POSTEAM = re.compile(r"\b([A-Za-z]{2,3})\s*-\s*(QB|RB|WR|TE|K|DEF)\b")
_RECORD = re.compile(r"\b(\d+)-(\d+)-(\d+)\b")


def _num(x: Any) -> float | None:
    if x in (None, ""):
        return None
    try:
        return float(str(x).strip().rstrip("%"))
    except (TypeError, ValueError):
        return None


def _team_abbr(raw: str | None) -> str | None:
    if not raw:
        return None
    up = raw.strip().upper()
    return YAHOO_TEAM_ALIASES.get(up, up)


def _soup(html: str) -> BeautifulSoup:
    return BeautifulSoup(html, "html.parser")


# ------------------------------------------------------------------------- settings parsing
def _clean_category(name: str) -> str:
    """Strip the ' Yahoo Default' annotation Yahoo appends to categories left at their default value."""
    return re.sub(r"\s*Yahoo Default\s*$", "", name).strip()


def parse_scoring(soup: BeautifulSoup) -> dict[str, float]:
    """Scoring table rows (category name in td.first, value in the row's <b>) -> {sleeper_key: points}."""
    out: dict[str, float] = {}
    for tr in soup.find_all("tr"):
        first = tr.find("td", class_="first")
        b = tr.find("b")
        if not first or not b:
            continue
        name = _clean_category(first.get_text(" ", strip=True))
        val = b.get_text(" ", strip=True)
        if not name or val == "":
            continue
        if name in YARDAGE_BASE:
            base = YARDAGE_BASE[name]
            stem = base[:-3]  # pass_yd -> pass
            rate = re.search(r"([\d.]+)\s*yards?\s*per\s*point", val)
            if rate and float(rate.group(1)):
                out[base] = round(1.0 / float(rate.group(1)), 6)
            for pts, yds in re.findall(r"([\d.]+)\s*points?\s*at\s*(\d+)\s*yards", val):
                if int(yds) in BONUS_BUCKETS:
                    out[f"bonus_{stem}_yd_{yds}"] = float(pts)
            continue
        keys = NAME_TO_SLEEPER.get(name)
        v = _num(val)
        if not keys or not v:
            continue
        for k in keys:
            out[k] = v
    return out


def parse_settings(soup: BeautifulSoup) -> dict:
    """League name, roster positions, waiver/FAAB rules and playoff shape from the settings page prose."""
    text = re.sub(r"\s+", " ", soup.get_text(" ", strip=True))

    roster_positions: list[str] = []
    reserve_slots = 0
    m = re.search(r"Roster Positions:\s*([A-Z/,\s]+?)\s*(?:Fractional Points|Max |Bench Points|$)", text)
    if m:
        for tok in m.group(1).split(","):
            slot = SLOT_MAP.get(tok.strip(), tok.strip())
            if slot == "IR":
                reserve_slots += 1
            elif slot:
                roster_positions.append(slot)

    uses_faab = bool(re.search(r"Waiver Type:\s*FAB", text, re.I))
    wt = re.search(r"Waiver Time:\s*(\d+)\s*day", text, re.I)
    daily = bool(re.search(r"Waiver Type:.*?Game ?Time", text, re.I))
    # e.g. "Playoffs: 4 teams - Week 16 and 17"
    playoff = re.search(r"Playoffs:\s*(\d+)\s*teams?\s*-\s*Week\s*(\d+)", text, re.I)
    trade_end = re.search(r"Trade End Date:\s*([A-Za-z]+ \d+,\s*\d{4})", text)

    return {
        "roster_positions": roster_positions,
        "reserve_slots": reserve_slots,
        "scoring": parse_scoring(soup),
        "uses_faab": uses_faab,
        "waiver_clear_days": _num(wt.group(1)) if wt else None,
        "daily_waivers": daily,
        "playoff_teams": int(playoff.group(1)) if playoff else 0,
        "playoff_week_start": int(playoff.group(2)) if playoff else None,
        "trade_deadline_date": trade_end.group(1) if trade_end else None,
    }


# --------------------------------------------------------------------------- roster / player parsing
def _player_row(a) -> dict:
    """Extract {yahoo_id, name, team, position, injury, is_def} from a player's anchor within a row."""
    tr = a.find_parent("tr")
    cell = a.find_parent("td") or tr
    yid = a.get("data-ys-playerid")
    name = a.get("title") or a.get_text(" ", strip=True)
    href = a.get("href") or ""
    is_def = "/nfl/teams/" in href
    team = pos = None
    m = _POSTEAM.search(cell.get_text(" ", strip=True)) if cell else None
    if m:
        team, pos = _team_abbr(m.group(1)), m.group(2)
    inj_el = (cell or tr).select_one(".F-injury [title], .ysf-player-status [title]") if (cell or tr) else None
    injury = None
    if inj_el:
        code = (inj_el.get("title") or inj_el.get_text(strip=True) or "").strip()
        injury = INJURY_MAP.get(code.upper(), code or None)
    if is_def:
        pos = "DEF"
    return {"yahoo_id": yid, "name": name, "team": team, "position": pos, "injury": injury, "is_def": is_def}


def parse_roster(soup: BeautifulSoup) -> list[dict]:
    """A team page's #team-roster table -> [{slot, yahoo_id, name, team, position, injury, is_def}]."""
    tbl = soup.find(id="team-roster")
    rows: list[dict] = []
    if not tbl:
        return rows
    for tr in tbl.select("tbody tr"):
        label = tr.select_one("span.pos-label")
        a = tr.select_one("a.name[data-ys-playerid]") or tr.find("a", attrs={"data-ys-playerid": True})
        if not label or not a:
            continue
        rec = _player_row(a)
        rec["slot"] = SLOT_MAP.get(label.get("data-pos", "").strip(), label.get("data-pos", "").strip())
        rows.append(rec)
    return rows


def parse_home(soup: BeautifulSoup, league_id: str) -> dict:
    """Home page -> {league_name, my_team_id, teams: {team_id: {name, wins, losses, ties}}}."""
    league_name = None
    if soup.title:
        league_name = re.split(r"\s*[|\-]\s*", soup.title.get_text(strip=True))[0].strip() or None
    my_team_id = None
    for a in soup.find_all("a", href=re.compile(rf"/f1/{league_id}/\d+$")):
        if a.get_text(strip=True).lower() == "my team":
            my_team_id = re.search(r"/(\d+)$", a["href"]).group(1)
            break
    teams: dict[str, dict] = {}
    href_re = re.compile(rf"/f1/{league_id}/(\d+)$")
    for a in soup.find_all("a", href=href_re):
        tid = href_re.search(a["href"]).group(1)
        name = a.get_text(" ", strip=True)
        if not name or name.lower() == "my team" or tid in teams:
            continue
        wins = losses = ties = 0
        container = a.find_parent("tr") or a.find_parent("li") or a.parent
        if container:
            rm = _RECORD.search(container.get_text(" ", strip=True))
            if rm:
                wins, losses, ties = int(rm.group(1)), int(rm.group(2)), int(rm.group(3))
        teams[tid] = {"name": name, "wins": wins, "losses": losses, "ties": ties}
    return {"league_name": league_name, "my_team_id": my_team_id, "teams": teams}


# --------------------------------------------------------------------------- pool / transactions parsing
def parse_pool_page(soup: BeautifulSoup) -> list[dict]:
    """Players page -> [{yahoo_id, name, team, position, injury, owned, status}] for available players."""
    out: list[dict] = []
    for a in soup.select("a.name[data-ys-playerid], a.playernote[data-ys-playerid]"):
        if a.get("id", "").startswith("playernote"):  # dedupe: skip the icon anchor, keep the name anchor
            if "name" not in (a.get("class") or []):
                continue
        tr = a.find_parent("tr")
        if not tr:
            continue
        rec = _player_row(a)
        row_text = tr.get_text(" ", strip=True)
        owned = re.search(r"(\d+)%", row_text)
        rec["owned"] = float(owned.group(1)) if owned else None
        status = None
        for td in tr.find_all("td"):
            t = td.get_text(" ", strip=True)
            if t in ("FA", "W"):
                status = {"FA": "FREEAGENT", "W": "WAIVERS"}[t]
                break
        rec["status"] = status
        out.append(rec)
    return out


def parse_transactions(soup: BeautifulSoup) -> list[dict]:
    """Transactions table -> [{type, adds:[yid], drops:[yid]}], one entry per row. Yahoo phrases a row's
    move as 'Free Agent'/'Added' (an add) or 'To Waivers'/'Dropped'/'Waivers' (a drop); best-effort, and
    it can't split a combined add+drop that Yahoo renders as a single two-player row."""
    out: list[dict] = []
    tbl = soup.find("table", class_="Tst-transaction-table")
    if tbl is None:
        return out
    for tr in tbl.select("tr"):
        yids = [a["data-ys-playerid"] for a in tr.select("a[data-ys-playerid]") if a.get("data-ys-playerid")]
        if not yids:
            continue
        low = tr.get_text(" ", strip=True).lower()
        if "trade" in low:
            out.append({"type": "trade", "adds": yids, "drops": []})
        elif "free agent" in low or "added" in low:
            out.append({"type": "free_agent", "adds": yids, "drops": []})
        elif "waiver" in low or "dropped" in low:
            out.append({"type": "free_agent", "adds": [], "drops": yids})
    return out


class YahooAuthError(RuntimeError):
    """The session cookie is no longer valid. Distinct from a transport error because the fix is
    a human action (re-copy the cookie), not a retry."""


class Yahoo:
    BASE = "https://football.fantasysports.yahoo.com/f1"

    def __init__(self, cache: Cache, cookie: str):
        self.cache = cache
        headers = {
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml", "Cookie": cookie,
        }
        self.http = httpx.AsyncClient(base_url=self.BASE, timeout=httpx.Timeout(60.0, connect=15.0),
                                      headers=headers, follow_redirects=True)
        # Yahoo soft-throttles rapid reloads (documented ~1/10s, HTTP 999); cap concurrency to be polite.
        self._sem = asyncio.Semaphore(3)

    async def aclose(self) -> None:
        await self.http.aclose()

    async def _get(self, path: str) -> str:
        async with self._sem:
            r = await self.http.get(path)
            r.raise_for_status()
            # An expired cookie doesn't error — Yahoo just redirects to the login page, which
            # parses into plausible-looking nonsense (a league called "Login", an empty roster).
            # Catching it here turns a silently wrong league into an actionable message.
            if "login.yahoo.com" in str(r.url) or "/config/login" in str(r.url):
                raise YahooAuthError(
                    "Yahoo cookie has expired — grab a fresh one from your browser and update "
                    "YAHOO_COOKIE in .env"
                )
            return r.text

    async def league(self, league_id: str) -> dict:
        async def loader():
            settings_html, home_html = await asyncio.gather(
                self._get(f"/{league_id}/settings"), self._get(f"/{league_id}"),
            )
            settings = parse_settings(_soup(settings_html))
            home = parse_home(_soup(home_html), league_id)
            team_ids = sorted(home["teams"], key=int)
            team_htmls = await asyncio.gather(*(self._get(f"/{league_id}/{tid}") for tid in team_ids))
            teams = []
            for tid, html in zip(team_ids, team_htmls):
                meta = home["teams"][tid]
                teams.append({"team_id": tid, "name": meta["name"], "record": meta,
                              "roster": parse_roster(_soup(html))})
            return {"league_id": league_id, "name": home.get("league_name"), "settings": settings,
                    "my_team_id": home["my_team_id"], "teams": teams}
        return await self.cache.get(f"yahoo:league:{league_id}", 1 * MIN, loader)

    async def pool(self, league_id: str, limit: int = 150) -> list[dict]:
        """Available players (free agents + waivers) with ownership. Yahoo's players page shows 25 rows and
        paginates by `count` as an OFFSET (Next 25 -> count=25, 50, ...), not a page size. Offense is paged;
        K and DEF add a page each."""
        def url(pos: str, offset: int) -> str:
            return f"/{league_id}/players?status=A&pos={pos}&cut_type=9&sort=PR&sdir=1&count={offset}"
        async def loader():
            reqs = [url("O", off) for off in range(0, limit, 25)] + [url("K", 0), url("DEF", 0)]
            htmls = await asyncio.gather(*(self._get(p) for p in reqs))
            rows: list[dict] = []
            seen: set[str] = set()
            for html in htmls:
                for row in parse_pool_page(_soup(html)):
                    yid = row.get("yahoo_id")
                    if yid and yid not in seen:
                        seen.add(yid)
                        rows.append(row)
            return rows
        return await self.cache.get(f"yahoo:pool:{league_id}:{limit}", 10 * MIN, loader)

    async def transactions(self, league_id: str) -> list[dict]:
        async def loader():
            html = await self._get(f"/{league_id}/transactions")
            return parse_transactions(_soup(html))
        return await self.cache.get(f"yahoo:tx:{league_id}", 1 * MIN, loader)


# ----------------------------------------------------------------------------- normalizers
def _pid(xw: Crosswalk, rec: dict) -> tuple[str, str | None, dict | None]:
    """(canonical pid, yahoo id, synthetic Sleeper-like record if unmapped) for a parsed player row."""
    yid = rec.get("yahoo_id")
    name, pos, team = rec.get("name"), rec.get("position"), rec.get("team")
    if rec.get("is_def") or pos == "DEF":
        pid = team if team in xw.players else None
        if pid:
            return pid, yid, None
        synth = {"player_id": f"yahoo:{yid}", "full_name": f"{team} D/ST" if team else name, "position": "DEF",
                 "fantasy_positions": ["DEF"], "team": team, "status": "Active", "injury_status": None, "search_rank": 9999}
        return synth["player_id"], yid, synth
    pid = xw.from_yahoo(int(yid), name, pos) if yid and yid.isdigit() else None
    if pid:
        return pid, yid, None
    synth = {"player_id": f"yahoo:{yid}", "full_name": name, "position": pos,
             "fantasy_positions": [pos] if pos else [], "team": team, "status": "Active",
             "injury_status": rec.get("injury"), "search_rank": 9999}
    return synth["player_id"], yid, synth


def normalize_league(raw: dict, league_id: str, season: str, xw: Crosswalk) -> dict:
    """Parsed Yahoo pages -> bundle {league, rosters, users_by_id, my_roster, synthetic, yahoo_ids}."""
    s = raw["settings"]
    roster_positions = [p for p in s["roster_positions"] if p != "IR"]
    starting = [p for p in roster_positions if p != "BN"]
    scoring = s["scoring"]
    rec = scoring.get("rec", 0)
    playoff_start = s.get("playoff_week_start") or 15
    settings = {
        "waiver_type": 2 if s["uses_faab"] else 0,
        "waiver_budget": 100 if s["uses_faab"] else 0, "waiver_bid_min": 0,
        "waiver_clear_days": s.get("waiver_clear_days"),
        "daily_waivers": 1 if s.get("daily_waivers") else 0,
        "waiver_days": [], "waiver_hour": None, "waiver_day_of_week": None,
        "reserve_slots": s["reserve_slots"], "taxi_slots": 0, "type": 0,
        "num_teams": len(raw["teams"]),
        "playoff_week_start": playoff_start, "playoff_teams": s.get("playoff_teams") or 0,
        "trade_deadline": None, "trade_deadline_date": s.get("trade_deadline_date"), "leg": 1,
    }
    league = {
        "platform": "yahoo", "platform_league_id": league_id, "league_id": f"yahoo:{league_id}",
        "name": raw.get("name") or f"Yahoo {league_id}", "season": str(season),
        "status": "in_season", "avatar": None, "total_rosters": len(raw["teams"]),
        "roster_positions": roster_positions, "scoring_settings": scoring,
        "scoring_type": "ppr" if rec >= 1 else ("half_ppr" if rec > 0 else "std"),
        "settings": settings, "ros_end_week": 17,
    }

    users_by_id: dict[str, dict] = {}
    synthetic: dict[str, dict] = {}
    yahoo_ids: dict[str, str] = {}
    rosters = []
    my_team_id = raw.get("my_team_id")
    my_roster = None
    for t in raw["teams"]:
        tid = t["team_id"]
        owner_id = f"team:{tid}"
        users_by_id[owner_id] = {"user_id": owner_id, "display_name": t["name"], "avatar": None,
                                 "is_owner": False, "metadata": {"team_name": t["name"]}}
        players, reserve, starters = [], [], []
        by_slot: dict[str, list[str]] = {}
        for prow in t["roster"]:
            pid, yid, synth = _pid(xw, prow)
            if synth:
                synthetic[pid] = synth
            if yid:
                yahoo_ids[pid] = yid
            players.append(pid)
            slot = prow.get("slot")
            if slot == "IR":
                reserve.append(pid)
            elif slot and slot != "BN":
                by_slot.setdefault(slot, []).append(pid)
        # Fill starters in the league's own slot order so they line up with roster_positions in the UI.
        # roster_positions lists dedicated slots before FLEX, so FLEX naturally takes the leftovers.
        for slot in starting:
            queue = by_slot.get(slot, [])
            starters.append(queue.pop(0) if queue else "0")
        r = t["record"]
        roster = {
            "roster_id": int(tid), "owner_id": owner_id, "co_owners": [],
            "league_id": league["league_id"], "players": players, "starters": starters, "reserve": reserve, "taxi": [],
            "settings": {
                "wins": r.get("wins", 0), "losses": r.get("losses", 0), "ties": r.get("ties", 0),
                "fpts": 0.0, "fpts_decimal": 0, "fpts_against": 0.0, "fpts_against_decimal": 0,
                "waiver_position": None,       # not in the server HTML (client-rendered)
                "waiver_budget_used": 0,       # FAAB balance not in the server HTML (client-rendered)
                "total_moves": 0,
            },
            "metadata": {"team_name": t["name"]},
        }
        rosters.append(roster)
        if tid == my_team_id:
            my_roster = roster
    return {"league": league, "rosters": rosters, "users_by_id": users_by_id, "my_roster": my_roster,
            "user_id": my_team_id, "synthetic": synthetic, "yahoo_ids": yahoo_ids}


def normalize_pool(rows: list[dict], xw: Crosswalk) -> tuple[dict[str, dict], dict[str, dict]]:
    """Parsed pool rows -> ({pid: info}, {pid: synthetic}). info carries Yahoo ownership and FA/waiver status."""
    info: dict[str, dict] = {}
    synthetic: dict[str, dict] = {}
    for row in rows:
        pid, yid, synth = _pid(xw, row)
        if synth:
            synthetic[pid] = synth
        info[pid] = {
            "yahoo_id": yid, "position": row.get("position"), "status": row.get("status"),
            "waiver_until": None, "owned": row.get("owned"), "owned_change": None,
            "injury_status": row.get("injury"),
        }
    return info, synthetic


def normalize_transactions(rows: list[dict], yahoo_id_to_pid: dict[str, str]) -> list[dict]:
    """Parsed transaction rows -> the service-layer transaction shape."""
    out = []
    for i, t in enumerate(rows):
        adds = {yahoo_id_to_pid.get(y, f"yahoo:{y}"): 0 for y in t["adds"]}
        drops = {yahoo_id_to_pid.get(y, f"yahoo:{y}"): 0 for y in t["drops"]}
        out.append({
            "transaction_id": f"yahoo-tx-{i}", "type": t["type"], "status": "complete",
            "leg": None, "created": None, "status_updated": None, "settings": None, "metadata": {},
            "adds": adds, "drops": drops, "roster_ids": [], "draft_picks": [], "waiver_budget": [],
        })
    return out
