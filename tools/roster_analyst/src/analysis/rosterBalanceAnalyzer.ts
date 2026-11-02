/**
 * Roster balance analysis
 *
 * Sélectionne le meilleur groupe de ROSTER_TARGET joueurs à garder via un MILP
 * à quotas souples (au plus N joueurs par rôle, cf. settings.roster), puis liste les joueurs non
 * retenus comme candidats à la vente.
 *
 * Quotas SOUPLES, pas stricts : si un rôle manque d'éligibles (ex. 2 seuls
 * libéros pour 4 slots), le MILP reste faisable — les slots vacants sont
 * réattribués aux meilleurs joueurs restants, tous rôles confondus (« flex »),
 * pour que la liste à vendre soit toujours produite. Les pénuries par rôle
 * sont remontées dans `shortfalls` pour affichage.
 *
 * Joueurs non-progressants (`forced`) : libérés EN PRIORITÉ, hors MILP — les
 * « Considering retirement » et les « Starting to decline » non exceptionnels
 * (cf. availabilityAnalyzer). Ils sont listés en tête, même si le roster ne
 * dépasse pas ROSTER_TARGET ; le MILP ne départage ensuite que les autres.
 */

import { solve } from "yalps";
import { Player, RoleName, ScoredPlayer, Params } from "../types";
import { rankForRole } from "../scoring/scorer";

import { SETTINGS } from "../config/settings";

/** Taille de roster visée (réglage `settings.roster.target`). */
export const rosterTarget = (): number => SETTINGS.roster.target;

/** Quota max par rôle (réglage `settings.roster.targetCounts`). */
export const targetCounts = (): Record<RoleName, number> => SETTINGS.roster.targetCounts;

const ALL_ROLES: RoleName[] = [
    "outsideHitter", "middleBlocker", "setter", "oppositeHitter", "libero",
];

/**
 * Bonus par joueur gardé dans l'objectif du MILP. Très supérieur au score max
 * (~120) pour que le solveur maximise D'ABORD le nombre de joueurs gardés,
 * ENSUITE la somme des scores (sinon il pourrait sacrifier un slot pour
 * affecter un joueur bi-rôle à son meilleur rôle).
 */
const KEEP_BONUS = 1000;

export interface SellCandidate {
    player:    Player;
    bestScore: number;   // meilleur score sur tous ses rôles éligibles (pour tri)
    bestRole:  RoleName | null;
    /** Motif de libération prioritaire (non-progressant) ; absent pour une vente « quota ». */
    reason?:   string;
}

/** Joueur à libérer en priorité, quel que soit son score. */
export interface ForcedSale {
    player: Player;
    reason: string;
}

/** Rôle dont le quota cible n'a pas pu être rempli. */
export interface RoleShortfall {
    role:     RoleName;
    kept:     number;   // joueurs effectivement gardés sur ce rôle
    target:   number;   // quota cible
    eligible: number;   // joueurs éligibles au rôle dans le roster
}

export interface RosterBalanceResult {
    totalPlayers:   number;
    toSell:         number;
    /** Libérations prioritaires (non-progressants) puis ventes quota (bestScore croissant). */
    sellCandidates: SellCandidate[];
    /** Nombre de libérations prioritaires (en tête de sellCandidates). */
    forcedCount:    number;
    /** Rôles en pénurie (quota non rempli). Vide si la composition cible est atteinte. */
    shortfalls:     RoleShortfall[];
    /** Joueurs gardés hors quota (slots des rôles en pénurie réattribués). */
    flexKeeps:      SellCandidate[];
    /** true si la composition cible est entièrement respectée. */
    feasible:       boolean;
}

/** Meilleur score / rôle d'un joueur sur tous ses rôles éligibles. */
function bestOfAllRoles(
    player: Player,
    allRankings: Record<RoleName, ScoredPlayer[]>
): { bestScore: number; bestRole: RoleName | null } {
    let bestScore = -Infinity;
    let bestRole: RoleName | null = null;
    for (const role of ALL_ROLES) {
        const sp = allRankings[role].find(s => s.player.fullName === player.fullName);
        if (sp && sp.score > bestScore) { bestScore = sp.score; bestRole = role; }
    }
    return { bestScore: bestScore === -Infinity ? 0 : bestScore, bestRole };
}

/**
 * Sélectionne les meilleurs joueurs à garder (quotas de rôle souples + slots
 * flex si pénurie) et retourne la liste des joueurs non retenus (à vendre).
 */
export function analyzeRosterBalance(
    allPlayers: Player[],
    params: Params,
    forced: ForcedSale[] = []
): RosterBalanceResult {
    const forcedNames = new Set(forced.map((f) => f.player.fullName));
    const players = allPlayers.filter((p) => !forcedNames.has(p.fullName));

    // Scores par rôle (même scoring que les rankings du rapport) — sur tout le
    // roster, pour afficher aussi le meilleur rôle des libérations prioritaires.
    const allRankings: Record<RoleName, ScoredPlayer[]> = {} as Record<RoleName, ScoredPlayer[]>;
    for (const role of ALL_ROLES) {
        allRankings[role] = rankForRole(players, params.roles[role], role);
    }
    const fullRankings: Record<RoleName, ScoredPlayer[]> = {} as Record<RoleName, ScoredPlayer[]>;
    for (const role of ALL_ROLES) {
        fullRankings[role] = rankForRole(allPlayers, params.roles[role], role);
    }
    const forcedSales: SellCandidate[] = forced.map((f) => ({
        player: f.player, reason: f.reason, ...bestOfAllRoles(f.player, fullRankings),
    }));

    // ── MILP : affectation joueur → rôle sous quotas max ─────────────────────
    //   - chaque joueur : au plus 1 rôle
    //   - chaque rôle : au plus TARGET_COUNTS[role] joueurs
    //   - objectif : KEEP_BONUS·(nb gardés) + Σ scores
    // Contraintes toutes en `max` → toujours faisable, même en pénurie.
    const vars: Record<string, Record<string, number>> = {};
    const cons: Record<string, { max: number }> = {};
    const varMeta = new Map<string, { name: string; role: RoleName }>();

    for (const role of ALL_ROLES) {
        cons[`role_${role}`] = { max: targetCounts()[role] ?? 0 };
        for (const sp of allRankings[role]) {
            const nm = sp.player.fullName;
            if (!cons[`pl_${nm}`]) cons[`pl_${nm}`] = { max: 1 };
            const varName = `x_${nm}_${role}`;
            varMeta.set(varName, { name: nm, role });
            vars[varName] = {
                obj:             KEEP_BONUS + sp.score,
                [`role_${role}`]: 1,
                [`pl_${nm}`]:     1,
            };
        }
    }

    const sol = solve({
        direction:   "maximize",
        objective:   "obj",
        constraints: cons,
        variables:   vars,
        binaries:    true,
    });

    // Joueurs gardés par le MILP + comptage par rôle
    const keptNames = new Set<string>();
    const keptByRole: Record<RoleName, number> = {
        outsideHitter: 0, middleBlocker: 0, setter: 0,
        oppositeHitter: 0, libero: 0,
    };
    if (sol.status === "optimal") {
        for (const [varName, value] of sol.variables) {
            if (value < 0.5) continue;
            const meta = varMeta.get(varName);
            if (!meta) continue;
            keptNames.add(meta.name);
            keptByRole[meta.role]++;
        }
    }

    // Pénuries : rôles dont le quota n'est pas rempli
    // (sans objet si tout le monde est gardé : aucune vente « quota »)
    const quotaApplies = players.length > rosterTarget();
    const shortfalls: RoleShortfall[] = ALL_ROLES
        .filter(role => quotaApplies && keptByRole[role] < (targetCounts()[role] ?? 0))
        .map(role => ({
            role,
            kept:     keptByRole[role],
            target:   targetCounts()[role] ?? 0,
            eligible: allRankings[role].length,
        }));

    // ── Slots flex : compléter jusqu'à la cible avec les meilleurs restants ──
    const targetKeep = Math.min(rosterTarget(), players.length);
    const leftovers: SellCandidate[] = players
        .filter(p => !keptNames.has(p.fullName))
        .map(player => ({ player, ...bestOfAllRoles(player, allRankings) }))
        .sort((a, b) => b.bestScore - a.bestScore);

    const flexKeeps = leftovers.slice(0, Math.max(0, targetKeep - keptNames.size));
    const quotaSales = leftovers
        .slice(flexKeeps.length)
        .sort((a, b) => a.bestScore - b.bestScore);
    const sellCandidates = [...forcedSales, ...quotaSales];

    return {
        totalPlayers: allPlayers.length,
        toSell:       sellCandidates.length,
        sellCandidates,
        forcedCount:  forcedSales.length,
        shortfalls,
        flexKeeps,
        feasible:     shortfalls.length === 0,
    };
}
