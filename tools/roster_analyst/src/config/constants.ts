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


// Paires de sous-stats exclusives : dans une action réelle, une seule des deux
// joue (un contre est lu OU engagé ; une passe est rapide OU haute — aucun
// tempo n'est privilégié par rôle, cf. règle utilisateur). Le scorer global ne
// garde que la stat de plus forte VALEUR chez le joueur — le poids de l'autre
// est retiré (computeRawScores). Ordre dans la paire = gagnant à égalité :
// read block (compétence principale du contre) et power (Rapide n'est retenu
// que si quick > power strict).
export const EXCLUSIVE_STAT_PAIRS: [string, string][] = [
    ["read block", "commit block"],
    ["power", "quick"],
];

// ─── Rotation du 2ᵉ libéro (substitution réception / service) ─────────────────
//
// Le jeu permet de faire entrer/sortir un 2ᵉ libéro selon la PHASE :
//   - RÉCEPTION : on reçoit le service adverse (platform pass, lecture du service…)
//   - SERVICE   : on sert, puis on défend l'attaque adverse (dig + passe de secours)
// On sépare donc le profil libéro en deux sous-profils comparables. Côté stats,
// SEULES `reception` et `defense` discriminent les deux phases (règle utilisateur) :
// toutes les autres sous-stats (overhand, bump, awareness, focus, stamina, reflex,
// setting) sont COMMUNES — elles portent la réception ET le dig, donc dans les deux.

/** Sous-stats communes aux deux phases (tout sauf `reception` et `defense`). */
const LIBERO_COMMON_SUBSTATS = [
    "overhand", "bump", "awareness", "focus", "stamina", "reflex", "setting",
];

/** Sous-stats du profil RÉCEPTION : `reception` (discriminante) + les communes. */
export const LIBERO_RECEPTION_SUBSTATS = ["reception", ...LIBERO_COMMON_SUBSTATS];

/** Sous-stats du profil DÉFENSE : `defense` (discriminante) + les communes. */
export const LIBERO_DEFENSE_SUBSTATS = ["defense", ...LIBERO_COMMON_SUBSTATS];

/**
 * Traits n'aidant QUE la réception service pour le libéro. Guardian se déclenche
 * sur « meilleures stats de réception » (prend la réception d'un coéquipier à sa
 * place) → réception pure : il ne joue pas sur le dig. Masqué du profil défense.
 */
export const LIBERO_RECEPTION_ONLY_TRAITS = ["Guardian"];

/**
 * Traits n'aidant QUE la défense pour le libéro. Defensive Specialist « ne
 * s'applique PAS à la réception service » (dig/contre uniquement) ; Last Resort
 * est le dig de sauvetage propre au poste → défense pure. Masqués du profil
 * réception.
 */
export const LIBERO_DEFENSE_ONLY_TRAITS = ["Defensive Specialist", "Last Resort"];


// ─── Academy & progression ───────────────────────────────────────────────────

/** Valeur canonique de la colonne Position pour un joueur à l'Academy. */
export const ACADEMY_POSITION = "Academy";

// Seuils réglables par l'utilisateur (âge Academy, gain d'un déclinant
// exceptionnel, Δ de rotation libéro…) : cf. settings.ts (bloc `settings`).
