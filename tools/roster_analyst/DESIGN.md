# Roster Analyst — engine rules

Reference documentation of the analysis engine. For usage, see [README.md](./README.md).

The engine reads a player CSV + a `params.json` (role profiles + settings) and produces a
report: role rankings, recommended 5-1 lineup (starters / bench / injury reserves + sign
chemistry + reception/serve rotation of the liberos), academy & progression, weak spots &
recruitment filter, players to sell.

**No tuned profile is shipped**: every manager builds their own (web editor → export
`params.json`). `example_params.json` is a neutral template (all stats at 5, no bonus) used
only as an example and for tests.

## Code layout
- `src/analyze.ts` — orchestration (`runAnalysis`), Node-free: shared by the CLI and the web app.
  `runAnalysisParallel` first solves the independent lineups (Improving base + each decliner,
  then recommended 5-1 + Academy hypothesis) through an injected `LineupSolver` (workers), puts
  them in the `LineupBuilder` cache, then runs `runAnalysis` (cache hits only). Progress steps
  follow the real computation: `availability` → `lineup` → `report`.
- `src/cli.ts` — Node CLI (file reading, console output + `--md`); also the `worker_threads`
  lineup worker (`--sequential` disables the workers).
- `src/models/playerParser.ts` — `parseCSVText`: CSV reading (French headers, French → English
  aliases for roles, traits, rarities, signs).
- `src/config/` — `constants.ts` (labels, stats, traits, libero constants, exclusive pairs),
  `settings.ts` (**user settings**: thresholds, MILP weights, quotas — `settings` block of
  params.json, neutral defaults), `roleConfig.ts` (`normalizeParams` / `parseParams`,
  `idealScore`, libero sub-profiles), `signs.ts` (signs, French aliases, chemistry matrix,
  thresholds, libero effects).
- `src/scoring/scorer.ts` — `scorePlayer`, `rankForRole`.
- `src/lineup/lineupBuilder.ts` — single-pass MILP of the 5-1 (starters + bench + reserves)
  + exact sign-chemistry optimisation.
- `src/lineup/assignment.ts` — maximum assignment (Hungarian algorithm) for the bounds of the
  chemistry branch & bound.
- `src/lineup/signChemistry.ts` — chemistry model of the 5-1 court.
- `src/analysis/` — `availabilityAnalyzer` (academy + progress → lineup pool),
  `academyAnalyzer`, `liberoRotationAnalyzer`, `weaknessAnalyzer`, `recruitmentAnalyzer`,
  `rosterBalanceAnalyzer`.
- `src/report/` — `Reporter` interface, `ConsoleReporter`, `MarkdownReporter`, `formatters`.
- `src/tools/verifyLineup.ts` — checks the lineup builder against an exhaustive enumeration
  (`npm run verify-lineup -- <roster.csv> <params.json> [nbPlayers] [seed]`).
- `web/` — browser app: `app.ts` (params editor, CSV import, report rendering), `worker.ts`
  (analysis in a Web Worker), `lineupWorker.ts` (lineup workers spawned by `worker.ts`, one per
  core), `schema.ts` (neutral template, params.json import/export, help
  texts), `build.mjs` (esbuild → `web/dist/`).

**Rule**: nothing under `src/` (except `cli.ts` and `src/tools/`) may depend on Node —
`npm run typecheck` enforces it (the web tsconfig has no Node types).

## Settings (`settings`)
Every user choice lives in `settings` (see `src/config/settings.ts`, defaults in
`DEFAULT_SETTINGS`). A missing setting takes its default; an unknown key or a value of the
wrong type is ignored with a warning.

| Setting | Purpose |
|---|---|
| `balanceExponent` | exponent of the power mean of the stats (1 = weighted average) |
| `lineup.subObjectiveWeight` / `reserveObjectiveWeight` | λ / λᵣ of the 5-1 MILP (0 < λᵣ < λ < 1) |
| `lineup.signSynergy` | exact sign-chemistry optimisation |
| `lineup.synergyTimeLimitSec` | branch & bound time limit |
| `lineup.perfectSynergyWinPct` | win-chance gain (%) of a perfect sign chemistry (default 10) — weight of chemistry in the lineup objective and sign recruitment |
| `availability.declineExceptionalMinGain` | minimum gain to keep a "Starting to decline" player |
| `academy.maxAge` | maximum (inclusive) academy-eligible age |
| `libero.subMinDelta` | minimum gain (2nd libero's lead in their best phase) to advise the libero rotation |
| `libero.receptionOnlyTraits` / `defenseOnlyTraits` | reception / defense split of the libero traits (a trait not listed counts in both phases) |
| `roster.target` / `roster.targetCounts` | target roster size and max quota per role |
| `recruitment.singletonTraits` / `singletonPriorityBonus` / `singletonTraitPositions` | "single-carrier" traits in recruitment |

**Game mechanics** constants (sign matrix, activation thresholds,
exclusive pairs, redundant traits) stay in the code.

## Report & modelling rules

- **Report sections** (numbered dynamically, numbering follows what is actually shown):
  1. Role rankings · 2. Recommended 5-1 lineup · 3. Academy & progression · 4. Team weak spots
  + recruitment filter · 5. Roster management — players to sell (if roster >
  `settings.roster.target` **or** there are non-improving players to release).
- **Console + markdown output**: `--md <file>` also writes the report as GitHub markdown
  (`MarkdownReporter`, same content as the console through the common `Reporter` interface).
  The web app renders this same markdown as HTML; in CI it can be published in the **job
  summary** (`$GITHUB_STEP_SUMMARY`), readable on mobile.
- **Collapsible markdown**: every numbered section is a `<details open>` with its `<h2>` in the
  `<summary>`; every sub-block (detailed tables, libero rotation, recruitment…) is a `<details>`
  collapsed by default with its **verdict summarised in the title**.
- **Lineup SUMMARY table (in-game entry)**: always visible at the top of the 5-1 section — one
  row per position (court order), columns Starter / Substitute (with Δ) / Injury reserve. The
  detailed tables (rarity, scores) follow (collapsed in markdown).
- **No methodology text in the report**: THIS file documents the rules. The report only holds
  data, verdicts and short symbol legends.
- **Court order**: starters, bench and reserves are listed in serving order — 1 Setter ·
  2 Front OH · 3 Front MB · 4 Opposite · 5 Back OH · 6 Back MB · 7 Libero (`getFiveOneOrder` /
  `getFiveOneSubSlots`, `lineupBuilder.ts`).
- **5-1 MILP** (`LineupBuilder`): joint selection of starters (weight 1), bench
  (λ = `settings.lineup.subObjectiveWeight`) and reserves (λᵣ =
  `settings.lineup.reserveObjectiveWeight`), two-level dominance starter ≥ substitute ≥ reserve
  per role, slots at `max: 1` (a role without eligible players leaves the slot empty instead of
  making the model infeasible). **Front/back order** as post-processing: Front OH ≥ Back OH
  (best attacker in front), Back MB ≥ Front MB (best blocker on the setter's line).
- **Lineup availability** (`availabilityAnalyzer`): **excluded** from rankings, 5-1, weak spots
  and recruitment:
  - players with `Position = Academy` (any "Acad…" variant, e.g. French "Académie");
  - players whose `Progress` column (French "Progression") ≠ `Improving`:
    `Considering retirement` (French "Envisage la retraite") **without exception** (no longer
    improving: playing time goes to the improving players); `Starting to decline` (French
    "Début de déclin") **unless exceptional** = their presence raises the total of the 7
    starters of the 5-1 (MILP, cascading effects included) by at least
    `settings.availability.declineExceptionalMinGain` vs the best lineup without them (value =
    sum of scores + value of the sign chemistry), each decliner evaluated alone against the
    "Improving" base.
  French values checked on a real export: "En progression", "Début de déclin". Missing/empty
  `Progress` column (old CSVs) ⇒ `Improving`; unknown value ⇒ treated as declining + warning.
- **Academy** (`academyAnalyzer`): eligible ⇔ age ≤ `settings.academy.maxAge`. The 5-1 is
  rebuilt on the available pool + eligible academy players; a youngster who is a **starter or
  substitute** (bench — a reserve does not count) of this hypothetical lineup should **leave**
  the academy (target slot + current holder shown); an academy player above the age limit
  leaves in any case; an eligible active player outside starters/bench should **join** the
  academy. The lineup of the 5-1 section stays the current one (academy excluded).
- **Priority releases** (`rosterBalanceAnalyzer`, `forced` param): `Considering retirement`
  players and non-exceptional `Starting to decline` players are listed **first** among the
  players to sell (reason shown), outside the MILP, even if the roster does not exceed the
  target; the quota MILP only decides among the others (role shortages are reported only if
  there are "quota" sales).
- **Sign chemistry**: "Sign chemistry" sub-block of the 5-1 section (unnumbered, verdict
  "units/9 · ≈ +x % win chance" in the title): sign (libero effect in brackets), chemistry per
  phase, active effect, setter connection. Absent if the CSV has no `Sign`/`Signe` column. A
  substitute with a **positive** Δ = a player with a better individual score left on the bench
  for chemistry.
- **Injury reserves** (game injury mechanic): 3rd level after the bench — one reserve per slot,
  the player who moves up to the bench when the starter is injured (their substitute then
  entering the starting six). Empty substitute slot ⇒ empty reserve slot.
- **Roster management with soft quotas** (`rosterBalanceAnalyzer`): choosing the
  `settings.roster.target` players to keep is a MILP with `max` constraints (at most N players
  per role: `settings.roster.targetCounts`; each player on at most 1 role) that maximises first
  the **number of players kept** (`KEEP_BONUS`) then the sum of scores. If a role lacks eligible
  players, the model stays **feasible**: vacant slots go to the best remaining players of any
  role ("flex"), the shortage is shown per role, and the **list of players to sell is always
  produced**.
- **2nd libero rotation (reception / serve substitution)** (`liberoRotationAnalyzer.ts`): the
  game lets the 2nd libero come in/out depending on the **phase** (reception = receiving the
  serve; serve = serving then defending/digging). The two selected liberos (5-1 starter + their
  "Sub Libero") are compared on **two separate sub-profiles** derived from the libero config
  (`deriveLiberoReception` / `deriveLiberoDefense`, `roleConfig.ts`): same stat weights, trait
  and sign bonuses as the libero profile, minus the traits the **settings** reserve to the
  other phase. **Only traits tell the phases apart**: the official descriptions of
  `reception`, `defense`, `bump`, `overhand`, `reflex`, `focus` all cover serve receive AND
  digs, so every sub-stat counts in both phases. The trait split is each manager's
  interpretation (`settings.libero.receptionOnlyTraits` / `defenseOnlyTraits`; a trait not
  listed counts in both, a trait listed on both sides is put back in both with a warning;
  editor: one "Both / Reception only / Defense only" choice per trait). Defaults: Guardian =
  reception only (takes a teammate's reception), Defensive Specialist ("not serve receive") +
  Last Resort (rescue dig) = defense only. Sign bonuses are kept in both (the libero sign
  effects apply to receptions and digs). **Decision**: if one libero
  scores better in both phases, they play the whole match (`none`). Otherwise the **primary**
  (best overall libero score) plays by default and the rotation brings the other one in for
  the only phase where they score better: the **gain** of the rotation is that single number
  (2nd libero's phase score − primary's), the primary's lead in their own phase is not a gain.
  Verdict: `rotate` if gain ≥ `settings.libero.subMinDelta` (0-99 scale; margin for the
  uncertainty of trait bonuses and the sign chemistry change, not modelled), `none` otherwise,
  `single` (only one libero selected). The table marks who plays each phase (◄ recep / ◄ def).
  Sub-block of the 5-1 section (unnumbered).
- **Recruitment — 3 signs** (`selectSigns`): for each sign, on each of the 3 targeted roles, the
  weakest starter of the role is replaced by a recruit with the same score carrying that sign;
  contribution = sign bonus of the role (normalised 0-99) + change in starters' chemistry units
  × value of one unit (same calibration as the 5-1). Top 3.
- **Recruitment — roles**: the 3 priority roles combine the lowest normalised score of the
  weakest starter and the largest bench gap (`urgency = shortage×1e6 + (100 − score) +
  benchDelta`, a lack of players comes first). The 3 recommended traits are chosen **jointly
  by a MILP** (`selectTraitTrio`): the trio that maximises the total contribution (sum of
  `traitBonuses`, reduced if already carried ≥ 2× in the lineup) to the 3 targeted roles, with an
  overlap penalty for redundant pairs (`REDUNDANT_TRAIT_GROUPS`, e.g. Meteor/Float Serve) — not
  a simple per-trait top 3.
- **Current score = today's performance, no rarity or progression term** (stats + traits +
  sign): rarity does not affect the score (rankings, 5-1 MILP, libero rotation, recruitment,
  roster management: all comparable).
- **French aliases of the newer traits** (`playerParser.ts`): to be confirmed in game; any trait
  not recognised after translation triggers an "unknown trait" warning (otherwise its bonus would
  be silently lost).

## Signs & chemistry (official game mechanics)

- **A player's chemistry** = Σ over each teammate on court on their side (libero zone included)
  of +1 (likes the sign), −1 (dislikes), 0. **Non-symmetric** matrix in `signs.ts` (rows =
  player, columns = teammate, Aries → Pisces). Effects from account level 20. Substitutions =
  chemistry changes during the match.
- **Sign effect** active if chemistry ≥ 3 (`SIGN_ACTIVATION_THRESHOLD`). **Setter**: no sign
  effect; stronger connection with the attacker if chemistry(setter) + chemistry(attacker) ≥ 3
  (`SETTER_SYNERGY_THRESHOLD`). **Libero**: own effect depending on the group of their sign
  (Taurus/Leo/Scorpio/Aquarius = energy recovery on a perfect reception/dig;
  Gemini/Virgo/Sagittarius/Pisces = reflexes; Aries/Cancer/Libra/Capricorn = takes every
  contested ball).
- **Perfect chemistry = +10 % win chance** by default (`settings.lineup.perfectSynergyWinPct`).

| Sign | Effect (player other than setter/libero) |
|---|---|
| Aries | on a kill, removes the opponents' non-permanent buffs |
| Taurus | fooled less by tips at the block |
| Gemini | their fakes draw more blockers |
| Cancer | always picks up tips / dumps / down balls in reach |
| Leo | blocks more tips, turns touches into stuffs |
| Virgo | all stats ↑ on set / match points and tie-break |
| Libra | facing the block, tips more; tips harder to block/dig |
| Scorpio | reduces the efficiency of blockers committed on them |
| Sagittarius | fewer serve faults |
| Capricorn | better placed serves and attacks |
| Aquarius | 3 connected attacks in a row ⇒ the next one gets through and hits harder |
| Pisces | their traits trigger more often |

### Modelling
- **Score** (`scorePlayer`): `signBonuses[role][sign]` is added raw (like a trait);
  `idealScore` includes the best sign bonus of the role. Keep the weight **light**: it is the
  value of the effect *assumed active*; activation depends on teammates and is handled by the
  lineup builder.
- **5-1 court in 2 phases** (½ each, `signChemistry.ts`): the libero replaces the back MB, the 2
  MBs are never on court together → phase A = Setter, 2 OH, OP, Front MB, Libero; phase B = same
  with Back MB. **Units** per phase (max 9): 5 activations (non-setters) + 4 setter ↔ attacker
  connections (OH, OP, MB).
- **Lineup builder — EXACT solving** (reliable rather than fast). Objective F = Σ starters'
  scores + V·units(starters) + λ·(score + entry chemistry) of substitutes + λᵣ·score of reserves,
  with V = p % × Σ starters' scores of the base MILP / 9 (perfect chemistry = +p % of the
  starters' value, p = `settings.lineup.perfectSynergyWinPct`). Chemistry being quadratic, linearising it in the joint MILP does not finish
  (> 2 min without a solution); a local search was tried then **dropped** (no optimality
  guarantee, shown sub-optimal on a real roster). Retained method (`optimizeSignSynergy`):
  1. base MILP without chemistry + local search ⇒ starting solutions;
  2. **branch & bound** on the 7 starters with valid upper bounds: optimal assignment
     (Hungarian algorithm, `assignment.ts`) of remaining starters + bench (entry bonus bounded
     per slot and sign with the same best-sign-per-relation relaxation as the chemistry bound) +
     reserves without dominance, and a chemistry bound (best sign still available per
     relation; exact enumeration when ≤ 2 free slots); symmetry of the 2 OH / 2 MB broken;
  3. at each leaf, **exact** bench + reserves: Hungarian assignment; if the substitute ≥
     reserve dominance is violated, branch & bound on per-role thresholds (substitutes ≥ t ≥
     reserves), each node being a Hungarian assignment with substitutes ≥ lo and reserves ≤ hi
     (the equivalent yalps MILP could take minutes per call when scores are close, e.g. with
     uniform stat weights).
  Checked against an exhaustive enumeration (starters × bench MILP) on sub-rosters. Time:
  a few seconds per lineup; results cached per pool (the decliners' base = main lineup). Time limit `settings.lineup.synergyTimeLimitSec`: beyond it,
  best lineup found + "optimality not proven" warning. The **starter ≥ substitute dominance is
  lifted** when there are signs (a substitute's Δ > 0 flags a player left out for chemistry).
  The substitute/reserve follows their starter in front/back swaps.
  `settings.lineup.signSynergy = false` disables everything.

## Trait effects (official game mechanics)

Reference to calibrate the `traitBonuses` of params.json. The "Mechanic" column describes the
**actual trigger** (not marketing flavour); it decides which roles benefit.

| Trait | Exact mechanic | Mostly benefits |
|-------|----------------|-----------------|
| **Master Mind** | Chance to trigger on the team's **1st or 2nd touch** if an involved player has the trait. Gives a bonus to **every following action until the ball crosses the net**. Only one Master Mind bonus active at a time. | **Setter** (systematic 2nd touch) **and libero/receiver** (very frequent 1st touch) |
| **Moving Wall** | Front row: if the opponent **directly in front** attacks, **always** joins the block + chance to react to attacks that would get through; block bonus when triggered. Otherwise a decreasing chance (lower when the block is already crowded). | Middle Blocker, Opposite (right-side block), front-row Setter |
| **Surprise Attack** | **As setter**: plays the **setter dump** more often, harder to read. **As attacker**: spike harder to block. When triggered, **faces at most 1 blocker**. | **Setter** (dump), Middle Blocker (quick), Opposite, Outside Hitter |
| **Marksman** | Triggers on **attacks AND serves**. Small bonus to the action + lets the player **aim at the weakest defender**. | Outside Hitter, Opposite (hitters); a plus for any server |
| **Meteor Serve** | When triggered, the serve becomes a **jump serve**: action bonus, **+ace chance**, **−fault chance**. | Opposite, Outside Hitter (power servers). **Not the libero.** |
| **Vigorous** | Chance, **on every action**, to perform it **without spending energy**. | High-volume players over 6 rotations: Setter, OH, Libero |
| **Guardian** | If the carrier has **better reception stats** than the player about to receive, chance to **take the action instead** (best receiver first, only one takes the ball). | Libero (top), Outside Hitter (good receiver); **counter-productive for the setter** (pulls them out of their hidden receive position) |
| **Float Serve** | When triggered, float serve: bonus making it **harder to receive** + involves **other stats** of the receiver. | Any server (Setter, OH, OP). **Not the libero.** Redundant with Meteor (see `REDUNDANT_TRAIT_GROUPS`). |
| **Defensive Specialist** | Chance, when **defending a powerful spike OR blocking**, to get a bonus (equal strength) or a better success rate (stronger opponent). **Does NOT apply to serve receive.** | Libero (dig), Outside Hitter (dig) **AND Middle Blocker / Opposite (block)** |
| **Quick Learner** | After **3 good receptions / digs / sets in a row**, the next touch (reception/dig/set) **cannot fail** and becomes a **critical action**. A failed/weak touch resets the counter. | **Libero** (max reception+dig volume → builds the streak) **and Setter** (sets almost every rally); OH (reception+dig). Not MB/OP (few defensive touches, no sets) |
| **Momentum Addict** | **Starts with an attack malus.** Every **clean** attack raises power (a kill even more), up to a cap. An **attack fault** resets to the starting malus. | **Reliable** high attack volume: Outside Hitter, Opposite; MB (quick). **Negative/zero** for the setter (too few attacks → stays at the malus) and **useless for the libero** (never attacks). |
| **Loudmouth** | Chance, when the player **scores in the front row with a spike or a block**, to **undermine the opponent in front**: all their actions weakened for **3 rallies** (does not stack, reapplying restarts the timer). | Front-row attackers/blockers: Opposite, Middle Blocker, Outside Hitter. **Not the libero** (never in front). |
| **True Leader** | Chance, when **a teammate on court fails an action (except block)**, to **steady them**: their next action cannot fail and their debuffs are cleared. | ~uniform **team** trait (depends on being on court): all starters. |
| **Overachiever** | Chance, when **blocking / receiving / digging a stronger attack or serve**, to **raise their own action to the level of the one received**. Only for **Mythic rarity and below**. | Defenders under fire: **Libero** (reception+dig), Outside Hitter, Middle Blocker & Opposite (block). A plus for the setter (block). |
| **Crafty** | Chance, on **their serves and attacks**, to make the opponent who handles them **spend extra energy**. When it triggers, **Vigorous cannot trigger**. | High-volume servers/attackers: OH, OP, MB, Setter (serves every rotation). **Zero for the libero** (neither serves nor attacks). Partial anti-synergy with Vigorous not modelled (both stay additive: different scopes). |
| **Tenacious** | If the team **lost ≥ 3 points in a row**, **every teammate** gets a bonus to all actions, **growing** with the number of points lost. Gone as soon as a point is won. | ~uniform anti-slump **team** trait (being on court): all starters. |
| **Hunter** | Chance, **on serve**, to **target the opposing setter (or opposite)** and put them **out of system** (serve bonus): the target's attack is reduced for the rally, and **Guardian cannot take the reception** for them. **Overhand/float** serves reach the setter anywhere; a **jump serve** only targets the back row. | Servers: Opposite, Outside Hitter, **Setter** (serves every rotation; float/overhand reaches the setter anywhere → synergy). Less for MB. **Zero for the libero** (never serves). |
| **Last Resort** | Chance, when a teammate's touch **was about to lose the rally**, for **the LIBERO** to dig it up and send it back as a **free ball** (rally saved). Only if the dig would be a legal touch and the libero did not make the previous contact. | **Libero only** (tied to the position). |

## Score computation (`scorePlayer`)
- **Base = the 18 lowercase sub-stats only.** The UPPERCASE keys (ATTACK, SETTING, RECEPTION,
  SERVE, BLOCK, STAMINA) are a **deterministic aggregation** of their lowercase sub-stats
  (checked by regression on 50 players, R² 0.98–1.00): weighting them in `statsWeights` on top of
  the lowercase ones would be **double counting**. Do not put uppercase weights in params.json (a
  guard ignores them + warns). Composites are still used by `weaknessAnalyzer` (weak stats shown),
  not for the score.
- **Cross-role normalisation**: the final score is rescaled to `~0-99` per role via
  `score / idealScore(role) × 99`, so scores are **comparable across roles** (otherwise roles with
  bigger trait bonuses had a higher ceiling). `idealScore` = `99 + sum of the role's 4 best
  traits` (4 = max traits, Special rarity) + best sign bonus.
- **No rarity or progression term in the score**: the score reflects today's performance.
- **Power mean** (`settings.balanceExponent` = p): stat part = (Σ wᵢ·statᵢᵖ)^(1/p), normalised
  weights. p = 1 ⇒ plain weighted average; p < 1 penalises low stats (favours balanced profiles).
- **Exclusive stat pairs (pair-max)** (`EXCLUSIVE_STAT_PAIRS`, applied in `computeRawScores`):
  in a real action only one of the two stats is used, so when both are weighted for the role,
  **only the player's higher one keeps its weight** (the other is dropped before normalisation):
  - `read block` / `commit block` (the block score takes the max) — on a tie read wins (main
    blocking skill). Asymmetric weights (read > commit) make a reader score slightly better than
    a committer at equal values.
  - `quick` / `power` (**no tempo favoured per role**, an MB can attack high sets) — on a tie
    power wins. So that no style is structurally favoured, give quick and power the same weight.

## Composite formulas (reverse-engineered, validated on 117 players)
The 6 UPPERCASE attributes are **global weighted averages** of the lowercase attributes. Refined
version on **117 players** (reveals `max/min` terms on ATTACK and BLOCK):

| Composite | Formula |
|-----------|---------|
| STAMINA   | `stamina` |
| SERVE     | `0.85·serve + 0.075·awareness + 0.075·attack` |
| SETTING   | `0.75·setting + 0.10·overhand + 0.075·attack + 0.075·awareness` |
| RECEPTION | `0.75·reception + 0.15·bump + 0.055·defense + 0.015·overhand + 0.015·focus + 0.015·reflex` |
| ATTACK    | `0.55·spike + 0.20·max(power,quick) + 0.05·min(power,quick) + 0.10·back attack + 0.05·attack + 0.05·awareness` |
| BLOCK     | `0.65·block + 0.20·max(read block,commit block) + 0.05·min(read block,commit block) + 0.04·defense + 0.04·focus + 0.02·reflex` |

Weights sum to ≈ 1 → true weighted averages.

### ⚠️ Composites are only a DISPLAY score — not a model of the game
Confirmed by the developer: the 6 UPPERCASE ratings are a **displayed summary** for players who
do not want to dig deeper. **The actual game works with sub-stat THRESHOLDS that unlock
actions** (e.g. enough overhand unlocks a given set tempo). Direct consequence for
`statsWeights`:
- **Do NOT spread weights following the coefficients above.** A sub-stat with a small display
  coefficient (e.g. `overhand` = 10 % of SETTING) can be **functionally critical** because it
  gates a key action.
- Calibrate **by the actual function of the position**: for each sub-stat, what does it
  unlock/carry in the role's job? Weight heavily the stats that *gate* the important actions.
  The scorer being a weighted average (no hard threshold), a **threshold is approximated by a
  high weight** on the triggering stat.

### Validated findings
- **Linear aggregation.** Squared terms are never usefully retained (zero LOO gain, weight ≈ 0)
  → no non-linearity. 3 composites are perfectly linear (R² > 0.9996).
- **Global formula, NOT per role.** Cross-validation shows per-role fitting does no better than
  global (often worse); the "per-role gain" seen on a small sample was overfitting. **So
  multi-role players follow the same formula as everyone** (they are even slightly better
  predicted).
- **`reflex` nearly absent from composites**: ~1.5 % in RECEPTION, ~2 % in BLOCK, none elsewhere.
  Do not conclude it is useless: its **real gameplay effect** (reaction in defense/dig, unlocked
  by threshold) is not reflected in the display rating — it keeps a non-negligible functional
  weight for defensive positions.
- **Irreducible anomalies**: a few isolated players follow no formula (e.g. an ATTACK of 63 while
  all sub-stats are ≥ 74 — mathematically impossible for a positive average; other gaps of
  ~8-9 points on ATTACK or BLOCK). No stat, squared term or role explains them → data
  inconsistencies in the game. This keeps the ATTACK/BLOCK MAE at ~1 instead of ~0.2.

## Official sub-stat descriptions (game source)
Reference to calibrate `statsWeights`. This table motivated the read/commit block and
quick/power pair-max.

| Sub-stat | Official effect |
|---|---|
| setting | Quality and consistency of sets + delivering quick-tempo sets |
| serve | Serve accuracy and reliability: fewer misses, faster, better placed |
| spike | Strength and accuracy of spikes |
| quick | Handling fast sets (quick, fast set, fast pipe) without an attack error; helps a setter deliver them |
| power | Pace: harder spikes off high sets, faster and heavier serves |
| awareness | Picking the smartest place to aim attacks and serves (gaps, weak spots) + how often a front-row setter dumps |
| attack | Chance for spikes, dumps and serves to land better |
| back attack | Attacking from the back row (pipe, back-row swing) |
| reception | Ball control on defense: **receiving serves and digging attacks** |
| overhand | Overhand passing / hand-setting: float serve receive, setting off a good pass, free balls, last touches |
| bump | Forearm passing: hard / topspin serves, digging, bump-setting off a poor pass |
| block | Block strength at the net |
| read block | Reading the play to get up and time a block — **main blocking skill** |
| commit block | Committing to an attacker — **only applies with dedicated blocking** |
| focus | Precision of attacks and serves; avoids mix-ups with teammates on defense; harder to fake out at the block |
| defense | Cleanliness of **receptions, digs and blocks** |
| stamina | Endurance: tiring, bench recovery; tired players make more mistakes |
| reflex | Reach and range on defense (dig, receive, help on a block); reacting to dumps and tips |

## Profile calibration method (by function)
Each role's `statsWeights` are calibrated **by the actual function of the position** (see the
composites section), not by display coefficients. For each role, list its actions (front/back
attack, reception, dig, block, serve, emergency set…), then weight the sub-stats that gate those
actions. `traitBonuses` follow the **exact mechanics** of the traits (1st/2nd touch for Master
Mind, setter dump for Surprise Attack on the setter, block for Defensive Specialist, etc.).

## params.json format
```jsonc
{
  "traitWeight": 1,            // multiplies every traitBonus (applied at load time)
  "settings": { ... },         // see Settings (optional, defaults otherwise)
  "roles": {                   // setter, outsideHitter, middleBlocker, oppositeHitter, libero
    "setter": {
      "statsWeights": { "setting": 10, ... },   // 18 lowercase sub-stats, any scale
      "traitBonuses": { "Master Mind": 0, ... }, // points added to the 0-99 stat score
      "signBonuses":  { "Aries": 0, ... }        // value of the sign effect (assumed active)
    }
  }
}
```
A `traitBonus` is added **raw** to the normalised stat score (~0-99): a bonus of 10 ≈ +10-14 %
of score → significant but not overwhelming.
