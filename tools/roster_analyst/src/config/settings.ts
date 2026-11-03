/**
 * Analysis settings (thresholds, MILP weights, synergy value, roster quotas…).
 *
 * Everything that is a user CHOICE lives here and is set in the
 * `settings` block of params.json (see `applySettings`, called by
 * `normalizeParams`). GAME MECHANICS constants (sign matrix,
 * activation thresholds, formulas…) stay in constants.ts / signs.ts.
 *
 * The defaults below are a neutral starting point: each
 * user exports their own settings from the web editor.
 */

import { RoleName } from "../types";
import { ALL_TRAITS } from "./constants";

export interface Settings {
    /**
     * Exponent of the stats' power mean: 1 = plain weighted
     * mean; 0 < p < 1 = penalizes unbalanced profiles (low stats).
     */
    balanceExponent: number;

    lineup: {
        /** Weight λ of substitutes in the 5-1 objective (0 < λ < 1). */
        subObjectiveWeight: number;
        /** Weight λᵣ of reserves (0 < λᵣ < λ). */
        reserveObjectiveWeight: number;
        /** Optimizes sign chemistry (if the CSV has a Sign column). */
        signSynergy: boolean;
        /** Safety limit of the synergy branch & bound (seconds). */
        synergyTimeLimitSec: number;
        /**
         * Win-chance gain (%) of a PERFECT synergy (all effects active +
         * all setter-attacker connections). Calibrates the chemistry weight
         * in the 5-1 objective (this % of the starters' score sum), the
         * sign recruitment and the "≈ +x % win" display.
         */
        perfectSynergyWinPct: number;
    };

    availability: {
        /**
         * Minimum gain (sum of the 7 starters + synergy, 0-99 scale) a
         * "Starting to decline" player must bring to stay available.
         */
        declineExceptionalMinGain: number;
    };

    academy: {
        /** Maximum age (inclusive) to be eligible for the Academy. */
        maxAge: number;
    };

    libero: {
        /**
         * Minimum gain (0-99 scale) to recommend the rotation: lead of the
         * 2nd libero over the main one in the phase where they are better.
         */
        subMinDelta: number;
        /**
         * Reception / defense split of the libero sub-profiles (each
         * manager's interpretation): a trait listed here counts ONLY in that phase;
         * an unlisted trait counts in both. All sub-stats count
         * in both phases (the official descriptions cover reception
         * AND dig) → only traits distinguish the phases.
         */
        receptionOnlyTraits: string[];
        defenseOnlyTraits: string[];
    };

    roster: {
        /** Target roster size ("players to sell" section beyond it). */
        target: number;
        /** Maximum quota per role in the kept roster. */
        targetCounts: Record<RoleName, number>;
    };

    recruitment: {
        /** "Unique" traits: a single useful holder in the lineup. */
        singletonTraits: string[];
        /** Priority multiplier of a unique trait missing from the lineup. */
        singletonPriorityBonus: number;
        /**
         * For a unique trait: roles where its presence counts (e.g. Master Mind
         * → setter / libero). Absent ⇒ all starters count.
         */
        singletonTraitPositions: Partial<Record<string, RoleName[]>>;
    };
}

export const DEFAULT_SETTINGS: Settings = {
    balanceExponent: 1,
    lineup: {
        subObjectiveWeight: 0.5,
        reserveObjectiveWeight: 0.25,
        signSynergy: true,
        synergyTimeLimitSec: 300,
        perfectSynergyWinPct: 10,
    },
    availability: {
        declineExceptionalMinGain: 5,
    },
    academy: {
        maxAge: 20,
    },
    libero: {
        subMinDelta: 3,
        // Traits: Guardian takes a teammate's reception; Defensive
        // Specialist "not serve receive"; Last Resort = rescue dig.
        receptionOnlyTraits: ["Guardian"],
        defenseOnlyTraits: ["Defensive Specialist", "Last Resort"],
    },
    roster: {
        target: 32,
        targetCounts: {
            outsideHitter: 9,
            middleBlocker: 8,
            setter: 5,
            oppositeHitter: 5,
            libero: 5,
        },
    },
    recruitment: {
        singletonTraits: [],
        singletonPriorityBonus: 1,
        singletonTraitPositions: {},
    },
};

/** Deep copy (settings only contain JSON). */
function clone<T>(v: T): T {
    return JSON.parse(JSON.stringify(v)) as T;
}

/** Active settings (read at runtime by the engine). */
export const SETTINGS: Settings = clone(DEFAULT_SETTINGS);

const isObj = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Deep merge `override` → `base`: only keys known in `base` are
 * taken, with the same type (otherwise a warning and the default value).
 * Free-key objects (targetCounts, singletonTraitPositions) are taken as
 * is.
 */
function merge(base: Record<string, unknown>, override: unknown, path: string, freeKeys: Set<string>): void {
    if (!isObj(override)) return;
    for (const [k, v] of Object.entries(override)) {
        const p = path ? `${path}.${k}` : k;
        if (k.startsWith("_")) continue; // comments
        if (!(k in base)) {
            console.warn(`⚠️  settings.${p}: unknown setting, ignored.`);
            continue;
        }
        const cur = base[k];
        if (freeKeys.has(p)) {
            if (isObj(v)) base[k] = { ...(cur as object), ...v };
            else console.warn(`⚠️  settings.${p}: object expected, default kept.`);
        } else if (isObj(cur)) {
            merge(cur, v, p, freeKeys);
        } else if (Array.isArray(cur)) {
            if (Array.isArray(v)) base[k] = v;
            else console.warn(`⚠️  settings.${p}: list expected, default kept.`);
        } else if (typeof v === typeof cur) {
            base[k] = v;
        } else {
            console.warn(`⚠️  settings.${p}: ${typeof cur} expected, default kept.`);
        }
    }
}

const FREE_KEYS = new Set(["roster.targetCounts", "recruitment.singletonTraitPositions"]);

/** Full settings = defaults + user override (no side effects). */
export function resolveSettings(override?: unknown): Settings {
    const s = clone(DEFAULT_SETTINGS);
    merge(s as unknown as Record<string, unknown>, override, "", FREE_KEYS);
    sanitizeLiberoPhases(s);
    if (!(s.lineup.reserveObjectiveWeight < s.lineup.subObjectiveWeight && s.lineup.subObjectiveWeight < 1)) {
        console.warn(
            "⚠️  settings.lineup: expected 0 < reserveObjectiveWeight < subObjectiveWeight < 1 " +
            "(otherwise the bench may be preferred over the starters)."
        );
    }
    return s;
}

/**
 * Libero phase traits: removes unknown names and duplicates, and
 * puts back in both phases (with a warning) a trait listed on both sides.
 */
function sanitizeLiberoPhases(s: Settings): void {
    const l = s.libero;
    const clean = (key: "receptionOnlyTraits" | "defenseOnlyTraits"): string[] => {
        for (const x of l[key]) {
            if (!ALL_TRAITS.includes(x)) console.warn(`⚠️  settings.libero.${key}: unknown trait "${x}", ignored.`);
        }
        return ALL_TRAITS.filter((x) => l[key].includes(x));
    };
    const rec = clean("receptionOnlyTraits");
    const def = clean("defenseOnlyTraits");
    const both = rec.filter((x) => def.includes(x));
    for (const x of both) {
        console.warn(`⚠️  settings.libero: "${x}" listed in receptionOnlyTraits and defenseOnlyTraits — counted in both phases.`);
    }
    l.receptionOnlyTraits = rec.filter((x) => !both.includes(x));
    l.defenseOnlyTraits = def.filter((x) => !both.includes(x));
}

/** Enables settings (replaces SETTINGS in place). */
export function applySettings(s: Settings): void {
    Object.assign(SETTINGS, clone(s));
    for (const fn of onSettingsChange) fn();
}

/** Subscribers notified on each settings change (e.g. clearing a cache). */
export const onSettingsChange: (() => void)[] = [];
