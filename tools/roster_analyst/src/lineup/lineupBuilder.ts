/**
 * Lineup builder — single-pass MILP (yalps)
 *
 * Jointly selects the 7 starters, the 7 substitutes AND the
 * 7 reserves (injuries) in a single program: starters weighted at
 * full, substitutes weighted by λ (< 1), reserves by λᵣ (< λ) so
 * that the best players start. The global selection avoids
 * the greedy pitfall, which starts versatile players in
 * non-critical slots and thereby empties the bench pools.
 *
 * The reserve covers the game's new INJURY mechanic: when
 * a slot's starter is injured, their substitute enters the starting
 * six and the reserve takes the spot left free on the bench.
 *
 * Key constraints:
 *   - each starter slot: at most 1 player (filled as soon as an eligible
 *     candidate exists — the objective gain is always positive — but not
 *     `equal 1`: a role with no eligible player, or with fewer candidates
 *     than slots, leaves the remaining slot(s) empty instead of
 *     making the whole model infeasible)
 *   - each substitute / reserve slot: at most 1 player (incomplete
 *     bench tolerated if the roster is too small, rather than an infeasible
 *     model)
 *   - each player: at most 1 slot (starter, substitute OR reserve)
 *   - domination: for a given role, every starter >= every substitute
 *     >= every reserve (guarantees delta <= 0 at each tier; a slot
 *     stays empty if no remaining player is both eligible and
 *     weaker than the tier above — no substitute ⇒ no reserve)
 *
 * Post-MILP tactical constraints (5-1):
 *   score(Front OH) >= score(Back OH)
 *     → the best OH attacks from the front
 *   score(Back MB)  >= score(Front MB)
 *     → the best MB blocks from the back (setter's line)
 *
 * Sign synergy (see signChemistry.ts) — EXACT resolution:
 *   F = Σ starters' scores + value of the starters' chemistry (perfect
 *       synergy = +10 % of the sum of the starters' scores ≙ +10 %
 *       win) + λ·(score + entry synergy) of the substitutes
 *       + λᵣ·score of the reserves.
 * Chemistry is quadratic (pairs of players): linearized in the MILP,
 * yalps does not terminate. We therefore maximize F by branch & bound over the 7
 * starters (valid bounds: optimal assignment via the Hungarian algorithm +
 * chemistry bound from the still-possible signs), the bench and reserve
 * being solved exactly with fixed starters (assignment, then MILP if the
 * substitute ≥ reserve domination is not met). The starter ≥ substitute
 * domination is lifted: a player left out for chemistry can
 * go to the bench (Δ > 0). Checked against an exhaustive enumeration.
 *
 * These constraints are applied in post-processing by a simple swap:
 * the MILP selects the two best available players,
 * then we assign them to the right slot by score.
 * The result is identical to a constrained MILP because the selection
 * of players does not change — only their slot assignment changes.
 */

import { solve } from "yalps";
import { ScoredPlayer, RoleName } from "../types";
import { AFFINITY, NO_SIGN, signIndex, signAffinity, SIGN_SYNERGY_MAX_WIN_GAIN, SIGN_ACTIVATION_THRESHOLD, SETTER_SYNERGY_THRESHOLD } from "../config/signs";
import { Sign } from "../types";
import {
    courtRoleOf, evaluateCourt, CourtMember, FIVE_ONE_COURTS, UNITS_PER_PHASE,
} from "./signChemistry";
import { maxAssignment } from "./assignment";
import { SETTINGS, onSettingsChange } from "../config/settings";

// ─── Public types (unchanged) ────────────────────────────────────────────────

export interface SlotDef {
    slot: string;
    role: RoleName;
}

export interface LineupResult {
    lineup: Record<string, ScoredPlayer | null>;
    usedPlayers: Set<string>;
    /**
     * Value (score points) of the starters' sign synergy:
     * units reached × value of one unit (0 without signs / synergy off).
     */
    synergyValue: number;
}

export interface SubSlot {
    label: string;
    role: RoleName;
    replacesSlot: string;
}

/**
 * Optimized 5-1 lineup, by player names: transferable between threads
 * (parallel computation in workers, see analyze.ts), then fed back into
 * the cache via `LineupBuilder.importFiveOne`.
 */
export interface SerializedLineup {
    starters:     (string | null)[];
    subs:         (string | null)[];
    reserves:     (string | null)[];
    objective:    number;
    synergyValue: number;
}

export interface Substitute {
    label: string;
    sub: ScoredPlayer | null;
    replaces: string;
    delta: number;
    /** Reserve: moves up to the bench when the slot's starter is injured. */
    reserve: ScoredPlayer | null;
    /** Score gap reserve − substitute (<= 0 by domination). */
    reserveDelta: number;
}

// ─── Tactical order constraints ──────────────────────────────────────────────

/**
 * Pair of slots whose scores must be ordered after solving the MILP.
 *   higher : slot that must get the player with the higher score
 *   lower  : slot that must get the player with the lower score
 */
interface OrderConstraint {
    higher: string;
    lower:  string;
}

interface ModelSolution {
    starters:  (ScoredPlayer | null)[];
    subs:      (ScoredPlayer | null)[];
    reserves:  (ScoredPlayer | null)[];
    /** Objective value (weighted scores + bench synergy bonus). */
    objective: number;
}

// ─── LineupBuilder ───────────────────────────────────────────────────────────

export class LineupBuilder {
    private allRankings: Record<RoleName, ScoredPlayer[]>;
    private used: Set<string>;

    /**
     * Nominal weight of substitutes in the single-MILP objective (0 < λ < 1).
     * < 1 guarantees that the best players start; > 0 pushes
     * to field the strongest possible bench under the domination constraint.
     */
    static get subObjectiveWeight(): number { return SETTINGS.lineup.subObjectiveWeight; }
    static set subObjectiveWeight(v: number) { SETTINGS.lineup.subObjectiveWeight = v; LineupBuilder.cache.clear(); }

    /**
     * Weight of reserves (injuries) in the objective (0 < λᵣ < λ).
     * < λ guarantees the bench is filled before the reserve; > 0 pushes to
     * field the best possible reserve under the double domination
     * starter >= substitute >= reserve.
     */
    static get reserveObjectiveWeight(): number { return SETTINGS.lineup.reserveObjectiveWeight; }
    static set reserveObjectiveWeight(v: number) { SETTINGS.lineup.reserveObjectiveWeight = v; LineupBuilder.cache.clear(); }

    /** Enables sign synergy optimization (if the CSV has signs). */
    static get signSynergy(): boolean { return SETTINGS.lineup.signSynergy; }
    static set signSynergy(v: boolean) { SETTINGS.lineup.signSynergy = v; }

    /**
     * Safety limit of the synergy branch & bound (ms). Beyond it, the best
     * lineup found is kept with a warning (optimality not proven).
     */
    static get synergyTimeLimitMs(): number { return SETTINGS.lineup.synergyTimeLimitSec * 1000; }

    /** Already optimized results, keyed by pool contents (see buildOptimalLineup). */
    private static cache = new Map<string, { best: ModelSolution; synergyValue: number }>();

    /** Clears the lineup cache (call when scores or settings change). */
    static clearCache(): void { LineupBuilder.cache.clear(); }

    constructor(allRankings: Record<RoleName, ScoredPlayer[]>) {
        this.allRankings = allRankings;
        this.used = new Set();
    }

    // ─── Public API (signatures unchanged) ────────────────────────────────────

    private static readonly FIVE_ONE_STARTERS: SlotDef[] = [
        { slot: "Setter",               role: "setter"         },
        { slot: "Libero",               role: "libero"         },
        { slot: "Front Outside Hitter", role: "outsideHitter"  },
        { slot: "Back Outside Hitter",  role: "outsideHitter"  },
        { slot: "Front Middle Blocker", role: "middleBlocker"  },
        { slot: "Back Middle Blocker",  role: "middleBlocker"  },
        { slot: "Opposite",             role: "oppositeHitter" },
    ];

    buildFiveOneLineup(): LineupResult {
        const starterDefs = LineupBuilder.FIVE_ONE_STARTERS;

        // 5-1 tactical order constraints:
        //   Front OH >= Back OH  (best attacker in front)
        //   Back MB  >= Front MB (best blocker at the back, setter's line)
        const orderConstraints: OrderConstraint[] = [
            { higher: "Front Outside Hitter", lower: "Back Outside Hitter"  },
            { higher: "Back Middle Blocker",  lower: "Front Middle Blocker" },
        ];

        return this.buildOptimalLineup(
            starterDefs,
            LineupBuilder.getFiveOneSubSlots(),
            orderConstraints
        );
    }

    getSubstitutes(
        lineup: Record<string, ScoredPlayer | null>,
        subSlotDefs: SubSlot[]
    ): Substitute[] {
        if (this._lastSubs) {
            const map      = this._lastSubs;
            const resMap   = this._lastReserves ?? {};
            this._lastSubs     = null;
            this._lastReserves = null;
            return subSlotDefs.map(({ label, replacesSlot }) => {
                const sub     = map[replacesSlot] ?? null;
                const reserve = resMap[replacesSlot] ?? null;
                const starter = lineup[replacesSlot] ?? null;
                const delta        = sub && starter ? sub.score - starter.score : 0;
                const reserveDelta = reserve && sub ? reserve.score - sub.score : 0;
                return {
                    label, sub, replaces: starter?.player.fullName ?? "—", delta,
                    reserve, reserveDelta,
                };
            });
        }
        return this._greedySubs(lineup, subSlotDefs);
    }

    /** Optimizes the 5-1 of `allRankings` (or reads it from cache) and serializes it. */
    static solveFiveOne(allRankings: Record<RoleName, ScoredPlayer[]>): SerializedLineup {
        new LineupBuilder(allRankings).buildFiveOneLineup();
        const { key } = LineupBuilder.cacheEntryOf(
            allRankings, LineupBuilder.FIVE_ONE_STARTERS, LineupBuilder.getFiveOneSubSlots());
        const { best, synergyValue } = LineupBuilder.cache.get(key)!;
        const nm = (sp: ScoredPlayer | null) => sp?.player.fullName ?? null;
        return {
            starters: best.starters.map(nm), subs: best.subs.map(nm), reserves: best.reserves.map(nm),
            objective: best.objective, synergyValue,
        };
    }

    /**
     * Caches a 5-1 computed elsewhere (`solveFiveOne` in a worker):
     * the next `buildFiveOneLineup` on the same rankings reads it back.
     */
    static importFiveOne(allRankings: Record<RoleName, ScoredPlayer[]>, s: SerializedLineup): void {
        const subSlotDefs = LineupBuilder.getFiveOneSubSlots();
        const { key, pools } = LineupBuilder.cacheEntryOf(allRankings, LineupBuilder.FIVE_ONE_STARTERS, subSlotDefs);
        const find = (role: RoleName, name: string | null) =>
            name === null ? null : pools[role].find((sp) => sp.player.fullName === name) ?? null;
        LineupBuilder.cache.set(key, {
            best: {
                starters: LineupBuilder.FIVE_ONE_STARTERS.map((d, i) => find(d.role, s.starters[i])),
                subs:     subSlotDefs.map((d, j) => find(d.role, s.subs[j])),
                reserves: subSlotDefs.map((d, j) => find(d.role, s.reserves[j])),
                objective: s.objective,
            },
            synergyValue: s.synergyValue,
        });
    }

    /** Pools sorted by score desc and cache key of a lineup problem. */
    private static cacheEntryOf(
        allRankings: Record<RoleName, ScoredPlayer[]>,
        starterDefs: SlotDef[],
        subSlotDefs: SubSlot[]
    ): { key: string; pools: Record<string, ScoredPlayer[]> } {
        const pools: Record<string, ScoredPlayer[]> = {};
        for (const def of [...starterDefs, ...subSlotDefs]) {
            pools[def.role] ??= [...(allRankings[def.role] ?? [])].sort(
                (a, b) => b.score - a.score
            );
        }
        const key = JSON.stringify([
            starterDefs, subSlotDefs, LineupBuilder.signSynergy,
            LineupBuilder.subObjectiveWeight, LineupBuilder.reserveObjectiveWeight,
            Object.entries(pools).map(([r, pool]) =>
                [r, pool.map((sp) => [sp.player.fullName, sp.score, sp.player.sign])]),
        ]);
        return { key, pools };
    }

    // ─── Static helpers ───────────────────────────────────────────────────────

    // Display order = position on the court (serving order):
    // 1 Setter · 2 Front OH · 3 Front MB · 4 Opposite · 5 Back OH · 6 Back MB,
    // then the Libero as 7. Sub-slots follow the same order so that
    // starters, bench and reserves line up visually.

    static getFiveOneSubSlots(): SubSlot[] {
        return [
            { label: "Sub Setter",     role: "setter",        replacesSlot: "Setter"               },
            { label: "Sub Front OH",   role: "outsideHitter",  replacesSlot: "Front Outside Hitter" },
            { label: "Sub Front MB",   role: "middleBlocker",  replacesSlot: "Front Middle Blocker" },
            { label: "Sub OP",         role: "oppositeHitter", replacesSlot: "Opposite"             },
            { label: "Sub Back OH",    role: "outsideHitter",  replacesSlot: "Back Outside Hitter"  },
            { label: "Sub Back MB",    role: "middleBlocker",  replacesSlot: "Back Middle Blocker"  },
            { label: "Sub Libero",     role: "libero",         replacesSlot: "Libero"               },
        ];
    }

    static getFiveOneOrder(): string[] {
        return [
            "Setter",
            "Front Outside Hitter",
            "Front Middle Blocker",
            "Opposite",
            "Back Outside Hitter",
            "Back Middle Blocker",
            "Libero",
        ];
    }

    // ─── Core: single-pass MILP (starters + substitutes + reserves) ──────────

    private _lastSubs:     Record<string, ScoredPlayer | null> | null = null;
    private _lastReserves: Record<string, ScoredPlayer | null> | null = null;

    /** Single-pass MILP starters + substitutes + reserves (pure score). */
    private solveModel(
        starterDefs: SlotDef[],
        subSlotDefs: SubSlot[],
        pools:       Record<string, ScoredPlayer[]>
    ): ModelSolution {
        const nS = starterDefs.length;
        const starterPools = starterDefs.map((d) => pools[d.role] ?? []);
        const nB = subSlotDefs.length;

        const lambda  = LineupBuilder.subObjectiveWeight;
        const lambdaR = LineupBuilder.reserveObjectiveWeight;

        const vars: Record<string, Record<string, number>> = {};
        const cons: Record<string, { equal?: number; max?: number; min?: number }> = {};
        const seenPlayer = new Set<string>();

        const addPlayerCons = (nm: string) => {
            if (!seenPlayer.has(nm)) {
                cons[`pl_${nm}`] = { max: 1 };   // one player = at most 1 slot
                seenPlayer.add(nm);
            }
        };

        // Slots: starters, substitutes and reserves all at { max: 1 } (not
        // `equal: 1`) — a starter slot stays empty, without making the model
        // infeasible, if its role has no (or no more) available candidate
        // (reserve slots mirror substitute slots: one per starter
        // slot, same role)
        for (let i = 0; i < nS; i++) cons[`sl_${i}`] = { max: 1 };
        for (let j = 0; j < nB; j++) cons[`su_${j}`] = { max: 1 };
        for (let j = 0; j < nB; j++) cons[`re_${j}`] = { max: 1 };

        // Starter variables (full weight)
        for (let i = 0; i < nS; i++) {
            for (const sp of starterPools[i]) {
                const nm = sp.player.fullName;
                addPlayerCons(nm);
                vars[`xs_${nm}_${i}`] = {
                    obj:          sp.score,
                    [`sl_${i}`]:  1,
                    [`pl_${nm}`]: 1,
                };
            }
        }

        // Substitute variables (weight λ)
        for (let j = 0; j < nB; j++) {
            for (const sp of (pools[subSlotDefs[j].role] ?? [])) {
                const nm = sp.player.fullName;
                addPlayerCons(nm);
                vars[`xb_${nm}_${j}`] = {
                    obj:          lambda * sp.score,
                    [`su_${j}`]:  1,
                    [`pl_${nm}`]: 1,
                };
            }
        }

        // Reserve variables (weight λᵣ < λ)
        for (let j = 0; j < nB; j++) {
            for (const sp of (pools[subSlotDefs[j].role] ?? [])) {
                const nm = sp.player.fullName;
                addPlayerCons(nm);
                vars[`xr_${nm}_${j}`] = {
                    obj:          lambdaR * sp.score,
                    [`re_${j}`]:  1,
                    [`pl_${nm}`]: 1,
                };
            }
        }

        // Domination: for a given role, every starter >= every substitute.
        //   StScore_i - SubScore_j >= 0   (linear constraint, constant scores)
        // A substitute slot stays empty (SubScore_j = 0) if no remaining player
        // is both eligible and weaker than the starters.
        for (let i = 0; i < nS; i++) {
            for (let j = 0; j < nB; j++) {
                if (starterDefs[i].role !== subSlotDefs[j].role) continue;
                const cname = `dom_${i}_${j}`;
                cons[cname] = { min: 0 };
                for (const sp of starterPools[i]) {
                    const v = vars[`xs_${sp.player.fullName}_${i}`];
                    if (v) v[cname] = (v[cname] ?? 0) + sp.score;
                }
                for (const sp of (pools[subSlotDefs[j].role] ?? [])) {
                    const v = vars[`xb_${sp.player.fullName}_${j}`];
                    if (v) v[cname] = (v[cname] ?? 0) - sp.score;
                }
            }
        }

        // 2nd-tier domination: every substitute >= every reserve of the same role.
        //   SubScore_j - ResScore_k >= 0
        // An empty substitute slot (SubScore_j = 0) thus forces the reserve slot
        // of the same role to stay empty too (no substitute ⇒ no
        // reserve), and transitively starter >= reserve.
        for (let j = 0; j < nB; j++) {
            for (let k = 0; k < nB; k++) {
                if (subSlotDefs[j].role !== subSlotDefs[k].role) continue;
                const cname = `domr_${j}_${k}`;
                cons[cname] = { min: 0 };
                for (const sp of (pools[subSlotDefs[j].role] ?? [])) {
                    const vb = vars[`xb_${sp.player.fullName}_${j}`];
                    if (vb) vb[cname] = (vb[cname] ?? 0) + sp.score;
                    const vr = vars[`xr_${sp.player.fullName}_${k}`];
                    if (vr) vr[cname] = (vr[cname] ?? 0) - sp.score;
                }
            }
        }

        const sol = solve({
            direction:   "maximize",
            objective:   "obj",
            constraints: cons,
            variables:   vars,
            binaries:    true,
        });

        // ── Extraction ────────────────────────────────────────────────────────

        const starters: (ScoredPlayer | null)[] = new Array(nS).fill(null);
        const subs:     (ScoredPlayer | null)[] = new Array(nB).fill(null);
        const reserves: (ScoredPlayer | null)[] = new Array(nB).fill(null);

        if (sol.status === "optimal") {
            const sel = new Map(sol.variables);
            for (let i = 0; i < nS; i++) {
                for (const sp of starterPools[i]) {
                    if ((sel.get(`xs_${sp.player.fullName}_${i}`) ?? 0) > 0.5) {
                        starters[i] = sp;
                        break;
                    }
                }
            }
            for (let j = 0; j < nB; j++) {
                for (const sp of (pools[subSlotDefs[j].role] ?? [])) {
                    if ((sel.get(`xb_${sp.player.fullName}_${j}`) ?? 0) > 0.5) {
                        subs[j] = sp;
                        break;
                    }
                }
            }
            for (let j = 0; j < nB; j++) {
                for (const sp of (pools[subSlotDefs[j].role] ?? [])) {
                    if ((sel.get(`xr_${sp.player.fullName}_${j}`) ?? 0) > 0.5) {
                        reserves[j] = sp;
                        break;
                    }
                }
            }
        }

        return {
            starters, subs, reserves,
            objective: sol.status === "optimal" ? sol.result : -Infinity,
        };
    }

    private buildOptimalLineup(
        starterDefs:      SlotDef[],
        subSlotDefs:      SubSlot[],
        orderConstraints: OrderConstraint[] = []
    ): LineupResult {
        const nS = starterDefs.length;
        const nB = subSlotDefs.length;

        // Pools sorted by score desc (starters + substitutes). Cache: the
        // same pool is often re-optimized (availability, Academy, main
        // lineup) — the branch & bound is expensive.
        const { key: cacheKey, pools } = LineupBuilder.cacheEntryOf(this.allRankings, starterDefs, subSlotDefs);
        let cached = LineupBuilder.cache.get(cacheKey);
        if (!cached) {
            // 1) MILP without synergy (selection by pure score, strict domination).
            let best = this.solveModel(starterDefs, subSlotDefs, pools);
            let synergyValue = 0;

            // 2) Sign synergy: exact branch & bound over the starters,
            //    optimal bench/reserve with fixed starters.
            if (LineupBuilder.signSynergy) {
                ({ best, synergyValue } = this.optimizeSignSynergy(starterDefs, subSlotDefs, pools, best));
            }
            cached = { best, synergyValue };
            LineupBuilder.cache.set(cacheKey, cached);
        }
        const synergyValue = cached.synergyValue;
        const starters = [...cached.best.starters];
        const subs     = [...cached.best.subs];
        const reserves = [...cached.best.reserves];

        const used = new Set<string>();
        for (const sp of [...starters, ...subs, ...reserves]) {
            if (sp) used.add(sp.player.fullName);
        }

        // ── Post-processing: order constraints (intra-role swap) ──────────────
        //
        // The MILP has selected the set of players; we only
        // assign them to the right slot by score. Swapping two starters of the
        // same role does not change the set, so domination stays valid.

        for (const { higher, lower } of orderConstraints) {
            const hiIdx = starterDefs.findIndex(d => d.slot === higher);
            const loIdx = starterDefs.findIndex(d => d.slot === lower);
            if (hiIdx === -1 || loIdx === -1) continue;

            const hiPlayer = starters[hiIdx];
            const loPlayer = starters[loIdx];
            if (!hiPlayer || !loPlayer) continue;

            if (hiPlayer.score < loPlayer.score) {
                starters[hiIdx] = loPlayer;
                starters[loIdx] = hiPlayer;
                // The substitute / reserve follows the starter they cover
                // (their entry synergy was evaluated against the other starters).
                const hiJ = subSlotDefs.findIndex(d => d.replacesSlot === higher);
                const loJ = subSlotDefs.findIndex(d => d.replacesSlot === lower);
                if (hiJ !== -1 && loJ !== -1) {
                    [subs[hiJ], subs[loJ]]         = [subs[loJ], subs[hiJ]];
                    [reserves[hiJ], reserves[loJ]] = [reserves[loJ], reserves[hiJ]];
                }
            }
        }

        // ── Build the result maps ─────────────────────────────────────────────

        const lineup: Record<string, ScoredPlayer | null> = {};
        for (let i = 0; i < nS; i++) {
            lineup[starterDefs[i].slot] = starters[i];
        }

        const subsMap:     Record<string, ScoredPlayer | null> = {};
        const reservesMap: Record<string, ScoredPlayer | null> = {};
        for (let j = 0; j < nB; j++) {
            subsMap[subSlotDefs[j].replacesSlot]     = subs[j];
            reservesMap[subSlotDefs[j].replacesSlot] = reserves[j];
        }

        this.used          = used;
        this._lastSubs     = subsMap;
        this._lastReserves = reservesMap;

        return { lineup, usedPlayers: new Set(used), synergyValue };
    }

    // ─── Sign synergy: EXACT branch & bound ───────────────────────────────────
    //
    // Objective (the one a single starters + bench + reserve MILP would have):
    //   F(S) = Σ starters' scores + V·U(S) + B(S)
    //   U(S) : starters' chemistry units (average of the 2 phases, ≤ 9)
    //   V    : value of one unit = 10 % × Σ scores of the base starters / 9
    //   B(S) : EXACT bench + reserve optimum with starters S fixed (λ·score +
    //          substitute's entry synergy, λᵣ·reserve score, player
    //          uniqueness, substitute ≥ reserve domination).
    // Chemistry depends on pairs of players (quadratic): linearized in the
    // joint MILP, yalps does not terminate. We therefore IMPLICITLY enumerate all
    // starter sets by branch & bound with valid upper bounds
    // (optimal assignment without domination for remaining starters + bench +
    // reserve, chemistry bound from the still-possible signs): the lineup
    // kept is the global optimum of F (unless
    // `synergyTimeLimitMs` is exceeded, reported by a warning).

    private optimizeSignSynergy(
        starterDefs: SlotDef[],
        subSlotDefs: SubSlot[],
        pools:       Record<string, ScoredPlayer[]>,
        base:        ModelSolution
    ): { best: ModelSolution; synergyValue: number } {
        const anySign = Object.values(pools).some((pool) => pool.some((sp) => sp.player.sign));
        if (!anySign || base.objective === -Infinity) return { best: base, synergyValue: 0 };

        const t0 = Date.now();
        const nS = starterDefs.length;
        const nB = subSlotDefs.length;
        const lambda  = LineupBuilder.subObjectiveWeight;
        const lambdaR = LineupBuilder.reserveObjectiveWeight;
        const slotIdx = new Map(starterDefs.map((d, i) => [d.slot, i]));
        const courts = FIVE_ONE_COURTS
            .map((court) => court.map((slot) => slotIdx.get(slot)).filter((i): i is number => i !== undefined));
        const phaseW = 1 / courts.length;
        const crole = starterDefs.map((d) => courtRoleOf(d.role));
        const subCrole = subSlotDefs.map((d) => courtRoleOf(d.role));
        const subOf = subSlotDefs.map((d) => slotIdx.get(d.replacesSlot) ?? -1);

        const baseTotal = base.starters.reduce((s, sp) => s + (sp?.score ?? 0), 0);
        const unitValue = (SIGN_SYNERGY_MAX_WIN_GAIN * baseTotal) / UNITS_PER_PHASE;

        // Players (the same player may appear in several role pools).
        const names: string[] = [];
        const nameIdx = new Map<string, number>();
        const signOfP: (Sign | null)[] = [];
        for (const pool of Object.values(pools)) {
            for (const sp of pool) {
                if (nameIdx.has(sp.player.fullName)) continue;
                nameIdx.set(sp.player.fullName, names.length);
                names.push(sp.player.fullName);
                signOfP.push(sp.player.sign);
            }
        }
        const nP = names.length;
        const roleScore = new Map<RoleName, Map<number, ScoredPlayer>>();
        for (const [role, pool] of Object.entries(pools) as [RoleName, ScoredPlayer[]][]) {
            roleScore.set(role, new Map(pool.map((sp) => [nameIdx.get(sp.player.fullName)!, sp])));
        }

        type Lineup = (ScoredPlayer | null)[];
        const sg = (S: Lineup, i: number) => S[i]?.player.sign ?? null;

        /** Chemistry units (average of the phases) of starters S. */
        // Numeric version (branch & bound hot path): sig[i] = sign index
        // of starter i (NO_SIGN = no sign, −1 = empty slot).
        const chemBuf = new Int32Array(nS);
        const unitsOfSigs = (sig: ArrayLike<number>): number => {
            let units = 0;
            for (const idxs of courts) {
                for (const m of idxs) {
                    if (sig[m] < 0) continue;
                    let c = 0;
                    const row = sig[m] * 13;
                    for (const o of idxs) if (o !== m && sig[o] >= 0) c += AFFINITY[row + sig[o]];
                    chemBuf[m] = c;
                }
                let setter = -1;
                for (const m of idxs) if (crole[m] === "setter" && sig[m] >= 0) setter = m;
                for (const m of idxs) {
                    if (sig[m] < 0 || sig[m] === NO_SIGN || crole[m] === "setter") continue;
                    if (chemBuf[m] >= SIGN_ACTIVATION_THRESHOLD) units += phaseW;
                    if (crole[m] === "hitter" && setter >= 0 && sig[setter] !== NO_SIGN &&
                        chemBuf[setter] + chemBuf[m] >= SETTER_SYNERGY_THRESHOLD) units += phaseW;
                }
            }
            return units;
        };
        const sigOf = (S: Lineup) => S.map((sp) => (sp ? signIndex(sp.player.sign) : -1));
        /** Chemistry units (average of the phases) of starters S. */
        const starterUnits = (S: Lineup): number => unitsOfSigs(sigOf(S));

        /** Units involving a substitute of sign k entering slot j (starters S). */
        const entryUnits = (S: Lineup, j: number, k: Sign): number => {
            const i = subOf[j];
            if (i < 0) return 0;
            let units = 0;
            for (const idxs of courts) {
                if (!idxs.includes(i)) continue;
                const others = idxs.filter((t) => t !== i && S[t]);
                let subChem = 0;
                for (const o of others) subChem += signAffinity(k, sg(S, o));
                const chemWithSub = (h: number) => {
                    let c = signAffinity(sg(S, h), k);
                    for (const o of others) if (o !== h) c += signAffinity(sg(S, h), sg(S, o));
                    return c;
                };
                if (subCrole[j] === "setter") {
                    for (const h of others) {
                        if (crole[h] === "hitter" && sg(S, h) &&
                            subChem + chemWithSub(h) >= SETTER_SYNERGY_THRESHOLD) units++;
                    }
                } else {
                    if (subChem >= SIGN_ACTIVATION_THRESHOLD) units++;
                    const setter = others.find((t) => crole[t] === "setter");
                    if (subCrole[j] === "hitter" && setter !== undefined && sg(S, setter) &&
                        chemWithSub(setter) + subChem >= SETTER_SYNERGY_THRESHOLD) units++;
                }
            }
            return units * phaseW;
        };
        const bonusTable = (S: Lineup) => {
            const cache = new Map<string, number>();
            return (sign: Sign | null, j: number): number => {
                if (!sign) return 0;
                const key = `${j}|${sign}`;
                let v = cache.get(key);
                if (v === undefined) {
                    v = lambda * unitValue * entryUnits(S, j, sign);
                    cache.set(key, v);
                }
                return v;
            };
        };
        /** Maximum entry bonus of a substitute slot (bound). */
        const maxBonus = subSlotDefs.map((d, j) => {
            const i = subOf[j];
            if (i < 0) return 0;
            const per = { setter: 4, hitter: 2, libero: 1 }[subCrole[j]];
            return lambda * unitValue * per * phaseW * courts.filter((idxs) => idxs.includes(i)).length;
        });

        /**
         * Optimal assignment WITHOUT domination (Hungarian algorithm):
         * remaining starter slots (score) + substitutes (λ·score + bonus) +
         * reserves (λᵣ·score), players outside `used`. Upper bound; equal
         * to B(S) when the solution respects domination.
         */
        const assign = (
            used: Set<number>,
            starterSlots: number[],
            subBonus: (sign: Sign | null, j: number) => number
        ) => {
            const cols: number[] = [];
            for (let p = 0; p < nP; p++) if (!used.has(p)) cols.push(p);
            const rows: { kind: "s" | "b" | "r"; idx: number; role: RoleName }[] = [
                ...starterSlots.map((i) => ({ kind: "s" as const, idx: i, role: starterDefs[i].role })),
                ...subSlotDefs.map((d, j) => ({ kind: "b" as const, idx: j, role: d.role })),
                ...subSlotDefs.map((d, j) => ({ kind: "r" as const, idx: j, role: d.role })),
            ];
            const value = rows.map((row) => cols.map((p) => {
                const sp = roleScore.get(row.role)?.get(p);
                if (!sp) return null;
                if (row.kind === "s") return sp.score;
                if (row.kind === "b") return lambda * sp.score + subBonus(signOfP[p], row.idx);
                return lambdaR * sp.score;
            }));
            const { total, colOf } = maxAssignment(value, cols.length);
            const at = (kind: "b" | "r", j: number): ScoredPlayer | null => {
                const r = rows.findIndex((row) => row.kind === kind && row.idx === j);
                const c = colOf[r];
                return c >= 0 ? roleScore.get(subSlotDefs[j].role)!.get(cols[c])! : null;
            };
            return { total, at };
        };

        // ── Exact evaluation of a complete starter set ───────────────────────
        let best: ModelSolution = base;
        let bestTotal = -Infinity;
        let bestS: Lineup = base.starters;
        const scoreSum = (S: Lineup) => S.reduce((s, sp) => s + (sp?.score ?? 0), 0);
        const usedOf = (S: Lineup) => new Set(S.filter(Boolean).map((sp) => nameIdx.get(sp!.player.fullName)!));
        const consider = (S: Lineup): void => {
            const starterPart = scoreSum(S) + unitValue * starterUnits(S);
            const bonus = bonusTable(S);
            const a = assign(usedOf(S), [], bonus);
            if (starterPart + a.total <= bestTotal + 1e-9) return;
            const subs = subSlotDefs.map((_, j) => a.at("b", j));
            const reserves = subSlotDefs.map((_, j) => a.at("r", j));
            // Substitute ≥ reserve domination (per role, empty slot = 0).
            const dominated = subSlotDefs.every((dj, j) => subSlotDefs.every((dk, k) =>
                dj.role !== dk.role || (subs[j]?.score ?? 0) >= (reserves[k]?.score ?? 0)));
            let sol = { subs, reserves, objective: a.total };
            if (!dominated) {
                sol = this.solveBench(subSlotDefs, pools, S,
                    (sp, j) => bonus(sp.player.sign, j));
            }
            const total = starterPart + sol.objective;
            if (total > bestTotal + 1e-9) {
                bestTotal = total;
                bestS = [...S];
                best = {
                    starters: [...S], subs: sol.subs, reserves: sol.reserves,
                    objective: scoreSum(S) + sol.objective,
                };
            }
        };

        // ── Incumbent: base + local search (speeds up pruning) ───────────────
        consider(base.starters);
        for (const S of this.localSearch(starterDefs, pools, base.starters,
                (S) => scoreSum(S) + unitValue * starterUnits(S))) {
            consider(S);
        }

        // ── Branch & bound over the starters ─────────────────────────────────
        // Symmetry: slots of the same role (2 OH, 2 MB) are interchangeable
        // for F (same court presence / swapped phases; substitutes
        // reassigned by the bench optimization) → increasing indices.
        const cand = starterDefs.map((d) => pools[d.role] ?? []);
        const prevSameRole = starterDefs.map((d, i) =>
            starterDefs.findIndex((e, k) => k < i && e.role === d.role));

        const S: Lineup = new Array(nS).fill(null);
        const fixed: boolean[] = new Array(nS).fill(false);
        const pick: number[] = new Array(nS).fill(-1);
        const used = new Set<number>();

        // Chemistry bound: an unfixed slot takes, independently for each
        // relation, the best of the signs still available in its pool.
        const synergyBound = (): number => {
            const signsOf: (Sign | null)[][] = starterDefs.map((_, i) => {
                if (fixed[i]) return S[i] ? [S[i]!.player.sign] : [];
                const out = new Set<Sign | null>();
                for (const sp of cand[i]) {
                    if (!used.has(nameIdx.get(sp.player.fullName)!)) out.add(sp.player.sign);
                }
                return [...out];
            });
            // Few free slots: exact enumeration of sign combinations
            // (player uniqueness relaxed ⇒ bound always valid).
            const free = starterDefs.map((_, i) => i).filter((i) => !fixed[i] && signsOf[i].length > 0);
            if (free.length <= 2) {
                let bestU = 0;
                const T = sigOf(S);
                const rec = (k: number) => {
                    if (k === free.length) { bestU = Math.max(bestU, unitsOfSigs(T)); return; }
                    for (const sign of signsOf[free[k]]) { T[free[k]] = signIndex(sign); rec(k + 1); }
                };
                rec(0);
                return unitValue * bestU;
            }
            let units = 0;
            for (const idxs of courts) {
                const present = idxs.filter((i) => signsOf[i].length > 0);
                const chemUb = new Map<number, number>();
                for (const m of present) {
                    let bestC = -Infinity;
                    for (const k of signsOf[m]) {
                        if (!k) continue;
                        let c = 0;
                        for (const o of present) {
                            if (o === m) continue;
                            let mx = -Infinity;
                            for (const l of signsOf[o]) mx = Math.max(mx, signAffinity(k, l));
                            c += mx;
                        }
                        bestC = Math.max(bestC, c);
                    }
                    chemUb.set(m, bestC);
                }
                const setter = present.find((i) => crole[i] === "setter");
                for (const m of present) {
                    if (crole[m] === "setter") continue;
                    if (chemUb.get(m)! >= SIGN_ACTIVATION_THRESHOLD) units += phaseW;
                    if (crole[m] === "hitter" && setter !== undefined &&
                        chemUb.get(setter)! + chemUb.get(m)! >= SETTER_SYNERGY_THRESHOLD) units += phaseW;
                }
            }
            return unitValue * units;
        };
        // Bound on the substitutes' entry bonus, per slot j and sign k: same
        // relaxation as synergyBound (best possible sign per relation;
        // an unfixed slot may end up empty ⇒ affinity 0 possible). Much
        // tighter than maxBonus (all units reached) as soon as some
        // starters are fixed, which prunes the B&B well before the leaves.
        const bonusUb = new Float64Array(nB * 13);
        const maxAff = new Int8Array(nS * 13);
        const hasSign = new Array<boolean>(nS);
        const present = new Array<boolean>(nS);
        const signSets: number[][] = new Array(nS);
        const benchBonusBound = (): ((sign: Sign | null, j: number) => number) => {
            for (let o = 0; o < nS; o++) {
                let set: number[];
                if (fixed[o]) set = S[o] ? [signIndex(S[o]!.player.sign)] : [];
                else {
                    const seen = new Set<number>();
                    for (const sp of cand[o]) {
                        if (!used.has(nameIdx.get(sp.player.fullName)!)) seen.add(signIndex(sp.player.sign));
                    }
                    set = [...seen];
                }
                signSets[o] = set;
                present[o] = set.length > 0;
                hasSign[o] = set.some((l) => l !== NO_SIGN);
                for (let k = 0; k < 13; k++) {
                    let mx = fixed[o] ? -Infinity : 0;
                    for (const l of set) mx = Math.max(mx, AFFINITY[k * 13 + l]);
                    maxAff[o * 13 + k] = present[o] ? mx : 0;
                }
            }
            bonusUb.fill(0);
            for (let j = 0; j < nB; j++) {
                const i = subOf[j];
                if (i < 0) continue;
                for (let k = 0; k < NO_SIGN; k++) {
                    let units = 0;
                    for (const idxs of courts) {
                        if (!idxs.includes(i)) continue;
                        const others = idxs.filter((t) => t !== i && present[t]);
                        let subChem = 0;
                        for (const o of others) subChem += maxAff[o * 13 + k];
                        const chemWithSubUb = (h: number): number => {
                            let best = -Infinity;
                            for (const l of signSets[h]) {
                                if (l === NO_SIGN) continue;
                                let c = AFFINITY[l * 13 + k];
                                for (const o of others) if (o !== h) c += maxAff[o * 13 + l];
                                best = Math.max(best, c);
                            }
                            return best;
                        };
                        if (subCrole[j] === "setter") {
                            for (const h of others) {
                                if (crole[h] === "hitter" && hasSign[h] &&
                                    subChem + chemWithSubUb(h) >= SETTER_SYNERGY_THRESHOLD) units++;
                            }
                        } else {
                            if (subChem >= SIGN_ACTIVATION_THRESHOLD) units++;
                            const setter = others.find((t) => crole[t] === "setter");
                            if (subCrole[j] === "hitter" && setter !== undefined && hasSign[setter] &&
                                chemWithSubUb(setter) + subChem >= SETTER_SYNERGY_THRESHOLD) units++;
                        }
                    }
                    bonusUb[j * 13 + k] = Math.min(maxBonus[j], lambda * unitValue * units * phaseW);
                }
            }
            return (sign, j) => bonusUb[j * 13 + signIndex(sign)];
        };
        const assignBound = (fromSlot: number): number =>
            assign(used, Array.from({ length: nS - fromSlot }, (_, k) => fromSlot + k), benchBonusBound()).total;

        let timedOut = false;
        let nodes = 0;
        const dfs = (i: number, partial: number): void => {
            if (timedOut) return;
            if ((++nodes & 0xff) === 0 && Date.now() - t0 > LineupBuilder.synergyTimeLimitMs) {
                timedOut = true;
                return;
            }
            if (i === nS) { consider(S); return; }
            const start = prevSameRole[i] >= 0 ? pick[prevSameRole[i]] + 1 : 0;
            // Bound without the candidate (slot i outside the assignment): removing one
            // more player can only lower it ⇒ partial + score(c) + rest
            // decreases with c (sorted by score) → stop as soon as it fails.
            const restAssign = assignBound(i + 1);
            const rest = restAssign + synergyBound();
            let any = false;
            for (let c = start; c < cand[i].length; c++) {
                const sp = cand[i][c];
                const p = nameIdx.get(sp.player.fullName)!;
                if (used.has(p)) continue;
                any = true;
                if (partial + sp.score + rest <= bestTotal + 1e-9) break;
                used.add(p); S[i] = sp; pick[i] = c; fixed[i] = true;
                // Chemistry bound (c fixed) first with the assignment without removing
                // c (≥ the true one, cheap), then the exact assignment.
                const syn = synergyBound();
                if (partial + sp.score + restAssign + syn > bestTotal + 1e-9 &&
                    partial + sp.score + assignBound(i + 1) + syn > bestTotal + 1e-9) {
                    dfs(i + 1, partial + sp.score);
                }
                used.delete(p); S[i] = null; pick[i] = -1; fixed[i] = false;
            }
            // Slot left empty only if there is no eligible player left (same
            // rule as the base MILP: a playable slot is always filled).
            if (!any) {
                pick[i] = cand[i].length; fixed[i] = true;
                dfs(i + 1, partial);
                pick[i] = -1; fixed[i] = false;
            }
        };
        dfs(0, 0);

        if (timedOut) {
            console.warn(
                `⚠️  Sign chemistry: ${LineupBuilder.synergyTimeLimitMs / 1000} s time limit reached, ` +
                `lineup = best found so far (optimality not proven).`
            );
        }
        return { best, synergyValue: unitValue * starterUnits(bestS) };
    }

    /**
     * Local search (single and double replacements): provides good
     * starting starter sets to the branch & bound (faster pruning).
     */
    private localSearch(
        starterDefs: SlotDef[],
        pools:       Record<string, ScoredPlayer[]>,
        start:       (ScoredPlayer | null)[],
        value:       (S: (ScoredPlayer | null)[]) => number
    ): (ScoredPlayer | null)[][] {
        const nS = starterDefs.length;
        const candidates = (S: (ScoredPlayer | null)[], i: number) => {
            const inS = new Set(S.filter(Boolean).map((sp) => sp!.player.fullName));
            return (pools[starterDefs[i].role] ?? []).filter((sp) => !inS.has(sp.player.fullName));
        };
        const path: (ScoredPlayer | null)[][] = [];
        let cur = [...start];
        let curVal = value(cur);
        for (let improved = true; improved; ) {
            improved = false;
            let bestS: (ScoredPlayer | null)[] | null = null;
            let bestVal = curVal + 1e-9;
            const tryS = (S: (ScoredPlayer | null)[]) => {
                const v = value(S);
                if (v > bestVal) { bestVal = v; bestS = [...S]; }
            };
            for (let i = 0; i < nS; i++) {
                for (const ci of candidates(cur, i)) {
                    const Si = [...cur]; Si[i] = ci; tryS(Si);
                    for (let k = i + 1; k < nS; k++) {
                        for (const ck of candidates(Si, k)) {
                            const Sk = [...Si]; Sk[k] = ck; tryS(Sk);
                        }
                    }
                }
            }
            if (bestS) { cur = bestS; curVal = bestVal; improved = true; path.push(cur); }
        }
        return path.reverse();
    }

    /**
     * EXACT bench + reserve optimum with FIXED starters. Objective: λ·score +
     * entry synergy bonus (substitutes) + λᵣ·score (reserves);
     * substitute ≥ reserve domination per role (empty substitute slot ⇒ no
     * reserve). No starter ≥ substitute domination: the
     * starters are chosen by the global objective (chemistry included), a
     * player left out for chemistry can go to the bench (Δ > 0).
     *
     * The domination of a role r is equivalent to a threshold t_r: substitutes ≥ t_r ≥
     * reserves. Branch & bound over threshold intervals [lo, hi]:
     * relaxation = assignment (Hungarian) with substitutes ≥ lo (and filled if
     * lo > 0) and reserves ≤ hi; on violation (min substitute s <
     * max reserve v), split at m = (s + v) / 2: t ≤ m (reserves ≤ m)
     * or t ≥ m (substitutes ≥ m), both excluding the current solution.
     * (The equivalent yalps MILP could take several minutes per call
     * when scores are close.)
     */
    private solveBench(
        subSlotDefs: SubSlot[],
        pools:       Record<string, ScoredPlayer[]>,
        starters:    (ScoredPlayer | null)[],
        bonus:       (sp: ScoredPlayer, j: number) => number
    ): { subs: (ScoredPlayer | null)[]; reserves: (ScoredPlayer | null)[]; objective: number } {
        const lambda  = LineupBuilder.subObjectiveWeight;
        const lambdaR = LineupBuilder.reserveObjectiveWeight;
        const nB = subSlotDefs.length;
        const inS = new Set(starters.filter(Boolean).map((sp) => sp!.player.fullName));

        const colIdx = new Map<string, number>();
        const free = subSlotDefs.map((d) => (pools[d.role] ?? []).filter((sp) => !inS.has(sp.player.fullName)));
        for (const list of free) for (const sp of list) {
            if (!colIdx.has(sp.player.fullName)) colIdx.set(sp.player.fullName, colIdx.size);
        }
        const nC = colIdx.size;
        // Player of column c in slot j (null if ineligible for the role).
        const at = free.map((list) => {
            const row: (ScoredPlayer | null)[] = new Array(nC).fill(null);
            for (const sp of list) row[colIdx.get(sp.player.fullName)!] = sp;
            return row;
        });
        const subVal = at.map((row, j) => row.map((sp) => (sp ? lambda * sp.score + bonus(sp, j) : 0)));

        const roles = [...new Set(subSlotDefs.map((d) => d.role))];
        const roleOf = subSlotDefs.map((d) => roles.indexOf(d.role));

        let best = {
            subs:     subSlotDefs.map((): ScoredPlayer | null => null),
            reserves: subSlotDefs.map((): ScoredPlayer | null => null),
            objective: -Infinity,
        };
        const node = (lo: number[], hi: number[]): void => {
            const value: (number | null)[][] = [];
            const required: boolean[] = [];
            for (let j = 0; j < nB; j++) {
                const l = lo[roleOf[j]];
                value.push(at[j].map((sp, c) => (sp && sp.score >= l ? subVal[j][c] : null)));
                required.push(l > 0);
            }
            for (let k = 0; k < nB; k++) {
                const h = hi[roleOf[k]];
                value.push(at[k].map((sp) => (sp && sp.score <= h ? lambdaR * sp.score : null)));
                required.push(false);
            }
            const { total, colOf } = maxAssignment(value, nC, required);
            if (total <= best.objective + 1e-9) return;
            const subs     = subSlotDefs.map((_, j) => (colOf[j] >= 0 ? at[j][colOf[j]] : null));
            const reserves = subSlotDefs.map((_, k) => (colOf[nB + k] >= 0 ? at[k][colOf[nB + k]] : null));

            // Role most violating domination (empty substitute = 0).
            let worst = -1, cut = 0, gap = 1e-9;
            roles.forEach((_, r) => {
                let sMin = Infinity, vMax = -Infinity;
                for (let j = 0; j < nB; j++) {
                    if (roleOf[j] !== r) continue;
                    sMin = Math.min(sMin, subs[j]?.score ?? 0);
                    if (reserves[j]) vMax = Math.max(vMax, reserves[j]!.score);
                }
                if (vMax - sMin > gap) { gap = vMax - sMin; worst = r; cut = (sMin + vMax) / 2; }
            });
            if (worst < 0) { best = { subs, reserves, objective: total }; return; }
            node(lo, hi.map((h, r) => (r === worst ? Math.min(h, cut) : h)));
            node(lo.map((l, r) => (r === worst ? Math.max(l, cut) : l)), hi);
        };
        node(roles.map(() => -Infinity), roles.map(() => Infinity));
        return best;
    }


    // ─── Greedy fallback (backward compatibility of standalone getSubstitutes) ─

    private _greedySubs(
        lineup:      Record<string, ScoredPlayer | null>,
        subSlotDefs: SubSlot[]
    ): Substitute[] {
        const usedForSubs = new Set(this.used);

        // 1st pass: substitutes (the bench is filled before the reserve,
        // as the MILP domination requires).
        const substitutes: Substitute[] = [];
        for (const { label, role, replacesSlot } of subSlotDefs) {
            const ranked  = this.allRankings[role] ?? [];
            const sub     = ranked.find(s => !usedForSubs.has(s.player.fullName)) ?? null;
            const starter = lineup[replacesSlot] ?? null;
            if (sub) usedForSubs.add(sub.player.fullName);
            const delta = sub && starter ? sub.score - starter.score : 0;
            substitutes.push({
                label, sub, replaces: starter?.player.fullName ?? "—", delta,
                reserve: null, reserveDelta: 0,
            });
        }

        // 2nd pass: reserves (injuries) — no substitute ⇒ no
        // reserve, consistent with the MILP.
        substitutes.forEach((entry, j) => {
            if (!entry.sub) return;
            const ranked  = this.allRankings[subSlotDefs[j].role] ?? [];
            const reserve = ranked.find(s => !usedForSubs.has(s.player.fullName)) ?? null;
            if (reserve) {
                usedForSubs.add(reserve.player.fullName);
                entry.reserve      = reserve;
                entry.reserveDelta = reserve.score - entry.sub.score;
            }
        });

        return substitutes;
    }
}
// Settings change (λ, synergy…) ⇒ cached lineups are stale.
onSettingsChange.push(() => LineupBuilder.clearCache());
