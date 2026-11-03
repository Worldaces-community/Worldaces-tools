/**
 * Academy moves (in / out).
 *
 * User rules:
 *   - eligible for the Academy ⇔ age ≤ ACADEMY_MAX_AGE (20);
 *   - a player must LEAVE the Academy if they are good enough for the roster,
 *     i.e. starter OR substitute (bench) of the 5-1; an injury reserve
 *     is not "good enough";
 *   - an Academy player older than 20 must leave in any case.
 *
 * Method: rebuild the 5-1 (MILP) from the available players + the
 * Academy players still eligible (≤ 20), thereby ignoring the
 * youngsters' current position. Any youngster ≤ 20 who is a starter / sub in
 * this hypothetical lineup belongs on the roster (leaves the Academy if
 * there); any youngster ≤ 20 outside starters / bench (reserves included)
 * would be better off in the Academy.
 */

import { Player, Params, ScoredPlayer } from "../types";
import { LineupBuilder, Substitute } from "../lineup/lineupBuilder";
import { SETTINGS } from "../config/settings";
import { rankAll, isAcademy } from "./availabilityAnalyzer";

export interface AcademyMove {
    player: Player;
    /** Slot obtained in the hypothetical lineup ("Setter", "Sub Front OH"…), null otherwise. */
    slot:   string | null;
    score:  number | null;
    /** Current holder of this slot in the recommended lineup (5-1 section). */
    displaces: string | null;
    reason: string;
}

export interface AcademyAnalysis {
    /** Players to bring out of the Academy. */
    out:   AcademyMove[];
    /** Players to send to the Academy. */
    in:    AcademyMove[];
    /** Players staying in the Academy (best score across all roles). */
    stay:  AcademyMove[];
}

function bestScore(p: Player, rankings: ReturnType<typeof rankAll>): number | null {
    let best: number | null = null;
    for (const list of Object.values(rankings)) {
        const sp = list.find((s) => s.player.fullName === p.fullName);
        if (sp && (best === null || sp.score > best)) best = sp.score;
    }
    return best;
}

/** Players of the hypothetical lineup: available + still-eligible Academy. */
export function academyLineupPlayers(pool: Player[], academy: Player[]): Player[] {
    return [...pool, ...academy.filter((p) => p.age <= SETTINGS.academy.maxAge)];
}

/**
 * @param pool        players available for the lineup (Academy excluded)
 * @param academy     players currently in the Academy
 * @param lineup      starters of the recommended lineup (5-1 section)
 * @param subs        substitutes of the recommended lineup (getFiveOneSubSlots order)
 */
export function analyzeAcademy(
    pool: Player[],
    academy: Player[],
    params: Params,
    lineup: Record<string, ScoredPlayer | null>,
    subs: Substitute[]
): AcademyAnalysis {
    const ACADEMY_MAX_AGE = SETTINGS.academy.maxAge;
    const rankings = rankAll(academyLineupPlayers(pool, academy), params);
    // Display scores: the whole Academy (including > 20, outside the hypothetical lineup).
    const displayRankings = rankAll([...pool, ...academy], params);

    const builder = new LineupBuilder(rankings);
    const hypo = builder.buildFiveOneLineup();
    const subSlots = LineupBuilder.getFiveOneSubSlots();
    const hypoSubs = builder.getSubstitutes(hypo.lineup, subSlots);

    // Name → slot held in the hypothetical lineup (starters + bench).
    const slotOf = new Map<string, { slot: string; score: number; displaces: string | null }>();
    for (const [slot, sp] of Object.entries(hypo.lineup)) {
        if (sp) slotOf.set(sp.player.fullName, {
            slot, score: sp.score, displaces: lineup[slot]?.player.fullName ?? null,
        });
    }
    hypoSubs.forEach((s, i) => {
        if (s.sub) slotOf.set(s.sub.player.fullName, {
            slot: s.label, score: s.sub.score, displaces: subs[i]?.sub?.player.fullName ?? null,
        });
    });

    const move = (player: Player, reason: string): AcademyMove => {
        const hit = slotOf.get(player.fullName);
        return {
            player,
            slot:      hit?.slot ?? null,
            score:     hit?.score ?? bestScore(player, displayRankings),
            displaces: hit && hit.displaces !== player.fullName ? hit.displaces : null,
            reason,
        };
    };

    const out: AcademyMove[] = [];
    const stay: AcademyMove[] = [];
    for (const p of academy) {
        if (p.age > ACADEMY_MAX_AGE) {
            out.push(move(p, `age ${p.age} > ${ACADEMY_MAX_AGE}: no longer eligible`));
        } else if (slotOf.has(p.fullName)) {
            out.push(move(p, "good enough for the roster"));
        } else {
            stay.push(move(p, "not a starter / sub yet"));
        }
    }

    const inMoves: AcademyMove[] = pool
        .filter((p) => !isAcademy(p) && p.age <= ACADEMY_MAX_AGE && !slotOf.has(p.fullName))
        .map((p) => move(p, "not a starter / sub: will progress at the Academy"));

    const byScore = (a: AcademyMove, b: AcademyMove) => (b.score ?? 0) - (a.score ?? 0);
    return { out: out.sort(byScore), in: inMoves.sort(byScore), stay: stay.sort(byScore) };
}
