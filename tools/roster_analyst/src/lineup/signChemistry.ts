/**
 * Sign chemistry on the 5-1 court — model shared by the lineup MILP
 * (LineupBuilder), the display and recruitment.
 *
 * Court: in a 5-1 the libero replaces the back-row MB, so the two MBs
 * are never on the court together. We model 2 PHASES of equal
 * weight (½ each):
 *   A : Setter · Front OH · Back OH · Opposite · Front MB · Libero
 *   B : Setter · Front OH · Back OH · Opposite · Back MB  · Libero
 *
 * Synergy "units" per phase (9 at most):
 *   - activation of each non-setter's sign (chemistry ≥ 3): 5;
 *   - setter ↔ attacker connection (OH, OP, MB): chemistry(setter) +
 *     chemistry(attacker) ≥ 3: 4.
 * Perfect synergy = 9 units in both phases ⇒ +10 % win.
 */

import { RoleName, Sign, ScoredPlayer } from "../types";
import {
    LIBERO_SIGN_EFFECT,
    chemistryOf,
    SIGN_ACTIVATION_THRESHOLD,
    SETTER_SYNERGY_THRESHOLD,
    SIGN_SYNERGY_MAX_WIN_GAIN,
} from "../config/signs";

export type CourtRole = "setter" | "hitter" | "libero";

export function courtRoleOf(role: RoleName): CourtRole {
    if (role === "setter") return "setter";
    if (role === "libero") return "libero";
    return "hitter";
}

/** Starter slots on the court in each phase (see header). */
export const FIVE_ONE_COURTS: string[][] = [
    ["Setter", "Front Outside Hitter", "Back Outside Hitter", "Opposite", "Front Middle Blocker", "Libero"],
    ["Setter", "Front Outside Hitter", "Back Outside Hitter", "Opposite", "Back Middle Blocker", "Libero"],
];

/** Role of each 5-1 starter slot. */
export const FIVE_ONE_SLOT_ROLES: Record<string, RoleName> = {
    "Setter": "setter",
    "Libero": "libero",
    "Front Outside Hitter": "outsideHitter",
    "Back Outside Hitter": "outsideHitter",
    "Front Middle Blocker": "middleBlocker",
    "Back Middle Blocker": "middleBlocker",
    "Opposite": "oppositeHitter",
};

/** Maximum units per phase (5 activations + 4 connections). */
export const UNITS_PER_PHASE = 9;

export interface CourtMember {
    key: string;
    role: CourtRole;
    sign: Sign | null;
}

export interface CourtEval {
    chem: Map<string, number>;
    active: Map<string, boolean>;
    /** Setter ↔ attacker connection, by attacker key. */
    connected: Map<string, boolean>;
    units: number;
}

/** Evaluates a court composition (members without a player excluded upstream). */
export function evaluateCourt(members: CourtMember[]): CourtEval {
    const chem = new Map<string, number>();
    for (const m of members) {
        chem.set(m.key, chemistryOf(m.sign, members.filter((o) => o !== m).map((o) => o.sign)));
    }
    const active = new Map<string, boolean>();
    const connected = new Map<string, boolean>();
    let units = 0;
    const setter = members.find((m) => m.role === "setter");
    for (const m of members) {
        if (m.role === "setter") continue;
        const on = !!m.sign && chem.get(m.key)! >= SIGN_ACTIVATION_THRESHOLD;
        active.set(m.key, on);
        if (on) units++;
        if (m.role === "hitter") {
            const ok = !!setter?.sign && !!m.sign &&
                chem.get(setter.key)! + chem.get(m.key)! >= SETTER_SYNERGY_THRESHOLD;
            connected.set(m.key, ok);
            if (ok) units++;
        }
    }
    return { chem, active, connected, units };
}

// ─── Lineup analysis (display + recruitment) ─────────────────────────────────

export interface StarterChemistry {
    slot: string;
    sign: Sign | null;
    name: string | null;
    /** Chemistry per phase (null = not on the court in this phase). */
    chem: (number | null)[];
    /** Sign effect active per phase (null = off the court or setter). */
    active: (boolean | null)[];
    /** Connection with the setter per phase (attackers only). */
    connected: (boolean | null)[];
}

export interface ChemistryAnalysis {
    /** false ⇒ no sign in the CSV: section not displayed. */
    hasSigns: boolean;
    starters: StarterChemistry[];
    /** Units reached (average of the 2 phases, 0-9). */
    units: number;
    ratio: number;
    /** Estimated win gain (ratio × 10 %). */
    winGain: number;
}

type Lineup = Record<string, ScoredPlayer | null>;

function phaseMembers(lineup: Lineup, court: string[]): CourtMember[] {
    return court
        .filter((slot) => lineup[slot])
        .map((slot) => ({
            key: slot,
            role: courtRoleOf(FIVE_ONE_SLOT_ROLES[slot]),
            sign: lineup[slot]!.player.sign,
        }));
}

/** Average units (2 phases) of a starters lineup. */
export function lineupUnits(lineup: Lineup): number {
    return FIVE_ONE_COURTS.reduce(
        (s, court) => s + evaluateCourt(phaseMembers(lineup, court)).units / FIVE_ONE_COURTS.length,
        0
    );
}

export function analyzeChemistry(lineup: Lineup, order: string[]): ChemistryAnalysis {
    const hasSigns = Object.values(lineup).some((sp) => !!sp?.player.sign);
    const evals = FIVE_ONE_COURTS.map((court) => evaluateCourt(phaseMembers(lineup, court)));
    const starters: StarterChemistry[] = order.map((slot) => {
        const sp = lineup[slot];
        const pick = <T>(f: (e: CourtEval) => T | undefined) =>
            FIVE_ONE_COURTS.map((court, i) =>
                sp && court.includes(slot) ? (f(evals[i]) ?? null) : null);
        return {
            slot,
            sign: sp?.player.sign ?? null,
            name: sp?.player.fullName ?? null,
            chem: pick((e) => e.chem.get(slot)),
            active: pick((e) => e.active.get(slot)),
            connected: pick((e) => e.connected.get(slot)),
        };
    });
    const units = evals.reduce((s, e) => s + e.units, 0) / evals.length;
    const ratio = units / UNITS_PER_PHASE;
    return { hasSigns, starters, units, ratio, winGain: ratio * SIGN_SYNERGY_MAX_WIN_GAIN };
}

// ─── Shared formatting (console + markdown) ──────────────────────────────────

/** "3 / 2" (2 phases) or "1" (MB, a single phase); "—" off the court. */
export function fmtChem(values: (number | null)[]): string {
    const v = values.filter((x): x is number => x !== null);
    return v.length ? v.map((x) => (x > 0 ? `+${x}` : `${x}`)).join(" / ") : "—";
}

/** ✓ (all phases) · ½ (one phase out of two) · ✗ · — (not applicable). */
export function fmtOn(values: (boolean | null)[]): string {
    const v = values.filter((x): x is boolean => x !== null);
    if (!v.length) return "—";
    const n = v.filter(Boolean).length;
    return n === v.length ? "✓" : n === 0 ? "✗" : "½";
}

/** Sign (+ libero effect in parentheses for the libero). */
export function fmtSign(s: StarterChemistry): string {
    if (!s.sign) return "—";
    return s.slot === "Libero" ? `${s.sign} (${LIBERO_SIGN_EFFECT[s.sign]})` : s.sign;
}

/** Summary verdict: "5.5/9 · ≈ +6.1 % win". */
export function fmtChemVerdict(a: ChemistryAnalysis): string {
    return `${a.units.toFixed(1)}/${UNITS_PER_PHASE} · ≈ +${(a.winGain * 100).toFixed(1)} % win chance`;
}
