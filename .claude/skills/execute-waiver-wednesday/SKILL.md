---
name: execute-waiver-wednesday
description: Carry out the Plan tab's moves (waiver claims with FAAB bids and drops, K/D-ST streaming adds, and starting them) on Sleeper, ESPN and Yahoo by driving the user's real Chrome with Claude in Chrome. Use when the user asks to execute, run, submit or "do" their plan, claims or streaming moves for a week, or invokes /execute-waiver-wednesday.
model: sonnet
---

# Execute the plan

The app can't write to any league, so this skill makes the moves in the user's own Chrome, where they're already signed in.

## 1. Get the checklist

```bash
backend/.venv/bin/python .claude/skills/execute-waiver-wednesday/scripts/plan.py [week]
```

This needs the backend on :8000. If it isn't running, use `preview_start` with `backend`. The script prints one block per league: the URL to open, then the moves:
- `CLAIM`: player, bid, drop.
- `STREAM`: claim the K or D/ST with its bid, make the drop if one is listed, then put him in the lineup.

If a FAAB claim shows `bid: none set`, ask for the bid before confirming.

Each line ends with the player's status: `waivers` or `taken`. The plan treats every unrostered player as on waivers, because a free agent can be waived by the time you get there. Skip any `taken` line and say so.

## 2. Confirm once

Show the checklist and ask: **"Submit all of these?"** Wait for a yes. That yes covers only the moves you listed. Ask again before making any move that isn't on the list, including a different drop or bid.

## 3. Do each move in Chrome

Load the Chrome tools in a single ToolSearch call, as the claude-in-chrome instructions say. Open one new tab and work through the leagues there.

- Search for the player on the league's players page and use its add or claim button.
- Put in a claim with the planned bid. If the site lets you add him outright with no bid, that's fine: add him and the bid goes unused.
- Pick the drop from the plan. If the plan has `drop: none set` and the roster is full, stop and ask.
- **STREAM:** once he's on the roster, set him in the K or DEF slot. You can't do this until the add clears. If he's on waivers, the claim is all you can do now, so say he still needs starting once it processes.
- If a page shows a fee, a warning, or a different player or price than the plan, stop and ask.

Platform notes:
- **Sleeper:** open the player card, choose Claim or Add, enter the bid, and pick the drop in the dialog.
- **ESPN:** the add page has a player search. Claims are made from the player's row and the drop is chosen on the next screen. Lineups are on My Team.
- **Yahoo:** the players page has search. Add/Claim leads to a page for choosing the drop and entering the FAAB bid. If Yahoo shows a login page, ask the user to sign in.

## 4. Verify and report

After submitting, read the league's pending claims or roster page to confirm each move took. Don't trust the submit click alone. Then report one line per move: ✅ done, ⏳ claim pending, ❌ failed (with the reason), or ⏭️ skipped.
