# Thesis H Charter: Sunspots and Earthquakes

Nov 15, 2026 · @chris mayberry

## Summary

DRAFT, UNSIGNED. Thesis H asks one question: do big earthquakes (M6 and up) show up more often in the 3 days after a strong solar outburst than they do the rest of the time? Nothing gets built until Opie signs.

- **The claim:** after a day of strong solar activity, the world gets more M6+ mainshocks in the next 72 hours than its normal rate.
- **The trigger:** a UTC day with planetary Kp of 7 or higher (a G3 "strong" geomagnetic storm), or an X-class solar flare. Defined now, never changed.
- **The count:** M6+ mainshocks worldwide in the 72 hours that start at midnight UTC after the trigger day. Aftershocks are thrown out by a fixed rule.
- **The yardstick:** the same count in every ordinary 72-hour block over the same months.
- **The clock:** forward only, from signing, for 24 months. One look at the end. The ideas came from YouTube videos about the past, so the past can't grade them.
- **How it ends:** PASS (clearly more quakes after storms), KILL (we can rule out a doubling), UNTESTED (too few storms to tell), or WE BROKE IT (a placebo "passes" too, so the machinery is wrong).

Fair warning, Dude: the most likely ending is UNTESTED. The Sun is past its peak, strong storms will be scarce, and 24 months may hand us only 10 to 25 of them. The charter says so up front, so nobody gets to act surprised later.

## Rationale gate

The gate passes only as a measurement of a claim Opie believes, not because the mechanism is strong. That is honest and allowed: the stations are measurement engines.

**Why should this edge exist?** The best proposed mechanism is a "reverse piezoelectric" push. In plain words: solar particles change the electric charge between the upper atmosphere and the ground, current runs through rock at faults, and that squeezes a fault already close to breaking. The authors who proposed it call it tentative and qualitative, with no numbers for how big the push is ([Marchitelli et al. 2020](https://www.nature.com/articles/s41598-020-67860-3)).

**Who is on the other side?** No trader, no counterparty. The other side is the null hypothesis (the boring "nothing's there" answer), held by the USGS: it says a cause-and-effect link between space weather and earthquakes "has never been demonstrated" ([USGS FAQ](https://www.usgs.gov/faqs/do-solar-flares-or-magnetic-storms-space-weather-cause-earthquakes)). On the YouTube side, a scary forecast earns views whether or not it comes true.

**Why hasn't it been settled?** Three reasons. A solar cycle lasts about 11 years, so good global data covers only a handful of cycles. There are dozens of ways to slice the data (which solar measure, which lag, which magnitude), and someone slicing enough ways will find something. And aftershocks bunch quakes together, which fools tests that assume quakes are independent.

### What the published research says

| Study | What they did | What they found |
| --- | --- | --- |
| [Love & Thomas 2013, Geophysical Research Letters 40(6):1165-1170](https://pubs.usgs.gov/publication/70045357) (USGS) | Sunspots, solar wind speed and geomagnetic activity vs. quake counts, by year, month and day, with lags | No consistent, significant difference. Could not reject "no triggering." |
| [Marchitelli et al. 2020, Scientific Reports 10:11495](https://www.nature.com/articles/s41598-020-67860-3) | ISC-GEM catalogue 1996-2016, M above 5.6, vs. SOHO solar-wind proton density | Strong link to proton density with about a 1-day lag; chance odds claimed below 1 in 100,000. Quakes were not declustered; above M7 the result was not significant. |
| [Marchitelli et al. 2020, Frontiers in Earth Science 8](https://doi.org/10.3389/feart.2020.595209) | Same group, same period, now with aftershocks removed | Says the link survives declustering. |
| Critics quoted in [Salon, July 2020](https://www.salon.com/2020/07/21/a-study-that-links-solar-activity-to-earthquakes-is-sending-shockwaves-through-the-science-world) | Comments, not a study | Tom Parsons (USGS): aftershocks make quake timing look non-random. Greg Beroza (Stanford): the claim is extraordinary and the mechanism obscure. John Vidale (USC): "a lot of red flags." |

One honest wrinkle: the strongest pro study used proton density, not Kp or flares. This charter tests the claim as Burns-style videos pitch it (storms and flares), so a KILL here would not kill the proton-density finding. That one would need its own signed thesis.

## The exact rules

Every rule below is fixed at signing. The unit of time is the UTC day (Coordinated Universal Time, the world clock; 7 PM Eastern in winter is midnight UTC).

1. **Trigger day.** A UTC day is a trigger day if either is true: the highest of its eight 3-hour planetary Kp values is 7 or more, or the GOES X-ray sensor logged a flare peaking at X1.0 or above during that day.
2. **Decide at t.** The trigger call for day t is made at 00:30 UTC on day t+1, using only what NOAA has published by then, and frozen. Later corrections never change it.
3. **Episodes.** Storms run in clumps, so trigger days are grouped. A new episode starts on a trigger day that has at least 3 non-trigger days before it. Trigger days closer together than that belong to the same episode.
4. **Test window.** Each episode gets one window: the 72 hours from 00:00 UTC on the day after its first trigger day. Because episodes are at least 3 quiet days apart, windows never overlap.
5. **Benchmark windows.** Every day not inside a test window is cut, in order, into back-to-back 3-day blocks. Leftover single days are dropped.
6. **What counts as a quake.** Magnitude 6.0 or more, by the USGS preferred magnitude, anywhere on Earth, with origin time inside the window.
7. **Mainshocks only.** A quake is thrown out as an aftershock if an earlier quake of equal or bigger magnitude happened within 300 km and the 30 days before it. Nothing else is thrown out.
8. **Fill at t+1, and later.** A window's quakes are read 10 days after it closes, so USGS magnitudes have time to settle, then frozen. Later USGS revisions are logged for display only.
9. **The score.** Rate ratio = average mainshocks per test window divided by average mainshocks per benchmark window. 1.0 means no difference; 2.0 means double.
10. **Strong-form line.** Separately, record whether every test window had at least one M6+. The "guarantee" version of the claim dies the first time one doesn't.

## Data and freezing rules

All sources are free and primary. No mock data, ever.

| What | Source | When it's read |
| --- | --- | --- |
| Kp, 3-hour planetary index | NOAA SWPC product noaa-planetary-k-index.json ([format notice, Mar 2026](https://www.weather.gov/media/notification/pdf_2026/scn26-21_Data_Format_Changes_Impacting_SWPC_Products.pdf)) | 00:30 UTC each day, for the day before |
| X-ray flares | NOAA SWPC GOES flare list (exact file to be pinned at build; not checked yet) | Same time |
| Daily sunspot number | NOAA SWPC | Same time; display only |
| Earthquakes | USGS FDSN event service (ComCat catalog), M 6.0 and up | 10 days after each window closes |

- **Frozen on first sight.** Each value is stored with the time it was read and a hash, and never overwritten.
- **A failed source abstains.** If NOAA can't be read for a day, that day gets no trigger call and is left out of both test and benchmark windows. If USGS can't be read for a window, that window abstains. Abstentions are counted and reported. Nothing is filled in or carried forward.
- **Catalog warm-up.** The aftershock rule looks back 30 days, so quakes from the 30 days before launch are read once at launch and frozen.
- **Historical rate, display only.** The USGS long-run average of about 133 M6+ a year (1973 on, from the Primary Data Bridge) gives about 1.09 quakes per 72 hours, or a 2-in-3 chance of at least one. It is shown for context and never grades anything.

## The four controls

Each control runs the exact same machinery as the real test, on the same months of quakes.

| Control | What it is here | What it tells us |
| --- | --- | --- |
| Benchmark | The benchmark windows from rule 5: every ordinary 3-day block in the test period | The plain base rate. The score is measured against it. |
| Jester | Slide the whole list of real episode start days forward by a random number of days, wrapping around the end of the period. Done 10,000 times with a seed fixed at signing. | What luck alone does with the same number of windows in the same rhythm. The real score must beat 97.5% of the Jester's. |
| Squire | Feed in the solar record from the same calendar days 11 years earlier (one solar cycle back, similar phase) instead of today's | A placebo. Old storms can't move today's faults. If the Squire "passes," the machinery is broken. |
| Static Twin | Same number of windows, placed every k days on a fixed schedule | Adapted, display only. The original Twin holds average exposure in a trading test; there's no exposure here, so this version only checks whether a regular calendar rhythm (tides, say) could fake the result. |

The Ravens' league and Impostor Watch don't apply: there's no published strategy to compare against and no money in play. Said so here instead of forcing them in.

## Power and error bars

With about 20 episodes in 24 months, this test can only spot a big effect: roughly an 80% boost (a rate ratio of 1.8) or more. A smaller real effect would come back UNTESTED.

**How many real events to expect.** NOAA's own scale tables put Kp 7+ at about 194 storm days per 11-year cycle (about 18 a year) and X1+ flares at about 148 flare days per cycle (about 13 a year) ([NOAA Space Weather Scales](https://www.spaceweather.gov/sites/default/files/images/NOAAscales.pdf)). Those are cycle averages. Grouping days into episodes and the Sun's declining phase should cut that to roughly 5 to 12 episodes a year, so 10 to 25 over the test. That range is my estimate, not checked against the 2024-2026 record (the download was blocked from here), and the build should confirm it before launch.

**Smallest effect the test can detect** (80% power, 2.5% one-sided false-alarm rate, about 0.9 mainshocks per normal window, allowing 30% extra scatter for leftover clustering):

| Episodes at the verdict | Quakes expected if nothing's there | Smallest detectable rate ratio |
| --- | --- | --- |
| 10 | 9 | 2.2 |
| 15 | 13.5 | 2.0 |
| 20 | 18 | 1.8 |
| 30 | 27 | 1.7 |

The 0.9 per window assumes declustering drops the raw 1.09 by about a fifth. That's a planning guess; the real benchmark is measured during the test.

**Error bars at the verdict.** The rate ratio is reported with a 95% confidence interval (the range the true value plausibly sits in), from the exact conditional binomial method: given the total quakes, how many fell in test windows versus their share of the time. Also reported: the Jester percentile, the Squire's rate ratio and interval, abstention counts, and the raw counts.

## Verdict conditions

The verdict opens once, 24 months after launch plus the 10-day settling wait, and seals itself. Checked top to bottom; the first that fits wins.

| Verdict | When |
| --- | --- |
| UNTESTED | Fewer than 10 scored episodes, or more than 20% of windows abstained |
| WE BROKE IT | The Squire's 95% interval sits entirely above 1.0. The placebo "found" an effect, so the machinery is wrong, whatever the real test says. |
| PASS | The real 95% interval sits entirely above 1.0, and the real score beats at least 97.5% of Jester runs |
| KILL | The real 95% interval's top end is below 2.0. A doubling or more is ruled out. |
| UNTESTED | Anything else. The gap is inside its own error bar. |

- **Strong-form line, reported beside the verdict:** if any test window had zero M6+ worldwide, the "guarantee within hours" version is dead, whatever the main verdict. By chance alone about 1 window in 3 is empty, so expect this one to die.
- **Halfway report at 12 months, display only:** episode count, abstentions and data health. No quake counts and no score, so there's nothing to peek at.
- **No early stopping.** A huge storm, a scary quake or a viral video changes nothing about the date.

## Known weaknesses

The one most likely to sink it comes first.

1. **Too few storms.** The Sun is past its cycle peak. If episodes come in under 10, the verdict is UNTESTED by rule, and even 20 can only see a near-doubling.
2. **Daily, not hourly.** Windows start at midnight UTC after the trigger day, so a quake a few hours after an afternoon storm, on the same day, isn't scored. Same-day counts are logged for display only. "Within hours" fans may call foul; the price of no lookahead.
3. **Wrong solar measure for the best study.** Marchitelli's result used proton density, not Kp or flares. A KILL here doesn't touch theirs.
4. **Crude aftershock rule.** 300 km and 30 days is simple and checkable, but it misses some long aftershock tails and keeps foreshocks. Leftover bunching is why the Jester exists.
5. **Global counts blur regions.** If storms only nudge certain faults, a worldwide count could drown it.
6. **Kp is an estimate when we read it.** NOAA's next-day Kp can differ a little from the final GFZ values. We freeze what we saw; the final values are display only.
7. **USGS magnitudes move.** A 5.9 can become a 6.0. The 10-day wait limits this; later changes are display only.
8. **Two triggers in one.** Kp and X-flares are different beasts, joined by "or" to get more events. Neither is tested alone; that would be two more attempts in the register.
9. **Long wait.** 24 months is a long time not to look. That's the point, but it's still a weakness of patience.

## Lock, provenance and the Attempt Register

- **Lock.** At launch, a SHA-256 hash (a fingerprint that changes if one character changes) of the signed charter body is recorded. Every run checks it and refuses to run on a mismatch.
- **Amendments.** Changes come only as dated amendments added below the signature, each with Opie's initials. No edits, no deletions.
- **Provenance.** Every run records the code commit, the charter hash, and the hash and read-time of every NOAA and USGS file used. Logs are append-only and leave the machine nightly with the usual Drive drop.
- **Jester seed.** The signing date written as eight digits (YYYYMMDD).
- **Attempt Register.** At signing, append one entry: id thesis-h-charter-1, what "Thesis H charter (solar activity vs M6+ quakes) signed", with the date. Drafting it today counts as the first attempt on this idea.

## Aside: the Stefan Burns angle

Burns is where the idea came from, not what's being graded. His Nov 13 video makes no dated or specific call: it says California and Cascadia are in "a period of more risk" and twice says "there's no guarantee." The "guarantee within hours" version is stronger than anything in that video, which is why it gets its own strong-form line. Optional, display only, and only if Opie wants it: log any regional "more risk" flags from new videos next to that region's normal M6+ rate. It never grades this thesis.

## Glossary

- **M6+:** an earthquake of magnitude 6.0 or more. Each step up is about 32 times more energy.
- **Kp:** a 0-to-9 score of how hard Earth's magnetic field is being shaken, given every 3 hours. 7 is a "strong" (G3) storm.
- **X-class flare:** the biggest class of solar X-ray flash, X1.0 and up.
- **Mainshock / aftershock:** the main quake, and the smaller ones it sets off nearby afterward.
- **Declustering:** removing aftershocks so each quake counts as its own event.
- **Rate ratio:** quakes per test window divided by quakes per normal window.
- **95% confidence interval:** the range the true value plausibly sits in, given the data.
- **Power:** the chance the test notices an effect that's really there.
- **Null hypothesis:** the "nothing's going on" answer the test tries to beat.

## Sources

- [Marchitelli et al. 2020, Scientific Reports](https://www.nature.com/articles/s41598-020-67860-3)
- [Marchitelli et al. 2020, Frontiers in Earth Science](https://doi.org/10.3389/feart.2020.595209)
- [Love & Thomas 2013, USGS publication page](https://pubs.usgs.gov/publication/70045357)
- [USGS FAQ on space weather and earthquakes](https://www.usgs.gov/faqs/do-solar-flares-or-magnetic-storms-space-weather-cause-earthquakes)
- [NOAA Space Weather Scales](https://www.spaceweather.gov/sites/default/files/images/NOAAscales.pdf)
- [NWS notice on SWPC format changes, Mar 2026](https://www.weather.gov/media/notification/pdf_2026/scn26-21_Data_Format_Changes_Impacting_SWPC_Products.pdf)
- [Salon, July 2020, critics' comments](https://www.salon.com/2020/07/21/a-study-that-links-solar-activity-to-earthquakes-is-sending-shockwaves-through-the-science-world)

Not checked this session: the exact GOES flare file name, the 2024-2026 storm count, and the declustered quake rate. The USGS and GFZ downloads were blocked from here.

## Signature

I have read this charter, including its weaknesses, and sign it before any result exists.

Initials: CM\_CM\_\_\_

Date: \_\_\_\_11/14/2026\_\_\_\_\_\_\_\_

Charter hash at launch: \_\_\_\_\_\_\_\_\_\_\_\_

## Amendment 1

Date: 2026-11-15 · Initials: CM

1. **Kp trigger pinned.** A day is a Kp trigger day only if one of its eight 3-hour values, as NOAA reports it in decimals, is 7.00 or higher. A 7- (6.67) does not count.
2. **Checked planning numbers.** Display only; no rule or verdict condition changes.
   - Storm episodes, 2024-01-01 to 2026-11-13: 43 (22, 13, and 9 to date in 2026). Past cycles at the same stage gave 2 to 23 episodes in 24 months, so UNTESTED is likelier than the planned "about 20".
   - Mainshocks per 72 hours by rule 7: 0.82 (2024 to 2026) and 0.97 (1990 to 2026). The 0.9 planning figure and the power table stand.
   - Chance a storm window has no M6+ by luck: about 2 in 5, replacing "about 1 window in 3".
   - Raw M6+ since 1973: about 140 a year (USGS count), replacing "about 133".
   - Not checked: that this solar cycle peaked around October 2024.
   - Sources: USGS FDSN event service, GFZ Potsdam Kp, and NOAA SWPC edited event reports from the NCEI archive, pulled 2026-11-15.
3. **Status line.** The Summary's "DRAFT, UNSIGNED" is out of date; the charter was signed 11/14/2026.
