/**
 * Role types for World Aces roster analysis
 */

import type { Settings } from "../config/settings";

export type RoleName = "setter" | "outsideHitter" | "middleBlocker" | "oppositeHitter" | "libero";

export interface RoleConfig {
    statsWeights: Record<string, number>;
    traitBonuses: Record<string, number>;
    /** Bonus (léger) de la valeur de l'effet du signe pour ce rôle. */
    signBonuses?: Record<string, number>;
}

export interface Params {
    /**
     * Multiplicateur global des traitBonuses (appliqué au chargement par
     * loadParams) — règle le poids des traits face aux stats. Défaut 1.
     */
    traitWeight?: number;
    roles: Record<RoleName, RoleConfig>;
    /** Seuils / poids de l'analyse (cf. config/settings.ts) ; complétés par les défauts. */
    settings?: Partial<Settings>;
}
