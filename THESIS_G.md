# THESIS_G — The Impostor Watch, pointed at the minds

**Station:** the Imperium itself (runs as a card on the Legion bus, `cards/panel/`)
**Status:** DRAFT — UNSIGNED. Nothing is built until Opie signs.
**Written:** 2026-11-10
**Binding:** the first thesis bound by all fifteen of the Empire's laws from the start. Law 8's error bars are **binding here**, not display-only.

---

## 1. The claim, in plain words

Three different Anthropic model tiers, reading the same headlines, produce **independent** judgments — not one mind speaking in three voices.

Operationally: a panel of three *different* models disagrees with itself **more** than a single model disagrees with itself across repeated calls, by a margin wider than its own error bar.

If that is false, then a "panel" of these models is one mind wearing three hats, the Law of Independent Minds cannot be enforced with them, and every scheme that treats panel agreement as corroboration is counting one opinion three times.

## 2. The rationale gate (law 11), in writing, before anything

**Why should this effect exist at all?**
Mechanism, not correlation: different model tiers are trained to different scales and have different capability profiles, so their failure modes on an ambiguous judgment should differ in kind, not only in magnitude. Independent failure modes show up as genuine spread. A single model resampled at the same temperature varies only by decoding noise — a much narrower and more homogeneous source of variation.

**Who is on the other side, and why would they keep taking it?**
The compute-matched single agent. It gets the whole token budget in one context with no handoff loss, and the published record is largely on its side: multi-agent arrangements usually fail to beat a well-prompted single model once compute is held constant, and an information argument says each handoff can only lose or preserve information, never add it. If this thesis PASSES, it says only that the raw material for independence exists — not that a panel is better at anything.

**Why hasn't it been competed away?**
It mostly has been *tested* and found wanting — but on benchmarks with known answers, usually within a single model family, and with no pre-registration. What is genuinely unexamined is the narrow precondition: whether the tiers of one commercial family are distinguishable minds at all. Every multi-agent design assumes yes. Nobody is funded to check, because the answer is unglamorous either way and a "no" is commercially inconvenient. That is the hole this fits.

## 3. What is measured — exact definitions

For each **observation** (one stimulus on one trading night):

1. A headline set is frozen with a timestamp the first time it is seen (law 5). The set is whatever the Skald already gathered for that reading.
2. **The Panel** — three scores, one each from `haiku`, `sonnet`, `opus`, on the identical frozen set, with the identical prompt, each in a fresh context with no knowledge of the others' answers.
3. **The Benchmark** — three scores from `haiku` alone, called three times on the identical frozen set, same prompt, same temperature, fresh context each time.
4. **The Squire** — three scores from the same three models on a **placebo** set: headlines drawn by seeded shuffle from frozen sets of random past dates.
5. **The Jester** — three scores drawn from a seeded uniform distribution over 20–80. No model call.

The score is the mood number the Skald already produces, 0–100.

Define for each group `g` in {panel, benchmark, squire, jester} on observation `i`:

> `D_g(i)` = the sample standard deviation of that group's three scores.

**The primary statistic** is the paired difference, observation by observation:

> `Δ(i) = D_panel(i) − D_benchmark(i)`

reported as its mean, its standard error, a one-sided t-statistic, and an annual-free 95% interval — by the same `paired_diff()` used by the Cavalier and Ecnalanif.

**The seeds.** Jester: `thesis-g-jester-2026-11-10|<date>|<stimulus>`. Squire shuffle: `thesis-g-squire-2026-11-10|<date>|<stimulus>`. Fixed at signature, never regenerated.

## 4. Why dispersion and not correlation

An earlier draft of this test proposed correlating each model's deviation from the panel mean. **That statistic is degenerate and was discarded before signature.** Three numbers measured as deviations from their own mean sum to zero, which forces their average pairwise correlation to exactly −1/(k−1) = −0.5 for k=3, whatever the models actually do. It would have produced a confident number that meant nothing.

Dispersion has no such defect, needs no arbitrary threshold, and converts the question directly into law 8's paired difference. The 0.80 Impostor threshold borrowed from the Ravens is therefore **not used in this thesis**; it belongs to a correlation of return series, which this is not.

A secondary, **display-only** descriptive is also recorded: mean pairwise absolute disagreement `|s_m − s_n|` within each group. It is intuitive, non-degenerate, and never enters a verdict.

## 5. The fleet, and what each control is for

| Rider | What it is | What it rules out |
|---|---|---|
| **The Panel** | haiku + sonnet + opus, same frozen headlines | — the thing under test |
| **The Benchmark** | haiku × 3, same headlines | **The floor.** One mind's own decoding jitter. If the panel does not clear this, three models are indistinguishable from one model resampled |
| **The Jester** | three seeded uniform draws, 20–80 | **The ceiling.** Three minds sharing nothing at all, including the news. If the panel approaches this, the models are not reading the headlines, they are guessing |
| **The Squire** | the panel on shuffled historical headlines | Whether the disagreement is about **the news** or is constitutional noise. If placebo spread equals real spread, the panel's independence has nothing to do with the input |

The panel should sit **meaningfully above the floor and well below the ceiling.** Either extreme is a finding.

## 6. Verdict conditions — one look, sealed once

The box opens at **60 completed observations** and not before (law 3). It opens once and seals itself. A halfway report is display-only.

- **PASS** — mean `Δ > 0` **and** the paired difference lies entirely outside its own 95% interval. Independent minds are available within this family.
- **KILL** — mean `Δ ≤ 0` and that difference lies outside its interval. The panel is no more dispersed than one model resampled. These tiers are impostors of each other.
- **UNTESTED** — the paired difference sits inside its own error bar. The test could not tell, and says so. *A gap inside its own error bar is UNTESTED, not a PASS* (law 8).
- **WE BROKE IT** — the machinery failed in a way that invalidates the readings. Honest, and recorded.

Three further results are **reported with the verdict and never change it**: the panel-vs-Jester gap, the panel-vs-Squire gap, and the cost actually incurred.

## 7. Power and error bars, stated before launch (law 8)

- **Observations:** 2 per trading night (the Skald's stock and crypto readings are two genuinely different stimuli already in the pipeline). 60 observations ≈ **30 trading nights, about six weeks.**
- **Smallest detectable effect:** with n=60 paired observations, a one-sided test at α=0.05 has 80% power against a mean `Δ` of **0.33 × the standard deviation of `Δ`** (t critical 1.671 at df=59; solved against the noncentral-t rather than taken from the normal approximation, which gives 0.321). In the score's own units this cannot be stated honestly before any data exists, because the spread of `Δ` is unknown. **It is therefore recorded at the first progress report (observation 30) and again before the box opens** — not as a verdict condition, but so the verdict can be read against what the test was ever capable of seeing.
- **If the true effect is smaller than that, this test will return UNTESTED and should.** 60 observations is what six weeks buys; it is not a promise of sensitivity.
- **Expected real events:** every observation is an event. There are no rare triggers, which is why this thesis is cheap in time compared with the trading theses.
- Every verdict reports the paired difference **and** its uncertainty.

## 8. The Attempt Register (law 9)

On signature, one entry: `thesis-g:panel-dispersion`, dated, outcome RUNNING. Every variant of prompt, model set, or scoring considered and abandoned goes in as its own dated entry. The denominator is reported beside the verdict.

As of writing, the register stands at 8 formal attempts, 0 PASS, 4 KILL, 3 running, **FLOOR ONLY** — the pre-register exploration was never written down and the register says so rather than guessing a number.

## 9. Operating rules

- **No mock data, ever (law 5).** A night where the Skald's reading is thin or failed **abstains**: it is logged, it does not count toward 60, and nothing is filled in or carried forward. Every score is frozen the first time it is seen with its timestamp.
- **Budget.** An estimated 18 model calls per night (9 per stimulus: 3 panel, 3 benchmark, 3 squire; the Jester costs nothing). The run passes through the Warden's existing daily budget gate and **abstains rather than exceeding it**. Actual cost is recorded nightly and reported with the verdict.
- **Forward-only (law 4).** This idea came from reading two architecture documents on 2026-11-10. History that shaped it cannot grade it. No backfill, no historical arm.
- **Not applicable, stated rather than omitted:** law 6 (decide at t, fill at t+1) — there is no forward decision to contaminate. Law 10 (money is not zero) — nothing is traded.
- **Provenance (law 14).** Every run records the code commit, this charter's hash, the frozen headline sets used, and the model identifiers actually served. Evidence leaves the machine nightly.
- **Law 15.** Nothing here places an order, moves money, or touches a broker.

## 10. Declared weaknesses, including the ones that might sink it

1. **Same family is the deepest problem.** haiku, sonnet and opus very likely share training lineage. A KILL therefore says *within-family tiers are impostors* — it does **not** condemn cross-lineage panels. That is Thesis H, and it needs a genuinely different model pulled locally first (Ollama is installed with **no models**, verified 2026-11-10).
2. **This measures disagreement, not accuracy.** There is no ground truth for "mood." It is a **precondition** test. It cannot show that a panel is *better* at anything, and claiming so later would be exactly the overreach these laws exist to stop.
3. **A 0–100 mood score is a coarse instrument.** Two models can land on the same number for different reasons, which would *understate* real independence and bias the test toward KILL.
4. **Two observations a night share the day's macro weather**, so they are not fully independent. The error bars will be slightly optimistic — the uncertainty is real but modestly understated.
5. **Temperature is a confound.** The Benchmark's spread depends on the sampling temperature it is called at. If that differs from the panel's, the floor moves. It is fixed identically for both at signature and recorded with every run.
6. **Cost is a live risk.** If the nightly spend proves unsustainable the honest moves are a dated amendment to a single stimulus, or "we broke it." Not quietly dropping a rider.
7. **A PASS is modest.** It licenses exactly one claim: the raw material for independence exists in this family. Everything interesting after that is a separate, signed thesis.

## 11. What this thesis may NOT conclude

- That a panel produces better answers. Not measured.
- That emergence occurs. Not measured, not defined here, and not claimable from dispersion.
- That cross-lineage panels are independent, or are not. Out of scope.
- That the Weave, the Council, the Chorus or any such layer is worth building. This test can only remove a reason not to.

---

## Amendments

*None. Changes arrive only as dated amendments with Opie's initials — never edits, never deletions.*

---

## Signature

By signing, the Jarl fixes the claim, the statistic, the fleet, the seeds, the checkpoint and the verdict conditions above. Nothing is built until this line is signed.

**Signed:** __Opie_____________________  **Date:** __11/10/2026__________

