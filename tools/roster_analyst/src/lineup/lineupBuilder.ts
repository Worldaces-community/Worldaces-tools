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
 * Sign synergy (see signChemistry.ts):
 *   F = Σ starters' scores − sign bonus of the starters whose sign effect is
 *       inactive + setter's connection bonus × connected attackers
 *       + λ·score of the substitutes + λᵣ·score of the reserves
 *       + λ · mean_k [C(state k) − C(starting 7)] (substitutions accumulate
 *       in the order of settings.lineup.substitutionOrder).
 * Chemistry is quadratic (pairs of players): linearized in the MILP,
 * yalps does not terminate. We therefore maximize F by branch & bound over the 7
 * starters (valid bounds: optimal assignment via the Hungarian algorithm +
 * chemistry bound from the still-possible signs), the bench being chosen
 * at each leaf by local search from the exact score-only bench (choice of
 * the substitutes and of which substitute replaces which starter). The
 * starter ≥ substitute domination is lifted: a player left out for
 * chemistry can go to the bench (Δ > 0). Checked against an exhaustive
 * enumeration (tools/verifyLineup.ts).
 *
 * These constraints are applied in post-processing by a simple swap:
 * the MILP selects the two best available players,
 * then we assign them to the right slot by score.
 * The result is identical to a constrained MILP because the selection
 * of players does not change — only their slot assignment changes.
 */

import { solve } from "yalps";
import { ScoredPlayer, RoleName } from "../types";
import { AFFINITY, NO_SIGN, signIndex, SIGN_ACTIVATION_THRESHOLD, SETTER_SYNERGY_THRESHOLD } from "../config/signs";
import {
    courtRoleOf, evaluateCourt, CourtMember, FIVE_ONE_COURT, lineupChemValue,
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
     * Chemistry value (score points) of the starters, relative to their
     * scores (which assume the sign effects active): connections × setter's
     * connection value − sign bonus lost to inactive effects (see lineupChemValue).
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

    /** Order in which the starters are replaced during a set (see signChemistry.ts). */
    static get substitutionOrder(): string[] { return SETTINGS.lineup.substitutionOrder; }

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
            starterDefs, subSlotDefs, LineupBuilder.signSynergy, LineupBuilder.substitutionOrder,
            LineupBuilder.subObjectiveWeight, LineupBuilder.reserveObjectiveWeight,
            Object.entries(pools).map(([r, pool]) =>
                [r, pool.map((sp) => [sp.player.fullName, sp.score, sp.signScore, sp.player.sign])]),
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

    /**
     * Single-pass MILP starters + substitutes + reserves on the score WITHOUT
     * the sign bonus (chemistry ignored ⇒ sign effects assumed inactive).
     */
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
        const base = (sp: ScoredPlayer) => sp.score - sp.signScore;

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
                    obj:          base(sp),
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
                    obj:          lambda * base(sp),
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
                    obj:          lambdaR * base(sp),
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
                    if (v) v[cname] = (v[cname] ?? 0) + base(sp);
                }
                for (const sp of (pools[subSlotDefs[j].role] ?? [])) {
                    const v = vars[`xb_${sp.player.fullName}_${j}`];
                    if (v) v[cname] = (v[cname] ?? 0) - base(sp);
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
                    if (vb) vb[cname] = (vb[cname] ?? 0) + base(sp);
                    const vr = vars[`xr_${sp.player.fullName}_${k}`];
                    if (vr) vr[cname] = (vr[cname] ?? 0) - base(sp);
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
            // 1) MILP without chemistry (score without sign bonus, strict domination).
            let best = this.solveModel(starterDefs, subSlotDefs, pools);
            let synergyValue = 0;

            // 2) Sign synergy: exact branch & bound over the starters,
            //    optimal bench/reserve with fixed starters.
            if (LineupBuilder.signSynergy) {
                ({ best, synergyValue } = this.optimizeSignSynergy(starterDefs, subSlotDefs, pools, best, orderConstraints));
            }
            cached = { best, synergyValue };
            LineupBuilder.cache.set(cacheKey, cached);
        }
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
                // (without signs: with signs, the order is already applied before choosing the bench).
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

        // Actual chemistry of the kept starters (also without the optimization:
        // the effects that happen to be active, the connections).
        return { lineup, usedPlayers: new Set(used), synergyValue: lineupChemValue(lineup) };
    }

    // ─── Sign synergy: branch & bound ─────────────────────────────────────────
    //
    // Objective:
    //   F(S, B) = Σ starters' scores + C(S) + λ·Σ substitutes' scores
    //             + λᵣ·Σ reserves' scores + λ · mean_k [C(S_k) − C(S)]
    //   C(·)  = K·(connected attackers) − Σ sign bonus (signScore) of the
    //           non-setter players whose sign effect is inactive (the score
    //           assumes it active); K = setter's connectionScore
    //   S_k   = court after the k first slots of
    //           `settings.lineup.substitutionOrder` (each starter replaced by
    //           their own substitute, substitutions accumulate, no return;
    //           a slot without substitute leaves the court unchanged).
    // The starting 7 keeps a fixed weight of 1; the accumulated substitutions
    // add their AVERAGE chemistry gain / loss once, weighted by λ like the
    // substitutes' scores (all 7 players count, so a substitute that breaks
    // the others' effects or links is penalised).
    //
    // Starters: branch & bound, valid upper bounds = optimal assignment
    // without domination (remaining starters + bench + reserves, scores only)
    // + chemistry bound (1 − λ)·Ĉ + λ·mean_k Ĉ_k, where Ĉ is the bound of
    // C(S) (best sign still available per relation) and Ĉ_k the same bound
    // with the k first slots of the order also open to every still-available
    // player (≥ C(S_k)). Bench at each leaf: exact score-only optimum
    // (assignment, then threshold branch & bound if the substitute ≥
    // reserve domination is violated), then local search over the
    // substitutes (see improveBench) with optimal reserves for each
    // candidate bench. The bench part is
    // thus a local optimum (checked against an exhaustive enumeration on
    // small rosters, see tools/verifyLineup.ts).

    private optimizeSignSynergy(
        starterDefs:      SlotDef[],
        subSlotDefs:      SubSlot[],
        pools:            Record<string, ScoredPlayer[]>,
        base:             ModelSolution,
        orderConstraints: OrderConstraint[]
    ): { best: ModelSolution; synergyValue: number } {
        const anySign = Object.values(pools).some((pool) => pool.some((sp) => sp.player.sign));
        if (!anySign || base.objective === -Infinity) return { best: base, synergyValue: 0 };

        const t0 = Date.now();
        const nS = starterDefs.length;
        const lambda  = LineupBuilder.subObjectiveWeight;
        const lambdaR = LineupBuilder.reserveObjectiveWeight;
        const slotIdx = new Map(starterDefs.map((d, i) => [d.slot, i]));
        const court = FIVE_ONE_COURT
            .map((slot) => slotIdx.get(slot)).filter((i): i is number => i !== undefined);
        const crole = starterDefs.map((d) => courtRoleOf(d.role));
        const subOf = subSlotDefs.map((d) => slotIdx.get(d.replacesSlot) ?? -1);

        // Substitution order (starter slot indices that have a substitute slot).
        const subSlotOf = new Map<number, number>();
        subOf.forEach((i, j) => { if (i >= 0) subSlotOf.set(i, j); });
        // Every listed court slot is a state (unchanged without a substitute).
        const subOrder = LineupBuilder.substitutionOrder
            .map((slot) => slotIdx.get(slot))
            .filter((i): i is number => i !== undefined && court.includes(i));
        /** prefixOpen[k][i]: slot i is among the k + 1 first slots of the order. */
        const prefixOpen = subOrder.map((_, k) =>
            starterDefs.map((_, i) => subOrder.slice(0, k + 1).includes(i) && subSlotOf.has(i)));

        // Value of one setter ↔ attacker connection (same for every setter).
        const connPts = (pools["setter"] ?? [])[0]?.connectionScore ?? 0;

        // Players (the same player may appear in several role pools).
        const names: string[] = [];
        const nameIdx = new Map<string, number>();
        for (const pool of Object.values(pools)) {
            for (const sp of pool) {
                if (nameIdx.has(sp.player.fullName)) continue;
                nameIdx.set(sp.player.fullName, names.length);
                names.push(sp.player.fullName);
            }
        }
        const nP = names.length;
        const idxOf = (sp: ScoredPlayer) => nameIdx.get(sp.player.fullName)!;
        const roleScore = new Map<RoleName, Map<number, ScoredPlayer>>();
        for (const [role, pool] of Object.entries(pools) as [RoleName, ScoredPlayer[]][]) {
            roleScore.set(role, new Map(pool.map((sp) => [idxOf(sp), sp])));
        }

        // Sign bonus included in the score, per starter slot and sign index (it
        // depends only on the role's config): lost if the effect is inactive.
        // Setters have no sign effect to activate → never removed. A
        // substitute has the role of the slot they replace ⇒ same table.
        const starterPts = new Float64Array(nS * 13);
        starterDefs.forEach((d, i) => {
            if (courtRoleOf(d.role) === "setter") return;
            for (const sp of pools[d.role] ?? []) starterPts[i * 13 + signIndex(sp.player.sign)] = sp.signScore;
        });

        type Lineup = (ScoredPlayer | null)[];

        /** Chemistry value C of a court (score points). */
        // Numeric version (branch & bound hot path): sig[i] = sign index
        // of the player in slot i (NO_SIGN = no sign, −1 = empty slot).
        const chemBuf = new Int32Array(nS);
        const chemOfSigs = (sig: ArrayLike<number>): number => {
            let value = 0;
            for (const m of court) {
                if (sig[m] < 0) continue;
                let c = 0;
                const row = sig[m] * 13;
                for (const o of court) if (o !== m && sig[o] >= 0) c += AFFINITY[row + sig[o]];
                chemBuf[m] = c;
            }
            let setter = -1;
            for (const m of court) if (crole[m] === "setter" && sig[m] >= 0) setter = m;
            for (const m of court) {
                if (sig[m] < 0 || sig[m] === NO_SIGN || crole[m] === "setter") continue;
                if (chemBuf[m] < SIGN_ACTIVATION_THRESHOLD) value -= starterPts[m * 13 + sig[m]];
                if (crole[m] === "hitter" && setter >= 0 && sig[setter] !== NO_SIGN &&
                    chemBuf[setter] + chemBuf[m] >= SETTER_SYNERGY_THRESHOLD) value += connPts;
            }
            return value;
        };
        const sigOf = (S: Lineup) => S.map((sp) => (sp ? signIndex(sp.player.sign) : -1));
        /** Chemistry value C of starters S. */
        const starterChem = (S: Lineup): number => chemOfSigs(sigOf(S));

        /** Bench chemistry term λ · mean_k [C(S_k) − C(S)] (substitutes B by sub slot). */
        const benchChem = (S: Lineup, B: Lineup): number => {
            const sig = sigOf(S);
            const c0 = chemOfSigs(sig);
            let sum = 0;
            for (const i of subOrder) {
                const j = subSlotOf.get(i);
                const sub = j === undefined ? null : B[j];
                if (S[i] && sub) sig[i] = signIndex(sub.player.sign);
                sum += chemOfSigs(sig);
            }
            return subOrder.length ? lambda * (sum / subOrder.length - c0) : 0;
        };

        /**
         * Optimal assignment WITHOUT domination (Hungarian algorithm), scores
         * only: remaining starter slots (score) + substitutes (λ·score) +
         * reserves (λᵣ·score), players outside `used`. Upper bound of the
         * score part; also the bench optimum when it respects domination.
         */
        const assign = (used: Set<number>, starterSlots: number[]) => {
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
                return (row.kind === "s" ? 1 : row.kind === "b" ? lambda : lambdaR) * sp.score;
            }));
            const { total, colOf } = maxAssignment(value, cols.length);
            const at = (kind: "b" | "r", j: number): ScoredPlayer | null => {
                const r = rows.findIndex((row) => row.kind === kind && row.idx === j);
                const c = colOf[r];
                return c >= 0 ? roleScore.get(subSlotDefs[j].role)!.get(cols[c])! : null;
            };
            return { total, at };
        };

        /**
         * Optimal reserves for fixed starters + substitutes: per role, every
         * reserve ≤ every substitute (empty substitute slot = 0 ⇒ no reserve).
         */
        const reservesFor = (inUse: Set<number>, B: Lineup) => {
            const thr = new Map<RoleName, number>();
            subSlotDefs.forEach((d, j) =>
                thr.set(d.role, Math.min(thr.get(d.role) ?? Infinity, B[j]?.score ?? 0)));
            const cols: number[] = [];
            for (let p = 0; p < nP; p++) if (!inUse.has(p)) cols.push(p);
            const value = subSlotDefs.map((d) => cols.map((p) => {
                const sp = roleScore.get(d.role)?.get(p);
                return sp && sp.score <= thr.get(d.role)! ? lambdaR * sp.score : null;
            }));
            const { total, colOf } = maxAssignment(value, cols.length);
            const reserves = subSlotDefs.map((d, j) =>
                colOf[j] >= 0 ? roleScore.get(d.role)!.get(cols[colOf[j]])! : null);
            return { total, reserves };
        };

        const slotsPerRole = new Map<RoleName, number>();
        for (const d of subSlotDefs) slotsPerRole.set(d.role, (slotsPerRole.get(d.role) ?? 0) + 1);
        /**
         * Bench part of F for starters S: λ·Σ substitutes + reserves + bench
         * chemistry. `floor`: if even an upper bound of the reserves cannot
         * beat it, the exact reserves are skipped (value = that bound,
         * reserves = null).
         */
        const benchValue = (S: Lineup, usedS: Set<number>, B: Lineup, floor = -Infinity) => {
            const inUse = new Set(usedS);
            let subs = 0;
            const thr = new Map<RoleName, number>();
            B.forEach((sp, j) => {
                const role = subSlotDefs[j].role;
                thr.set(role, Math.min(thr.get(role) ?? Infinity, sp?.score ?? 0));
                if (sp) { inUse.add(idxOf(sp)); subs += lambda * sp.score; }
            });
            const partial = subs + benchChem(S, B);
            if (floor > -Infinity) {
                // Reserves bound: per role, its n best free players not above the
                // weakest substitute (uniqueness across roles relaxed).
                let ub = partial;
                for (const [role, n] of slotsPerRole) {
                    const t = thr.get(role)!;
                    let left = n;
                    for (const sp of pools[role] ?? []) {   // sorted by score desc
                        if (left === 0) break;
                        if (sp.score > t || inUse.has(idxOf(sp))) continue;
                        ub += lambdaR * sp.score; left--;
                    }
                }
                if (ub <= floor) return { value: ub, reserves: null };
            }
            const r = reservesFor(inUse, B);
            return { value: partial + r.total, reserves: r.reserves };
        };

        /**
         * Local search over the substitutes (best improvement). Moves:
         * replace one substitute by a free player of the role; swap two
         * substitutes' assignments (which substitute for which starter);
         * move a substitute to a slot of another role (multi-role player) and
         * refill theirs with a free player. Only MAXIMAL benches are kept (an empty slot has no free
         * eligible player): a slot that can be filled is never emptied.
         */
        const improveBench = (S: Lineup, usedS: Set<number>, B0: Lineup) => {
            const nB = subSlotDefs.length;
            const eligible = (j: number, sp: ScoredPlayer) => roleScore.get(subSlotDefs[j].role)?.get(idxOf(sp));
            const freeFor = (j: number, inB: Set<number>) =>
                (pools[subSlotDefs[j].role] ?? []).filter((sp) => !usedS.has(idxOf(sp)) && !inB.has(idxOf(sp)));
            const maximal = (C: Lineup) => {
                if (C.every(Boolean)) return true;
                const inC = new Set(C.filter(Boolean).map((sp) => idxOf(sp!)));
                return C.every((sp, j) => sp || freeFor(j, inC).length === 0);
            };
            let B = [...B0];
            let cur = benchValue(S, usedS, B);
            for (;;) {
                let bestB: Lineup | null = null;
                let bestV = cur.value + 1e-9;
                let bestR = cur;
                const inB = new Set(B.filter(Boolean).map((sp) => idxOf(sp!)));
                const tryB = (C: Lineup) => {
                    if (!maximal(C)) return;
                    const v = benchValue(S, usedS, C, bestV);
                    if (v.reserves && v.value > bestV) { bestV = v.value; bestB = C; bestR = v; }
                };
                for (let j = 0; j < nB; j++) {
                    for (const sp of freeFor(j, inB)) { const C = [...B]; C[j] = sp; tryB(C); }
                }
                for (let j = 0; j < nB; j++) {
                    for (let k = 0; k < nB; k++) {
                        if (j === k || !B[k]) continue;
                        const toJ = eligible(j, B[k]!);
                        if (!toJ) continue;
                        // Swap (or move into an empty slot).
                        if (j < k || !B[j]) {
                            const toK = B[j] ? eligible(k, B[j]!) : null;
                            if (!B[j] || toK) { const C = [...B]; C[j] = toJ; C[k] = toK ?? null; tryB(C); }
                        }
                        // Move B[k] to a slot of ANOTHER role and refill slot k with a
                        // free player (same role = a swap followed by a replacement).
                        if (subSlotDefs[j].role === subSlotDefs[k].role) continue;
                        const inC = new Set(inB);
                        if (B[j]) inC.delete(idxOf(B[j]!));
                        for (const sp of freeFor(k, inC)) {
                            const C = [...B]; C[j] = toJ; C[k] = eligible(k, sp)!; tryB(C);
                        }
                    }
                }
                if (!bestB) break;
                B = bestB; cur = bestR;
            }
            return { subs: B, reserves: cur.reserves!, value: cur.value };
        };

        // ── Chemistry bound ──────────────────────────────────────────────────
        // Each slot not fixed (or open: substitutable in this state) takes,
        // independently for each relation, the best of the signs still
        // available in its pool (player uniqueness relaxed ⇒ always valid).
        const cand = starterDefs.map((d) => pools[d.role] ?? []);
        const candIdx = cand.map((pool) => pool.map((sp) => ({ p: idxOf(sp), k: signIndex(sp.player.sign) })));
        /** Distinct sign indices of the still-available candidates of each slot. */
        const availSigns = (used: Set<number>): number[][] => candIdx.map((pool) => {
            const seen: number[] = [];
            for (const { p, k } of pool) if (!used.has(p) && !seen.includes(k)) seen.push(k);
            return seen;
        });
        const maxAff = new Int8Array(nS * 13);
        const T = new Int32Array(nS);
        /**
         * Chemistry bound for one state. `avail` = availSigns(used); `open`:
         * slots that may hold their substitute (starter sign or any
         * available sign).
         */
        const chemBound = (S: Lineup, fixed: boolean[], avail: number[][], open?: boolean[]): number => {
            const isFixed = (i: number) => fixed[i] && !open?.[i];
            const sets: number[][] = starterDefs.map((_, i) => {
                const own = S[i] ? signIndex(S[i]!.player.sign) : -1;
                if (isFixed(i)) return own >= 0 ? [own] : [];
                if (fixed[i] && own >= 0 && !avail[i].includes(own)) return [own, ...avail[i]];
                return avail[i];
            });
            // Few free slots: exact enumeration of sign combinations.
            const free = starterDefs.map((_, i) => i).filter((i) => !isFixed(i) && sets[i].length > 0);
            if (free.length <= 2) {
                let bestU = -Infinity;
                for (let i = 0; i < nS; i++) T[i] = S[i] ? signIndex(S[i]!.player.sign) : -1;
                const rec = (k: number) => {
                    if (k === free.length) { bestU = Math.max(bestU, chemOfSigs(T)); return; }
                    for (const sign of sets[free[k]]) { T[free[k]] = sign; rec(k + 1); }
                    // An unfixed slot may also end up empty (its candidates taken elsewhere).
                    T[free[k]] = -1; rec(k + 1);
                };
                rec(0);
                return bestU;
            }
            const present = court.filter((i) => sets[i].length > 0);
            for (const o of present) {
                for (let k = 0; k < 13; k++) {
                    let mx = -128;
                    for (const l of sets[o]) { const v = AFFINITY[k * 13 + l]; if (v > mx) mx = v; }
                    maxAff[o * 13 + k] = mx;
                }
            }
            let value = 0;
            let setter = -1;
            for (const i of present) if (crole[i] === "setter") setter = i;
            // Best chemistry of each slot, and bound of its activation term
            // (0 if active, −sign bonus if inactive), per possible sign.
            const chemUbOf = (m: number): [number, number] => {
                let bestC = -Infinity;
                let act = isFixed(m) ? -Infinity : 0;
                for (const k of sets[m]) {
                    if (k === NO_SIGN) { act = Math.max(act, 0); continue; }
                    let c = 0;
                    for (const o of present) if (o !== m) c += maxAff[o * 13 + k];
                    if (c > bestC) bestC = c;
                    const pts = starterPts[m * 13 + k];
                    act = Math.max(act, c >= SIGN_ACTIVATION_THRESHOLD ? Math.max(0, -pts) : -pts);
                }
                return [bestC, act];
            };
            const setterUb = setter >= 0 ? chemUbOf(setter)[0] : -Infinity;
            for (const m of present) {
                if (crole[m] === "setter") continue;
                const [c, act] = chemUbOf(m);
                value += act;
                if (crole[m] === "hitter" && setter >= 0 && setterUb + c >= SETTER_SYNERGY_THRESHOLD) value += connPts;
            }
            return value;
        };
        /**
         * Bound of mean_k C(S_k): state k differs from the starters only on
         * the k first slots of the order ⇒ C(S_k) ≤ bound with those open.
         */
        const statesBound = (S: Lineup, fixed: boolean[], avail: number[][]): number =>
            prefixOpen.reduce((s, open) => s + chemBound(S, fixed, avail, open), 0) / prefixOpen.length;
        /** Bound of C(S) + bench chemistry = (1 − λ)·C(S) + λ·mean_k C(S_k). */
        const chemTermBound = (S: Lineup, fixed: boolean[], used: Set<number>): number => {
            const avail = availSigns(used);
            const b0 = chemBound(S, fixed, avail);
            return subOrder.length ? (1 - lambda) * b0 + lambda * statesBound(S, fixed, avail) : b0;
        };

        // ── Evaluation of a complete starter set ─────────────────────────────
        // Order constraints applied first (Front OH ≥ Back OH, Back MB ≥
        // Front MB): the substitution order is per slot, so the bench is
        // chosen for the final slot assignment.
        const canon = (S0: Lineup): Lineup => {
            const S = [...S0];
            for (const { higher, lower } of orderConstraints) {
                const hi = slotIdx.get(higher), lo = slotIdx.get(lower);
                if (hi === undefined || lo === undefined || !S[hi] || !S[lo]) continue;
                if (S[hi]!.score < S[lo]!.score) [S[hi], S[lo]] = [S[lo], S[hi]];
            }
            return S;
        };
        let best: ModelSolution = base;
        let bestTotal = -Infinity;
        let bestS: Lineup = base.starters;
        const scoreSum = (S: Lineup) => S.reduce((s, sp) => s + (sp?.score ?? 0), 0);
        const usedOf = (S: Lineup) => new Set(S.filter(Boolean).map((sp) => idxOf(sp!)));
        const allFixed = new Array<boolean>(nS).fill(true);
        const consider = (S0: Lineup): void => {
            const S = canon(S0);
            const usedS = usedOf(S);
            const c0 = starterChem(S);
            const starterPart = scoreSum(S) + c0;
            const a = assign(usedS, []);
            const chemUb = subOrder.length ? lambda * (statesBound(S, allFixed, availSigns(usedS)) - c0) : 0;
            if (starterPart + a.total + chemUb <= bestTotal + 1e-9) return;
            // Exact score-only bench (substitute ≥ reserve domination), then local search.
            let subs = subSlotDefs.map((_, j) => a.at("b", j));
            const reserves = subSlotDefs.map((_, j) => a.at("r", j));
            const dominated = subSlotDefs.every((dj, j) => subSlotDefs.every((dk, k) =>
                dj.role !== dk.role || (subs[j]?.score ?? 0) >= (reserves[k]?.score ?? 0)));
            if (!dominated) subs = this.solveBench(subSlotDefs, pools, S, () => 0).subs;
            const sol = improveBench(S, usedS, subs);
            const total = starterPart + sol.value;
            if (total > bestTotal + 1e-9) {
                bestTotal = total;
                bestS = S;
                best = {
                    starters: S, subs: sol.subs, reserves: sol.reserves,
                    objective: scoreSum(S) + sol.value,
                };
            }
        };

        // ── Incumbent: base + local search (speeds up pruning) ───────────────
        consider(base.starters);
        for (const S of this.localSearch(starterDefs, pools, base.starters,
                (S) => scoreSum(S) + starterChem(S))) {
            consider(S);
        }

        // ── Branch & bound over the starters ─────────────────────────────────
        // Symmetry: slots of the same role (2 OH, 2 MB) are interchangeable
        // (consider() reorders them by the order constraints) → increasing indices.
        const prevSameRole = starterDefs.map((d, i) =>
            starterDefs.findIndex((e, k) => k < i && e.role === d.role));

        const S: Lineup = new Array(nS).fill(null);
        const fixed: boolean[] = new Array(nS).fill(false);
        const pick: number[] = new Array(nS).fill(-1);
        const used = new Set<number>();
        const assignBound = (fromSlot: number): number =>
            assign(used, Array.from({ length: nS - fromSlot }, (_, k) => fromSlot + k)).total;

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
            const rest = restAssign + chemTermBound(S, fixed, used);
            let any = false;
            for (let c = start; c < cand[i].length; c++) {
                const sp = cand[i][c];
                const p = idxOf(sp);
                if (used.has(p)) continue;
                any = true;
                if (partial + sp.score + rest <= bestTotal + 1e-9) break;
                used.add(p); S[i] = sp; pick[i] = c; fixed[i] = true;
                // Chemistry bound (c fixed) first with the assignment without removing
                // c (≥ the true one, cheap), then the exact assignment.
                const syn = chemTermBound(S, fixed, used);
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
        return { best, synergyValue: starterChem(bestS) };
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
     * per-slot bonus (substitutes; 0 here: score-only starting bench of the
     * chemistry local search) + λᵣ·score (reserves);
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
