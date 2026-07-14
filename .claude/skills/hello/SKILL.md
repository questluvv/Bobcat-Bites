---
name: hello
description: Session status update — what's been done, what's in progress, what's blocked, and what's next for Bobcat Bites. Use when the user types /hello or asks "what's going on" / "give me an update".
---

# /hello — session status update

Give the user a quick, plain-English status of this working session and the app.
Do not start new work; this is a read-only checkpoint.

## Gather (read-only)

1. `git log --oneline -10` and `git status` — what shipped recently, what's uncommitted.
2. `git fetch origin main && git log origin/main --oneline -5` — confirm what's actually live on main (never trust a merge that wasn't verified; check file contents with `git show origin/main:<file>` when it matters).
3. The task list (TaskList tool) if tasks exist.
4. Anything discussed earlier in the conversation that's still open (blockers, things waiting on the user).

## Report — keep it under ~15 lines, in this order

1. **Done since last check-in** — merged PRs / shipped features, one line each.
2. **In progress** — what's mid-flight right now, and its next step.
3. **Blocked / waiting on you** — anything that needs the user (approvals, dashboard
   steps, accounts, secrets). Be specific about the exact action needed.
4. **Suggested next move** — one recommendation, not a menu.

Write like a teammate catching someone up, not a changelog: lead with what matters,
skip commit hashes unless asked, and translate jargon (say "the payments backend"
not "the edge function scaffold" unless precision matters).
