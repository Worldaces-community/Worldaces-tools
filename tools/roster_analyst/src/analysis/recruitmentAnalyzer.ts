/**
 * Recruitment analysis
 * Identifies priority roles and traits for recruitment
 */

import { solve } from "yalps";
import { Player, RoleName, ScoredPlayer, Params } from "../types";
import { ALL_TRAITS, SETTINGS } from "../config";
import { REDUNDANT_TRAIT_GROUPS, idealScore } from "../config/roleConfig";
import { ALL_SIGNS } from "../config/signs";
import { lineupUnits, perfectSynergyWinGain, UNITS_PER_PHASE } from "../lineup/signChemistry";
import { Sign } from "../types";
import { analyzeWeaknesses } from "./weaknessAnalyzer";
import { SubSlot, Substitute } from "../lineup";

/** Short role abbreviations for compact breakdowns (OH+7 · SET+3 …). */
export const ROLE_SIGLES: Record<RoleName, string> = {
    setter: "SET",
    outsideHitter: "OH",
    middleBlocker: "MB",
    oppositeHitter: "OP",
    libero: "LIB",
};

export interface RoleUrgency {
    role: RoleName;
    label: string;
    urgency: number;
    /** Normalized score (0-99) of the role's weakest starter. */
    worstStarterScore: number;
    /** Level drop starter → best available substitute (normalized points). */
    benchDelta: number;
    /** Eligible players missing to field starters + 1 substitute. */
    shortage: number;
    reason: string;
}

const SLOT_ROLE_MAP: Record<string, RoleName> = {
    "Setter": "setter",
    "Libero": "libero",
    "Front Outside Hitter": "outsideHitter",
    "Back Outside Hitter": "outsideHitter",
    "Front Middle Blocker": "middleBlocker",
    "Back Middle Blocker": "middleBlocker",
    "Opposite": "oppositeHitter",
};

export interface TraitUrgency {
    trait: string;
    urgency: number;
    reason: string;
}

export interface SignUrgency {
    sign: Sign;
    /** Estimated contribution (score points) summed over the 3 targeted roles. */
    urgency: number;
    reason: string;
}

export interface RecruitmentAnalysis {
    top3Roles: RoleUrgency[];
    top3Traits: TraitUrgency[];
    /** Empty if the CSV has no signs. */
    top3Signs: SignUrgency[];
}

/**
 * Recruitment priority per role (user rule):
 *   recruit first the roles that combine the WORST NORMALIZED SCORE
 *   of the starter and the BIGGEST BENCH GAP (drop starter → substitute).
 *
 *   urgency = headcount shortage × 1e6           (absolute override: without
 *                                                   enough eligible players,
 *                                                   nothing else matters)
 *           + (100 − normalized score of the weakest starter)
 *           + bench delta
 *
 * The recommended traits are then those that contribute most (sum of
 * traitBonuses) to the 3 selected roles, damped if already covered in the
 * lineup (recruiting a trait already present 2× adds almost nothing).
 */
export function analyzeRecruitment(
    starterPlayers: Player[],
    allRankings: Record<RoleName, ScoredPlayer[]>,
    lineup: Record<string, ScoredPlayer | null>,
    substitutes: Substitute[],
    subSlots: SubSlot[], 
    params: Params,
    roleLabels: Record<RoleName, string>
): RecruitmentAnalysis {

    // Bench delta per role = worst drop starter → best free substitute.
    const benchDeltaByRole: Partial<Record<RoleName, number>> = {};
    subSlots.forEach((slotDef, i) => {
        const sub = substitutes[i];
        if (!sub?.sub) return;
        const starterScore = lineup[slotDef.replacesSlot]?.score ?? 0;
        const depthDelta = Math.max(0, starterScore - sub.sub.score);
        benchDeltaByRole[slotDef.role] = Math.max(benchDeltaByRole[slotDef.role] ?? 0, depthDelta);
    });

    const weaknessAnalysis = analyzeWeaknesses(
        starterPlayers,
        allRankings,
        lineup,
        params,
        roleLabels
    );

    // Number of starters required per role in the 5-1. We want at least
    // (starters + 1 substitute) eligible players: below that, headcount
    // shortage = absolute priority.
    const starterReq: Partial<Record<RoleName, number>> = {
        setter: 1,
        libero: 1,
        outsideHitter: 2,
        middleBlocker: 2,
        oppositeHitter: 1,
    };

    const roleUrgencies: RoleUrgency[] = weaknessAnalysis.roleWeaknesses
        .map((rw) => {
            const benchDelta = benchDeltaByRole[rw.role] ?? 0;
            const eligibleCount = (allRankings[rw.role] || []).length;
            const need = (starterReq[rw.role] ?? 1) + 1; // starters + 1 substitute
            const shortage = Math.max(0, need - eligibleCount);
            const worstStarterScore = rw.topScore;

            const urgency =
                shortage * 1_000_000 + (100 - Math.min(100, worstStarterScore)) + benchDelta;

            const reasons: string[] = [];
            if (shortage > 0) reasons.push(`short of ${shortage} eligible player(s)`);
            reasons.push(`weakest starter at ${worstStarterScore.toFixed(0)}/100`);
            if (benchDelta > 0) reasons.push(`bench at −${benchDelta.toFixed(0)}`);

            return {
                role: rw.role,
                label: rw.label,
                urgency,
                worstStarterScore,
                benchDelta,
                shortage,
                reason: reasons.join(", "),
            };
        });
    roleUrgencies.sort((a, b) => b.urgency - a.urgency);

    const top3Roles = roleUrgencies.slice(0, 3);
    const focusRoles = top3Roles.map((r) => r.role);

    const starterRoleByName = new Map<string, RoleName>();
    for (const [slot, sp] of Object.entries(lineup)) {
        const role = SLOT_ROLE_MAP[slot];
        if (role && sp) {
            starterRoleByName.set(sp.player.fullName, role);
        }
    }

    const top3Traits = selectTraitTrio(starterPlayers, focusRoles, params, starterRoleByName);

    const top3Signs = selectSigns(lineup, focusRoles, params);

    return { top3Roles, top3Traits, top3Signs };
}

/**
 * 3 signs to recruit: for each sign and each targeted role, replace
 * the role's weakest starter with a recruit of the same score carrying this
 * sign, and sum
 *   - the role's sign bonus (normalized 0-99, see scorer);
 *   - the change in starters' synergy (chemistry units gained /
 *     lost × value of one unit: perfect synergy = perfectSynergyWinPct % of the sum of the
 *     starters' scores, as in the 5-1 MILP).
 */
export function selectSigns(
    lineup: Record<string, ScoredPlayer | null>,
    focusRoles: RoleName[],
    params: Params
): SignUrgency[] {
    if (!Object.values(lineup).some((sp) => sp?.player.sign)) return [];

    const starterSum = Object.values(lineup).reduce((s, sp) => s + (sp?.score ?? 0), 0);
    const unitValue = (perfectSynergyWinGain() * starterSum) / UNITS_PER_PHASE;
    const baseUnits = lineupUnits(lineup);

    // Targeted slot per role: the weakest starter (empty slot first).
    const targetSlot = new Map<RoleName, string>();
    for (const role of focusRoles) {
        const slots = Object.entries(SLOT_ROLE_MAP).filter(([, r]) => r === role).map(([slot]) => slot);
        slots.sort((a, b) => (lineup[a]?.score ?? -1) - (lineup[b]?.score ?? -1));
        if (slots.length) targetSlot.set(role, slots[0]);
    }

    const out: SignUrgency[] = ALL_SIGNS.map((sign) => {
        let urgency = 0;
        const parts: string[] = [];
        for (const role of focusRoles) {
            const slot = targetSlot.get(role);
            if (!slot) continue;
            const config = params.roles[role];
            const bonus = config.signBonuses?.[sign] ?? 0;
            const bonusPts = (bonus / (idealScore(config) || 1)) * 99;
            const cur = lineup[slot];
            const recruit: ScoredPlayer = {
                player: { ...(cur?.player ?? ({} as Player)), sign, fullName: "__recruit__" },
                score: cur?.score ?? 0,
            };
            const dUnits = lineupUnits({ ...lineup, [slot]: recruit }) - baseUnits;
            urgency += bonusPts + dUnits * unitValue;
            const bits: string[] = [];
            if (bonus) bits.push(`bonus +${bonus}`);
            if (dUnits) bits.push(`chemistry ${dUnits > 0 ? "+" : ""}${dUnits.toFixed(1)}`);
            if (bits.length) parts.push(`${ROLE_SIGLES[role]} ${bits.join(", ")}`);
        }
        return {
            sign,
            urgency,
            reason: parts.join(" · ") || "neutral",
        };
    });

    return out.sort((a, b) => b.urgency - a.urgency).slice(0, 3);
}

/**
 * JOINT selection of the 3 traits to recruit (MILP, yalps): we pick the TRIO
 * that maximizes the summed contribution to the 3 targeted roles, not the 3 best traits
 * taken one by one. The difference: redundant traits (same action, see
 * REDUNDANT_TRAIT_GROUPS — e.g. Meteor Serve / Float Serve) do not stack
 * on the same player; an individual sort may thus keep two traits
 * whose contributions overlap, whereas the MILP pays for that overlap and
 * prefers a complementary trio.
 *
 * Model:
 *   max  Σ_t eff(t)·x_t − Σ_(a,b) redundant  overlap(a,b)·y_ab
 *   s.t. Σ_t x_t = 3 ;  x_a + x_b − y_ab ≤ 1 ;  x, y binary
 * where eff(t) = Σ_roles bonus(role,t) × coverage factor (a trait already
 * held ≥ 2× in the lineup is worth less), and overlap(a,b) = Σ_roles
 * min(contribution of a, contribution of b) — the share lost if one recruit carries both.
 */
export function selectTraitTrio(
    starterPlayers: Player[],
    focusRoles: RoleName[],
    params: Params,
    starterRoleByName: Map<string, RoleName> = new Map()
): TraitUrgency[] {
    // A trait already well covered (>= 2 holders in the lineup) must have a
    // clearly higher benefit to stay ahead of a missing one.
    const coverFactor = (c: number) => (c === 0 ? 1.0 : c === 1 ? 0.9 : 0.6);

    interface TraitInfo {
        trait: string;
        focusBenefit: number;                       // raw sum of bonuses
        perRoleEff: Partial<Record<RoleName, number>>; // damped bonus per role
        effective: number;                          // Σ perRoleEff
        reason: string;
        isBanned?: boolean;
    }

    const infos = new Map<string, TraitInfo>();
    for (const trait of ALL_TRAITS) {
        const starterCount = starterPlayers.filter((p) => p.traits.includes(trait)).length;
        const { singletonTraits, singletonTraitPositions, singletonPriorityBonus } = SETTINGS.recruitment;
        const isSingleton = singletonTraits.includes(trait);
        const restrictedPositions = singletonTraitPositions[trait];
        const singletonCount = restrictedPositions
            ? starterPlayers.filter((p) => {
                  if (!p.traits.includes(trait)) return false;
                  const assignedRole = starterRoleByName.get(p.fullName);
                  return assignedRole !== undefined && restrictedPositions.includes(assignedRole);
              }).length
            : starterCount;

        const isBanned = isSingleton && singletonCount >= 1;
        const cf = isBanned ? 0 : coverFactor(starterCount);
        const singletonBoost = isSingleton && singletonCount === 0 ? singletonPriorityBonus : 1;
        let focusBenefit = 0;
        let effective = 0;
        const perRoleEff: Partial<Record<RoleName, number>> = {};
        const perRole: string[] = [];
        for (const role of focusRoles) {
            const bonus = params.roles[role].traitBonuses[trait] ?? 0;
            focusBenefit += bonus;
            const eff = bonus * cf * singletonBoost;
            perRoleEff[role] = eff;
            effective += eff;
            if (bonus > 0) perRole.push(`${ROLE_SIGLES[role]}+${Math.round(bonus * 10) / 10}`);
        }
        const coverNote = isBanned
            ? "already in the lineup (single-carrier trait) — excluded"
            : starterCount === 0
            ? isSingleton ? "missing — recruitment priority (single-carrier trait)" : "missing from the lineup"
            : starterCount === 1 ? "only 1 carrier"
            : "already covered";
        infos.set(trait, {
            trait, focusBenefit, perRoleEff, effective, isBanned,
            reason: `${perRole.join(" · ") || "no bonus"} — ${coverNote}`,
        });
    }

    // MILP: binary x_t per trait, exactly 3 selected.
    const vars: Record<string, Record<string, number>> = {};
    const cons: Record<string, { equal?: number; max?: number }> = {
        picks: { equal: 3 },
    };
    for (const trait of ALL_TRAITS) {
        const info = infos.get(trait)!;
        vars[`x_${trait}`] = { obj: info.effective, picks: 1 };
        if (info.isBanned) {
            cons[`ban_${trait}`] = { max: 0 };
            vars[`x_${trait}`][`ban_${trait}`] = 1;
        }
    }

    // Redundancy penalty: if two traits of the same group are picked
    // together, a recruit carrying both does not stack their effects →
    // subtract the overlap (Σ_roles min of the damped contributions).
    for (const group of REDUNDANT_TRAIT_GROUPS) {
        for (let i = 0; i < group.length; i++) {
            for (let j = i + 1; j < group.length; j++) {
                const a = infos.get(group[i]);
                const b = infos.get(group[j]);
                 if (!a || !b || a.isBanned || b.isBanned) continue;
                let overlap = 0;
                for (const role of focusRoles) {
                    overlap += Math.min(a.perRoleEff[role] ?? 0, b.perRoleEff[role] ?? 0);
                }
                if (overlap <= 0) continue;
                const cname = `red_${i}_${j}_${group[i]}`;
                cons[cname] = { max: 1 };                       // x_a + x_b − y ≤ 1
                vars[`x_${group[i]}`][cname] = 1;
                vars[`x_${group[j]}`][cname] = 1;
                vars[`y_${cname}`] = { obj: -overlap, [cname]: -1 };
            }
        }
    }

    const sol = solve({
        direction: "maximize",
        objective: "obj",
        constraints: cons,
        variables: vars,
        binaries: true,
    });

    let selected: string[];
    if (sol.status === "optimal") {
        selected = ALL_TRAITS.filter((t) =>
            (new Map(sol.variables).get(`x_${t}`) ?? 0) > 0.5
        );
    } else {
        // Fallback (should not happen): individual top 3.
        selected = [...infos.values()]
            .filter((t) => !t.isBanned)
            .sort((a, b) => b.effective - a.effective)
            .slice(0, 3)
            .map((t) => t.trait);
    }

    return selected
        .map((t) => infos.get(t)!)
        .filter((t) => t.focusBenefit > 0)
        .sort((a, b) => b.effective - a.effective)
        .map(({ trait, focusBenefit, reason }) => ({ trait, urgency: focusBenefit, reason }));
}
