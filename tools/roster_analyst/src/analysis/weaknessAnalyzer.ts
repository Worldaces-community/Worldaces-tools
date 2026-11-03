/**
 * Team weakness analysis
 * Identifies weak points and generates recruitment targets
 */

import { Player, ScoredPlayer, RoleName, Params } from "../types";
import { ALL_TRAITS, COMPOSITE_STATS } from "../config";

export interface RoleWeakness {
    role: RoleName;
    label: string;
    /** Normalized score (0-99) of the role's weakest starter. */
    topScore: number;
    /** Name of the role's weakest starter (THEY are the weak spot). */
    topPlayer: string;
    topNormalized: number;
    gapFromIdeal: number;
    /** Priority stats to improve, sorted by role weight × gap. */
    keyWeakStats: string[];
}

export interface WeaknessAnalysis {
    roleWeaknesses: RoleWeakness[];
    /** Traits missing from the lineup (0 starters). */
    missingTraits: string[];
    /** Traits held by a single starter (fragile coverage). */
    weakTraits: string[];
    /** Solidly covered traits (>= 2 starters). */
    presentTraits: string[];
}

/**
 * Analyze team weaknesses across all roles and stats.
 *
 * For each role we look at the WEAKEST STARTER (the weak link,
 * not the best player) and the stats that, weighted by the role's weights,
 * leave the biggest gap.
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
        // Weighted: an exploitable weakness = a stat that is both important for the
        // role (high weight) AND weak (low value) → weakness = weight × (99 - val).
        // Composite stats (uppercase) are excluded so as not to duplicate their
        // sub-stats (e.g. serve + SERVE), as are zero-weight stats (irrelevant).
        const compositeSet = new Set(COMPOSITE_STATS);
        const statContribs = Object.entries(config.statsWeights)
            .filter(([stat, weight]) => weight > 0 && !compositeSet.has(stat))
            .map(([stat, weight]) => {
                const val = (starter.player as unknown as Record<string, number>)[stat] ?? 0;
                return { stat, val, weakness: weight * (99 - val) };
            });
        statContribs.sort((a, b) => b.weakness - a.weakness); // biggest weighted weakness first

        // starter.score is already normalized per role (0-99, see scorePlayer).
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

    // Trait coverage analysis: count holders per trait in the lineup.
    const traitCount = (t: string) => starterPlayers.filter((p) => p.traits.includes(t)).length;
    const missingTraits = ALL_TRAITS.filter((t) => traitCount(t) === 0);
    const weakTraits = ALL_TRAITS.filter((t) => traitCount(t) === 1); // a single holder
    const presentTraits = ALL_TRAITS.filter((t) => traitCount(t) >= 2); // solidly covered

    return {
        roleWeaknesses,
        missingTraits,
        weakTraits,
        presentTraits,
    };
}
