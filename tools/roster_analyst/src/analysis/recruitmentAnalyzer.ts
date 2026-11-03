/**
 * Recruitment analysis
 * Identifies priority roles and traits for recruitment
 */

import { solve } from "yalps";
import { Player, RoleName, ScoredPlayer, Params } from "../types";
import { ALL_TRAITS, SETTINGS } from "../config";
import { REDUNDANT_TRAIT_GROUPS, idealScore } from "../config/roleConfig";
import { ALL_SIGNS, SIGN_SYNERGY_MAX_WIN_GAIN } from "../config/signs";
import { lineupUnits, UNITS_PER_PHASE } from "../lineup/signChemistry";
import { Sign } from "../types";
import { analyzeWeaknesses } from "./weaknessAnalyzer";
import { SubSlot, Substitute } from "../lineup";

/** Sigles courts par rôle pour les ventilations compactes (OH+7 · SET+3 …). */
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
    /** Score normalisé (0-99) du titulaire le plus faible du rôle. */
    worstStarterScore: number;
    /** Chute de niveau titulaire → meilleur remplaçant disponible (points normalisés). */
    benchDelta: number;
    /** Joueurs éligibles manquants pour aligner titulaires + 1 remplaçant. */
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
    /** Apport estimé (points de score) cumulé sur les 3 rôles ciblés. */
    urgency: number;
    reason: string;
}

export interface RecruitmentAnalysis {
    top3Roles: RoleUrgency[];
    top3Traits: TraitUrgency[];
    /** Vide si le CSV n'a pas de signes. */
    top3Signs: SignUrgency[];
}

/**
 * Priorité de recrutement par rôle (règle utilisateur) :
 *   recruter en priorité les rôles qui cumulent le MOINS BON SCORE NORMALISÉ
 *   du titulaire et le PLUS GROS GAP SUR LE BANC (chute titulaire → remplaçant).
 *
 *   urgence = manque d'effectifs × 1e6            (override absolu : sans assez
 *                                                   de joueurs éligibles, rien
 *                                                   d'autre ne compte)
 *           + (100 − score normalisé du titulaire le plus faible)
 *           + delta de banc
 *
 * Les traits recommandés sont ensuite ceux qui apportent le plus (somme des
 * traitBonuses) aux 3 rôles retenus, atténués s'ils sont déjà couverts dans la
 * lineup (recruter un trait déjà présent 2× n'apporte presque rien).
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

    // Delta de banc par rôle = pire chute titulaire → meilleur remplaçant libre.
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

    // Nombre de joueurs titulaires requis par rôle dans le 5-1. On veut au moins
    // (titulaires + 1 remplaçant) de joueurs éligibles : en dessous, manque
    // d'effectifs (shortage) = priorité absolue.
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
            const need = (starterReq[rw.role] ?? 1) + 1; // titulaires + 1 remplaçant
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
 * 3 signes à recruter : pour chaque signe et chaque rôle ciblé, on remplace
 * le titulaire le plus faible du rôle par une recrue de même score portant ce
 * signe, et on cumule
 *   - le bonus de signe du rôle (normalisé 0-99, cf. scorer) ;
 *   - la variation de synergie des titulaires (unités de chimie gagnées /
 *     perdues × valeur d'une unité : synergie parfaite = 10 % de la somme des
 *     scores des titulaires, comme dans le MILP du 5-1).
 */
export function selectSigns(
    lineup: Record<string, ScoredPlayer | null>,
    focusRoles: RoleName[],
    params: Params
): SignUrgency[] {
    if (!Object.values(lineup).some((sp) => sp?.player.sign)) return [];

    const starterSum = Object.values(lineup).reduce((s, sp) => s + (sp?.score ?? 0), 0);
    const unitValue = (SIGN_SYNERGY_MAX_WIN_GAIN * starterSum) / UNITS_PER_PHASE;
    const baseUnits = lineupUnits(lineup);

    // Slot visé par rôle : titulaire le plus faible (slot vide en priorité).
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
 * Sélection JOINTE des 3 traits à recruter (MILP, yalps) : on choisit le TRIO
 * qui maximise l'apport cumulé aux 3 rôles ciblés, pas les 3 meilleurs traits
 * pris un par un. La différence : les traits redondants (même action, cf.
 * REDUNDANT_TRAIT_GROUPS — ex. Meteor Serve / Float Serve) ne s'additionnent
 * pas chez un même joueur ; un tri individuel peut donc retenir deux traits
 * dont les apports se recouvrent, alors que le MILP paie ce recouvrement et
 * préfère un trio complémentaire.
 *
 * Modèle :
 *   max  Σ_t eff(t)·x_t − Σ_(a,b) redondants  overlap(a,b)·y_ab
 *   s.c. Σ_t x_t = 3 ;  x_a + x_b − y_ab ≤ 1 ;  x, y binaires
 * où eff(t) = Σ_rôles bonus(rôle,t) × facteur de couverture (un trait déjà
 * porté ≥ 2× dans la lineup rapporte moins), et overlap(a,b) = Σ_rôles
 * min(apport de a, apport de b) — la part perdue si un recruté porte les deux.
 */
export function selectTraitTrio(
    starterPlayers: Player[],
    focusRoles: RoleName[],
    params: Params,
    starterRoleByName: Map<string, RoleName> = new Map()
): TraitUrgency[] {
    // Un trait déjà bien pourvu (>= 2 porteurs dans la lineup) doit avoir un
    // bénéfice nettement supérieur pour rester prioritaire face à un absent.
    const coverFactor = (c: number) => (c === 0 ? 1.0 : c === 1 ? 0.9 : 0.6);

    interface TraitInfo {
        trait: string;
        focusBenefit: number;                       // somme brute des bonus
        perRoleEff: Partial<Record<RoleName, number>>; // bonus atténué par rôle
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

    // MILP : x_t binaire par trait, exactement 3 sélectionnés.
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

    // Pénalité de redondance : si deux traits d'un même groupe sont pris
    // ensemble, un recruté qui porte les deux n'en cumule pas les effets →
    // on retire le recouvrement (Σ_rôles min des apports atténués).
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
        // Fallback (ne devrait pas arriver) : top 3 individuel.
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
