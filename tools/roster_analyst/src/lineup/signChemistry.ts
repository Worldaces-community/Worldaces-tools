/**
 * Chimie des signes sur le terrain du 5-1 — modèle partagé par le MILP du
 * lineup (LineupBuilder), l'affichage et le recrutement.
 *
 * Terrain : en 5-1 le libéro remplace le MB de la rangée arrière, les deux MB
 * ne sont donc jamais ensemble sur le terrain. On modélise 2 PHASES de poids
 * égal (½ chacune) :
 *   A : Setter · Front OH · Back OH · Opposite · Front MB · Libéro
 *   B : Setter · Front OH · Back OH · Opposite · Back MB  · Libéro
 *
 * « Unités » de synergie par phase (9 au maximum) :
 *   - activation du signe de chaque non-passeur (chimie ≥ 3) : 5 ;
 *   - connexion passeur ↔ attaquant (OH, OP, MB) : chimie(passeur) +
 *     chimie(attaquant) ≥ 3 : 4.
 * Synergie parfaite = 9 unités dans les 2 phases ⇒ +10 % de victoire.
 */

import { RoleName, Sign, ScoredPlayer } from "../types";
import {
    LIBERO_SIGN_EFFECT,
    SIGN_LABELS_FR,
    chemistryOf,
    SIGN_ACTIVATION_THRESHOLD,
    SETTER_SYNERGY_THRESHOLD,
    SIGN_SYNERGY_MAX_WIN_GAIN,
} from "../config/signs";

export type CourtRole = "setter" | "hitter" | "libero";

export function courtRoleOf(role: RoleName): CourtRole {
    if (role === "setter") return "setter";
    if (role === "libero") return "libero";
    return "hitter";
}

/** Slots titulaires sur le terrain dans chaque phase (cf. en-tête). */
export const FIVE_ONE_COURTS: string[][] = [
    ["Setter", "Front Outside Hitter", "Back Outside Hitter", "Opposite", "Front Middle Blocker", "Libero"],
    ["Setter", "Front Outside Hitter", "Back Outside Hitter", "Opposite", "Back Middle Blocker", "Libero"],
];

/** Rôle de chaque slot titulaire du 5-1. */
export const FIVE_ONE_SLOT_ROLES: Record<string, RoleName> = {
    "Setter": "setter",
    "Libero": "libero",
    "Front Outside Hitter": "outsideHitter",
    "Back Outside Hitter": "outsideHitter",
    "Front Middle Blocker": "middleBlocker",
    "Back Middle Blocker": "middleBlocker",
    "Opposite": "oppositeHitter",
};

/** Unités maximales par phase (5 activations + 4 connexions). */
export const UNITS_PER_PHASE = 9;

export interface CourtMember {
    key: string;
    role: CourtRole;
    sign: Sign | null;
}

export interface CourtEval {
    chem: Map<string, number>;
    active: Map<string, boolean>;
    /** Connexion passeur ↔ attaquant, par clé d'attaquant. */
    connected: Map<string, boolean>;
    units: number;
}

/** Évalue une composition de terrain (membres sans joueur exclus en amont). */
export function evaluateCourt(members: CourtMember[]): CourtEval {
    const chem = new Map<string, number>();
    for (const m of members) {
        chem.set(m.key, chemistryOf(m.sign, members.filter((o) => o !== m).map((o) => o.sign)));
    }
    const active = new Map<string, boolean>();
    const connected = new Map<string, boolean>();
    let units = 0;
    const setter = members.find((m) => m.role === "setter");
    for (const m of members) {
        if (m.role === "setter") continue;
        const on = !!m.sign && chem.get(m.key)! >= SIGN_ACTIVATION_THRESHOLD;
        active.set(m.key, on);
        if (on) units++;
        if (m.role === "hitter") {
            const ok = !!setter?.sign && !!m.sign &&
                chem.get(setter.key)! + chem.get(m.key)! >= SETTER_SYNERGY_THRESHOLD;
            connected.set(m.key, ok);
            if (ok) units++;
        }
    }
    return { chem, active, connected, units };
}

// ─── Analyse de la lineup (affichage + recrutement) ──────────────────────────

export interface StarterChemistry {
    slot: string;
    sign: Sign | null;
    name: string | null;
    /** Chimie par phase (null = pas sur le terrain dans cette phase). */
    chem: (number | null)[];
    /** Effet du signe actif par phase (null = hors terrain ou passeur). */
    active: (boolean | null)[];
    /** Connexion avec le passeur par phase (attaquants seulement). */
    connected: (boolean | null)[];
}

export interface ChemistryAnalysis {
    /** false ⇒ aucun signe dans le CSV : section non affichée. */
    hasSigns: boolean;
    starters: StarterChemistry[];
    /** Unités atteintes (moyenne des 2 phases, 0-9). */
    units: number;
    ratio: number;
    /** Gain de victoire estimé (ratio × 10 %). */
    winGain: number;
}

type Lineup = Record<string, ScoredPlayer | null>;

function phaseMembers(lineup: Lineup, court: string[]): CourtMember[] {
    return court
        .filter((slot) => lineup[slot])
        .map((slot) => ({
            key: slot,
            role: courtRoleOf(FIVE_ONE_SLOT_ROLES[slot]),
            sign: lineup[slot]!.player.sign,
        }));
}

/** Unités moyennes (2 phases) d'une lineup de titulaires. */
export function lineupUnits(lineup: Lineup): number {
    return FIVE_ONE_COURTS.reduce(
        (s, court) => s + evaluateCourt(phaseMembers(lineup, court)).units / FIVE_ONE_COURTS.length,
        0
    );
}

export function analyzeChemistry(lineup: Lineup, order: string[]): ChemistryAnalysis {
    const hasSigns = Object.values(lineup).some((sp) => !!sp?.player.sign);
    const evals = FIVE_ONE_COURTS.map((court) => evaluateCourt(phaseMembers(lineup, court)));
    const starters: StarterChemistry[] = order.map((slot) => {
        const sp = lineup[slot];
        const pick = <T>(f: (e: CourtEval) => T | undefined) =>
            FIVE_ONE_COURTS.map((court, i) =>
                sp && court.includes(slot) ? (f(evals[i]) ?? null) : null);
        return {
            slot,
            sign: sp?.player.sign ?? null,
            name: sp?.player.fullName ?? null,
            chem: pick((e) => e.chem.get(slot)),
            active: pick((e) => e.active.get(slot)),
            connected: pick((e) => e.connected.get(slot)),
        };
    });
    const units = evals.reduce((s, e) => s + e.units, 0) / evals.length;
    const ratio = units / UNITS_PER_PHASE;
    return { hasSigns, starters, units, ratio, winGain: ratio * SIGN_SYNERGY_MAX_WIN_GAIN };
}

// ─── Mise en forme commune (console + markdown) ──────────────────────────────

/** « 3 / 2 » (2 phases) ou « 1 » (MB, une seule phase) ; « — » hors terrain. */
export function fmtChem(values: (number | null)[]): string {
    const v = values.filter((x): x is number => x !== null);
    return v.length ? v.map((x) => (x > 0 ? `+${x}` : `${x}`)).join(" / ") : "—";
}

/** ✓ (toutes les phases) · ½ (une phase sur deux) · ✗ · — (non applicable). */
export function fmtOn(values: (boolean | null)[]): string {
    const v = values.filter((x): x is boolean => x !== null);
    if (!v.length) return "—";
    const n = v.filter(Boolean).length;
    return n === v.length ? "✓" : n === 0 ? "✗" : "½";
}

/** Signe en FR (+ effet libéro entre parenthèses pour le libéro). */
export function fmtSign(s: StarterChemistry): string {
    if (!s.sign) return "—";
    const fr = SIGN_LABELS_FR[s.sign];
    return s.slot === "Libero" ? `${fr} (${LIBERO_SIGN_EFFECT[s.sign]})` : fr;
}

/** Verdict résumé : « 5.5/9 · ≈ +6.1 % de victoire ». */
export function fmtChemVerdict(a: ChemistryAnalysis): string {
    return `${a.units.toFixed(1)}/${UNITS_PER_PHASE} · ≈ +${(a.winGain * 100).toFixed(1)} % de victoire`;
}
