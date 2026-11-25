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
    for c in lg["claims"]:
        drop = f" / drop {c['drop']['name']} ({c['drop']['position']})" if c.get("drop") else " / drop: none set"
        bid = f" ${c['bid']}" if c.get("bid") is not None else ""
        print(f"- CLAIM {c['name']} ({c['position']} {c['team']}){bid}{drop} [{c['standing']['status']}]")
    for a in lg["adds"]:
        rep = f" / drop {a['replaces']['name']}" if a.get("replaces") else ""
        print(f"- STREAM {a['slot']} {a['name']} ({a['team']}){rep}, then start him [{a['standing']['status']}]")
