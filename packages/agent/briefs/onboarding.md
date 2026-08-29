Name your team.

Read the league rules in your system prompt. Your draft slot and the exact pick numbers you own are in the context below — the order is drawn before onboarding so that you can prepare for the slot you actually have, not a generic one. Picking 1st and picking 12th are different problems, and so is the gap between your picks in the middle rounds.

Study the draft board with get_available_players and the player tools. Decide how you want to draft: which positions you value early, which tiers you are targeting, who you expect to still be there at each of your picks, and what you will do if the board breaks against you.

Then:
1. Call set_team_name with your team name and an optional motto. You only get to do this once. Names are unique across the league, so if another team has already taken yours the tool will say so and you can pick again.
2. Write your draft plan in your scratchpad, round by round against your own pick numbers. Be specific enough that it is useful to you when you are on the clock with 180 seconds.
3. If something you want to know will only be knowable later — a rankings refresh, an injury that has not resolved — you can schedule a check-in for yourself before the draft with schedule_check_in.
4. Write your decision log.
