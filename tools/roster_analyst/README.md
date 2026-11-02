# Roster Analyst

Analyses a World Aces roster export with **your own scoring profile** and produces a report:

1. **Role rankings** — every available player scored 0-99 for each role they can play.
2. **Recommended 5-1 lineup** — starters, bench and injury reserves chosen together (exact
   MILP), optional exact optimisation of the **sign chemistry**, and whether to rotate your two
   liberos between serve-receive and defense.
3. **Academy & progression** — who should leave / join the academy, which declining players are
   still worth playing.
4. **Weak spots & recruitment filter** — the 3 roles to recruit for, with the best trait trio
   and signs to look for.
5. **Roster management** — players to sell when the roster is over its target size (or not
   improving any more).

The report itself is in French. No tuned profile is shipped: you decide how each stat, trait
and sign is worth for each role, and export it as a `params.json` you can reuse.

Author: @Peariforme

## In the browser (no install)

Open the tool from the [community tools page](https://worldaces-community.github.io/Worldaces-tools/)
(`roster_analyst/`). Everything runs locally in your browser; nothing is uploaded.

1. **Settings** — sliders and inputs for each role (18 stat weights, 18 trait bonuses,
   12 sign bonuses), global trait weight, and the analysis thresholds (lineup weights,
   academy age, decline threshold, libero rotation, roster quotas, recruitment rules).
   **Export params.json** saves everything in one file; **Import params.json** restores it.
   The last settings are also remembered by your browser.
2. **Roster** — drop the roster CSV exported from the game (English or French headers), or
   try the bundled example.
3. **Report** — run the analysis (a few seconds; up to a few minutes with sign chemistry on a
   large roster), read it, download it as Markdown or print it.

## From the command line

Requires Node.js 20+.

```bash
cd tools/roster_analyst
npm ci
npm run analyze -- example_roster.csv example_params.json
npm run analyze -- my_roster.csv my_params.json --verbose --md report.md
```

- `--verbose` adds the score formulas and trait/sign bonuses per role.
- `--md <file>` also writes the report as GitHub Markdown (e.g. for a GitHub Actions job
  summary: `cat report.md >> "$GITHUB_STEP_SUMMARY"`).
- Colours are automatic on a terminal (`NO_COLOR` disables them, `FORCE_COLOR=1` forces them).

### Using it from your own (private) repository

Keep only your `params.json` and roster CSVs in your repo and check this tool out in your
workflow:

```yaml
- uses: actions/checkout@v4
- uses: actions/checkout@v4
  with:
    repository: Worldaces-community/Worldaces-tools
    path: worldaces-tools
- uses: actions/setup-node@v4
  with: { node-version: "20" }
- run: npm ci
  working-directory: worldaces-tools/tools/roster_analyst
- run: |
    npm --prefix worldaces-tools/tools/roster_analyst run analyze -- \
      "$PWD/roster.csv" "$PWD/params.json" --md "$PWD/report.md"
    cat report.md >> "$GITHUB_STEP_SUMMARY"
```

## Input: roster CSV

The in-game roster export. Required columns: `First name`, `Last name`, `Roles`
(French export: `Prénom`, `Nom`, `Rôles`). Used when present: `Age`, `Rarity`, `Position`
(`Academy` players are kept out of the lineup), `Traits`, `Sign`, `Progress`
(`Improving` / `Starting to decline` / `Considering retirement`), the 6 composite stats
(`ATTACK`… — only used to show weak stats) and the 18 sub-stats (`setting`, `serve`, `spike`,
`quick`, `power`, `awareness`, `attack`, `back attack`, `reception`, `overhand`, `bump`,
`block`, `read block`, `commit block`, `focus`, `defense`, `stamina`, `reflex`).
Multiple roles / traits are separated by `;`. See [`example_roster.csv`](./example_roster.csv)
(invented players).

Unknown traits, signs or progress values are reported as warnings instead of being silently
ignored.

## Input: params.json

```jsonc
{
  "traitWeight": 1,          // multiplies every trait bonus
  "settings": { ... },       // analysis thresholds — optional, defaults otherwise
  "roles": {
    "setter":         { "statsWeights": {...}, "traitBonuses": {...}, "signBonuses": {...} },
    "outsideHitter":  { ... },
    "middleBlocker":  { ... },
    "oppositeHitter": { ... },
    "libero":         { ... }
  }
}
```

- `statsWeights` — 0-10 per sub-stat; they are normalised, only the ratios matter.
  For `read block`/`commit block` and `quick`/`power` only the player's better stat counts.
- `traitBonuses` / `signBonuses` — points added to the 0-99 stat score (negative allowed).
- `settings` — see the table in [DESIGN.md](./DESIGN.md#réglages-settings).

[`example_params.json`](./example_params.json) is the neutral template of the editor (all
stats equal, no bonuses) — a starting point, not a recommendation.

## How it works

The scoring, lineup optimisation (MILP + branch & bound on sign chemistry), availability,
academy, libero rotation, recruitment and roster rules are documented (in French) in
[DESIGN.md](./DESIGN.md), along with the official trait / sign / sub-stat mechanics.

## Development

```bash
npm ci
npm run typecheck        # CLI + browser bundle (the engine must stay Node-free)
npm run build:browser    # → web/dist/ (index.html, app.js, worker.js…)
npx http-server web/dist # or any static server, then open http://localhost:8080
npm run verify-lineup -- example_roster.csv example_params.json 14 0
```

The GitHub Pages workflow runs `npm run build:browser` for every tool whose `package.json`
has that script, and `scripts/build_docs.py` publishes the folder named by `browser_build`
in `metadata.json`.
