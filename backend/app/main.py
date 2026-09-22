from __future__ import annotations

from contextlib import asynccontextmanager
from typing import Literal

import httpx
from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .cache import Cache
from .config import DATA_DIR, ESPN_LEAGUE_IDS, ESPN_S2, ESPN_SWID, YAHOO_COOKIE, YAHOO_LEAGUE_IDS, ConfigError
from .espn import Espn
from .yahoo import Yahoo
from .odds import Odds
from .picks import PickIn, PickStore
from .services import Service
from .sleeper import Sleeper


@asynccontextmanager
async def lifespan(app: FastAPI):
    cache = Cache(DATA_DIR / "cache")
    sleeper = Sleeper(cache)
    app.state.cache = cache
    app.state.sleeper = sleeper
    espn = Espn(cache, ESPN_S2, ESPN_SWID) if ESPN_LEAGUE_IDS else None
    app.state.espn = espn
    yahoo = Yahoo(cache, YAHOO_COOKIE) if (YAHOO_LEAGUE_IDS and YAHOO_COOKIE) else None
    app.state.yahoo = yahoo
    odds = Odds(cache)
    app.state.odds = odds
    app.state.service = Service(sleeper, espn, yahoo, odds)
    app.state.picks = PickStore(DATA_DIR / "stream_picks.json")
    yield
    await app.state.odds.aclose()
    await sleeper.aclose()
    if espn:
        await espn.aclose()
    if yahoo:
        await yahoo.aclose()


app = FastAPI(title="Zesty Fantasy Manager", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"], allow_methods=["*"], allow_headers=["*"])


@app.exception_handler(ConfigError)
async def config_error(_, exc: ConfigError):
    return JSONResponse(status_code=500, content={"detail": str(exc)})


@app.exception_handler(httpx.HTTPStatusError)
async def sleeper_error(_, exc: httpx.HTTPStatusError):
    return JSONResponse(status_code=502, content={"detail": f"Sleeper returned {exc.response.status_code} for {exc.request.url}"})


def svc() -> Service:
    return app.state.service


@app.get("/api/health")
async def health():
    return {"ok": True}


@app.get("/api/state")
async def state():
    return await svc().state()


@app.get("/api/me")
async def me():
    return await svc().me()


@app.get("/api/leagues/{league_id}/waivers")
async def waivers(league_id: str, week: int | None = Query(default=None, ge=1, le=18)):
    return await svc().waivers(league_id, week)


@app.get("/api/streaming")
async def streaming(week: int | None = Query(default=None, ge=1, le=18)):
    """K and D/ST across every league: the next four weeks of lines, and where each is open."""
    return await svc().streaming(week)


@app.get("/api/leagues/{league_id}/rosters")
async def rosters(league_id: str, week: int | None = Query(default=None, ge=1, le=18)):
    return await svc().rosters(league_id, week)


@app.get("/api/leagues/{league_id}/transactions")
async def transactions(league_id: str, weeks: int = Query(default=3, ge=1, le=18)):
    return await svc().transactions(league_id, weeks)


@app.get("/api/games")
async def games(
    week: int | None = Query(default=None, ge=1, le=18),
    season: int | None = Query(default=None, ge=2020, le=2100),
):
    """NFL games for a week, chronological, with Vegas lines and implied team totals."""
    st = await svc().state()
    return await app.state.odds.week(
        season if season is not None else int(st["season"]),
        week if week is not None else int(st["current_week"]),
    )


@app.get("/api/my-players")
async def my_players(week: int | None = Query(default=None, ge=1, le=18)):
    return await svc().my_players(week)


@app.get("/api/players/{player_id}")
async def player(player_id: str, league_id: str | None = None):
    return await svc().player_detail(player_id, league_id)


@app.post("/api/cache/refresh")
async def refresh(prefix: str = ""):
    app.state.cache.invalidate(prefix)
    return {"ok": True}


# ---- streaming picks ----------------------------------------------------
async def _picks() -> list[dict]:
    season = (await svc().state())["season"]
    return [p.model_dump() for p in await app.state.picks.list(season)]


@app.get("/api/stream-picks")
async def list_picks():
    return await _picks()


@app.put("/api/stream-picks")
async def set_pick(body: PickIn):
    """Make this unit your pick for its league, position and week, replacing any earlier one.
    Answers with every pick for the season, so the page can swap its copy in one step."""
    await app.state.picks.set((await svc().state())["season"], body)
    return await _picks()


@app.delete("/api/stream-picks")
async def clear_pick(league_id: str, position: Literal["K", "DEF"], week: int = Query(ge=1, le=18)):
    await app.state.picks.clear((await svc().state())["season"], league_id, position, week)
    return await _picks()
