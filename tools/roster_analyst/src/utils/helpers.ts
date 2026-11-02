/**
 * Utility helper functions
 */

import { Player, RoleName } from "../types";
import { ROLE_GAME_NAMES } from "../config";

/**
 * Check if a player has a specific role
 */
export function hasRole(player: Player, role: RoleName): boolean {
    const gameNames = ROLE_GAME_NAMES[role];
    return player.roles.some((r) => gameNames.some((g) => r.includes(g)));
}

/**
 * Filter function factory for role-based filtering
 */
export function getRoleFilter(role: RoleName) {
    return (p: Player) => hasRole(p, role);
}
