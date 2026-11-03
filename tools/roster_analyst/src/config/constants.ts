/**
 * Constants for World Aces roster analysis
 */

import { RoleName } from "../types";

// Role labels for display
export const ROLE_LABELS: Record<RoleName, string> = {
    setter: "Setter",
    outsideHitter: "Outside Hitter (OH)",
    middleBlocker: "Middle Blocker (MB)",
    oppositeHitter: "Opposite Hitter (OP)",
    libero: "Libero",
};

// World Aces in-game role strings that match each position
export const ROLE_GAME_NAMES: Record<RoleName, string[]> = {
    setter: ["Setter"],
    outsideHitter: ["Outside Hitter"],
    middleBlocker: ["Middle Blocker"],
    oppositeHitter: ["Opposite Hitter"],
    libero: ["Libero"],
};

// All detailed stats (lowercase)
export const ALL_STATS = [
    "setting", "serve", "spike", "quick", "power", "awareness",
    "attack", "back attack", "reception", "overhand", "bump",
    "block", "read block", "commit block", "focus", "defense", "stamina", "reflex",
];

// Composite stats (uppercase) - the only trainable stats in game
export const COMPOSITE_STATS = ["ATTACK", "SETTING", "RECEPTION", "SERVE", "BLOCK", "STAMINA"];

// All possible traits
export const ALL_TRAITS = [
    "Master Mind", "Moving Wall", "Guardian", "Vigorous", "Surprise Attack",
    "Marksman", "Meteor Serve", "Defensive Specialist", "Float Serve",
    "Quick Learner", "Momentum Addict", "Loudmouth", "True Leader",
    "Overachiever", "Crafty", "Tenacious", "Hunter", "Last Resort",
];


// Exclusive sub-stat pairs: in a real action, only one of the two
// applies (a block is read OR committed; a set is quick OR high — no
// tempo is favored per role, see user rule). The global scorer only
// keeps the stat with the highest VALUE for the player — the other one's weight
// is removed (computeRawScores). Order in the pair = winner on a tie:
// read block (the main blocking skill) and power (Quick is only kept
// if quick > power strictly).
export const EXCLUSIVE_STAT_PAIRS: [string, string][] = [
    ["read block", "commit block"],
    ["power", "quick"],
];

// ─── Academy & progression ───────────────────────────────────────────────────

/** Canonical value of the Position column for an Academy player. */
export const ACADEMY_POSITION = "Academy";

// User-adjustable thresholds (Academy age, gain of an exceptional
// decliner, libero rotation Δ…): see settings.ts (`settings` block).
