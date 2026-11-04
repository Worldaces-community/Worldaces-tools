/**
 * Role types for World Aces roster analysis
 */

import type { Settings } from "../config/settings";

export type RoleName = "setter" | "outsideHitter" | "middleBlocker" | "oppositeHitter" | "libero";

export interface RoleConfig {
    statsWeights: Record<string, number>;
    traitBonuses: Record<string, number>;
    /** (Light) bonus for the value of the sign effect for this role (not the setter). */
    signBonuses?: Record<string, number>;
    /**
     * Setter only: points earned per connected attacker (chemistry(setter) +
     * chemistry(attacker) ≥ 3). The setter activates no sign effect.
     */
    connectionBonus?: number;
}

export interface Params {
    /**
     * Global multiplier of the traitBonuses (applied on load by
     * loadParams): a trait rated r adds r × traitWeight points. Not a share
     * of the score. Default 1.
     */
    traitWeight?: number;
    /**
     * Global multiplier of the signBonuses and of the setter's
     * connectionBonus (applied on load), like traitWeight. Default 1.
     */
    signWeight?: number;
    roles: Record<RoleName, RoleConfig>;
    /** Analysis thresholds / weights (see config/settings.ts); completed with the defaults. */
    settings?: Partial<Settings>;
}
