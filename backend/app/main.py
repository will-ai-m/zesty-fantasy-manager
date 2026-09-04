from __future__ import annotations

from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from .cache import Cache
from .config import DATA_DIR, ESPN_LEAGUE_IDS, ESPN_S2, ESPN_SWID, FANTASYPROS_DELAY, FANTASYPROS_ENABLED, \
    NEWS_ENABLED, ConfigError
from .espn import Espn
from .fantasypros import FantasyPros
from .news import News, SeenStore
from .plans import PlanIn, PlanPatch, PlanStore
from .services import Service
from .sleeper import Sleeper


@asynccontextmanager
async def lifespan(app: FastAPI):
    cache = Cache(DATA_DIR / "cache")
    sleeper = Sleeper(cache)
    app.state.cache = cache
    app.state.sleeper = sleeper
    espn = Espn(cache, ESPN_S2, ESPN_SWID) if ESPN_LEAGUE_IDS else None
    fp = FantasyPros(cache, FANTASYPROS_DELAY, FANTASYPROS_ENABLED)
    news = News(cache, NEWS_ENABLED)
    app.state.espn = espn
    app.state.fp = fp
    app.state.news = news
    app.state.service = Service(sleeper, espn, fp, news)
    app.state.plans = PlanStore(DATA_DIR / "plans.json")
    app.state.news_seen = SeenStore(DATA_DIR / "news_seen.json")
    yield
    await sleeper.aclose()
    await fp.aclose()
    await news.aclose()
    if espn:
        await espn.aclose()


app = FastAPI(title="Zesty Fantasy Manager", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"], allow_methods=["*"], allow_headers=["*"])


@app.exception_handler(ConfigError)
async def config_error(_, exc: ConfigError):
    return JSONResponse(status_code=500, content={"detail": str(exc)})


@app.exception_handler(httpx.HTTPStatusError)
async def sleeper_error(_, exc: httpx.HTTPStatusError):
    return JSONResponse(status_code=502, content={"detail": f"Sleeper returned {exc.response.status_code} for {exc.request.url}"})


class SeenIn(BaseModel):
    keys: list[str]
    seen: bool = True


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


@app.get("/api/leagues/{league_id}/roster")
async def roster(league_id: str, week: int | None = Query(default=None, ge=1, le=18)):
    return await svc().roster(league_id, week)


@app.get("/api/leagues/{league_id}/rosters")
async def rosters(league_id: str, week: int | None = Query(default=None, ge=1, le=18)):
    return await svc().rosters(league_id, week)


@app.get("/api/leagues/{league_id}/transactions")
async def transactions(league_id: str, weeks: int = Query(default=3, ge=1, le=18)):
    return await svc().transactions(league_id, weeks)


@app.get("/api/leagues/{league_id}/waiver-board")
async def waiver_board(league_id: str, week: int | None = Query(default=None, ge=1, le=18), limit: int = Query(default=60, ge=1, le=200)):
    return await svc().waiver_board(league_id, week, limit)


@app.get("/api/leagues/{league_id}/lineup")
async def lineup(league_id: str, week: int | None = Query(default=None, ge=1, le=18)):
    return await svc().lineup(league_id, week)


@app.get("/api/week")
async def week_view():
    return await svc().week_view(await app.state.news_seen.all())


@app.get("/api/news")
async def news(league_id: str | None = None, limit: int = Query(default=60, ge=1, le=200)):
    return await svc().news_feed(league_id, limit, await app.state.news_seen.all())


@app.post("/api/news/seen")
async def news_seen(body: SeenIn):
    await app.state.news_seen.ack(body.keys, body.seen)
    return {"ok": True, "keys": body.keys, "seen": body.seen}


@app.get("/api/trends")
async def trends():
    return await svc().trends()


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


# ---- plans --------------------------------------------------------------
def _plan_player(players: dict, pid: str | None) -> dict | None:
    if not pid:
        return None
    p = players.get(pid, {})
    name = p.get("full_name") or (f"{p.get('team')} D/ST" if p.get("position") == "DEF" else pid)
    return {"player_id": pid, "name": name, "position": p.get("position"), "team": p.get("team")}


@app.get("/api/plans")
async def list_plans():
    store: PlanStore = app.state.plans
    players = await svc().s.players()
    out = []
    for plan in await store.list():
        d = plan.model_dump()
        d["add_player"] = _plan_player(players, plan.add_player_id)
        d["drop_player"] = _plan_player(players, plan.drop_player_id)
        out.append(d)
    out.sort(key=lambda d: (d["priority"] if d["priority"] is not None else 1_000, d["created_at"]))
    return out


@app.post("/api/plans", status_code=201)
async def create_plan(body: PlanIn):
    store: PlanStore = app.state.plans
    return (await store.create(body)).model_dump()


@app.patch("/api/plans/{plan_id}")
async def patch_plan(plan_id: str, body: PlanPatch):
    store: PlanStore = app.state.plans
    plan = await store.patch(plan_id, body)
    if plan is None:
        raise HTTPException(404, "plan not found")
    return plan.model_dump()


@app.delete("/api/plans/{plan_id}", status_code=204)
async def delete_plan(plan_id: str):
    store: PlanStore = app.state.plans
    if not await store.delete(plan_id):
        raise HTTPException(404, "plan not found")
    return None
