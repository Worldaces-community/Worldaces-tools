/**
 * Roster balance analysis
 *
 * Selects the best group of ROSTER_TARGET players to keep via a MILP
 * with soft quotas (at most N players per role, see settings.roster), then lists the players not
 * kept as sell candidates.
 *
 * SOFT quotas, not strict: if a role lacks eligible players (e.g. only 2
 * liberos for 4 slots), the MILP stays feasible — vacant slots are
 * reassigned to the best remaining players, all roles combined ("flex"),
 * so the sell list is always produced. Per-role shortages
 * are reported in `shortfalls` for display.
 *
 * Non-improving players (`forced`): released FIRST, outside the MILP — the
 * "Considering retirement" and non-exceptional "Starting to decline" players
 * (see availabilityAnalyzer). They are listed first, even if the roster does not
 * exceed ROSTER_TARGET; the MILP then only decides among the others.
 */

import { solve } from "yalps";
import { Player, RoleName, ScoredPlayer, Params } from "../types";
import { rankForRole } from "../scoring/scorer";

import { SETTINGS } from "../config/settings";

/** Target roster size (setting `settings.roster.target`). */
export const rosterTarget = (): number => SETTINGS.roster.target;

/** Max quota per role (setting `settings.roster.targetCounts`). */
export const targetCounts = (): Record<RoleName, number> => SETTINGS.roster.targetCounts;

const ALL_ROLES: RoleName[] = [
    "outsideHitter", "middleBlocker", "setter", "oppositeHitter", "libero",
];

/**
 * Bonus per kept player in the MILP objective. Far above the max score
 * (~120) so the solver maximizes FIRST the number of kept players,
 * THEN the sum of scores (otherwise it could sacrifice a slot to
 * assign a dual-role player to their best role).
 */
const KEEP_BONUS = 1000;

export interface SellCandidate {
    player:    Player;
    bestScore: number;   // best score across all their eligible roles (for sorting)
    bestRole:  RoleName | null;
    /** Reason for priority release (non-improving); absent for a "quota" sale. */
    reason?:   string;
}

/** Player to release first, whatever their score. */
export interface ForcedSale {
    player: Player;
    reason: string;
}

/** Role whose target quota could not be filled. */
export interface RoleShortfall {
    role:     RoleName;
    kept:     number;   // players actually kept in this role
    target:   number;   // target quota
    eligible: number;   // players eligible for the role in the roster
}

export interface RosterBalanceResult {
    totalPlayers:   number;
    toSell:         number;
    /** Priority releases (non-improving) then quota sales (ascending bestScore). */
    sellCandidates: SellCandidate[];
    /** Number of priority releases (at the head of sellCandidates). */
    forcedCount:    number;
    /** Roles in shortage (quota not filled). Empty if the target composition is met. */
    shortfalls:     RoleShortfall[];
    /** Players kept outside quotas (reassigned slots of roles in shortage). */
    flexKeeps:      SellCandidate[];
    /** true if the target composition is fully met. */
    feasible:       boolean;
}

/** Best score / role of a player across all their eligible roles. */
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
 * Selects the best players to keep (soft role quotas + flex slots
 * on shortage) and returns the list of players not kept (to sell).
 */
export function analyzeRosterBalance(
    allPlayers: Player[],
    params: Params,
    forced: ForcedSale[] = []
): RosterBalanceResult {
    const forcedNames = new Set(forced.map((f) => f.player.fullName));
    const players = allPlayers.filter((p) => !forcedNames.has(p.fullName));

    // Per-role scores (same scoring as the report rankings) — over the whole
    // roster, to also display the best role of priority releases.
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

    // ── MILP: player → role assignment under max quotas ─────────────────────
    //   - each player: at most 1 role
    //   - each role: at most TARGET_COUNTS[role] players
    //   - objective: KEEP_BONUS·(nb kept) + Σ scores
    // All constraints are `max` → always feasible, even on shortage.
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

    // Players kept by the MILP + count per role
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

    // Shortages: roles whose quota is not filled
    // (not applicable if everyone is kept: no "quota" sale)
    const quotaApplies = players.length > rosterTarget();
    const shortfalls: RoleShortfall[] = ALL_ROLES
        .filter(role => quotaApplies && keptByRole[role] < (targetCounts()[role] ?? 0))
        .map(role => ({
            role,
            kept:     keptByRole[role],
            target:   targetCounts()[role] ?? 0,
            eligible: allRankings[role].length,
        }));

    // ── Flex slots: fill up to the target with the best remaining ───────────
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
