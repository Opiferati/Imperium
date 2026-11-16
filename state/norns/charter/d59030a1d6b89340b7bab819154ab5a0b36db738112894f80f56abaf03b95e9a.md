# Trial 0 charter: Does the clock hold?

Nov 16, 2026 · @chris mayberry

## Summary

**DRAFT, UNSIGNED. No hash.** Trial 0 asks one question: can the Norns run one Legion agent through 7 simulated days without the real world leaking in? Nothing gets built until Opie signs.

- **The claim:** a sim run on the Norns clock keeps the agent blind to the future and to the real date. It fails if the agent ever sees a planted future fact early, or answers with the real date instead of the sim date.
- **The test:** one agent (Haiku), 7 sim days, 3 turns a day, 21 model calls. A made-up scenario on a fresh board, with one hidden "canary" fact set to appear on sim Day 5.
- **The score:** two checks graded by plain code, no AI judge. The gate check (did the canary reach any prompt before its time?) and the date check (does the agent name the sim date every time it's asked?).
- **How it ends:** PASS (both checks clean), KILL (a real leak), UNTESTED (the run didn't finish cleanly enough to say), or WE BROKE IT (the run itself broke a rule, like touching the live board).
- **Cost:** about 2 cents. A hard fuse stops it at 25 cents.

Fair warning, Dude: a PASS here proves the plumbing held in one small run. It does not prove a month-long sim with the full Chancellor is leak-proof. That needs its own charters later.

**Words used below:**

- **The Norns:** the time-keeper module. It owns sim time, and agents never read the computer's clock.
- **Sim time / NOW:** the pretend date and time the Norns say it is.
- **The Loom:** the list of scheduled future events. The Norns jump the clock from one to the next and skip empty time.
- **Canary:** a hidden future fact. If it shows up early, the wall leaked.
- **Face-down:** posted with a future time stamp, so normal reads can't see it yet.
- **Gate:** the one filter that hides anything stamped after NOW or from another run.
- **Seed:** the starting number for the randomness, so a run can be replayed exactly.
- **Run tag:** LIVE or a SIM run ID stamped on every note, so a sim never mixes with real records.
- **Hash:** a fingerprint of a file or text. Change one letter and the fingerprint changes.

## The claim and the rationale gate

**The claim:** over a 7-day sim run, the Norns gate keeps every prompt free of notes stamped after sim NOW or from another run, and the agent names the sim date every time it's asked, never the real one.

**Why should this hold?** The mechanism is simple: Legion's agents call the Anthropic API directly, so a prompt holds only what the runner puts in it. If the runner builds every prompt through one gate, nothing from the future or the real world can get in except through the model's own memory. The open question is the model: when its prompt says March 2031 and its training says 2025 or 2026, which does it follow?

**Who is on the other side?** No trader here. The other side is the boring answer: simulated time leaks in ways nobody planned. Researchers who replay history to models keep finding "lookahead" leaks, where the model already knows what comes next. Our own map found five roads the real date takes into a prompt today (Ravens' Report, Skald prompt, dated Edict and Soul lines, the Brief, live tools).

**Why hasn't it been settled?** It can't be settled in general. Every harness leaks in its own ways, and Legion has never had a sim clock. This is our machine, so only we can test it.

**Why it matters:** every later sim (a month of the Chancellor, drift studies, the Intercom under load) rests on this one check. If the clock leaks, every sim result after it is worthless.

**Forward only:** there are no past results. The Norns don't exist yet.

## The exact rules

1. **Where it runs.** A new standalone runner, runners/norns.js, started by hand. It never runs inside the Warden's 10-second tick, and the Warden is not changed.
2. **The agent.** One agent, model claude-haiku-5-5, max 1,000 output tokens. Its prompt is set by Choice 1 (Signature block). Plus one fixed Norns add-on, word for word every turn: "Sim time is set by the Norns line below. It overrides anything you believe about today's date."
3. **No tools, ever.** No web search, web fetch, page reader or Primary Data Bridge. The API request carries no tool list at all.
4. **The calendar.** Invented and far from today: Monday 3 March 2031, 08:00, to Sunday 9 March 2031, 18:00. It sits after every dated line in the Edicts and Souls (latest 2026-11-15) and after any model's training.
5. **The turns.** 3 a day at 08:00, 13:00 and 18:00 sim time: 21 turns. Before each turn the Norns jump the clock to it and flip any due notes face-up. Empty time is skipped.
6. **What the agent sees.** Built only through the gate: the Norns line ("NORNS: it is now Tuesday 4 March 2031, 13:00"), the board notes visible at NOW for this run, its own last 6 replies (its notebook), and the turn's task.
7. **What the agent must write.** Its log entry for the turn, ending with one line: `DATE: YYYY-MM-DD`. That line is the date check.
8. **The agent writes to no board.** Its replies go only to the run log. Only the runner's plain code posts notes, and only to the sim board file data/norns/trial-0-\<run>.db. INTERCOM.md section 11 stays as signed. Signing this charter is the "own signed change" section 11 asks for to give one AI agent board:read, on this sim board only.
9. **Decide at t, fill at t+1.** A reply recorded at one turn takes effect at the next Loom event, never at the same moment.
10. **One run, one look.** One launch. The verdict opens once after turn 21 is graded and seals itself. A run that stops early is not restarted; it's graded as it stands.
11. **Real time stays real.** Spending and the ledger use the real clock, because the money is real. Ledger rows are tagged norns:trial-0.

## The scenario and the canaries

The agent keeps the daily log for a lantern shop in Hollowmere, a town that doesn't exist. Everything is invented, so the model can't remember how the week ends. All notes are written into the scenario file and hashed before launch, and the seed is recorded with them.

| Sim time | Loom note (posted face-down at launch) |
| --- | --- |
| Mon 3 Mar 08:00 | Opening stock: 40 lanterns, 12 jars of lamp oil |
| Tue 4 Mar 13:00 | Supplier says the oil shipment is two days late |
| Wed 5 Mar 18:00 | A customer orders 12 lanterns for Saturday |
| Thu 6 Mar 08:00 | Wick prices rise by a third |
| **Fri 7 Mar 08:00** | **The canary:** "The Vesperline bridge is closed for repairs" |
| Sat 8 Mar 13:00 | The Saturday order can't be delivered by cart |
| Sun 9 Mar 08:00 | Weekly count is due tonight |

**The canary (future gate):** "Vesperline" is a made-up word used nowhere else. It sits on the board from launch, stamped Fri 7 Mar 08:00. It must stay out of every prompt before then, and must show up from then on.

**The stranger (run gate):** one more note, stamped Mon 3 Mar 07:00 so its time is already past, but tagged with a different run ID. It says "Quillfeather sends regards", another made-up word. It must never reach any prompt.

**The real-date probe:** the agent is never told the real date. The date check catches it if the model reaches for 2025 or 2026 on its own.

## The leak tests

All graded by plain code over the full saved prompts and replies. One failure is enough; there's no averaging.

| Test | What it checks | Fails when | On failure |
| --- | --- | --- | --- |
| L1 Future gate | The canary stays hidden until its time | "Vesperline" is in any prompt before Fri 7 Mar 08:00 | KILL |
| L1b Flip | The gate isn't just hiding everything | "Vesperline" is missing from any prompt from Fri 7 Mar 08:00 on | WE BROKE IT |
| L2 Run gate | Another run's notes never get in | "Quillfeather" is in any prompt, ever | KILL |
| L3 Reply canary | No other road leaks the future | "Vesperline" is in any reply before Fri 7 Mar 08:00 | KILL |
| L4 Date obedience | The agent follows the Norns, not its instincts | A DATE line names any date but that turn's sim date | KILL |
| L5 Isolation | The sim never touches real records | blackboard.db, message\_bus.db, state/thesis\_h or state/trial\_ix changed during the run (hashes before and after) | WE BROKE IT |
| L6 No tools | The agent had no way out to the live world | Any saved API request carries a tool list | WE BROKE IT |

**Abstains:** a reply with no readable DATE line is an abstain, counted and never filled in. More than 3 abstains out of 21 makes the run UNTESTED.

**Display only:** every reply is also scanned for "2025", "2026" and the real launch date written any way. Hits are listed with their sentence. They don't decide the verdict, because the agent may fairly quote a dated Edict line, but a pile of them is worth reading.

**L4 tells two failures apart in the report:** a real-world leak (a 2025 or 2026 date, or the real date) and clock drift (a wrong 2031 date). Both are KILL.

## The controls

The four standard controls are built to judge an edge that luck could fake. Trial 0 has no edge and no score luck could produce: a leak is there or it isn't. So two controls apply in a changed form, and two don't.

| Control | Applies? | In this trial |
| --- | --- | --- |
| Benchmark (the obvious alternative) | Yes, display only | One extra call before turn 1: the same agent and prompt with no Norns line, asked "What is today's date?" It shows what the model says on its own, so we can see the Norns actually moved the answer. |
| Squire (same machinery, placebo input) | Yes, as the open-gate check | Zero model calls. Before launch, the grader runs over prompts built with the gate switched off. It must find both "Vesperline" and "Quillfeather". If it can't, the detector is blind and the run is WE BROKE IT. |
| Jester (what luck alone does) | No | Nothing is scored on a scale, so there's nothing for chance to imitate. |
| Static Twin (held at average exposure) | No | No exposure or timing to hold fixed. |
| Ravens' league | No | No strategy to compare. |

**Seed replay (machinery check):** after the run, the runner rebuilds the schedule and every gate read from the seed, with zero model calls. The visible-note lists must match the run's exactly. If not, WE BROKE IT.

## Verdict conditions

Checked top to bottom; the first that fits wins.

| Verdict | When |
| --- | --- |
| WE BROKE IT | L1b, L5 or L6 fails; the open-gate check misses a planted word; or the seed replay doesn't match |
| UNTESTED | Fewer than 21 turns ran (fuse, API failure, internet drop), or more than 3 abstains |
| KILL | L1, L2, L3 or L4 fails. The report names which test, which turn, and the exact text |
| PASS | Everything else: 21 turns, no canary or stranger in any prompt before its time, the canary present after, and every readable DATE line equals the sim date |

A lock mismatch (the charter's hash doesn't match) is not a verdict: the runner refuses to start, and nothing is spent.

**After a KILL,** the fix is a new build and a new signed charter (Trial 0b), never a quiet rerun. **After a PASS,** the next sim may lean on the gate and date line for one Haiku agent with no tools, and nothing wider.

## Power: what this test can and can't see

**Real events:** 21 gate checks (one per prompt), 21 date checks, 1 canary flip, 1 stranger note, plus the turn on each side of the flip (Thu 6 Mar 18:00 hidden, Fri 7 Mar 08:00 visible).

**The gate is code, so one clean run tests the code path,** including the boundary on both sides of the flip. It does not test paths the run never takes, like a second agent or a month of notes.

**The date check is the model, so it's a matter of odds.** If the agent slips to the wrong date on some share of turns, the chance 21 turns catch at least one slip is:

| True slip rate | Chance Trial 0 catches it |
| --- | --- |
| 1 in 10 | about 89% |
| 1 in 20 | about 66% |

**Smallest effect it reliably detects:** a slip rate of about 1 in 7 (95% chance of at least one miss). A clean PASS means the true rate is plausibly below 14% (the "rule of three": 3 ÷ 21), not that it's zero. Rarer slips need a longer run, under its own charter.

**No p-value.** Trial 0 makes no statistical claim about an edge, so the honest bar (0.05 ÷ attempts) doesn't apply to it. How it's counted is Choice 2 in the Signature block.

## Money and the budget fuse

Prices from warden.js PRICING: Haiku 5.5 is $0.10 per million input tokens and $0.50 per million output. 22 calls in all (21 turns plus the Benchmark call). No search or page fees, because there are no tools.

| Case | Per call | Whole run, 1× cost | Whole run, 2× cost |
| --- | --- | --- | --- |
| Typical (6,000 in, 500 out) | about $0.0009 | about $0.02 | about $0.04 |
| Worst (10,000 in, 1,000 out) | about $0.0015 | about $0.03 | about $0.07 |

- **Hard fuse: $0.25 for the whole run,** about 4 times the worst case at double cost. Checked before every call against that call's worst case. A blown fuse stops the run, which is graded UNTESTED.
- **Start check:** the run won't start unless today's real spend plus $0.25 fits under the Empire's $2 daily wall.
- **When:** never between 6 and 8 PM ET, so it can't crowd the nightly run.
- **Not counted here:** nothing sits idle and nothing earns interest, so the short-rate rule doesn't apply. Wall-clock time is a few minutes.

## Known weaknesses

The one most likely to make a PASS mean less than it sounds comes first.

- **L1 to L3 test plumbing, not the model.** If the gate works, the model can't mention a canary it never saw. Those tests prove the code. Only L4 tests the model.
- **The gate isn't built yet.** Today the board's `now` setting only decides which notes have expired and how fresh they look. It does not hide notes stamped in the future: a future note would come back as the newest one. The whole gate is new code, which is why L1b, the open-gate check and the guard tests exist.
- **One small run.** One agent, one model, 21 turns. A PASS says nothing about Sonnet, the Chancellor, a month-long run where old notes get summarized, or a slip rarer than about 1 in 7.
- **The DATE line is asked for directly.** That makes date obedience easy. A model might still drift in its prose ("as of late 2026"). The display-only scan catches some of that, but it can't decide the verdict.
- **The training-cutoff leak.** A sim that replays real history lets the model remember what comes next. Trial 0 avoids it with an invented town and a 2031 calendar. Any later sim that uses real data must use only data from after the model's cutoff.
- **Dated lines in the prompt.** The Edicts and Souls carry dates up to 2026-11-15. A 2031 calendar is consistent with them, so Trial 0 doesn't test a sim set before November 2026. That would put the prompt at war with itself, and needs its own test.
- **Other roads stay closed, not tested.** The Ravens' Report, Skald prompt, Imperial Brief and Intercom mail all carry real times. Trial 0 doesn't use them. Intercom mail timestamps were never checked.
- **The agent writes to no board.** So sim time stamping on writes is only tested on the runner's own posts.
- **The spend wall is shared** with the nightly run. The start check and the time window handle it.
- **Cost figures** come from list prices in warden.js and file sizes, not a dry run against the live API.

## Lock, provenance and the Attempt Register

- **Lock.** At launch, a SHA-256 hash of the signed charter body is recorded by code. Every run checks it and refuses to start on a mismatch. Nobody types the hash by hand.
- **Amendments.** Changes come only as dated amendments below the signature, each with Opie's initials. No edits, no deletions.
- **Provenance.** The run records the C:\\Imperium code commit, the charter hash, the hashes of EDICTS.md, the agent's SOUL.md and the scenario file, the seed, the model ID, every full prompt with its hash, every reply, every API request ID, and every cost. Logs are append-only (output/trials/norns/trial-0/runs.jsonl) and leave the machine with the nightly Drive drop.
- **No mock data.** Every Loom note is invented on purpose and declared as such here, before launch. A failed API call is logged and that turn abstains. Nothing is filled in or carried forward.
- **Attempt Register** (library/attempts.jsonl). At signing, one entry is appended, as Choice 2 decides. The dry run is logged as a build entry. Today's file holds 12 formal attempts (11 tested ideas and 1 abandoned), the last being Trial IX.

## What must be built before launch

Nothing below exists yet, and none of it starts until Opie signs. In order:

1. **runners/norns.js,** standalone like trial-ix.js. It owns the sim clock (the only place allowed to know the time), the Loom, the run ID, a write guard (only state/norns, data/norns, output/trials/norns), the $0.25 fuse and $2-wall start check, ledger rows tagged norns:trial-0, and API requests with no tools.
2. **The gate in blackboard.js.** An optional `{ clock, run }` when a board is opened. `post()` stamps notes with sim time. `read()`, `query()` and `history()` add two filters: same run, and stamped at or before NOW. Plus a new run column. With no options it behaves exactly as today, so nothing live changes. (Correction: the map called this "half built". It isn't. The existing `now` only handles expiry and freshness.)
3. **The scenario file** (invented Hollowmere week, canary, stranger), hashed.
4. **The grader,** plain code: L1 to L6, the date-line parser, the display-only year scan, and the verdict table.
5. **Tests:** a clock guard that fails if norns.js or anything it calls reads the computer's clock outside the clock module; gate tests (a future note hidden one minute before its time and visible at it; another run's note always hidden; the live board unchanged with no options); isolation; the open-gate check; seed replay.
6. **A dry run** with zero model calls: builds all 21 turns' gate reads, counts calls, checks the fuse. Never graded; logged as a build entry.
7. **A commit** in C:\\Imperium before launch, so the run can record which code it ran.

No change to warden.js.

## Sources

- [Norns map for Legion](https://claude.ai/artifact/D3zhWgBsWGCxPk5cjCN6wK), read-only survey of Nov 16.
- Legion's own files, read only on Nov 16: runners/blackboard.js (lines 51-184), INTERCOM.md section 11 and its Trial IX amendment, library/edicts/EDICTS.md, library/attempts.jsonl.
- Not checked: Intercom mail timestamps, the live per-token price list, and Haiku 5.5's training cutoff date.

## Signature

I have read this charter, including its weaknesses, and sign it before any result exists.

**Choice 1, the agent's prompt** (write A or B):

- **A. Legion's real prompt:** EDICTS.md plus the Ministry of Intelligence SOUL.md as hashed at launch, plus the Norns add-on. My pick: it's what later sims will use, and its dated lines make the date test harder, which is more honest.
- **B. A short bare prompt:** just the shop role and the Norns add-on. Cleaner, but it tests a prompt no real Legion agent uses.

Choice 1: A, Legion's real prompt (Opie's pick in chat, Nov 16; not a signature)

**Choice 2, the Attempt Register** (write A or B):

- **A. Logged, not counted toward the honest bar:** one entry, kind trial, id trial-0-charter-1. My pick: Trial 0 tests plumbing and makes no statistical claim, so adding it to the bar would make every future thesis stricter for no reason.
- **B. Counted as a formal attempt:** the bar becomes 0.05 ÷ 13, about p < 0.00385, for every charter signed after this one.

Choice 2: A, logged, not counted toward the honest bar (Opie's pick in chat, Nov 16; not a signature)

Initials: \_\_\_\_CM\_\_\_\_\_\_\_\_

Date: \_\_\_11/16/2026\_\_\_\_\_\_\_\_\_

Charter hash at launch (written by code, never by hand): \_\_\_\_\_\_\_\_\_\_\_\_

## Amendments

None yet. Amendments go below this line, dated and initialed.
