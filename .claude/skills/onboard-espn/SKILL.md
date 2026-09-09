---
name: onboard-espn
description: Walk a user through connecting an ESPN fantasy football league — finding the leagueId in the league URL, copying the espn_s2 and SWID browser cookies for private leagues, writing them to .env, and verifying them against ESPN's read API. Use when ESPN leagues are missing from the app, when setting up ESPN for the first time, when an ESPN league card shows "ESPN request failed" or a 401, or when the user asks how to connect/refresh/fix ESPN credentials.
---

# Onboard an ESPN league

ESPN has no supported API and no programmatic login. Reading a private league needs three values
in `.env`, and two of them are cookies the user must copy out of a logged-in browser:

| Variable | What it is | Where it comes from |
| --- | --- | --- |
| `ESPN_LEAGUE_IDS` | league ids, comma separated | the `leagueId=` in the league URL |
| `ESPN_S2` | session cookie | browser cookies for `espn.com` |
| `ESPN_SWID` | the ESPN account's GUID, in braces | browser cookies for `espn.com` |

`ESPN_SWID` does double duty: it authenticates *and* it is how the app identifies which team in the
league is the user's (`espn.py:normalize_league` matches it against each roster's owners). A cookie
pair from a different ESPN account will read the league fine but leave the user with no team.

Work through the steps below with the user, then run the check script. Ask them to paste the values
into `.env` themselves; if they paste a cookie into the chat instead, write it to `.env` and tell
them the transcript now contains a live credential they may want to rotate later (logging out of
fantasy.espn.com invalidates `espn_s2`).

## 1. League id

Have the user open the league in a browser. The URL looks like:

```
https://fantasy.espn.com/football/team?leagueId=1280588303&teamId=12&seasonId=2026
```

`ESPN_LEAGUE_IDS=1280588303`. All digits. Multiple leagues are comma separated, no spaces needed:
`ESPN_LEAGUE_IDS=1280588303,987654321`. The mobile app's league URL (Share → Copy link) carries the
same `leagueId=` parameter.

## 2. Is the league public?

If the league manager has turned on **League Settings → Basic Settings → "Make League Viewable to
Public"**, the read API answers without cookies — leave `ESPN_S2` and `ESPN_SWID` empty and skip to
step 4. The app will show the league but cannot tell which team is the user's, so this is only
worth it for a league they don't manage a roster in. For a normal league, get the cookies.

## 3. The two cookies

In Chrome, Edge, or Arc, logged in at `fantasy.espn.com`:

1. Open DevTools (`Cmd+Option+I` on macOS).
2. **Application** tab → left sidebar **Storage → Cookies → `https://fantasy.espn.com`**.
3. Filter for `espn_s2`. Copy its **Value** — it is long (~300 characters) and may end in `%3D%3D`.
   Paste it exactly as shown; the `%` escapes are part of the value and work as-is.
4. Filter for `SWID`. Copy its value **including the curly braces**:
   `{8C9EC219-564A-488A-9273-E763C40FD1F2}`.

Safari: enable Develop menu → Web Inspector → **Storage** tab → Cookies. Firefox: **Storage** tab.

`document.cookie` in the console is a faster alternative but is not reliable here — `espn_s2` is
often marked HttpOnly and simply will not appear. Use the Application/Storage panel.

If the user is signed in to more than one ESPN account, or has a personal and a work profile, make
sure the browser profile they copy from is the one that plays in that league — that is the most
common cause of a "SWID does not own a team" result.

## 4. Write `.env`

At the repo root (`.env` is gitignored; `.env.example` documents the same keys):

```
ESPN_LEAGUE_IDS=1280588303
ESPN_S2=AECzUq...%3D
ESPN_SWID={8C9EC219-564A-488A-9273-E763C40FD1F2}
```

No quotes, no trailing spaces. Real environment variables win over `.env`, so if a shell has a stale
`ESPN_S2` exported, unset it.

## 5. Verify

```bash
backend/.venv/bin/python .claude/skills/onboard-espn/scripts/check_espn.py
```

It reads the same `.env` the backend does, calls the ESPN read API for each league, and reports the
league name, team count, and which team the SWID owns. Credentials are masked in its output. Exit
code 1 if anything failed. Add `--season 2025` to check a past season.

A good run:

```
league 1280588303:
  OK    "Time Tracking FFB 26-27" — 12 teams, scoringPeriodId 1
  OK    your team: SUN GOD KING (teamId 12)
```

## 6. Restart the backend

`config.py` reads `.env` once at import, and `--reload` only watches `.py` files, so a running
server will not pick up new credentials. Restart it:

```bash
backend/.venv/bin/uvicorn app.main:app --app-dir backend --port 8000 --reload
```

The ESPN league then appears alongside the Sleeper leagues, with ids prefixed `espn:`.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `401 You are not authorized to view this League` | private league, cookies missing/expired/wrong account | re-copy both cookies from a logged-in browser (step 3) |
| `404 — no league N in season YYYY` | wrong `leagueId`, or the league did not exist that season | recheck the URL; try `--season` for an older year |
| `the SWID does not own a team in this league` | cookies came from a different ESPN account | copy from the browser profile that plays in the league |
| League card in the app reads `ESPN request failed: ...` | same as the 401 row — `services.py` surfaces the exception per league | run the check script, then refresh cookies |
| Check script passes but the app still shows nothing | backend not restarted after editing `.env` | step 6 |

Cookies last a long time (reportedly up to ~2 years) but ESPN has forced refreshes, and logging out
kills `espn_s2` immediately. When a league that used to work starts 401ing, it is almost always an
expired cookie — nothing in the code needs changing.

## What not to do

- Do not try to log in to ESPN programmatically. The Disney login endpoint is behind reCAPTCHA;
  every library that used to do this is dead. Cookies copied by hand are the only path.
- Do not put credentials in `.env.example`, in a commit, or in a test fixture.
- Writes (add/drop/lineup) are out of scope — this project is read-only against ESPN. See
  `research/yahoo-espn-apis.md` for what is known about the write host.
