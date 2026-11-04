/**
 * Scoring engine for players based on role configurations
 */

import { Player, ScoredPlayer, RoleConfig, RoleName } from "../types";
import { getRoleFilter } from "../utils";
import {
    ALL_STATS,
    EXCLUSIVE_STAT_PAIRS,
} from "../config/constants";
import { SETTINGS } from "../config/settings";
import { idealScore, REDUNDANT_TRAIT_GROUPS } from "../config/roleConfig";

/**
 * The 18 lowercase attributes = the only basis for computing the score.
 * UPPERCASE keys (ATTACK, SETTING, …) are a deterministic aggregation of
 * their lowercase sub-stats: weighting them as well would be double counting.
 */
const LOWERCASE_STATS = new Set(ALL_STATS);

/** Avoids spamming the same uppercase-weight warning for every player. */
const warnedUppercaseWeights = new Set<string>();

/** Value of a sub-stat (keys with a space go through the index signature). */
function statOf(player: Player, stat: string): number {
    return (player as unknown as Record<string, number>)[stat] ?? 0;
}

/**
 * Applies the exclusive pairs (EXCLUSIVE_STAT_PAIRS) to a set of weights:
 * when both stats of a pair are weighted, only the one with the highest
 * VALUE for the player is kept — the player blocks with their best
 * style and attacks at the tempo that suits them, the other stat does not apply.
 * On a tie, the pair's first stat wins. Mutates in place.
 */
function applyExclusivePairs(weights: Record<string, number>, player: Player): void {
    for (const [a, b] of EXCLUSIVE_STAT_PAIRS) {
        if ((weights[a] ?? 0) > 0 && (weights[b] ?? 0) > 0) {
            delete weights[statOf(player, a) >= statOf(player, b) ? b : a];
        }
    }
}

// ─── Scoring ──────────────────────────────────────────────────────────────────
/**
 * Weighted power mean: Σ(w·stat^p)^(1/p). p=1 → classic weighted
 * mean (current behavior). p<1 → concave, penalizes low stats
 * more than it rewards high stats → favors balanced profiles.
 */
function weightedPowerMean(
    entries: [string, number][],
    player: Player,
    p: number
): number {
    const weightSum = entries.reduce((a, [, w]) => a + w, 0) || 1;
    if (p === 1) {
        return entries.reduce((a, [s, w]) => a + statOf(player, s) * (w / weightSum), 0);
    }
    const acc = entries.reduce(
        (a, [s, w]) => a + (w / weightSum) * Math.pow(Math.max(statOf(player, s), 0), p),
        0
    );
    return Math.pow(acc, 1 / p);
}

/**
 * Scoring core: stats part (18 lowercase attributes, normalized weights) and
 * traits part (role bonuses, redundancies removed).
 */
function computeRawScores(
    player: Player,
    config: RoleConfig
): { statScore: number; traitScore: number; signScore: number } {
    let statScore = 0;

    // The score is computed ONLY from the 18 lowercase attributes. Any
    // UPPERCASE keys in statsWeights are ignored (double counting).
    const lowerEntries = Object.entries(config.statsWeights).filter(
        ([stat]) => LOWERCASE_STATS.has(stat)
    );

    // Safety net: reports (once) a non-zero uppercase weight left in the params.
    for (const [stat, w] of Object.entries(config.statsWeights)) {
        if (!LOWERCASE_STATS.has(stat) && w > 0 && !warnedUppercaseWeights.has(stat)) {
            warnedUppercaseWeights.add(stat);
            console.warn(
                `⚠️  statsWeights["${stat}"]=${w} ignored: the score only uses the lowercase ` +
                `sub-stats (the "${stat}" composite is already covered by its sub-stats).`
            );
        }
    }

    // Exclusive pairs (read/commit block, power/quick): only the stat with the
    // highest value for the player keeps its weight.
    const weights: Record<string, number> = Object.fromEntries(lowerEntries);
    applyExclusivePairs(weights, player);

    // Normalize weights at compute time so params.json can use any scale
    const kept = Object.entries(weights);
    statScore = weightedPowerMean(kept, player, SETTINGS.balanceExponent);

    let traitScore = 0;
    // Redundant traits (same action, e.g. the two serves): only the
    // best bonus present is kept, the others are dropped (see REDUNDANT_TRAIT_GROUPS).
    const suppressed = new Set<string>();
    for (const group of REDUNDANT_TRAIT_GROUPS) {
        const owned = group.filter((t) => player.traits.includes(t));
        if (owned.length > 1) {
            const best = owned.reduce((a, b) =>
                (config.traitBonuses[b] ?? 0) > (config.traitBonuses[a] ?? 0) ? b : a);
            for (const t of owned) if (t !== best) suppressed.add(t);
        }
    }
    for (const [trait, bonus] of Object.entries(config.traitBonuses)) {
        if (!player.traits.includes(trait)) continue;
        if (suppressed.has(trait)) continue;
        traitScore += bonus;
    }

    // Sign: light bonus = value of the sign effect for the role (setter: 0,
    // they do not trigger a sign effect), assumed active here. Its ACTIVATION
    // (chemistry ≥ 3) depends on teammates → the lineup builder removes it
    // (`signScore`) when the effect is inactive.
    const signScore = player.sign ? (config.signBonuses?.[player.sign] ?? 0) : 0;

    return { statScore, traitScore, signScore };
}

/**
 * Score a player for a specific role configuration.
 *
 * Pure CURRENT score: stats + traits + sign, normalized across roles. Neither rarity nor
 * progress term (removed at the user's request): the score
 * reflects today's performance.
 *
 * @param player  Player to score
 * @param config  Role configuration (stat weights + trait bonuses)
 */
export function scorePlayer(
    player: Player,
    config: RoleConfig
): ScoredPlayer {
    const { statScore, traitScore, signScore } = computeRawScores(player, config);
    const rawTotal = statScore + traitScore + signScore;

    // Cross-role normalization: rescale the score by the role's ceiling
    // so the rating caps at ~99 whatever the role → ratings
    // become comparable across roles. Linear rescale per role:
    // intra-role order and MILP domination are preserved.
    const ideal           = idealScore(config) || 1;
    const normalizedScore = (rawTotal / ideal) * 99;

    return {
        player,
        score: normalizedScore,
        statScore: (statScore / ideal) * 99,
        traitScore: (traitScore / ideal) * 99,
        signScore: (signScore / ideal) * 99,
        connectionScore: ((config.connectionBonus ?? 0) / ideal) * 99,
    };
}

/**
 * Rank all players for a specific role.
 * Filters players by role eligibility and scores them.
 */
export function rankForRole(
    players: Player[],
    config:  RoleConfig,
    role:    RoleName
): ScoredPlayer[] {
    return players
        .filter(getRoleFilter(role))
        .map((p) => scorePlayer(p, config))
        .sort((a, b) => b.score - a.score);
}
