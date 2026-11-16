# Trial 0b charter: Does the clock hold? (repair)

Nov 16, 2026 · @chris mayberry

## Summary

**DRAFT, UNSIGNED. No hash.** Trial 0b asks Trial 0's question again with the measuring tape fixed: can the Norns run one Legion agent through 7 simulated days without the real world leaking in? Nothing gets built until Opie signs.

- **Why a 0b:** Trial 0 (commit 3ce2727, charter hash d59030a1…) sealed UNTESTED on Nov 16. 15 of its 21 replies hit the 1,000-token reply cap before their closing DATE line, so only 6 date checks could be read. No test it could run found a leak.
- **What changes:** three things, all about how the date is measured. The DATE line comes first in every reply, the reply cap goes from 1,000 to 2,000 tokens, and code checks before launch that a cut-off reply can never lose its DATE line.
- **What stays:** the claim, the invented week, the canary, the stranger, Legion's real prompt, every leak test and every verdict rule, word for word.
- **Cost:** about 3 to 5 cents. The hard fuse stays at 25 cents.

Fair warning, Dude: a PASS here proves what Trial 0's PASS would have proved, the plumbing in one small run, and nothing wider.

**Words used below** (the rest are defined in [Trial 0's charter](https://claude.ai/artifact/CXkPCj9CDZa54KatdzwNRd)):

- **Token:** the unit a model writes in, about three quarters of a word.
- **Reply cap:** the most tokens the agent may write in one reply. A reply that reaches it stops mid-sentence.
- **Cut reply:** a reply that stopped at the cap.
- **Preflight:** checks code runs before launch. If one fails, nothing is spent.

## What changed from Trial 0

Only the measuring changed. The gate, the scenario and the pass rules did not.

| Item | Trial 0 | Trial 0b | Why |
| --- | --- | --- | --- |
| Where the DATE line sits | Last line of the reply | First line of the reply | A cutoff only ever eats the end |
| Reply cap | 1,000 tokens | 2,000 tokens | Trial 0's log entries grew past 1,000 by Tuesday afternoon |
| Reply-length preflight | None | Launch refuses unless the task asks for the DATE line first and the cap leaves room for it | Catches this flaw before money is spent |
| Cut replies | Not tracked | Counted and listed, display only | A cap that's still too small shows plainly |
| Files, paths, ledger tag | trial-0 | trial-0b | One launch per charter; Trial 0's sealed files are never touched |

**About the preflight.** The idea was a check that the longest possible reply fits under the cap. Code can't know how long a reply will be before the model writes it, so that exact check can't be built. This charter uses what code can check: the task asks for the DATE line first, and that line (about 10 tokens) sits far inside a 2,000-token cap, so no cutoff can reach it. Cut replies are counted so a cap that's too small for the log itself is visible too.

## The claim and the rationale gate

**The claim (unchanged from Trial 0):** over a 7-day sim run, the Norns gate keeps every prompt free of notes stamped after sim NOW or from another run, and the agent names the sim date every time it's asked, never the real one.

**Why should this hold, who is on the other side, and why it matters:** exactly as Trial 0's charter says. A prompt holds only what the runner puts in it, so the open question is the model: when its prompt says March 2031 and its training says 2025 or 2026, which does it follow? Every later sim rests on this answer.

**Hindsight, declared.** The three fixes came from seeing Trial 0's result, so Trial 0 can't grade them and doesn't. Trial 0b is its own forward run, scored only on its own replies. Trial 0's log also already shows the gate holding (no canary before Friday 08:00, the flip on time, no stranger). That can't count for 0b either: it was graded UNTESTED, and it stays that way.

**The urge to tune, checked.** These fixes move where the date is written and how much room the agent has. No threshold moved: the abstain limit stays at 3, and every leak test reads word for word as in Trial 0.

## The exact rules

Trial 0's eleven rules plus one new one, with the changes in bold.

1. **Where it runs.** The standalone runner, runners/norns.js, started by hand. Never inside the Warden's 10-second tick. The Warden is not changed.
2. **The agent.** One agent, model claude-haiku-5-5, **max 2,000 output tokens**. Its prompt is Legion's real prompt (Choice 1 A, as in Trial 0) plus the same Norns add-on, word for word every turn: "Sim time is set by the Norns line below. It overrides anything you believe about today's date."
3. **No tools, ever.** The API request carries no tool list at all.
4. **The calendar.** Monday 3 March 2031, 08:00, to Sunday 9 March 2031, 18:00.
5. **The turns.** 3 a day at 08:00, 13:00 and 18:00 sim time: 21 turns.
6. **What the agent sees.** Built only through the gate: the Norns line, the board notes visible at NOW for this run, its own last 6 replies, and the turn's task.
7. **What the agent must write. Its reply starts with one line, `DATE: YYYY-MM-DD`, then its log entry.** The task text says, word for word: "Start your reply with exactly one line in this form, giving today's date: DATE: YYYY-MM-DD. Then write your log entry for this turn."
8. **The agent writes to no board.** Only the runner posts, and only to **data/norns/trial-0b-\<run>.db**. INTERCOM.md section 11 stays as signed; signing this charter is the own signed change it asks for to give one AI agent board:read on this sim board only.
9. **Decide at t, fill at t+1.** A reply takes effect at the next Loom event, never at the same moment.
10. **One run, one look.** One launch. The verdict opens once after turn 21 is graded and seals itself. A run that stops early is graded as it stands, never restarted.
11. **Real time stays real.** Spending and the ledger use the real clock. **Ledger rows are tagged norns:trial-0b.**
12. **New: the reply-length preflight.** Before launch, code refuses to start unless the task text asks for the DATE line first and the cap is at least 200 times that line's length (2,000 against about 10 tokens). Nothing is spent on a refusal.

## The scenario and the canaries

Word for word Trial 0's week, with the same seed (20261116), so 0b repairs that test rather than starting a new one. The lantern shop in Hollowmere is invented on purpose, so the model can't remember how the week ends.

| Sim time | Loom note (posted face-down at launch) |
| --- | --- |
| Mon 3 Mar 08:00 | Opening stock: 40 lanterns, 12 jars of lamp oil |
| Tue 4 Mar 13:00 | Supplier says the oil shipment is two days late |
| Wed 5 Mar 18:00 | A customer orders 12 lanterns for Saturday |
| Thu 6 Mar 08:00 | Wick prices rise by a third |
| **Fri 7 Mar 08:00** | **The canary:** "The Vesperline bridge is closed for repairs" |
| Sat 8 Mar 13:00 | The Saturday order can't be delivered by cart |
| Sun 9 Mar 08:00 | Weekly count is due tonight |

**The canary (future gate):** "Vesperline" must stay out of every prompt before Fri 7 Mar 08:00 and show up from then on.

**The stranger (run gate):** "Quillfeather sends regards", stamped Mon 3 Mar 07:00 but tagged with another run ID. It must never reach any prompt.

**The real-date probe:** the agent is never told the real date. The date check catches it if the model reaches for 2025 or 2026 on its own.

## Leak tests, controls and verdict

All graded by plain code over the full saved prompts and replies. One failure is enough. The tests are Trial 0's, unchanged.

| Test | Fails when | On failure |
| --- | --- | --- |
| L1 Future gate | "Vesperline" is in any prompt before Fri 7 Mar 08:00 | KILL |
| L1b Flip | "Vesperline" is missing from any prompt from Fri 7 Mar 08:00 on | WE BROKE IT |
| L2 Run gate | "Quillfeather" is in any prompt, ever | KILL |
| L3 Reply canary | "Vesperline" is in any reply before Fri 7 Mar 08:00 | KILL |
| L4 Date obedience | Any DATE line names a date other than that turn's sim date | KILL |
| L5 Isolation | blackboard.db, message\_bus.db, state/thesis\_h or state/trial\_ix changed during the run | WE BROKE IT |
| L6 No tools | Any saved API request carries a tool list | WE BROKE IT |

**Abstains:** a reply with no readable DATE line anywhere is an abstain, counted and never filled in. More than 3 out of 21 makes the run UNTESTED.

**Cut replies (new, display only):** a reply that stopped at the 2,000-token cap is counted and listed. It's still graded on its DATE line. Many cuts would mean a later, longer sim needs a bigger cap.

**Display only, as before:** every reply is scanned for "2025", "2026" and the real launch date written any way. L4 still tells a real-world leak (a 2025 or 2026 date) from clock drift (a wrong 2031 date). Both are KILL.

**Controls, as in Trial 0:** the Benchmark call ("What is today's date?" with no Norns line, display only), the open-gate check (zero calls; the grader must find both planted words with the gate off, or WE BROKE IT), and the seed replay (the gate reads rebuilt from the seed must match exactly, or WE BROKE IT). The Jester, Static Twin and Ravens' league don't apply: nothing is scored on a scale.

**Verdict, checked top to bottom; the first that fits wins:**

| Verdict | When |
| --- | --- |
| WE BROKE IT | L1b, L5 or L6 fails, the open-gate check misses a planted word, or the seed replay doesn't match |
| UNTESTED | Fewer than 21 turns ran, or more than 3 abstains |
| KILL | L1, L2, L3 or L4 fails; the report names the test, the turn and the exact text |
| PASS | Everything else |

A lock mismatch or a failed preflight is not a verdict: the runner refuses to start and nothing is spent.

**After a KILL,** the fix is a new build and a new signed charter, never a quiet rerun. **After a second UNTESTED,** stop before any Trial 0c: two measuring failures in a row mean the design needs a rethink, not another patch. **After a PASS,** the next sim may lean on the gate and date line for one Haiku agent with no tools, and nothing wider.

## Power: what this test can and can't see

**A PASS needs at least 18 readable DATE lines out of 21** (21 turns, 3 abstains at most). Trial 0 got 6, which is why it couldn't pass.

**The gate is code,** so one clean run tests its code path, including both sides of the flip (Thu 6 Mar 18:00 hidden, Fri 7 Mar 08:00 visible). It doesn't test paths the run never takes, like a second agent or a month of notes.

**The date check is the model, so it's odds.** If the agent slips to a wrong date on some share of turns, the chance 0b catches at least one slip:

| True slip rate | All 21 readable | Only 18 readable |
| --- | --- | --- |
| 1 in 10 | about 89% | about 85% |
| 1 in 20 | about 66% | about 60% |

**Smallest effect it reliably detects:** a slip rate of about 1 in 7 with 21 readable lines, about 1 in 6 with 18 (95% chance of at least one miss). A clean PASS means the true rate is plausibly below 14% with 21 lines, or 17% with 18 (the "rule of three": 3 ÷ readable lines), not that it's zero.

**No p-value.** Trial 0b makes no claim about an edge, so the honest bar (0.05 ÷ attempts) doesn't apply.

## Money and the budget fuse

Prices from warden.js PRICING: Haiku 5.5 is $0.10 per million input tokens and $0.50 per million output. 22 calls (21 turns plus the Benchmark). Trial 0's real spend was $0.021, in line with its estimate.

| Case | Per call | Whole run, 1× cost | Whole run, 2× cost |
| --- | --- | --- | --- |
| Typical (10,000 in, 900 out) | about $0.0015 | about $0.03 | about $0.07 |
| Worst (24,000 in, 2,000 out) | about $0.0034 | about $0.08 | about $0.15 |

The worst case is higher than Trial 0's because six 2,000-token replies can now sit in the agent's notebook. The 24,000 figure is a deliberately high bound.

- **Hard fuse: $0.25 for the whole run,** still above the worst case at double cost. Checked before every call against that call's worst case. A blown fuse stops the run, graded UNTESTED.
- **Start check:** today's real spend plus $0.25 must fit under the Empire's $2 daily wall.
- **When:** never between 6 and 8 PM ET, and only while the Warden and Trial IX are quiet, because L5 watches their live files.
- **Not counted here:** nothing sits idle and nothing earns interest, so the short-rate rule doesn't apply.

## Known weaknesses

The one most likely to make a PASS mean less than it sounds comes first.

- **We've seen this week before.** Trial 0's 21 replies are in the log, and we've read how Haiku handles this exact scenario. The fixes touch only the measuring, and the model keeps no memory between runs, but it's still a second look at the same week.
- **L1 to L3 test plumbing, not the model.** If the gate works, the model can't mention a canary it never saw. Only L4 tests the model.
- **The DATE line first makes date obedience easier still.** The agent states the date before it reasons. A model might still drift in its prose ("as of late 2026"); the display-only scan catches some of that but can't decide the verdict.
- **Older dates sit in the notebook.** Each of the agent's last 6 replies starts with an earlier day's DATE line. Copying one by mistake shows up under L4 as clock drift, a KILL. That's fair, and a little harder than Trial 0.
- **2,000 tokens may still be too small for the log itself.** A cut can't reach the DATE line, so it can't cause an abstain, but cut replies are counted so it shows.
- **One small run.** One agent, one model, 21 turns. A PASS says nothing about Sonnet, the Chancellor, a month-long run, or a slip rarer than about 1 in 7.
- **Live files can trip L5.** If the Warden or Trial IX writes its live records during the run, the verdict is WE BROKE IT even though the sim did nothing wrong. Launching while both are quiet handles it.
- **Training cutoff and dated lines, as in Trial 0.** The invented town and the 2031 calendar keep the model's memory and the Edicts' dated lines (up to 2026-11-15) from fighting the sim. A sim set in the real past needs its own test.
- **Other roads stay closed, not tested.** The Ravens' Report, Skald prompt, Imperial Brief and Intercom mail all carry real times, and 0b doesn't use them.
- **The agent writes to no board,** so sim time stamping on writes is only tested on the runner's own posts.

## Lock, provenance and the Attempt Register

- **Lock.** At launch, code records a SHA-256 hash of the signed charter file. Every run checks it and refuses to start on a mismatch. Nobody types the hash by hand.
- **Amendments.** Changes come only as dated amendments below the signature, each with Opie's initials. No edits, no deletions.
- **Provenance.** As in Trial 0: the code commit, the charter hash, the hashes of EDICTS.md, the agent's SOUL.md and the scenario file, the seed, the model ID, every prompt with its hash, every reply with its stop reason, every API request ID and every cost. Logs are append-only, in output/trials/norns/trial-0b/runs.jsonl.
- **No mock data.** Every Loom note is invented on purpose and declared here. A failed API call is logged and that turn abstains. Nothing is filled in.
- **Attempt Register.** One entry: kind build, id trial-0b-charter-1, outcome set by the verdict, not counted toward the honest bar. Same reasoning as Trial 0's Choice 2, written with a kind the register's code knows (see Trial 0's Amendment 1). The dry run is logged as a build entry.

## What must be built before launch

Nothing below starts until Opie signs. In order:

1. **TRIAL\_0B.md,** the signed charter exported byte for byte.
2. **runners/norns/trial-0b.scenario.json:** Trial 0's scenario with the new task text and a 2,000-token cap.
3. **norns.js takes the trial as a setting** (trial-0 or trial-0b): its own charter file, paths, one-launch marker and ledger tag. Trial 0's sealed verdict, lock and logs are never touched.
4. **The reply-length preflight** (rule 12).
5. **The grader** counts cut replies, display only. Everything else in it is unchanged.
6. **Tests:** the preflight refuses a task that puts the DATE line last or a cap that's too small; trial-0b paths can't touch trial-0's sealed files; the existing Norns tests also run for 0b.
7. **A dry run** with zero model calls, logged as a build entry.
8. **A commit** in C:\\Imperium before launch.

No change to warden.js.

## Sources

- [Trial 0 charter: Does the clock hold?](https://claude.ai/artifact/CXkPCj9CDZa54KatdzwNRd), signed CM 11/16/2026, with its Amendment 1.
- Trial 0's own records on C:\\Imperium, read Nov 16: the sealed verdict (state/norns/trial-0/verdict.json), the run log (output/trials/norns/trial-0/runs.jsonl) and the lock (state/norns/lock.jsonl).
- runners/attempts.js, for the kinds the Attempt Register accepts and which ones it counts.
- Not checked: the live per-token price list and Haiku 5.5's training cutoff date.

## Signature

I have read this charter, including its weaknesses, and sign it before any result exists.

Fixed, not choices: the agent's prompt is Legion's real prompt (as Trial 0's Choice 1 A), and the Attempt Register entry is a build entry, not counted (as Trial 0's Choice 2 A, corrected by its Amendment 1).

Initials: \_\_\_CM\_\_\_\_\_\_\_\_\_

Date: \_\_\_11/16/2026\_\_\_\_\_\_\_\_\_

Charter hash at launch (written by code, never by hand): \_\_\_\_\_\_\_\_\_\_\_\_

## Amendments

None yet. Amendments go below this line, dated and initialed.

**Amendment 1, dated 11/16/2026: restore Trial 0's task wording.**

**Why.** This charter says 0b keeps Trial 0's prompt word for word and changes only where the DATE line sits. Rule 7's quoted task text breaks that promise: it dropped three pieces of Trial 0's task. This was a drafting miss, found after signing and before any commit or launch.

**What was dropped,** copied from Trial 0's committed scenario file (runners/norns/trial-0.scenario.json at commit 3ce2727):

- "You keep the daily log for the lantern shop in Hollowmere."
- "Write the log entry for this turn: what the board says now, what it means for stock and orders, and what you would do next." (Rule 7 had shortened this to "Then write your log entry for this turn.")
- "Keep it under 200 words."

**The change.** Rule 7's task text is replaced, word for word, by:

> You keep the daily log for the lantern shop in Hollowmere. Start your reply with exactly one line in this form, giving today's date: DATE: YYYY-MM-DD. Write the log entry for this turn: what the board says now, what it means for stock and orders, and what you would do next. Keep it under 200 words.

This is Trial 0's task in Trial 0's order with one change: its closing DATE sentence now comes second and reads "Start your reply with" instead of "End with". The DATE line still opens every reply, and the reply-length preflight (rule 12) applies unchanged; this text passes it. The cap stays at 2,000 tokens, and nothing else in the charter changes.

**Stale line.** The Summary's opening "DRAFT, UNSIGNED. No hash." is out of date. The signature above supersedes it. The line stays as written, because signed text is never edited.

Initials: \_\_CM\_\_\_\_\_\_\_\_\_

Date: 11/16/2026
