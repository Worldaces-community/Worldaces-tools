/**
 * Réglages de l'analyse (seuils, poids du MILP, quotas du roster…).
 *
 * Tout ce qui relève d'un CHOIX de l'utilisateur vit ici et se règle dans le
 * bloc `settings` du params.json (cf. `applySettings`, appelé par
 * `normalizeParams`). Les constantes de MÉCANIQUE DU JEU (matrice des signes,
 * seuils d'activation, formules…) restent dans constants.ts / signs.ts.
 *
 * Les valeurs par défaut ci-dessous sont un point de départ neutre : chaque
 * utilisateur exporte ses propres réglages depuis l'éditeur web.
 */

import { RoleName } from "../types";

export interface Settings {
    /**
     * Exposant de la moyenne de puissance des stats : 1 = moyenne pondérée
     * simple ; 0 < p < 1 = pénalise les profils déséquilibrés (stats basses).
     */
    balanceExponent: number;

    lineup: {
        /** Poids λ des remplaçants dans l'objectif du 5-1 (0 < λ < 1). */
        subObjectiveWeight: number;
        /** Poids λᵣ des réservistes (0 < λᵣ < λ). */
        reserveObjectiveWeight: number;
        /** Optimise la chimie des signes (si le CSV a une colonne Sign). */
        signSynergy: boolean;
        /** Garde-fou du branch & bound de la synergie (secondes). */
        synergyTimeLimitSec: number;
    };

    availability: {
        /**
         * Gain minimal (somme des 7 titulaires + synergie, échelle 0-99) qu'un
         * « Starting to decline » doit apporter pour rester disponible.
         */
        declineExceptionalMinGain: number;
    };

    academy: {
        /** Âge maximal (inclus) pour être éligible à l'Academy. */
        maxAge: number;
    };

    libero: {
        /** Δ minimal entre les 2 libéros sur une phase pour conseiller la rotation. */
        subMinDelta: number;
    };

    roster: {
        /** Taille de roster visée (section « joueurs à vendre » au-delà). */
        target: number;
        /** Quota maximal par rôle dans le roster gardé. */
        targetCounts: Record<RoleName, number>;
    };

    recruitment: {
        /** Traits « uniques » : un seul porteur utile dans la lineup. */
        singletonTraits: string[];
        /** Multiplicateur de priorité d'un trait unique absent de la lineup. */
        singletonPriorityBonus: number;
        /**
         * Pour un trait unique : rôles où sa présence compte (ex. Master Mind
         * → passeur / libéro). Absent ⇒ tous les titulaires comptent.
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
    },
    availability: {
        declineExceptionalMinGain: 5,
    },
    academy: {
        maxAge: 20,
    },
    libero: {
        subMinDelta: 5,
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

/** Copie profonde (les réglages ne contiennent que du JSON). */
function clone<T>(v: T): T {
    return JSON.parse(JSON.stringify(v)) as T;
}

/** Réglages actifs (lus à l'exécution par le moteur). */
export const SETTINGS: Settings = clone(DEFAULT_SETTINGS);

const isObj = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Fusion profonde `override` → `base` : seules les clés connues de `base` sont
 * reprises, avec le même type (sinon avertissement et valeur par défaut). Les
 * objets à clés libres (targetCounts, singletonTraitPositions) sont repris tels
 * quels.
 */
function merge(base: Record<string, unknown>, override: unknown, path: string, freeKeys: Set<string>): void {
    if (!isObj(override)) return;
    for (const [k, v] of Object.entries(override)) {
        const p = path ? `${path}.${k}` : k;
        if (k.startsWith("_")) continue; // commentaires
        if (!(k in base)) {
            console.warn(`⚠️  settings.${p} : réglage inconnu, ignoré.`);
            continue;
        }
        const cur = base[k];
        if (freeKeys.has(p)) {
            if (isObj(v)) base[k] = { ...(cur as object), ...v };
            else console.warn(`⚠️  settings.${p} : objet attendu, valeur par défaut gardée.`);
        } else if (isObj(cur)) {
            merge(cur, v, p, freeKeys);
        } else if (Array.isArray(cur)) {
            if (Array.isArray(v)) base[k] = v;
            else console.warn(`⚠️  settings.${p} : liste attendue, valeur par défaut gardée.`);
        } else if (typeof v === typeof cur) {
            base[k] = v;
        } else {
            console.warn(`⚠️  settings.${p} : ${typeof cur} attendu, valeur par défaut gardée.`);
        }
    }
}

const FREE_KEYS = new Set(["roster.targetCounts", "recruitment.singletonTraitPositions"]);

/** Réglages complets = défauts + surcharge utilisateur (sans effet de bord). */
export function resolveSettings(override?: unknown): Settings {
    const s = clone(DEFAULT_SETTINGS);
    merge(s as unknown as Record<string, unknown>, override, "", FREE_KEYS);
    if (!(s.lineup.reserveObjectiveWeight < s.lineup.subObjectiveWeight && s.lineup.subObjectiveWeight < 1)) {
        console.warn(
            "⚠️  settings.lineup : il faut 0 < reserveObjectiveWeight < subObjectiveWeight < 1 " +
            "(sinon le banc peut passer devant les titulaires)."
        );
    }
    return s;
}

/** Active des réglages (remplace SETTINGS en place). */
export function applySettings(s: Settings): void {
    Object.assign(SETTINGS, clone(s));
    for (const fn of onSettingsChange) fn();
}

/** Abonnés notifiés à chaque changement de réglages (ex. vider un cache). */
export const onSettingsChange: (() => void)[] = [];
