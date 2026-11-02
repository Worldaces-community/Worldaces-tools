/**
 * Role configuration loading and utilities
 */

import { Params, RoleConfig } from "../types";
import {
    LIBERO_RECEPTION_SUBSTATS,
    LIBERO_DEFENSE_SUBSTATS,
    LIBERO_RECEPTION_ONLY_TRAITS,
    LIBERO_DEFENSE_ONLY_TRAITS,
} from "./constants";
import { applySettings, resolveSettings } from "./settings";

/**
 * Restreint une config libéro à un sous-profil de phase : on ne garde que les
 * sous-stats `keepStats` (mêmes poids que le profil de base) et on retire les
 * traits `dropTraits` (utiles dans l'autre phase seulement). Le reste des traits
 * — partagés (Master Mind, Quick Learner, Overachiever, Vigorous, traits
 * d'équipe…) — est conservé tel quel : ils comptent dans les deux phases.
 */
function maskLiberoConfig(
    libero: RoleConfig,
    keepStats: string[],
    dropTraits: string[]
): RoleConfig {
    const keep = new Set(keepStats);
    const drop = new Set(dropTraits);

    const statsWeights: Record<string, number> = {};
    for (const [stat, w] of Object.entries(libero.statsWeights)) {
        if (keep.has(stat)) statsWeights[stat] = w;
    }
    const traitBonuses: Record<string, number> = {};
    for (const [trait, b] of Object.entries(libero.traitBonuses)) {
        if (!drop.has(trait)) traitBonuses[trait] = b;
    }
    return { statsWeights, traitBonuses };
}

/**
 * Sous-profil RÉCEPTION du libéro : sous-stats de réception service + on retire
 * les traits purement défensifs (Defensive Specialist, Last Resort). Sert à
 * comparer nos 2 libéros sur la phase de réception (rotation du 2ᵉ libéro).
 */
export function deriveLiberoReception(libero: RoleConfig): RoleConfig {
    return maskLiberoConfig(libero, LIBERO_RECEPTION_SUBSTATS, LIBERO_DEFENSE_ONLY_TRAITS);
}

/**
 * Sous-profil DÉFENSE du libéro : sous-stats de dig / passe de secours + on
 * retire le trait purement réception (Guardian). Sert à comparer nos 2 libéros
 * sur la phase de défense (rotation du 2ᵉ libéro).
 */
export function deriveLiberoDefense(libero: RoleConfig): RoleConfig {
    return maskLiberoConfig(libero, LIBERO_DEFENSE_SUBSTATS, LIBERO_RECEPTION_ONLY_TRAITS);
}

const ROLE_NAMES = ["setter", "outsideHitter", "middleBlocker", "oppositeHitter", "libero"] as const;

/**
 * Valide et normalise un params.json déjà parsé (sans effet de bord sur
 * l'objet reçu) puis ACTIVE ses réglages (`settings`) pour le moteur.
 * Utilisable tel quel dans le navigateur ; la CLI lit le fichier puis appelle
 * cette fonction.
 */
export function normalizeParams(input: unknown): Params {
    if (typeof input !== "object" || input === null) {
        throw new Error("invalid params.json: JSON object expected.");
    }
    const params = JSON.parse(JSON.stringify(input)) as Params;
    if (typeof params.roles !== "object" || params.roles === null) {
        throw new Error('invalid params.json: missing "roles" block.');
    }
    for (const role of ROLE_NAMES) {
        const cfg = params.roles[role];
        if (!cfg) throw new Error(`invalid params.json: role "${role}" missing from "roles".`);
        cfg.statsWeights ??= {};
        cfg.traitBonuses ??= {};
        cfg.signBonuses ??= {};
    }
    // traitWeight : multiplicateur global des traitBonuses (poids des traits
    // face aux stats), appliqué une fois ici → scorer, idealScore, recrutement
    // et affichage --verbose voient tous les bonus effectifs.
    const tw = params.traitWeight ?? 1;
    if (tw !== 1) {
        for (const config of Object.values(params.roles)) {
            for (const t of Object.keys(config.traitBonuses)) {
                config.traitBonuses[t] = Math.round(config.traitBonuses[t] * tw * 100) / 100;
            }
        }
    }
    const settings = resolveSettings(params.settings);
    params.settings = settings;
    applySettings(settings);
    return params;
}

/** Parse le texte d'un params.json (cf. normalizeParams). */
export function parseParams(text: string): Params {
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch (e) {
        throw new Error(`params.json: invalid JSON (${(e as Error).message}).`);
    }
    return normalizeParams(raw);
}

/** Nombre maximum de traits qu'un joueur peut porter (rareté Special). */
export const MAX_TRAITS = 4;

/**
 * Groupes de traits agissant sur la MÊME action → NON additifs : un joueur ne sert
 * qu'un ballon à la fois, donc cumuler Meteor Serve (jump topspin) et Float Serve
 * (float) n'additionne pas la qualité — au mieux un peu de flexibilité. On ne compte
 * donc que le MEILLEUR bonus présent dans chaque groupe (cf. scorer + idealScore).
 * NB : les autres paires NE sont PAS redondantes (Guardian/Defensive Specialist et
 * Surprise/Marksman ont des mécanismes complémentaires, mesurés distincts) → elles
 * s'additionnent normalement.
 */
export const REDUNDANT_TRAIT_GROUPS: string[][] = [["Meteor Serve", "Float Serve"]];

/** Bonus de traits du rôle après effondrement des groupes redondants à leur max. */
function nonRedundantBonuses(traitBonuses: Record<string, number>): number[] {
    const grouped = new Set<string>();
    const out: number[] = [];
    for (const group of REDUNDANT_TRAIT_GROUPS) {
        const present = group.filter((t) => t in traitBonuses);
        if (present.length) {
            out.push(Math.max(...present.map((t) => traitBonuses[t] ?? 0)));
            for (const t of group) grouped.add(t);
        }
    }
    for (const [t, b] of Object.entries(traitBonuses)) if (!grouped.has(t)) out.push(b);
    return out;
}

/**
 * Calculate ideal score for a role configuration.
 * Plafond théorique d'un joueur parfait au poste : stats à 99 (moyenne pondérée
 * bornée à 99) + les MAX_TRAITS meilleurs bonus de traits du rôle + le meilleur
 * bonus de signe du rôle.
 *
 * On ne somme PAS tous les traits : leur nombre est plafonné par la rareté
 * (Special 4, Mythic 3, Legendary 2, Rare 1, Common 0) → au plus 4. Sert de
 * dénominateur de normalisation pour rendre les scores comparables entre rôles.
 */
export function idealScore(config: RoleConfig): number {
    const weightSum = Object.values(config.statsWeights).reduce((a, b) => a + b, 0) || 1;
    const statScore = Object.values(config.statsWeights).reduce(
        (sum, w) => sum + 99 * (w / weightSum),
        0
    );
    const traitScore = nonRedundantBonuses(config.traitBonuses)
        .sort((a, b) => b - a)
        .slice(0, MAX_TRAITS)
        .reduce((sum, b) => sum + b, 0);
    // Un joueur n'a qu'un signe → plafond = meilleur bonus de signe du rôle.
    const signScore = Math.max(0, ...Object.values(config.signBonuses ?? {}));
    return statScore + traitScore + signScore;
}
