/**
 * Player types for World Aces roster analysis
 */
// ─── Rarity ──────────────────────────────────────────────────────────────────

export type Rarity = "Common" | "Rare" | "Legendary" | "Mythic" | "Special";

// ─── Progress (CSV "Progress" column) ────────────────────────────────────────
//   Improving              : still improving (matches + training)
//   Starting to decline    : decline started, stats dropping each season
//   Considering retirement : decline peak reached, no longer improving at all
export type Progress = "Improving" | "Starting to decline" | "Considering retirement";

// ─── Astrological sign (CSV "Sign" / "Signe" column) ────────────────────────
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
    /** Player's progress ("Improving" if the column is missing from the CSV). */
    progress: Progress;
    roles: string[];
    traits: string[];
    /** Player's sign (null if the column is missing/empty — old CSVs). */
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
    /** Score with the sign effect assumed active (0-99 scale). */
    score: number;
    /**
     * Part of `score` due to the sign bonus (same scale): it only counts when
     * the effect is active in the lineup (chemistry ≥ 3, see lineupBuilder).
     */
    signScore: number;
    /**
     * Value of one setter ↔ attacker connection (setter role only, same
     * scale; 0 otherwise). Not included in `score`: earned per connected attacker.
     */
    connectionScore: number;
}
