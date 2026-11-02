/**
 * Player types for World Aces roster analysis
 */
// ─── Rareté ──────────────────────────────────────────────────────────────────

export type Rarity = "Common" | "Rare" | "Legendary" | "Mythic" | "Special";

// ─── Progression (colonne « Progress » du CSV) ──────────────────────────────
//   Improving              : progresse encore (matchs + entraînement)
//   Starting to decline    : déclin entamé, stats en baisse chaque saison
//   Considering retirement : pic de déclin atteint, ne progresse plus du tout
export type Progress = "Improving" | "Starting to decline" | "Considering retirement";

// ─── Signe astrologique (colonne « Sign » / « Signe » du CSV) ───────────────
export type Sign =
    | "Aries" | "Taurus" | "Gemini" | "Cancer" | "Leo" | "Virgo"
    | "Libra" | "Scorpio" | "Sagittarius" | "Capricorn" | "Aquarius" | "Pisces";

export interface Player {
    firstName: string;
    lastName: string;
    fullName: string;
    age: number;
    rarity: Rarity;
    position: string;
    /** Progression du joueur (« Improving » si la colonne est absente du CSV). */
    progress: Progress;
    roles: string[];
    traits: string[];
    /** Signe du joueur (null si colonne absente/vide — anciens CSV). */
    sign: Sign | null;
    // Composite stats (uppercase in CSV)
    ATTACK: number;
    SETTING: number;
    RECEPTION: number;
    SERVE: number;
    BLOCK: number;
    STAMINA: number;
    // Detailed stats (lowercase in CSV)
    setting: number;
    serve: number;
    spike: number;
    quick: number;
    power: number;
    awareness: number;
    attack: number;
    "back attack": number;
    reception: number;
    overhand: number;
    bump: number;
    block: number;
    "read block": number;
    "commit block": number;
    focus: number;
    defense: number;
    stamina: number;
    reflex: number;
}

export interface ScoredPlayer {
    player: Player;
    score: number;
}
