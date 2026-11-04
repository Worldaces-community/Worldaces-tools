/**
 * Role configuration loading and utilities
 */

import { Params, RoleConfig } from "../types";
import { applySettings, resolveSettings, SETTINGS } from "./settings";

/**
 * Libero phase sub-profile: removes the traits reserved for the OTHER
 * phase (`dropTraits`, see settings.libero). Everything else — stat weights
 * (shared by both phases), shared trait bonuses, sign bonuses (the
 * libero's sign effects apply in reception as in dig) — is kept.
 */
function maskLiberoConfig(libero: RoleConfig, dropTraits: string[]): RoleConfig {
    return {
        statsWeights: { ...libero.statsWeights },
        traitBonuses: Object.fromEntries(
            Object.entries(libero.traitBonuses).filter(([t]) => !dropTraits.includes(t))
        ),
        signBonuses: { ...(libero.signBonuses ?? {}) },
    };
}

/**
 * Libero RECEPTION sub-profile: without the settings' "defense only"
 * traits. Used to compare our 2 liberos on the reception phase
 * (2nd libero rotation).
 */
export function deriveLiberoReception(libero: RoleConfig): RoleConfig {
    return maskLiberoConfig(libero, SETTINGS.libero.defenseOnlyTraits);
}

/**
 * Libero DEFENSE sub-profile: without the settings' "reception only"
 * traits. Used to compare our 2 liberos on the defense phase
 * (2nd libero rotation).
 */
export function deriveLiberoDefense(libero: RoleConfig): RoleConfig {
    return maskLiberoConfig(libero, SETTINGS.libero.receptionOnlyTraits);
}

const ROLE_NAMES = ["setter", "outsideHitter", "middleBlocker", "oppositeHitter", "libero"] as const;

/**
 * Validates and normalizes an already-parsed params.json (without side effects on
 * the received object) then ENABLES its settings (`settings`) for the engine.
 * Usable as is in the browser; the CLI reads the file then calls
 * this function.
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
    // traitWeight: global multiplier of the traitBonuses (rating × weight =
    // points added), applied once here → scorer, idealScore, recruitment
    // and --verbose display all see the effective bonuses.
    const tw = params.traitWeight ?? 1;
    if (tw !== 1) {
        for (const config of Object.values(params.roles)) {
            for (const t of Object.keys(config.traitBonuses)) {
                config.traitBonuses[t] = Math.round(config.traitBonuses[t] * tw * 100) / 100;
            }
        }
    }
    // The setter activates no sign effect: their chemistry value is the
    // connection with the attackers (connectionBonus) — and only theirs.
    if (Object.values(params.roles.setter.signBonuses ?? {}).some((v) => v !== 0)) {
        console.warn("⚠️  roles.setter.signBonuses: the setter activates no sign effect — ignored (see connectionBonus).");
    }
    params.roles.setter.signBonuses = {};
    for (const role of ROLE_NAMES) {
        if (role !== "setter" && params.roles[role].connectionBonus) {
            console.warn(`⚠️  roles.${role}.connectionBonus: setter only — ignored.`);
        }
        if (role !== "setter") delete params.roles[role].connectionBonus;
    }
    // signWeight: global multiplier of the signBonuses and connectionBonus
    // (rating × weight = points), applied once here like traitWeight.
    const sw = params.signWeight ?? 1;
    if (sw !== 1) {
        const scale = (v: number) => Math.round(v * sw * 100) / 100;
        for (const config of Object.values(params.roles)) {
            for (const s of Object.keys(config.signBonuses!)) config.signBonuses![s] = scale(config.signBonuses![s]);
            if (config.connectionBonus) config.connectionBonus = scale(config.connectionBonus);
        }
    }
    const settings = resolveSettings(params.settings);
    params.settings = settings;
    applySettings(settings);
    return params;
}

/** Parses the text of a params.json (see normalizeParams). */
export function parseParams(text: string): Params {
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch (e) {
        throw new Error(`params.json: invalid JSON (${(e as Error).message}).`);
    }
    return normalizeParams(raw);
}

/** Maximum number of traits a player can carry (Special rarity). */
export const MAX_TRAITS = 4;

/**
 * Groups of traits acting on the SAME action → NOT additive: a player only serves
 * one ball at a time, so stacking Meteor Serve (jump topspin) and Float Serve
 * (float) does not add up quality — at best a bit of flexibility. We therefore only
 * count the BEST bonus present in each group (see scorer + idealScore).
 * NB: the other pairs are NOT redundant (Guardian/Defensive Specialist and
 * Surprise/Marksman have complementary mechanisms, measured separately) → they
 * add up normally.
 */
export const REDUNDANT_TRAIT_GROUPS: string[][] = [["Meteor Serve", "Float Serve"]];

/** Role trait bonuses after collapsing redundant groups to their max. */
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
 * Theoretical ceiling of a perfect player in the position: stats at 99 (weighted mean
 * capped at 99) + the role's MAX_TRAITS best trait bonuses + the role's best
 * sign bonus.
 *
 * We do NOT sum all traits: their number is capped by rarity
 * (Special 4, Mythic 3, Legendary 2, Rare 1, Common 0) → at most 4. Used as the
 * normalization denominator to make scores comparable across roles.
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
    // A player has only one sign → ceiling = the role's best sign bonus.
    const signScore = Math.max(0, ...Object.values(config.signBonuses ?? {}));
    return statScore + traitScore + signScore;
}
