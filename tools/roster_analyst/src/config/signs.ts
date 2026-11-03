/**
 * Astrological signs & team chemistry (official game mechanics).
 *
 * A player's chemistry = Σ, over each teammate on the court on their
 * side (libero zone included), of +1 if they like the teammate's sign, −1 if they
 * dislike it, 0 otherwise. The relation is NOT symmetric (it is the
 * player's opinion of the teammate that counts for THEIR chemistry).
 *
 *   - player (except setter): their sign effect is active if chemistry ≥ 3;
 *   - setter: no sign effect; on each set, chemistry(setter) +
 *     chemistry(attacker) ≥ 3 ⇒ better connection chance;
 *   - libero: libero-specific effect, determined by their sign (3 groups).
 *
 * Effects only from account level 20 onwards.
 */

import { Sign } from "../types";

/** Canonical order (= order of the matrix rows / columns). */
export const ALL_SIGNS: Sign[] = [
    "Aries", "Taurus", "Gemini", "Cancer", "Leo", "Virgo",
    "Libra", "Scorpio", "Sagittarius", "Capricorn", "Aquarius", "Pisces",
];

/** French labels (translated game export) → canonical sign. */
export const SIGN_ALIASES: Record<string, Sign> = {
    "Bélier": "Aries",
    "Taureau": "Taurus",
    "Gémeaux": "Gemini",
    "Cancer": "Cancer",
    "Lion": "Leo",
    "Vierge": "Virgo",
    "Balance": "Libra",
    "Scorpion": "Scorpio",
    "Sagittaire": "Sagittarius",
    "Capricorne": "Capricorn",
    "Verseau": "Aquarius",
    "Poissons": "Pisces",
};

/** French display label. */
export const SIGN_LABELS_FR: Record<Sign, string> = Object.fromEntries(
    Object.entries(SIGN_ALIASES).map(([fr, en]) => [en, fr])
) as Record<Sign, string>;

/**
 * Chemistry matrix: SIGN_CHEMISTRY[player][teammate] ∈ {−1, 0, +1}
 * (rows = player's sign, columns = teammate's sign, Aries → Pisces).
 */
const MATRIX: number[][] = [
    /* Aries       */ [-1, +1,  0, -1, +1, -1,  0, +1, +1, -1, +1, -1],
    /* Taurus      */ [-1, -1, -1, -1, +1, +1,  0,  0, +1, +1, -1, +1],
    /* Gemini      */ [-1, +1, +1, -1, +1, +1, -1, -1,  0, +1,  0, -1],
    /* Cancer      */ [+1, +1, -1, -1, +1, +1, -1, -1, +1,  0,  0, -1],
    /* Leo         */ [+1,  0, +1, +1, -1, -1, +1, -1, -1, +1,  0, -1],
    /* Virgo       */ [+1, -1, +1,  0, +1, +1, -1, -1, -1, -1, +1,  0],
    /* Libra       */ [ 0, +1, -1, +1, -1, -1, +1, +1, -1, +1, -1,  0],
    /* Scorpio     */ [+1,  0, -1, +1, -1, -1, +1, +1, +1, -1, -1,  0],
    /* Sagittarius */ [-1, -1,  0, +1, -1, +1, +1, +1, -1, -1,  0, +1],
    /* Capricorn   */ [-1, -1, +1,  0, -1, -1, +1,  0, +1, -1, +1, +1],
    /* Aquarius    */ [-1, -1, +1, -1,  0, +1, +1, +1, -1, +1, -1,  0],
    /* Pisces      */ [+1, +1, +1, -1, -1,  0, -1, +1, -1,  0, +1, -1],
];

const IDX = new Map<Sign, number>(ALL_SIGNS.map((s, i) => [s, i]));

/** Numeric index of a sign (0-11, 12 = no sign) — fast computation. */
export const NO_SIGN = 12;
export function signIndex(sign: Sign | null): number {
    return sign ? IDX.get(sign)! : NO_SIGN;
}
/** Flat 13×13 affinity matrix (row/column 12 = no sign ⇒ 0). */
export const AFFINITY = new Int8Array(13 * 13);
for (let a = 0; a < 12; a++) for (let b = 0; b < 12; b++) AFFINITY[a * 13 + b] = MATRIX[a][b];

/** Opinion of a player of sign `player` on a teammate of sign `mate`. */
export function signAffinity(player: Sign | null, mate: Sign | null): number {
    if (!player || !mate) return 0;
    return MATRIX[IDX.get(player)!][IDX.get(mate)!];
}

/** A player's chemistry with a list of teammates on the court. */
export function chemistryOf(player: Sign | null, mates: (Sign | null)[]): number {
    return mates.reduce((s, m) => s + signAffinity(player, m), 0);
}

/** Activation threshold of the sign effect (players + libero). */
export const SIGN_ACTIVATION_THRESHOLD = 3;

/** Threshold chemistry(setter) + chemistry(attacker) for the best connection. */
export const SETTER_SYNERGY_THRESHOLD = 3;

/**
 * Win gain of a PERFECT synergy for the team (all effects
 * active + all setter-attacker connections): +10 %. Used to calibrate
 * the synergy weight in the 5-1 MILP (10 % of the sum of the
 * starters' scores) and the "≈ +x % win" display.
 */
export const SIGN_SYNERGY_MAX_WIN_GAIN = 0.10;

/** Libero effect per sign (3 groups). */
export const LIBERO_SIGN_EFFECT: Record<Sign, string> = {
    Taurus: "energy", Leo: "energy", Scorpio: "energy", Aquarius: "energy",
    Gemini: "reflexes", Virgo: "reflexes", Sagittarius: "reflexes", Pisces: "reflexes",
    Aries: "takes the ball", Cancer: "takes the ball", Libra: "takes the ball", Capricorn: "takes the ball",
};
