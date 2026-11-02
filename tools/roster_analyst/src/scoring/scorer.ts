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
 * Les 18 attributs minuscules = seule base de calcul du score.
 * Les clés MAJUSCULES (ATTACK, SETTING, …) sont une agrégation déterministe de
 * leurs sous-stats minuscules : les pondérer en plus serait du double comptage.
 */
const LOWERCASE_STATS = new Set(ALL_STATS);

/** Évite de spammer le même avertissement de poids majuscule à chaque joueur. */
const warnedUppercaseWeights = new Set<string>();

/** Valeur d'une sous-stat (les clés à espace passent par l'index signature). */
function statOf(player: Player, stat: string): number {
    return (player as unknown as Record<string, number>)[stat] ?? 0;
}

/**
 * Applique les paires exclusives (EXCLUSIVE_STAT_PAIRS) à un jeu de poids :
 * quand les deux stats d'une paire sont pondérées, seule celle de plus forte
 * VALEUR chez le joueur est conservée — le joueur bloque avec son meilleur
 * style et attaque au tempo qui lui convient, l'autre stat ne joue pas.
 * À égalité, la première stat de la paire gagne. Mutation en place.
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
 * Moyenne de puissance pondérée : Σ(w·stat^p)^(1/p). p=1 → moyenne pondérée
 * classique (comportement actuel). p<1 → concave, pénalise les stats basses
 * plus qu'elle ne récompense les stats hautes → favorise les profils équilibrés.
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
 * Cœur du scoring : part stats (18 attributs minuscules, poids normalisés) et
 * part traits (bonus du rôle, redondances supprimées).
 */
function computeRawScores(
    player: Player,
    config: RoleConfig
): { statScore: number; traitScore: number; signScore: number } {
    let statScore = 0;

    // Le score se calcule UNIQUEMENT sur les 18 attributs minuscules. Les cl\u00E9s
    // MAJUSCULES \u00E9ventuelles dans statsWeights sont ignor\u00E9es (double comptage).
    const lowerEntries = Object.entries(config.statsWeights).filter(
        ([stat]) => LOWERCASE_STATS.has(stat)
    );

    // Garde-fou : signale (une fois) un poids majuscule non nul rest\u00E9 dans les params.
    for (const [stat, w] of Object.entries(config.statsWeights)) {
        if (!LOWERCASE_STATS.has(stat) && w > 0 && !warnedUppercaseWeights.has(stat)) {
            warnedUppercaseWeights.add(stat);
            console.warn(
                `\u26A0\uFE0F  statsWeights["${stat}"]=${w} ignor\u00E9 : le score ne prend que les ` +
                `attributs minuscules (le composite "${stat}" est d\u00E9j\u00E0 couvert par ses sous-stats).`
            );
        }
    }

    // Paires exclusives (read/commit block, power/quick) : seule la stat de plus
    // forte valeur chez le joueur garde son poids.
    const weights: Record<string, number> = Object.fromEntries(lowerEntries);
    applyExclusivePairs(weights, player);

    // Normalize weights at compute time so params.json can use any scale
    const kept = Object.entries(weights);
    statScore = weightedPowerMean(kept, player, SETTINGS.balanceExponent);

    let traitScore = 0;
    // Traits redondants (même action, ex. les deux services) : on ne garde que le
    // meilleur bonus présent, on supprime les autres (cf. REDUNDANT_TRAIT_GROUPS).
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

    // Signe : bonus léger = valeur de l'effet du signe pour le rôle (setter : 0,
    // il n'active pas d'effet de signe). Son ACTIVATION (chimie ≥ 3) dépend des
    // coéquipiers → gérée par le MILP du 5-1, pas ici.
    const signScore = player.sign ? (config.signBonuses?.[player.sign] ?? 0) : 0;

    return { statScore, traitScore, signScore };
}

/**
 * Score a player for a specific role configuration.
 *
 * Score COURANT pur : stats + traits + signe, normalisé cross-rôle. Ni rareté ni
 * terme de progression (retirés à la demande de l'utilisateur) : le score
 * reflète la performance du jour.
 *
 * @param player  Joueur à scorer
 * @param config  Configuration du rôle (poids stats + bonus traits)
 */
export function scorePlayer(
    player: Player,
    config: RoleConfig
): ScoredPlayer {
    const { statScore, traitScore, signScore } = computeRawScores(player, config);
    const rawTotal = statScore + traitScore + signScore;

    // Normalisation cross-rôle : on rescale le score par le plafond du rôle
    // pour que la note plafonne à ~99 quel que soit le rôle → les notes
    // deviennent comparables entre rôles. Rescale linéaire par rôle :
    // l'ordre intra-rôle et la domination du MILP sont préservés.
    const ideal           = idealScore(config) || 1;
    const normalizedScore = (rawTotal / ideal) * 99;

    return { player, score: normalizedScore };
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
