/**
 * Role types for World Aces roster analysis
 */

import type { Settings } from "../config/settings";

export type RoleName = "setter" | "outsideHitter" | "middleBlocker" | "oppositeHitter" | "libero";

export interface RoleConfig {
    statsWeights: Record<string, number>;
    traitBonuses: Record<string, number>;
    /** (Light) bonus for the value of the sign effect for this role. */
    signBonuses?: Record<string, number>;
}

export interface Params {
    /**
     * Global multiplier of the traitBonuses (applied on load by
     * loadParams) — sets the weight of traits vs stats. Default 1.
     */
    traitWeight?: number;
    roles: Record<RoleName, RoleConfig>;
    /** Analysis thresholds / weights (see config/settings.ts); completed with the defaults. */
    settings?: Partial<Settings>;
}
