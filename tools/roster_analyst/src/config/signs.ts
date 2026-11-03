/**
 * Signes astrologiques & chimie d'équipe (mécanique officielle du jeu).
 *
 * Chimie d'un joueur = Σ, sur chaque coéquipier présent sur le terrain de son
 * côté (zone libéro comprise), de +1 s'il aime le signe du coéquipier, −1 s'il
 * ne l'aime pas, 0 sinon. La relation n'est PAS symétrique (c'est l'avis du
 * joueur sur le coéquipier qui compte pour SA chimie).
 *
 *   - joueur (hors passeur) : effet de son signe actif si chimie ≥ 3 ;
 *   - passeur : pas d'effet de signe ; à chaque passe, chimie(passeur) +
 *     chimie(attaquant) ≥ 3 ⇒ meilleure chance de connexion ;
 *   - libéro : effet propre au libéro, déterminé par son signe (3 groupes).
 *
 * Effets uniquement à partir du niveau de compte 20.
 */

import { Sign } from "../types";

/** Ordre canonique (= ordre des lignes / colonnes de la matrice). */
export const ALL_SIGNS: Sign[] = [
    "Aries", "Taurus", "Gemini", "Cancer", "Leo", "Virgo",
    "Libra", "Scorpio", "Sagittarius", "Capricorn", "Aquarius", "Pisces",
];

/** Libellés FR (export du jeu traduit) → signe canonique. */
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

/** Libellé FR d'affichage. */
export const SIGN_LABELS_FR: Record<Sign, string> = Object.fromEntries(
    Object.entries(SIGN_ALIASES).map(([fr, en]) => [en, fr])
) as Record<Sign, string>;

/**
 * Matrice de chimie : SIGN_CHEMISTRY[joueur][coéquipier] ∈ {−1, 0, +1}
 * (lignes = signe du joueur, colonnes = signe du coéquipier, Aries → Pisces).
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

/** Index numérique d'un signe (0-11, 12 = pas de signe) — calcul rapide. */
export const NO_SIGN = 12;
export function signIndex(sign: Sign | null): number {
    return sign ? IDX.get(sign)! : NO_SIGN;
}
/** Matrice d'affinité à plat 13×13 (ligne/colonne 12 = pas de signe ⇒ 0). */
export const AFFINITY = new Int8Array(13 * 13);
for (let a = 0; a < 12; a++) for (let b = 0; b < 12; b++) AFFINITY[a * 13 + b] = MATRIX[a][b];

/** Avis du joueur de signe `player` sur un coéquipier de signe `mate`. */
export function signAffinity(player: Sign | null, mate: Sign | null): number {
    if (!player || !mate) return 0;
    return MATRIX[IDX.get(player)!][IDX.get(mate)!];
}

/** Chimie d'un joueur face à une liste de coéquipiers sur le terrain. */
export function chemistryOf(player: Sign | null, mates: (Sign | null)[]): number {
    return mates.reduce((s, m) => s + signAffinity(player, m), 0);
}

/** Seuil d'activation de l'effet du signe (joueurs + libéro). */
export const SIGN_ACTIVATION_THRESHOLD = 3;

/** Seuil chimie(passeur) + chimie(attaquant) pour la meilleure connexion. */
export const SETTER_SYNERGY_THRESHOLD = 3;

/**
 * Gain de victoire d'une synergie PARFAITE sur l'équipe (tous les effets
 * actifs + toutes les connexions passeur-attaquant) : +10 %. Sert à calibrer
 * le poids de la synergie dans le MILP du 5-1 (10 % de la somme des scores
 * des titulaires) et l'affichage « ≈ +x % de victoire ».
 */
export const SIGN_SYNERGY_MAX_WIN_GAIN = 0.10;

/** Effet libéro par signe (3 groupes). */
export const LIBERO_SIGN_EFFECT: Record<Sign, string> = {
    Taurus: "energy", Leo: "energy", Scorpio: "energy", Aquarius: "energy",
    Gemini: "reflexes", Virgo: "reflexes", Sagittarius: "reflexes", Pisces: "reflexes",
    Aries: "takes the ball", Cancer: "takes the ball", Libra: "takes the ball", Capricorn: "takes the ball",
};
