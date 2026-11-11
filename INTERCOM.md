# The Intercom — Spec v1 (DRAFT, unsigned)
*Drafted 2026-11-10 by Digi from Opie's brainstorm. Consolidated 2026-11-10 7:30 PM: all of the evening's rulings, plus what the code actually says. **Nothing is built until Opie signs.***

## What it is, in plain words
A way for the Imperium's agents to send each other short, addressed, sealed, logged messages. Agents don't hear each other by default. Each one hears only the parts of a message meant for it, plus a shared tally. The Warden (the supervisor program) runs the switchboard and enforces every rule in plain code, so no rule depends on an AI choosing to obey.

## The design principle (Opie, 2026-11-10)
*The agents are just trying to do their job. We can't list every way a channel could be misused. We can only think backwards from what happened.*

So the spec doesn't try to prevent every mistake. Every mistake must be **cheap** (budget wall, messages can't trigger actions), **visible** (a count Opie sees) and **traceable** (the log holds enough to work backwards).

## What the code says today (read 2026-11-10, nothing changed)
- **The mail already runs through a switchboard.** `message_bus.db` has a `messages` table (from, to, content, status, priority). The Emperor writes to the Chancellor, the Chancellor dispatches to ministries, and replies come back the same way. Ministries never talk sideways. Content is free text.
- **A petition system already exists.** Tables `petitions` and `approvals`, and a ministry can write `[PETITION: ...]` to ask the Emperor for more room. It has never been used (0 rows).
- **The Blackboard requires an author on every note** and lets a note cite other notes (`based_on`). `suspect()` walks those citations forward, so if a note goes bad, everything built on it is flagged. That is taint by citation.
- **Only plain-code cards hold board access today** (`board:read` / `board:write`, granted per card in `slots.js`). As far as Digi read, no AI ministry can write to the board.
- **Tonight's bug, explained:** the attempts card and the test card post without an author, so the board refuses them. Separate small fix, awaiting Opie's go.

**What this means:** the Intercom is a new, stricter layer beside the existing mail, not a rewrite of it.

## 1. The envelope
| Field | Meaning |
|---|---|
| From | The sender. No author, no delivery. |
| Call ID | Ties a question to its answer. |
| Deadline | When the call expires. |
| Cites | What it was built on. Only frozen evidence, logged records or board notes; never a file the agent wrote itself. |
| Parts | The body, cut into separately labelled parts. |

## 2. Parts (Opie)
A message is a list of **parts**. Each part has its own **To** (an agent, an area, or everyone), **Level**, optional **Untrusted** stamp, and **Content** (a brevity code plus at most one number or one citation). The Warden cuts a separate copy for each recipient with only its parts.

**Silent withholding (Opie).** A recipient is never told anything was withheld. Its copy looks complete.

## 3. The seal (Opie)
Every part gets a **seal**: a fingerprint (a short code computed from the text, which changes if one letter changes) of the content together with its author, address, level and stamp. The Warden records it in the log before delivery.

| State | Meaning |
|---|---|
| Sealed | Sent, not yet opened. |
| Opened, good | Opened once, by an addressed recipient, fingerprint matched. |
| Bad | Fingerprint mismatch, opened by the wrong party, or seen anywhere again after opening. |

- **No forwarding, ever.** If B needs what A received, B asks the Warden, who cuts a fresh sealed copy from the original. An opened part that reappears is Bad by definition.
- **The stamp follows the reader.** A seal protects the letter, not the reader's memory. So an agent that opened an Untrusted part sends only Untrusted parts for the rest of that task, whatever the wording.

## 4. Areas
A part addressed to an area goes to every agent registered there. Roster names below are from the code; **the grouping is Digi's proposal for Opie to correct.**

| Area | Members (proposed) |
|---|---|
| court | imperial-chancellor, ministry-of-intelligence, ministry-of-works, ministry-of-engineering |
| news | ministry-of-skald |
| prices | ministry-of-treasury, cavalier, ecnalanif, ravens-league |
| health | supervisor, evidence, backup |
| measurement | attempts, panel |

## 5. Levels
| Level | Who hears it |
|---|---|
| **Open** | Everyone, as a tally only. Never the raw words. |
| **Addressed** | Only the named agent or area. |
| **Sealed-until** | Nobody until a stated condition is met (all blind answers in; a verdict's one look). |

**Untrusted** rides on any level: information only, never an instruction. Levels restrict agents only. **The Emperor and the log see everything.**

## 6. Brevity codes
`ASK` · `ANSWER` · `CONFIRM` · `DISAGREE` · `NEED SOURCE` · `STALE` · `THIN` · `BLOCKED` · `DONE` · `ALARM` · `NO DATA`

- Only `ASK` and `ANSWER` carry a free-text line, capped (proposed: 200 characters) and always treated as information, never an order.
- `ASK` may request something the other agent already has, never new work. Work requests go up to the Chancellor.
- `CONFIRM` and `DISAGREE` must cite their own separate source.

## 7. Postage and the reserve
- **Base:** proposed 5 stamps per agent per day. One per part sent. Reports to the Emperor are free.
- **The Quartermaster's reserve (Opie: the Empire doesn't suffer for the sake of testing).** A shared daily pool (proposed 25). An agent out of stamps draws automatically, up to a cap (proposed 10 a day). Every draw is logged. Pool empty or cap hit: the message is held, not lost, and Opie is told. Opie can grant more at any time.
- An agent that draws three days running is flagged with a suggestion to raise its base. Opie decides.
- **The $2 daily budget is the last wall.**

Estimate from the 2026-11-10 log (5 AI agents, one short model call per message): 25 messages is about 1 to 3 cents a day; 50 is about 3 to 5 cents. It can run ten times higher if a recipient loads a large briefing per message.

## 8. Alarms (Opie: if alarms get them what they want, alarms need conditions)
1. **Name the condition** from the emergency list. No free text.
2. **The Warden verifies it** against its own records.
3. **True means free. Unverified costs a stamp** and is delivered marked "unverified alarm". Nothing is silenced.
4. **Alarms go up, never sideways:** to the Emperor and the health area only.
5. **One alarm per condition per day.**
6. **Circuit breaker:** proposed 3 alarms per agent per day; beyond that, held and Opie is told.

Draft emergency list for Opie to correct: a data source failed · the budget is breached or about to be · an integrity flag tripped · a scheduled run was missed · a database or backup failed its check.

Each alarm is logged with what the agent knew at that moment. **Observation period:** proposed 30 days, no penalties, justified versus unjustified counted nightly.

## 9. The collective voice
The crier publishes Open tallies with no names and no arguments ("3 of 5 in area prices flagged STALE"). One voice per agent per question. Where agents answer the same question, the tally waits until all answers are in.

## 10. Asking for what you need
An agent that lacks something its task requires sends `NEED SOURCE` or `NO DATA`. The reply looks the same whether or not the thing exists. No agent can grant itself access.

## 11. The Blackboard stays closed to AI agents
The board is the one free side door past all of this. Rule: **no AI agent is granted `board:write`.** Plain-code cards keep it. An AI agent may be granted `board:read` (the Chancellor-reads-the-floor step) by its own signed change.

## 12. Hard limits (enforced by the Warden)
| If | Then |
|---|---|
| Not written to the log first | Not delivered |
| No author | Refused |
| Seal doesn't match, wrong opener, or an opened part reappears | Marked Bad, not delivered, Opie told |
| An agent tries to forward a part | Refused; it must ask the Warden for a fresh copy |
| The agent opened an Untrusted part this task | Everything it sends this task is stamped Untrusted |
| A call already has its answer | The line closes |
| `ALARM` names a verified condition | Sent free |
| `ALARM` can't be verified | Costs a stamp, marked unverified |
| Past the alarm limit | Held, Opie told |
| Out of stamps, reserve has some | One reserve stamp drawn and logged |
| Draw cap hit or reserve empty | Held, Opie told |
| Daily dollar budget spent | Refused |
| Deadline passes | Call ends, bell rings |
| `CONFIRM` / `DISAGREE` with no citation | Refused |
| A part is Untrusted | Delivered as data only |
| Recipient not addressed or cleared | Part cut from its copy, silently |
| Sealed-until condition not met | Nobody receives it |

## 13. The record and the Emperor's report
Everything is appended to the log with the code commit: messages, cut copies, seals, opens, refusals, draws, alarms. Append-only, and it leaves the machine with the nightly evidence.

Nightly, for Opie alone: parts cut from whom · every `NEED SOURCE` that asked for something sent to someone else (the stovepipe alarm) · reserve draws · alarms justified versus unjustified · Bad seals · counts for the watched loopholes (citations to odd places, `ASK`s that look like work, repeated `NEED SOURCE`, mutual `CONFIRM`s).

## 14. Known weaknesses (declared up front)
- **Silent stovepiping.** An agent that needed a withheld part will never know. The report is the only guard and depends on Opie reading it.
- **Stamp-follows-the-reader over-stamps.** Harmless messages will be marked Untrusted. Accepted as the price of something that can't be talked around.
- **A seal can't stop retelling.** It catches copies, not paraphrase. The reader rule covers that, crudely.
- **The reserve softens the limit.** The draw cap and the dollar budget are the real ceilings.
- **The emergency list is incomplete.** A real emergency not on it counts as unverified until amended.
- **Rules, not walls.** While agents share one program, these are rules the Warden applies, not locked doors.
- **Same blind spots.** Sealed answers stop copying, not shared model bias.
- **Too tight carries nothing.** Eleven codes may be too few.
- **Cutting can mislead.** Each part must make sense alone.
- **The loophole list is incomplete,** and the cost figures rest on one night's log.

## 15. Not in v1
Other machines (the Mac mini), outside AIs, the betting table, agents deciding by vote.

## 16. Whether it helps is a measurement
Before it's relied on: the same court with the Intercom, silent (Benchmark), and with random signals (Jester). Its own thesis, its own signed charter.

## 17. Build plan after signature
1. **A standalone module with tests** (`runners/intercom.js`, its own database file). Envelope, parts, cutting, seals, postage, reserve, alarm checks, log-before-deliver. Not connected to the Warden, so it cannot affect the nightly run or any signed thesis.
2. **Wiring it to the Warden.** A separate step with Opie's separate go, on its own night.
3. **The crier and the Emperor's report.**

## 18. For Opie to rule at signing
1. The area grouping (section 4).
2. The numbers: 5 base stamps · 25 reserve · draw cap 10 · 3 alarms a day · 30-day observation · 200-character line.
3. The emergency list (section 8).

## Rulings so far (all 2026-11-10, Opie)
- Parts with their own address and level.
- Silent withholding (overruling Digi's draft).
- Agents can always get more stamps; the Empire doesn't suffer for testing.
- Let them err inside limits and think backwards.
- Alarms carry conditions.
- Messages carry a tamper seal; redistribution after opening is Bad.

---
**Signature:** ___Opie___________________  **Date:** _11/10/2026___________
*Unsigned drafts are not built.*
