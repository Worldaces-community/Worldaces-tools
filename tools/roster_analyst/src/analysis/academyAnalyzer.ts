/**
 * Mouvements Academy (entrées / sorties).
 *
 * Règles utilisateur :
 *   - éligible à l'Academy ⇔ âge ≤ ACADEMY_MAX_AGE (20 ans) ;
 *   - un joueur doit SORTIR de l'Academy s'il est assez bon pour le roster,
 *     c.-à-d. titulaire OU remplaçant (banc) du 5-1 ; un réserviste blessure
 *     n'est pas « assez bon » ;
 *   - un joueur de l'Academy de plus de 20 ans doit sortir dans tous les cas.
 *
 * Méthode : on reconstruit le 5-1 (MILP) sur les joueurs disponibles + les
 * joueurs de l'Academy encore éligibles (≤ 20 ans), en ignorant donc la
 * position actuelle des jeunes. Tout jeune ≤ 20 ans titulaire / remplaçant de
 * cette lineup hypothétique a sa place dans le roster (sortie d'Academy s'il y
 * est) ; tout jeune ≤ 20 ans hors titulaires / banc (y compris réserviste)
 * gagnerait à aller à l'Academy.
 */

import { Player, Params, ScoredPlayer } from "../types";
import { LineupBuilder, Substitute } from "../lineup/lineupBuilder";
import { SETTINGS } from "../config/settings";
import { rankAll, isAcademy } from "./availabilityAnalyzer";

export interface AcademyMove {
    player: Player;
    /** Slot obtenu dans la lineup hypothétique (« Setter », « Sub Front OH »…), null sinon. */
    slot:   string | null;
    score:  number | null;
    /** Occupant actuel de ce slot dans la lineup recommandée (section 5-1). */
    displaces: string | null;
    reason: string;
}

export interface AcademyAnalysis {
    /** Joueurs à faire sortir de l'Academy. */
    out:   AcademyMove[];
    /** Joueurs à envoyer à l'Academy. */
    in:    AcademyMove[];
    /** Joueurs qui restent à l'Academy (meilleur score tous rôles). */
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

/**
 * @param pool        joueurs disponibles pour la lineup (hors Academy)
 * @param academy     joueurs actuellement à l'Academy
 * @param lineup      titulaires de la lineup recommandée (section 5-1)
 * @param subs        remplaçants de la lineup recommandée (ordre getFiveOneSubSlots)
 */
export function analyzeAcademy(
    pool: Player[],
    academy: Player[],
    params: Params,
    lineup: Record<string, ScoredPlayer | null>,
    subs: Substitute[]
): AcademyAnalysis {
    const ACADEMY_MAX_AGE = SETTINGS.academy.maxAge;
    const eligibleAcademy = academy.filter((p) => p.age <= ACADEMY_MAX_AGE);
    const rankings = rankAll([...pool, ...eligibleAcademy], params);
    // Scores d'affichage : tout l'Academy (y compris les > 20 ans, hors lineup hypothétique).
    const displayRankings = rankAll([...pool, ...academy], params);

    const builder = new LineupBuilder(rankings);
    const hypo = builder.buildFiveOneLineup();
    const subSlots = LineupBuilder.getFiveOneSubSlots();
    const hypoSubs = builder.getSubstitutes(hypo.lineup, subSlots);

    // Nom → slot occupé dans la lineup hypothétique (titulaires + banc).
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
