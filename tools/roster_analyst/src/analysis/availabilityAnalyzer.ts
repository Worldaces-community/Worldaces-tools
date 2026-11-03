/**
 * Disponibilité des joueurs pour la lineup (Academy + progression).
 *
 *   - Position « Academy » : jamais disponible pour la lineup (cf. academyAnalyzer
 *     pour les entrées / sorties recommandées).
 *   - Progress « Considering retirement » : ne progresse plus → exclu sans
 *     exception (le faire jouer prend du temps de jeu aux jeunes qui progressent)
 *     et libéré en priorité.
 *   - Progress « Starting to decline » : exclu SAUF s'il est exceptionnel, c.-à-d.
 *     s'il augmente la valeur des 7 titulaires du 5-1 (somme des scores +
 *     synergie des signes) d'au moins
 *     DECLINE_EXCEPTIONAL_MIN_GAIN par rapport à la meilleure lineup sans lui
 *     (alternatives « Improving » comprises, effets de cascade inclus via le MILP).
 *     Non exceptionnel ⇒ libéré en priorité.
 */

import { Player, Params, RoleName, ScoredPlayer } from "../types";
import { rankForRole } from "../scoring/scorer";
import { LineupBuilder } from "../lineup/lineupBuilder";
import { ACADEMY_POSITION } from "../config/constants";
import { SETTINGS } from "../config/settings";

/** Classements par rôle d'un sous-ensemble de joueurs. */
export function rankAll(players: Player[], params: Params): Record<RoleName, ScoredPlayer[]> {
    const out = {} as Record<RoleName, ScoredPlayer[]>;
    for (const role of Object.keys(params.roles) as RoleName[]) {
        out[role] = rankForRole(players, params.roles[role], role);
    }
    return out;
}

/**
 * Valeur des titulaires du 5-1 optimal construit sur `players` : somme de
 * leurs scores + valeur de la synergie des signes (points de score).
 */
function starterTotal(players: Player[], params: Params): number {
    const res = new LineupBuilder(rankAll(players, params)).buildFiveOneLineup();
    return Object.values(res.lineup).reduce((s, sp) => s + (sp?.score ?? 0), 0) + res.synergyValue;
}

export const isAcademy = (p: Player): boolean => p.position === ACADEMY_POSITION;

export interface DecliningEval {
    player: Player;
    /** Gain sur la somme des scores des 7 titulaires s'il est disponible. */
    gain:   number;
    /** true ⇒ exceptionnel : reste disponible pour la lineup et le roster. */
    kept:   boolean;
}

export interface AvailabilityResult {
    /** Joueurs disponibles pour la lineup (hors Academy, Improving + déclinants exceptionnels). */
    pool:      Player[];
    /** Joueurs à l'Academy (indisponibles pour la lineup). */
    academy:   Player[];
    /** Joueurs « Starting to decline » (hors Academy), gain décroissant. */
    declining: DecliningEval[];
    /** Joueurs « Considering retirement » (hors Academy). */
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
 * Joueurs des lineups que `analyzeAvailability` optimise (base « Improving »
 * puis base + chaque déclinant) : indépendantes, calculables en parallèle.
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

    // Chaque déclinant est évalué seul face à la base « Improving ».
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
