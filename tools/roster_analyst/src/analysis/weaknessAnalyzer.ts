/**
 * Team weakness analysis
 * Identifies weak points and generates recruitment targets
 */

import { Player, ScoredPlayer, RoleName, Params } from "../types";
import { ALL_TRAITS, COMPOSITE_STATS } from "../config";

export interface RoleWeakness {
    role: RoleName;
    label: string;
    /** Score normalisé (0-99) du titulaire le plus faible du rôle. */
    topScore: number;
    /** Nom du titulaire le plus faible du rôle (c'est LUI le point faible). */
    topPlayer: string;
    topNormalized: number;
    gapFromIdeal: number;
    /** Stats prioritaires à améliorer, triées par poids du rôle × manque. */
    keyWeakStats: string[];
}

export interface WeaknessAnalysis {
    roleWeaknesses: RoleWeakness[];
    /** Traits absents de la lineup (0 starter). */
    missingTraits: string[];
    /** Traits portés par un seul starter (couverture fragile). */
    weakTraits: string[];
    /** Traits solidement couverts (>= 2 starters). */
    presentTraits: string[];
}

/**
 * Analyze team weaknesses across all roles and stats.
 *
 * Pour chaque rôle on regarde le TITULAIRE LE PLUS FAIBLE (le maillon faible,
 * pas le meilleur joueur) et les stats qui, pondérées par les poids du rôle,
 * laissent le plus gros manque.
 */
export function analyzeWeaknesses(
    starterPlayers: Player[],
    allRankings: Record<RoleName, ScoredPlayer[]>,
    lineup: Record<string, ScoredPlayer | null>,
    params: Params,
    roleLabels: Record<RoleName, string>
): WeaknessAnalysis {
    // Role-level weakness analysis
    const roleWeaknesses: RoleWeakness[] = [];

    const starterSlotsByRole: Record<RoleName, string[]> = {
        setter: ["Setter"],
        libero: ["Libero"],
        outsideHitter: ["Front Outside Hitter", "Back Outside Hitter"],
        middleBlocker: ["Front Middle Blocker", "Back Middle Blocker"],
        oppositeHitter: ["Opposite"],
    };

    function starterEntriesForRole(role: RoleName): ScoredPlayer[] {
        return (starterSlotsByRole[role] || [])
            .map((slot) => lineup[slot])
            .filter((entry): entry is ScoredPlayer => !!entry);
    }

    const realRoles = Object.keys(params.roles) as RoleName[];

    for (const roleName of realRoles) {
        const config = params.roles[roleName];
        const starters = starterEntriesForRole(roleName);
        const ranked = allRankings[roleName];

        // Skip if no players available for this role
        if (starters.length === 0 && (ranked.length === 0 || !ranked[0])) {
            continue;
        }

        // Find the weakest starter for this role
        const starter = starters.length
            ? starters.reduce(
                (worst, candidate) => (candidate.score < worst.score ? candidate : worst),
                starters[0]
            )
            : ranked[0];

        // Find the weakest contributing stats for this role's chosen starter.
        // Pondéré : une faiblesse exploitable = stat à la fois importante pour le
        // rôle (poids élevé) ET faible (valeur basse) → weakness = poids × (99 - val).
        // On exclut les stats composites (majuscules) pour ne pas dupliquer leurs
        // sous-stats (ex. serve + SERVE), et les stats de poids nul (non pertinentes).
        const compositeSet = new Set(COMPOSITE_STATS);
        const statContribs = Object.entries(config.statsWeights)
            .filter(([stat, weight]) => weight > 0 && !compositeSet.has(stat))
            .map(([stat, weight]) => {
                const val = (starter.player as unknown as Record<string, number>)[stat] ?? 0;
                return { stat, val, weakness: weight * (99 - val) };
            });
        statContribs.sort((a, b) => b.weakness - a.weakness); // plus grosse faiblesse pondérée d'abord

        // starter.score est déjà normalisé par rôle (0-99, cf. scorePlayer).
        const topNormalized = Math.min(100, starter.score);
        const gapFromIdeal = Math.max(0, 100 - topNormalized);

        roleWeaknesses.push({
            role: roleName,
            label: roleLabels[roleName],
            topScore: starter.score,
            topPlayer: starter.player.fullName,
            topNormalized,
            gapFromIdeal,
            keyWeakStats: statContribs.slice(0, 3).map((x) => `${x.stat} (${x.val})`),
        });
    }

    roleWeaknesses.sort((a, b) => b.gapFromIdeal - a.gapFromIdeal);

    // Trait coverage analysis : on compte les porteurs par trait dans la lineup.
    const traitCount = (t: string) => starterPlayers.filter((p) => p.traits.includes(t)).length;
    const missingTraits = ALL_TRAITS.filter((t) => traitCount(t) === 0);
    const weakTraits = ALL_TRAITS.filter((t) => traitCount(t) === 1); // un seul porteur
    const presentTraits = ALL_TRAITS.filter((t) => traitCount(t) >= 2); // solidement couvert

    return {
        roleWeaknesses,
        missingTraits,
        weakTraits,
        presentTraits,
    };
}
