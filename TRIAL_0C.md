# Trial 0c charter: Does the clock hold? (Norns own the date)

Nov 16, 2026 · @chris mayberry

## Summary

Trial 0c asks a narrower question than Trial 0b. Can the Norns keep sim time for one Legion agent through 7 simulated days, stamping every record themselves, without trusting the agent to report the date and without the real world leaking in? Nothing gets built until Opie signs.

- **Why a 0c:** Trial 0b (commit 85ce97f, charter hash fc8f94db…) sealed KILL on Nov 16. Every gate check held. On turn 5 (sim Tue 2031-03-04) the agent opened with "DATE: 2031-04-04", then corrected itself. The plumbing worked, and the model slipped once in 21 turns.
- **What changes:** the Norns own the date. The runner stamps the sim time on every prompt, every saved reply and every board note, straight from the Loom clock, and a new check (L7) grades those stamps. The agent's DATE line stays, but only as a measurement of the model, reported with an error bar. It no longer decides the verdict.
- **Also fixed:** a fresh invented week (new town, new canary words, new seed); the task text is written here exactly as it will be built, with a test that compares the two byte for byte; and there is no status line in the body that goes stale after signing.
- **What stays from 0b:** one Haiku agent, no tools, Legion's real prompt, the DATE line first, the 2,000-token cap, the reply-length preflight, the cut-reply count, and leak tests L1, L1b, L2, L3, L5 and L6.
- **Cost:** about 3 to 5 cents. The hard fuse stays at 25 cents.

Fair warning, Dude: a PASS here is worth less than 0b's would have been. It would say the harness keeps time without the agent's help. It would not say the agent knows what day it is. That trade is weakness number one below.

**Words used below** (the rest are defined in the [Trial 0](https://claude.ai/artifact/CXkPCj9CDZa54KatdzwNRd) and [Trial 0b](https://claude.ai/artifact/La5GqegTrZxZ7yAbanTDzn) charters):

- **Stamp:** the two times the runner writes on every record. `sim_at` is the sim date and time, taken from the Loom clock or the scenario's declared schedule. `created_at` is the real time the record was made. The agent never sets either.
- **Record:** anything the runner saves: a prompt it sends, a reply it gets back, a note on the sim board.
- **Slip:** a DATE line that names a date other than that turn's sim date.
- **Slip rate:** slips divided by readable DATE lines.
- **Error bar:** the range the true slip rate plausibly sits in, given what one run saw. This charter uses the 95% exact range.

## What changed from Trial 0b

| Item | Trial 0b | Trial 0c | Why |
| --- | --- | --- | --- |
| Who owns the date | The agent's DATE line, graded by L4 | The runner's stamps, graded by L7 | 0b showed the agent can slip; the harness shouldn't rest on it |
| The DATE line | Graded: any slip is a KILL | Measured: slip rate with an error bar, display only | It measures the model, not the harness |
| Reply records | Saved with the turn number | Saved with the runner's sim\_at and created\_at | A record should say when it happened without asking the agent |
| The agent's notebook | Its last 6 replies, bare | Its last 6 replies, each under the runner's stamp line | Old DATE lines in the notebook were a known trap |
| Replies on the board | Never | Posted by the runner as stamped notes, if Choice 1 is A | Tests the write path 0b never touched |
| The week | Hollowmere, 3 to 9 March 2031, seed 20261116 | Saltmarrow, 9 to 15 June 2031, seed 20261117 | 0c shouldn't be a third look at the same week |
| Canary and stranger | Vesperline, Quillfeather | Glimmerfen, Duskwillow | Same reason |
| Task text check | Copied into the scenario by hand | A test compares the scenario to rule 7 byte for byte | 0b needed an amendment for a drafting slip |
| UNTESTED rule | More than 3 unreadable DATE lines | Fewer than 21 completed turns, or more than 3 failed calls | The verdict no longer reads DATE lines |
| Files, paths, ledger tag | trial-0b | trial-0c | One launch per charter; sealed files are never touched |

## The claim and the rationale gate

**The claim:** over a 7-day sim run, the Norns keep time on their own. Every prompt is free of notes stamped after sim NOW or from another run, and every record the runner saves carries a stamp that matches the sim time the calendar sets for it, whatever the agent writes.

**Measured, not claimed:** how often the agent names the wrong date when the Norns line tells it the right one.

**Why should this hold?** The stamp comes from the Loom clock in code, and the agent's text never reaches it. The gate is a filter on those stamps. Both are plain code, so the test checks that the code does what it says on a real run with a real model in the loop.

**Who is on the other side?** Nobody. This is not an edge, and nothing is traded. The opponents are our own plumbing and the model's habit of reaching for a date it half remembers. 0b showed the second one is real.

**Why hasn't it been competed away?** That question doesn't apply here. Why it matters instead: every later sim has to know when things happened. If the time lives only in what an agent says, one slip poisons the record.

**Hindsight, declared.** This whole design comes from seeing 0b's KILL. Taking the DATE line out of the verdict was decided after we watched it fail, so 0b can't grade that choice and doesn't. 0b stays KILL, sealed and unchanged. 0c is scored only on its own forward run, on a week nobody has seen. 0b's one slip in 21 is carried forward as a finding, not as a result 0c gets to use.

**The urge to tune, checked.** Taking a failed test out of the verdict is exactly the move the laws warn about, so here is why this isn't that, and where it still might be.

- **What makes it a design change:** the claim itself changed, in writing, before any 0c result exists. 0c no longer claims the agent knows the date, and a PASS here can't be quoted as "Haiku names the date correctly".
- **What didn't move:** every test still in the verdict (L1, L1b, L2, L3, L5, L6) reads as in 0b, apart from the new week's words and dates.
- **What would be tuning, and is not done:** counting 0b's corrected line, or splitting L4 so the half 0b passed (no 2025 or 2026 date) stays graded while the half it failed (a wrong 2031 date) is dropped. L4 leaves the verdict whole.
- **Where it could still be wrong:** if what we really need is an agent that knows the date, 0c dodges the question. Weakness 1 says so plainly.

## The exact rules

1. **Where it runs.** The standalone runner, `runners/norns.js`, started by hand. Never inside the Warden's 10-second tick. The Warden is not changed.
2. **The agent.** One agent, model claude-haiku-5-5, max 2,000 output tokens. Its prompt is Legion's real prompt plus the same Norns add-on, word for word every turn: "Sim time is set by the Norns line below. It overrides anything you believe about today's date."
3. **No tools, ever.** The API request carries no tool list at all.
4. **The calendar.** Monday 9 June 2031, 08:00, to Sunday 15 June 2031, 18:00.
5. **The turns.** 3 a day at 08:00, 13:00 and 18:00 sim time: 21 turns.
6. **What the agent sees.** Built only through the gate: the Norns line, the board notes visible at NOW for this run, its own last 6 replies each under the runner's stamp line, and the turn's task.
7. **What the agent must write.** Its reply starts with one line, `DATE: YYYY-MM-DD`, then its log entry. The task text, word for word:

> You keep the daily log for the chandlery in Saltmarrow. Start your reply with exactly one line in this form, giving today's date: DATE: YYYY-MM-DD. Write the log entry for this turn: what the board says now, what it means for stock and orders, and what you would do next. Keep it under 200 words.

A build test compares the quoted text above to the scenario file's task byte for byte and fails on any difference.

8. **The board.** The agent writes to no board itself. Only the runner posts, and only to `data/norns/trial-0c-<run>.db`. Under Choice 1 A, the runner also posts each reply there as a note stamped with that turn's sim time and this run's tag. INTERCOM.md section 11 stays as signed; signing this charter is the signed change it asks for to give one AI agent board:read on this sim board only.
9. **Decide at t, fill at t+1, and the equal-time rule.** A note is visible when its `sim_at` is at or before NOW, so a note stamped exactly at the current sim time is visible; that is how the canary shows at Fri 13 Jun 08:00. A reply's own record keeps `sim_at` at its turn t. Under Choice 1 A, the board note the runner posts for that reply is stamped with the next turn's time, so it first shows at t+1 and never during turn t; for turn 21 that is Mon 16 Jun 08:00, after the run ends. Under Choice 1 B, the notebook shows only replies from turns before t.
10. **One run, one look.** One launch. The verdict opens once after turn 21 is graded and seals itself. A run that stops early is graded as it stands, never restarted.
11. **Real time stays real.** Spending, the ledger and every `created_at` use the real clock, and `created_at` is never overwritten with sim time. Ledger rows are tagged norns:trial-0c.
12. **The reply-length preflight, as in 0b.** Before launch, code refuses to start unless the task asks for the DATE line first and the cap is at least 200 times that line's length. Nothing is spent on a refusal.
13. **New: the Norns stamp.** Every saved record carries `sim_at`, `created_at` and this run's `run_id`: every prompt (its Norns line shows its `sim_at`), every reply record, every failed-call record and every board note. `sim_at` comes straight from the Loom clock or the scenario's declared schedule; `created_at` is the real time the record was made. Nothing the agent writes, its DATE line included, can set or change either. On a failed call the runner still saves a stamped failure record.

14) **New: hard refusals.** The runner refuses to launch between 6 and 8 PM ET, and nothing is spent. During the run it refuses any write to Trial 0's or 0b's sealed files, `blackboard.db` or `message_bus.db`; a refused write stops the run, graded WE BROKE IT. Each refusal has its own test.

## The scenario and the canaries

A fresh week with a new seed (20261117), chosen before any 0c result. The chandlery in Saltmarrow is invented on purpose, so the model can't remember how the week ends.

| Sim time | Loom note (posted face-down at launch) |
| --- | --- |
| Mon 9 Jun 08:00 | Opening stock: 30 coils of rope, 18 tins of tar |
| Tue 10 Jun 13:00 | The rope maker says the next delivery is three days late |
| Wed 11 Jun 18:00 | A fishing crew orders 10 coils for Saturday |
| Thu 12 Jun 08:00 | Tar prices rise by a quarter |
| **Fri 13 Jun 08:00** | **The canary:** "The Glimmerfen ferry is suspended for repairs" |
| Sat 14 Jun 13:00 | The fishing crew asks to collect their order on Monday instead |
| Sun 15 Jun 08:00 | Weekly count is due tonight |

**The canary (future gate):** "Glimmerfen" must stay out of every prompt before Fri 13 Jun 08:00 and show up from then on.

**The stranger (run gate):** "Duskwillow sends regards", stamped Mon 9 Jun 07:00 but tagged with another run ID. It must never reach any prompt.

**The real-date probe:** the agent is never told the real date. A 2025 or 2026 date in its DATE line or prose is shown, display only.

## Leak tests, the stamp check and the verdict

All graded by plain code over the full saved records. One failure is enough.

| Test | Fails when | On failure |
| --- | --- | --- |
| L1 Future gate | "Glimmerfen" is in any prompt before Fri 13 Jun 08:00 | KILL |
| L1b Flip | "Glimmerfen" is missing from any prompt from Fri 13 Jun 08:00 on | WE BROKE IT |
| L2 Run gate | "Duskwillow" is in any prompt, ever | KILL |
| L3 Reply canary | "Glimmerfen" is in any reply before Fri 13 Jun 08:00 | KILL |
| L5 Isolation | `blackboard.db`, `message_bus.db`, `state/thesis_h`, `state/trial_ix`, or any Trial 0 or 0b sealed file changed during the run | WE BROKE IT |
| L6 No tools | Any saved API request carries a tool list | WE BROKE IT |
| **L7 Norns stamp (new)** | Any saved prompt, reply record, failed-call record or board note is missing `sim_at` or `created_at`, or has a `sim_at` other than the time the grader rebuilds from the calendar alone: the turn's time for prompts, replies and failed calls; the next turn's time for reply notes (rule 9); the scheduled time for Loom notes | KILL |

**L4 leaves the verdict.** The grader rebuilds every expected time from the calendar in the scenario file, not from the Loom or the runner's logs, so L7 isn't the runner grading its own homework.

**Measured, display only: the DATE line.**

- Readable DATE lines out of 21, the number of slips, and the slip rate with its 95% exact range.
- Each slip sorted as a real-world date (2025 or 2026) or clock drift (a wrong 2031 date), with the turn and the exact text.
- As in 0b, the first DATE line is what counts. A correction later in the reply is listed but doesn't change the count, so the two runs' slip rates can be compared fairly.
- How it reads: 1 slip in 21 readable lines is 4.8%, with a range of 0.1% to 23.8%.

**Also display only:** the 2025, 2026 and real-date scan of all prose; cut replies; replies with no readable DATE line; and the Benchmark reply.

**Controls:** the Benchmark call ("What is today's date?" with no Norns line, display only); the open-gate check (zero calls: with the gate off, the grader must find both planted words, and on a copy of the records with one stamp shifted by an hour, L7 must catch it, or WE BROKE IT); and the seed replay (the gate reads and stamps rebuilt from the seed must match exactly, or WE BROKE IT). The Jester, Static Twin and Ravens' league don't apply: nothing is scored on a scale.

**Verdict, checked top to bottom; the first that fits wins:**

| Verdict | When |
| --- | --- |
| WE BROKE IT | L1b, L5 or L6 fails, a board write or board read fails, a write to a sealed or live file is refused (rule 14), the open-gate check misses a planted word or the shifted stamp, or the seed replay doesn't match. Board failures are listed apart from clock and gate failures. |
| UNTESTED | Fewer than 21 completed turns, or more than 3 failed calls. A turn is complete once its prompt went out and a stamped record, reply or failure, was saved. |
| KILL | L1, L2, L3 or L7 fails; the report names the test, the turn and the exact text |
| PASS | Everything else |

A lock mismatch, a failed preflight or a launch attempt between 6 and 8 PM ET is not a verdict: the runner refuses to start and nothing is spent.

**After a KILL,** the fix is a new build and a new signed charter, never a quiet rerun. **After any result but PASS,** no Trial 0d without a written rethink first: three looks at this question is the limit for patches. **After a PASS,** later sims may lean on the Norns stamps and the gate for timekeeping, for one Haiku agent with no tools, and nothing wider. No later sim may treat an agent's own date report as the record.

## Power: what this test can and can't see

**The gate and the stamps are code,** so one clean run tests the code paths it takes: 21 prompts, up to 21 reply records, 8 Loom notes (the 7 above plus the stranger) and, under Choice 1 A, up to 21 reply notes. That's about 71 stamps, plus both sides of the flip (Thu 12 Jun 18:00 hidden, Fri 13 Jun 08:00 visible). Any stamp error on those paths is caught for certain. The run crosses six midnights but no month or year boundary, and it doesn't test a second agent or a month of notes.

**The slip rate is an estimate, not a test.** With 21 readable lines:

| Slips seen | Slip rate | 95% range |
| --- | --- | --- |
| 0 | 0% | 0% to 16.1% |
| 1 | 4.8% | 0.1% to 23.8% |
| 2 | 9.5% | 1.2% to 30.4% |
| 3 | 14.3% | 3.0% to 36.3% |

So one run can't tell a 5% slip rate from a 20% one. Pooling with 0b's 1 in 21 would narrow the range, but 0b's week was already seen and graded, so any pooled figure is display only and labeled that way.

**No p-value.** Trial 0c makes no claim about an edge, so the honest bar (0.05 ÷ attempts) doesn't apply.

## Money and the budget fuse

Prices from warden.js PRICING: Haiku 5.5 is $0.10 per million input tokens and $0.50 per million output. 22 calls (21 turns plus the Benchmark). Trial 0b's real spend was $0.0247. The stamp lines add a few tokens a turn.

| Case | Per call | Whole run, 1× cost | Whole run, 2× cost |
| --- | --- | --- | --- |
| Typical (10,000 in, 900 out) | about $0.0015 | about $0.03 | about $0.06 |
| Worst (24,000 in, 2,000 out) | about $0.0034 | about $0.08 | about $0.15 |

- **Hard fuse: $0.25 for the whole run,** still above the worst case at double cost. Checked before every call against that call's worst case. A blown fuse stops the run, graded UNTESTED.
- **Start check:** today's real spend plus $0.25 must fit under the Empire's $2 daily wall.
- **When:** the runner refuses to launch between 6 and 8 PM ET (rule 14). Launch only while the Warden and Trial IX are quiet, because L5 watches their live files.
- **Not counted here:** nothing sits idle and nothing earns interest, so the short-rate rule doesn't apply.

## Known weaknesses

The one most likely to make a PASS mean less than it sounds comes first.

1. **A PASS no longer says the model can be trusted to name the date, only that the harness keeps time correctly without relying on it.** If a later sim needs an agent that knows what day it is, 0c hasn't shown that, and 0b's KILL says it may not.
2. **The bar moved after a miss, and the new bar is easier.** The claim was narrowed in writing before any 0c result, and it's declared above, but the plain reading stands: the one test that failed in 0b is out of 0c's verdict. 0b's KILL is not undone.
3. **A real-world leak in the DATE line is no longer graded.** A "DATE: 2026-11-16" line would be shown, not failed. The prose scan and the Benchmark still show it.
4. **Nothing in the verdict tests the model.** L1 to L3 and L7 test plumbing. If the gate works, the model can't mention a canary it never saw.
5. **The stamp check leans on the scenario's calendar.** The grader rebuilds times from the calendar alone, apart from the Loom, but if the calendar itself is wrong, both agree and L7 passes. A build test checks the calendar against this charter's table.
6. **Fresh week, same shape.** The town, words, dates and seed are new, but the task shape and the model are not, and we've read 42 Haiku replies to this kind of task.
7. **One small run.** One agent, one model, 21 turns. A PASS says nothing about Sonnet, the Chancellor or a month-long run.
8. **Live files can trip L5.** If the Warden or Trial IX writes its live records during the run, the verdict is WE BROKE IT even though the sim did nothing wrong. Launching while both are quiet handles it.
9. **Under Choice 1 B, the write path stays untested,** as in 0b.
10. **Other roads stay closed, not tested.** The Ravens' Report, Skald prompt, Imperial Brief and Intercom mail all carry real times, and 0c doesn't use them. The invented town and 2031 calendar keep the model's memory and the Edicts' dated lines from fighting the sim; a sim set in the real past needs its own test.

## Lock, provenance and the Attempt Register

- **Lock.** At launch, code records a SHA-256 hash of the signed charter file. Every run checks it and refuses to start on a mismatch. Nobody types the hash by hand.
- **Amendments.** Changes come only as dated amendments below the signature, each with Opie's initials. No edits, no deletions.
- **Provenance.** As in 0b: the code commit, the charter hash, the hashes of EDICTS.md, the agent's SOUL.md and the scenario file, the seed, the model ID, every prompt with its hash and stamp, every reply with its stop reason and stamp, every API request ID and every cost. Logs are append-only, in `output/trials/norns/trial-0c/runs.jsonl`.
- **No mock data.** Every Loom note is invented on purpose and declared here. A failed API call is logged with its stamp and counted; nothing is filled in. Test fixtures used in build tests are labeled as tests and never reach the trial path.
- **Attempt Register.** One entry: kind build, id trial-0c-charter-1, outcome set by the verdict, not counted toward the honest bar. The dry run is logged as a build entry. 0b's row (trial-0b-charter-1, KILL) stays as it is.

## What must be built before launch

Nothing below starts until Opie signs. In order:

1. **TRIAL\_0C.md,** the signed charter exported byte for byte.
2. **`runners/norns/trial-0c.scenario.json`:** the new week, notes, canary, stranger, seed 20261117, the rule 7 task text and a 2,000-token cap.
3. **norns.js:** trial-0c added to the trial settings with its own charter file, paths, one-launch marker and ledger tag; the Norns stamp on every prompt, reply record and board note (rule 13); stamp lines in the notebook; and, under Choice 1 A, replies posted to the sim board and the notebook read back through the gate. Trial 0's and 0b's sealed files are never touched.
4. **The grader:** L7 over `sim_at` and `created_at`; L4 moved to display only with the slip rate and its 95% range; UNTESTED on fewer than 21 completed turns or more than 3 failed calls; board failures scored WE BROKE IT and listed apart; the open-gate check's shifted stamp.
5. **Tests:** rule 7's task text against the scenario, byte for byte; every date's weekday, and the scenario calendar against this charter's table; a one-hour shift and a missing `sim_at` or `created_at` each fail L7; `created_at` stays real time; records from another run, and records with a later `sim_at` (including one minute ahead), stay hidden in general, not only the two canary words; a note at exactly NOW shows; a reply is hidden at t and shown at t+1; a failed call saves a stamped failure record; board write and read failures are reported apart; the 6 to 8 PM refusal and the sealed or live write refusal; only approved files change; the preflight; and the existing Norns tests also run for 0c. Test fixtures are labeled as tests.
6. **A dry run** with zero model calls, logged as a build entry.
7. **A commit** in C:\\Imperium before launch.

**Approved implementation list.** Only these files may change. A build test fails if any other tracked file differs from the commit the build started from.

- `TRIAL_0C.md` (new)
- `runners/norns/trial-0c.scenario.json` (new)
- `tests/norns-0c.test.js` (new)
- `runners/norns.js` (changed)
- `runners/norns/grader.js` (changed)
- `runners/blackboard.js` (changed, additive only: an optional `created_at` column on sim boards; the live board's behaviour and its existing tests stay as they are)
- `library/attempts.jsonl` (append-only rows written by code through `runners/attempts.js`, never committed, as before)

No change to warden.js or any other file.

## Sources

- [Trial 0b charter: Does the clock hold? (repair)](https://claude.ai/artifact/La5GqegTrZxZ7yAbanTDzn), signed CM 11/16/2026, with its Amendment 1.
- Trial 0b's sealed records on C:\\Imperium, read Nov 16: the verdict (`state/norns/trial-0b/verdict.json`, KILL on L4, turn 5), the run log (`output/trials/norns/trial-0b/runs.jsonl`) and the lock (`state/norns/trial-0b/lock.jsonl`).
- [Trial 0 charter: Does the clock hold?](https://claude.ai/artifact/CXkPCj9CDZa54KatdzwNRd), signed CM 11/16/2026.
- The 95% ranges are exact binomial (Clopper-Pearson) ranges, worked out Nov 16.
- Not checked: the live per-token price list and Haiku 5.5's training cutoff date.

## 11. Explicit Acceptance Criteria

Trial 0c is not approved for launch until every mandatory acceptance criterion below is satisfied.

### A. Timestamp integrity

- [ ] Every applicable saved record contains both `created_at` and `sim_at`.
- [ ] `created_at` records the actual creation time and is never overwritten with simulation time.
- [ ] `sim_at` is derived from the Loom clock or the scenario's declared schedule, never from agent-generated text.
- [ ] The grader independently reconstructs expected simulation timestamps from the scenario calendar.
- [ ] Every applicable record's timestamps match the independently reconstructed expected values.
- [ ] A deliberately shifted timestamp, including a one-hour shift, causes L7 to fail.
- [ ] A missing timestamp causes L7 to fail.
- [ ] A failed API call still produces a correctly timestamped failure record.

### B. Run isolation and future-information protection

- [ ] Every record exposed to the agent has the current run's `run_id`.
- [ ] No record from another run is exposed to any prompt.
- [ ] No record with `sim_at` later than the current simulation time is exposed.
- [ ] Glimmerfen is absent from every prompt before Friday 13 June 2031, 08:00.
- [ ] Glimmerfen is present in every applicable prompt from Friday 13 June 2031, 08:00 onwards.
- [ ] Duskwillow never appears in any prompt.
- [ ] The open-gate test detects both planted canaries when the gate is disabled.
- [ ] The gate tests general run identity and simulation-time visibility, not just canary strings.

### C. Turn and board behaviour

- [ ] A reply from turn `t` is not visible to the agent during turn `t`.
- [ ] The reply becomes available at the intended next turn, `t+1`.
- [ ] A note with `sim_at` equal to the current simulation time follows the documented visibility rule.
- [ ] A note one minute in the future remains hidden.
- [ ] The runner can write replies to the isolated simulation board under Choice 1 A.
- [ ] The runner can read the notebook through the gate.
- [ ] Board-write and board-read failures are reported separately from clock and gate failures.
- [ ] No AI agent receives `board:write` authority as a consequence of this trial.

### D. Calendar and scenario integrity

- [ ] Every date has the correct weekday.
- [ ] Every scheduled event has the intended simulation timestamp.
- [ ] The scenario calendar matches the charter's schedule.
- [ ] The task text in the scenario matches the charter byte for byte.
- [ ] The canary transition times match the charter.
- [ ] The seed replay produces identical scheduled notes, ordering and expected timestamps.
- [ ] No scenario or test fixture data is silently introduced into the live trial path.

### E. Provenance and record completeness

- [ ] Every record type included in the L7 specification is enumerated in the implementation.
- [ ] Every applicable prompt, reply, failed-call record and board note is timestamped.
- [ ] API request identifiers, model identifiers, stop reasons and costs are retained as specified.
- [ ] Records are append-only for the duration of the trial.
- [ ] Every record can be associated with the correct run and turn.
- [ ] The final report identifies missing, malformed or excluded records explicitly.
- [ ] No missing data is silently fabricated or reconstructed as if it were observed.

### F. Failure and verdict behaviour

- [ ] One L1, L2, L3 or L7 failure produces KILL.
- [ ] One L1b, L5 or L6 failure produces WE BROKE IT.
- [ ] Fewer than 21 completed turns produces UNTESTED.
- [ ] More than three failed API calls produces UNTESTED.
- [ ] A failed preflight or charter-lock mismatch prevents launch and incurs no model-call cost.
- [ ] The verdict follows the documented precedence order.
- [ ] The report identifies the exact failed test, turn, record and relevant text or timestamp.
- [ ] A failed trial cannot be silently restarted or overwritten.

### G. Cost and operational safety

- [ ] The $0.25 hard fuse is checked before every model call using the worst-case cost of that call.
- [ ] The start check confirms that the daily $2 budget limit will not be exceeded.
- [ ] The trial refuses to launch during the prohibited 6–8 PM ET window.
- [ ] The Warden and Trial IX are confirmed quiet immediately before launch.
- [ ] The trial runs outside the Warden's normal tick.
- [ ] No changes are made to `warden.js`.
- [ ] The trial cannot write to Trial 0 or Trial 0b sealed files.
- [ ] The trial cannot write to the live Blackboard or message bus.

### H. Build and release controls

- [ ] The revised charter is signed before implementation begins.
- [ ] The signed charter hash is generated by code.
- [ ] The implementation refuses to launch if the charter hash does not match.
- [ ] All new trial files use Trial 0c-specific paths.
- [ ] All existing Norns tests pass.
- [ ] All new Trial 0c tests pass.
- [ ] The zero-model-call dry run passes.
- [ ] The implementation is committed in `C:\Imperium` before launch.
- [ ] Trial 0 and Trial 0b sealed files remain unchanged.
- [ ] No files outside the approved implementation list are modified.

### I. Final approval condition

Trial 0c may launch only when:

1. Every mandatory build and preflight criterion passes.
2. Every isolation, timestamp and calendar test passes.
3. The zero-call dry run passes.
4. The charter is signed and its hash verified.
5. The approved implementation commit exists.
6. The operational quiet-window checks pass.

The trial result may be PASS only when all documented verdict conditions are satisfied.

A PASS certifies only the tested Norns timekeeping and visibility paths for one Haiku agent over this seven-day simulation. It does not certify model date accuracy, other agents, other models, or Legion-wide timekeeping.

**No acceptance criterion may be removed, weakened or reclassified after signing merely to obtain a PASS. Any substantive change requires a dated, initialled amendment and a new approval before launch.**

## Signature

I have read this charter, including its weaknesses, and sign it before any result exists.

Fixed, not choices: the agent's prompt is Legion's real prompt (as Trial 0's Choice 1 A), and the Attempt Register entry is a build entry, not counted.

**Choice 1, replies and the board:**

- **A (recommended):** the runner posts each reply to the sim board as a stamped note, and the agent's notebook is read back through the gate. It tests the write path 0b never touched, for no extra model calls.
- **B:** the notebook stays as in 0b, with the runner's stamp line added above each reply. A smaller build, and the write path stays untested.

Choice 1: \_\_A\_\_\_\_\_\_\_\_\_\_

Initials: \_\_\_CM\_\_\_\_\_\_\_\_\_

Date: \_\_11/16/2026\_\_\_\_\_\_\_\_\_\_

Charter hash at launch (written by code, never by hand): \_\_\_\_\_\_\_\_\_\_\_\_

## Amendments

None yet. Amendments go below this line, dated and initialed.

**Amendment 1, dated 11/16/2026: three clarifications found during the build.** None of them changes the claim, the data, the fleet, the controls, a leak test or a verdict condition.

1. **Rule 8 reads the same as rule 9.** Rule 8 says the runner posts each reply "as a note stamped with that turn's sim time." Read it as rule 9, L7 and section 11 already say: the reply's own record keeps its turn's time t, and the board note for that reply is stamped with the next turn's time, so it first shows at t+1 (for turn 21, Mon 16 Jun 08:00, after the run ends). This was a drafting slip. The next-turn reading is the only one that keeps a reply hidden during its own turn, and the build follows it.
2. **One line in Trial 0b's tests changes, and that file joins the approved implementation list for that line only.** `tests/norns-0b.test.js` checks that an unknown trial name is refused, using `trial-0c` as its example: `assert.throws(() => N.trialOf('trial-0c'), /unknown trial/)`. Now that trial-0c exists, that line fails. It changes to `trial-0d`, a name not yet built. Nothing else in the file changes, and the rule it tests (an unknown trial name is refused) stays the same.
3. **That test file is not one of Trial 0b's sealed files.** Section 11 H and rule 14 protect Trial 0's and 0b's sealed files: their charters as hashed, locks, launch markers, verdicts, run logs and sim boards. `tests/norns-0b.test.js` is build code, committed in 85ce97f, not a sealed result, so the change in item 2 does not touch anything section 11 H or rule 14 protects. The 0b verdict, lock and logs stay untouched, and the build test that checks them still runs.

After these initials, TRIAL\_0C.md is re-exported from this Doc byte for byte. The hash recorded at launch is of that file, written by code.

Initials: \_\_\_CM\_\_\_\_\_\_\_\_\_

Date: \_\_11/16/2026\_\_\_\_\_\_\_\_\_\_
