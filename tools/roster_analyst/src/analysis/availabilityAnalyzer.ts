/**
 * Player availability for the lineup (Academy + progress).
 *
 *   - Position "Academy": never available for the lineup (see academyAnalyzer
 *     for the recommended moves in / out).
 *   - Progress "Considering retirement": no longer improving → excluded without
 *     exception (playing them takes game time from improving youngsters)
 *     and released first.
 *   - Progress "Starting to decline": excluded UNLESS exceptional, i.e.
 *     if they raise the value of the 7 starters of the 5-1 (sum of scores +
 *     sign synergy) by at least
 *     DECLINE_EXCEPTIONAL_MIN_GAIN over the best lineup without them
 *     ("Improving" alternatives included, cascade effects included via the MILP).
 *     Not exceptional ⇒ released first.
 */

import { Player, Params, RoleName, ScoredPlayer } from "../types";
import { rankForRole } from "../scoring/scorer";
import { LineupBuilder } from "../lineup/lineupBuilder";
import { ACADEMY_POSITION } from "../config/constants";
import { SETTINGS } from "../config/settings";

/** Per-role rankings of a subset of players. */
export function rankAll(players: Player[], params: Params): Record<RoleName, ScoredPlayer[]> {
    const out = {} as Record<RoleName, ScoredPlayer[]>;
    for (const role of Object.keys(params.roles) as RoleName[]) {
        out[role] = rankForRole(players, params.roles[role], role);
    }
    return out;
}

/**
 * Value of the starters of the optimal 5-1 built from `players`: sum of
 * their scores + value of the sign synergy (score points).
 */
function starterTotal(players: Player[], params: Params): number {
    const res = new LineupBuilder(rankAll(players, params)).buildFiveOneLineup();
    return Object.values(res.lineup).reduce((s, sp) => s + (sp?.score ?? 0), 0) + res.synergyValue;
}

export const isAcademy = (p: Player): boolean => p.position === ACADEMY_POSITION;

export interface DecliningEval {
    player: Player;
    /** Gain on the sum of the 7 starters' scores if they are available. */
    gain:   number;
    /** true ⇒ exceptional: stays available for the lineup and the roster. */
    kept:   boolean;
}

export interface AvailabilityResult {
    /** Players available for the lineup (Academy excluded, Improving + exceptional decliners). */
    pool:      Player[];
    /** Players in the Academy (unavailable for the lineup). */
    academy:   Player[];
    /** "Starting to decline" players (Academy excluded), by decreasing gain. */
    declining: DecliningEval[];
    /** "Considering retirement" players (Academy excluded). */
    retiring:  Player[];
}

function splitActive(players: Player[]) {
    const active = players.filter((p) => !isAcademy(p));
    return {
        academy:   players.filter(isAcademy),
        improving: active.filter((p) => p.progress === "Improving"),
        retiring:  active.filter((p) => p.progress === "Considering retirement"),
        decliners: active.filter((p) => p.progress === "Starting to decline"),
    };
}

/**
 * Players of the lineups that `analyzeAvailability` optimizes ("Improving" base,
 * then base + each decliner): independent, computable in parallel.
 */
export function availabilityLineupPools(players: Player[]): Player[][] {
    const { improving, decliners } = splitActive(players);
    return [
        ...(improving.length > 0 ? [improving] : []),
        ...decliners.map((player) => [...improving, player]),
    ];
}

export function analyzeAvailability(players: Player[], params: Params): AvailabilityResult {
    const { academy, improving, retiring, decliners } = splitActive(players);

    // Each decliner is evaluated alone against the "Improving" base.
    const base = improving.length > 0 ? starterTotal(improving, params) : 0;
    const declining: DecliningEval[] = decliners
        .map((player) => {
            const gain = starterTotal([...improving, player], params) - base;
            return { player, gain, kept: gain >= SETTINGS.availability.declineExceptionalMinGain };
        })
        .sort((a, b) => b.gain - a.gain);

    const pool = [...improving, ...declining.filter((d) => d.kept).map((d) => d.player)];
    return { pool, academy, declining, retiring };
}
