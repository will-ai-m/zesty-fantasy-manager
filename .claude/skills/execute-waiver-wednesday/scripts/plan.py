"""Print the Plan tab as a short checklist, one line per move. Usage: plan.py [week]"""
import json
import sys
import urllib.request

URLS = {
    "sleeper": "https://sleeper.com/leagues/{id}/players",
    "espn": "https://fantasy.espn.com/football/players/add?leagueId={id}",
    "yahoo": "https://football.fantasysports.yahoo.com/f1/{id}/players",
}

q = f"?week={sys.argv[1]}" if len(sys.argv) > 1 else ""
plan = json.load(urllib.request.urlopen(f"http://localhost:8000/api/plan{q}"))
print(f"Week {plan['week']}")
for lg in plan["leagues"]:
    if not lg["claims"] and not lg["adds"]:
        continue
    pid = lg["league_id"].split(":", 1)[1]
    w = lg["waiver"]
    faab = f" | ${lg['my_team'].get('faab_remaining')} FAAB left" if w.get("type_code") == 2 else ""
    print(f"\n## {lg['name']} ({lg['platform']}){faab}\n{URLS[lg['platform']].format(id=pid)}")
    room = lg["spots"]["open"] > 0
    for c in lg["claims"]:
        if c.get("drop"):
            drop = f" / drop {c['drop']['name']} ({c['drop']['position']})"
        else:
            drop = " / no drop needed" if room else " / drop: none set"
        bid = f" ${c['bid']}" if c.get("bid") is not None else (" bid: none set" if w.get("type_code") == 2 else "")
        print(f"- CLAIM {c['name']} ({c['position']} {c['team']}){bid}{drop} [{c['standing']['status']}]")
    for a in lg["adds"]:
        old = a.get("replaces")
        drop = " / no drop needed" if room else (f" / drop {old['name']}" if old else " / drop: none set")
        start = f", then start him over {old['name']}" if old else ", then start him"
        bid = ""
        if a["standing"]["status"] == "waivers" and w.get("type_code") == 2:
            bid = f" ${a['bid']}" if a.get("bid") is not None else " bid: none set"
        print(f"- STREAM {a['slot']} {a['name']} ({a['team']}){bid}{drop}{start} [{a['standing']['status']}]")
    if lg["spots"]["empty_starts"]:
        print(f"- NOTE empty starting slot(s): {', '.join(lg['spots']['empty_starts'])}")
