"""Game-time weather for K and D/ST streaming.

Two layers, because they keep for very different lengths of time:

- The **roof**, known for every game on the schedule. A kicker indoors is kicking in still air
  whatever the forecast says, and that is as true of week 6 as of this Sunday.
- The **forecast**, from Open-Meteo (free, no key, open-meteo.com): hourly wind, gusts,
  precipitation and temperature at the stadium across the hours the game is played. Only for
  kickoffs within `FORECAST_DAYS` — wind is the thing that matters and a wind forecast past about
  a week is noise, so beyond that the game shows its roof and nothing else.

Stadiums are keyed by nflverse's `stadium_id`, which the schedule carries for every game
including neutral-site ones. Coordinates are from Wikidata (P625) as of 2026-09-22. Roof types
are kept here by hand rather than read from nflverse, whose `roof` column is blank for every
retractable roof on future games and wrong for several 2026 international venues (it calls the
MCG and the Allianz Arena domes; both have open-air pitches).
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Literal, NamedTuple

import httpx

from .cache import Cache

OPEN_METEO = "https://api.open-meteo.com/v1/forecast"
HOUR = 3600
FORECAST_DAYS = 7
# Kickoff hour plus the three after it: a game runs a little over three hours.
GAME_HOURS = 4

Roof = Literal["dome", "retractable", "open"]


class Stadium(NamedTuple):
    name: str
    lat: float
    lon: float
    roof: Roof


STADIUMS: dict[str, Stadium] = {
    "ATL97": Stadium("Mercedes-Benz Stadium", 33.7553, -84.4008, "retractable"),
    "BAL00": Stadium("M&T Bank Stadium", 39.2781, -76.6228, "open"),
    "BOS00": Stadium("Gillette Stadium", 42.0909, -71.2643, "open"),
    "BUF00": Stadium("Highmark Stadium", 42.7730, -78.7922, "open"),
    "CAR00": Stadium("Bank of America Stadium", 35.2258, -80.8528, "open"),
    "CHI98": Stadium("Soldier Field", 41.8625, -87.6167, "open"),
    "CIN00": Stadium("Paycor Stadium", 39.0954, -84.5160, "open"),
    "CLE00": Stadium("Huntington Bank Field", 41.5061, -81.6994, "open"),
    "DAL00": Stadium("AT&T Stadium", 32.7477, -97.0929, "retractable"),
    "DEN00": Stadium("Empower Field at Mile High", 39.7439, -105.0200, "open"),
    "DET00": Stadium("Ford Field", 42.3400, -83.0456, "dome"),
    "GNB00": Stadium("Lambeau Field", 44.5014, -88.0622, "open"),
    "HOU00": Stadium("NRG Stadium", 29.6847, -95.4108, "retractable"),
    "IND00": Stadium("Lucas Oil Stadium", 39.7601, -86.1638, "retractable"),
    "JAX00": Stadium("EverBank Stadium", 30.3239, -81.6375, "open"),
    "KAN00": Stadium("GEHA Field at Arrowhead Stadium", 39.0489, -94.4839, "open"),
    # A fixed translucent canopy with open sides: weather-proof for football purposes.
    "LAX01": Stadium("SoFi Stadium", 33.9504, -118.3380, "dome"),
    "LON00": Stadium("Wembley Stadium", 51.5556, -0.2797, "open"),
    "LON02": Stadium("Tottenham Hotspur Stadium", 51.6044, -0.0664, "open"),
    "MAD01": Stadium("Bernabéu", 40.4531, -3.6883, "retractable"),
    "MEL00": Stadium("Melbourne Cricket Ground", -37.8199, 144.9834, "open"),
    "MEX00": Stadium("Estadio Banorte", 19.3031, -99.1506, "open"),
    "MIA00": Stadium("Hard Rock Stadium", 25.9581, -80.2389, "open"),
    "MIN01": Stadium("U.S. Bank Stadium", 44.9739, -93.2581, "dome"),
    "MUN01": Stadium("Allianz Arena", 48.2188, 11.6248, "open"),
    "NAS00": Stadium("Nissan Stadium", 36.1664, -86.7714, "open"),
    "NOR00": Stadium("Caesars Superdome", 29.9508, -90.0811, "dome"),
    "NYC01": Stadium("MetLife Stadium", 40.8136, -74.0744, "open"),
    "PAR00": Stadium("Stade de France", 48.9244, 2.3600, "open"),
    "PHI00": Stadium("Lincoln Financial Field", 39.9009, -75.1678, "open"),
    "PHO00": Stadium("State Farm Stadium", 33.5275, -112.2625, "retractable"),
    "PIT00": Stadium("Acrisure Stadium", 40.4467, -80.0158, "open"),
    "RIO00": Stadium("Maracanã", -22.9122, -43.2303, "open"),
    "SEA00": Stadium("Lumen Field", 47.5953, -122.3317, "open"),
    "SFO01": Stadium("Levi's Stadium", 37.4034, -121.9700, "open"),
    "TAM00": Stadium("Raymond James Stadium", 27.9758, -82.5033, "open"),
    "VEG00": Stadium("Allegiant Stadium", 36.0908, -115.1830, "dome"),
    "WAS00": Stadium("Northwest Stadium", 38.9078, -76.8644, "open"),
}

# Where a team plays at home, for a game the schedule does not place. Sleeper abbreviations.
HOME: dict[str, str] = {
    "ARI": "PHO00", "ATL": "ATL97", "BAL": "BAL00", "BUF": "BUF00", "CAR": "CAR00", "CHI": "CHI98",
    "CIN": "CIN00", "CLE": "CLE00", "DAL": "DAL00", "DEN": "DEN00", "DET": "DET00", "GB": "GNB00",
    "HOU": "HOU00", "IND": "IND00", "JAX": "JAX00", "KC": "KAN00", "LAC": "LAX01", "LAR": "LAX01",
    "LV": "VEG00", "MIA": "MIA00", "MIN": "MIN01", "NE": "BOS00", "NO": "NOR00", "NYG": "NYC01",
    "NYJ": "NYC01", "PHI": "PHI00", "PIT": "PIT00", "SEA": "SEA00", "SF": "SFO01", "TB": "TAM00",
    "TEN": "NAS00", "WAS": "WAS00",
}

HOURLY = ("temperature_2m", "precipitation_probability", "precipitation", "snowfall",
          "wind_speed_10m", "wind_gusts_10m")


def _kickoff(iso: str | None) -> datetime | None:
    if not iso:
        return None
    try:
        return datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone(timezone.utc)
    except ValueError:
        return None


class Weather:
    def __init__(self, cache: Cache):
        self.cache = cache
        self.http = httpx.AsyncClient(timeout=httpx.Timeout(30.0, connect=10.0))

    async def aclose(self) -> None:
        await self.http.aclose()

    async def _hourly(self) -> dict[str, dict]:
        """stadium_id -> {"UTC hour": {variable: value}} for every open-air stadium, one request
        for all of them. Refreshed hourly; a forecast does not move faster than that."""
        ids = [sid for sid, s in STADIUMS.items() if s.roof == "open"]

        async def loader() -> dict[str, dict]:
            r = await self.http.get(OPEN_METEO, params={
                "latitude": ",".join(str(STADIUMS[s].lat) for s in ids),
                "longitude": ",".join(str(STADIUMS[s].lon) for s in ids),
                "hourly": ",".join(HOURLY),
                "wind_speed_unit": "mph", "temperature_unit": "fahrenheit", "precipitation_unit": "inch",
                "timezone": "GMT", "forecast_days": FORECAST_DAYS + 1,
            })
            r.raise_for_status()
            out: dict[str, dict] = {}
            for sid, loc in zip(ids, r.json()):
                h = loc["hourly"]
                out[sid] = {t: {v: h[v][i] for v in HOURLY} for i, t in enumerate(h["time"])}
            return out
        return await self.cache.get("open_meteo:stadiums", HOUR, loader)

    def _forecast(self, hourly: dict, kickoff: datetime) -> dict | None:
        """The game window's worst case: strongest wind and gust, likeliest precipitation, the
        total that falls, the coldest hour. `hours` is how many of the window's hours the
        forecast covered."""
        rows = [hourly.get((kickoff + timedelta(hours=n)).strftime("%Y-%m-%dT%H:00")) for n in range(GAME_HOURS)]
        rows = [r for r in rows if r]
        if not rows:
            return None

        def col(v: str) -> list[float]:
            return [r[v] for r in rows if r.get(v) is not None]
        wind, gust, prob = col("wind_speed_10m"), col("wind_gusts_10m"), col("precipitation_probability")
        temp = col("temperature_2m")
        return {
            "wind": round(max(wind)) if wind else None,
            "gust": round(max(gust)) if gust else None,
            "precip_prob": round(max(prob)) if prob else None,
            "precip": round(sum(col("precipitation")), 2),
            "snow": round(sum(col("snowfall")), 2),
            "temp": round(min(temp)) if temp else None,
            "hours": len(rows),
        }

    async def games(self, games: list[dict]) -> dict[str, dict]:
        """game_id -> {stadium, roof, forecast} for games on the odds payload. `forecast` is None
        indoors, past the forecast horizon, for a game already over, or if Open-Meteo is down —
        the roof still stands in every one of those cases."""
        now = datetime.now(timezone.utc)
        hourly: dict[str, dict] | None = None
        out: dict[str, dict] = {}
        for g in games:
            sid = g.get("stadium_id") if g.get("stadium_id") in STADIUMS else HOME.get(g.get("home") or "")
            if not sid:
                continue
            st = STADIUMS[sid]
            forecast = None
            kick = _kickoff(g.get("kickoff"))
            if st.roof == "open" and kick and now - timedelta(hours=GAME_HOURS) <= kick <= now + timedelta(days=FORECAST_DAYS):
                if hourly is None:
                    try:
                        hourly = await self._hourly()
                    except (httpx.HTTPError, KeyError, ValueError, TypeError):
                        hourly = {}
                forecast = self._forecast(hourly.get(sid) or {}, kick.replace(minute=0, second=0, microsecond=0))
            out[g["game_id"]] = {"stadium": st.name, "roof": st.roof, "forecast": forecast}
        return out
