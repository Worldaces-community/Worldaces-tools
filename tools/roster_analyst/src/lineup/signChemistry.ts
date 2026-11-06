/**
 * Sign chemistry on the 5-1 court — model shared by the lineup MILP
 * (LineupBuilder), the display and recruitment.
 *
 * Court: the game always computes chemistry over the 7 starters (both MBs
 * and the libero included, even when one of them is not on the court during
 * the rally). It is re-evaluated only on a position-for-position
 * substitution, still over 7 signs.
 *
 * Substitutions accumulate during a set: starters leave in the order of
 * `settings.lineup.substitutionOrder` (each for their own substitute), so
 * the court goes through states 0 (starting 7), 1, 2, … (see
 * substitutionStates). Bench chemistry = λ · mean over the states k ≥ 1 of
 * [C(state k) − C(state 0)]: the starting 7 keeps a fixed weight of 1, the
 * substitutions add their average gain / loss once, weighted like the
 * substitutes' scores.
 *
 * Value (score points):
 *   - each non-setter's sign effect (chemistry ≥ 3) earns their sign bonus
 *     (signScore, included in their score: lost if inactive);
 *   - each setter ↔ attacker connection (2 OH, OP, 2 MB): chemistry(setter) +
 *     chemistry(attacker) ≥ 3 earns the setter's connection bonus
 *     (connectionScore, not included in the score).
 */

import { RoleName, Sign, ScoredPlayer } from "../types";
import {
    LIBERO_SIGN_EFFECT,
    chemistryOf,
    SIGN_ACTIVATION_THRESHOLD,
    SETTER_SYNERGY_THRESHOLD,
} from "../config/signs";

export type CourtRole = "setter" | "hitter" | "libero";

export function courtRoleOf(role: RoleName): CourtRole {
    if (role === "setter") return "setter";
    if (role === "libero") return "libero";
    return "hitter";
}

/** The 7 starter slots whose signs make up the chemistry (see header). */
export const FIVE_ONE_COURT: string[] = [
    "Setter", "Front Outside Hitter", "Back Outside Hitter", "Opposite",
    "Front Middle Blocker", "Back Middle Blocker", "Libero",
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
}

/** Evaluates a court composition (members without a player excluded upstream). */
export function evaluateCourt(members: CourtMember[]): CourtEval {
    const chem = new Map<string, number>();
    for (const m of members) {
        chem.set(m.key, chemistryOf(m.sign, members.filter((o) => o !== m).map((o) => o.sign)));
    }
    const active = new Map<string, boolean>();
    const connected = new Map<string, boolean>();
    const setter = members.find((m) => m.role === "setter");
    for (const m of members) {
        if (m.role === "setter") continue;
        const on = !!m.sign && chem.get(m.key)! >= SIGN_ACTIVATION_THRESHOLD;
        active.set(m.key, on);
        if (m.role === "hitter") {
            const ok = !!setter?.sign && !!m.sign &&
                chem.get(setter.key)! + chem.get(m.key)! >= SETTER_SYNERGY_THRESHOLD;
            connected.set(m.key, ok);
        }
    }
    return { chem, active, connected };
}

// ─── Lineup analysis (display + recruitment) ─────────────────────────────────

export interface StarterChemistry {
    slot: string;
    sign: Sign | null;
    name: string | null;
    /** Chemistry (null = empty slot). */
    chem: number | null;
    /** Sign effect active (null = empty slot or setter). */
    active: boolean | null;
    /** Connection with the setter (null = not an attacker). */
    connected: boolean | null;
    /** Sign bonus earned (signScore if the effect is active, else 0). */
    signGain: number;
    /** Connection value earned (connectionScore of the setter if connected, else 0). */
    connectionGain: number;
}

export interface ChemistryAnalysis {
    /** false ⇒ no sign in the CSV: section not displayed. */
    hasSigns: boolean;
    starters: StarterChemistry[];
    /** Active sign effects / non-setter starters with a sign. */
    effects: { active: number; total: number };
    /** Connected attackers / attackers with a sign (0 without a setter sign). */
    connections: { active: number; total: number };
    /** Score points earned by the activations (sign bonuses + connections). */
    gain: number;
}

type Lineup = Record<string, ScoredPlayer | null>;

function courtMembers(lineup: Lineup): CourtMember[] {
    return FIVE_ONE_COURT
        .filter((slot) => lineup[slot])
        .map((slot) => ({
            key: slot,
            role: courtRoleOf(FIVE_ONE_SLOT_ROLES[slot]),
            sign: lineup[slot]!.player.sign,
        }));
}

/** Chemistry evaluation of a starters lineup. */
export function evaluateLineup(lineup: Lineup): CourtEval {
    return evaluateCourt(courtMembers(lineup));
}

/**
 * Sign bonus (signScore, included in the score) lost by a starter whose
 * sign effect is inactive; 0 for the setter (no sign effect to activate).
 */
export function lostSignScore(lineup: Lineup, ev: CourtEval, slot: string): number {
    const sp = lineup[slot];
    return sp && ev.active.get(slot) === false ? sp.signScore : 0;
}

/** Value of one setter ↔ attacker connection (setter's connectionScore). */
export function connectionValue(lineup: Lineup): number {
    return lineup["Setter"]?.connectionScore ?? 0;
}

/**
 * Chemistry value of a starters lineup, relative to the scores (which
 * assume the sign effects active): connections × connection value − sign
 * bonus lost to inactive effects. Σ scores + this = actual value.
 */
export function lineupChemValue(lineup: Lineup, ev: CourtEval = evaluateLineup(lineup)): number {
    let connected = 0;
    for (const ok of ev.connected.values()) if (ok) connected++;
    const lost = FIVE_ONE_COURT.reduce((s, slot) => s + lostSignScore(lineup, ev, slot), 0);
    return connected * connectionValue(lineup) - lost;
}

export function analyzeChemistry(lineup: Lineup, order: string[]): ChemistryAnalysis {
    const hasSigns = Object.values(lineup).some((sp) => !!sp?.player.sign);
    const ev = evaluateLineup(lineup);
    const conn = connectionValue(lineup);
    const starters: StarterChemistry[] = order.map((slot) => {
        const sp = lineup[slot];
        const active = ev.active.get(slot) ?? null;
        const connected = ev.connected.get(slot) ?? null;
        return {
            slot,
            sign: sp?.player.sign ?? null,
            name: sp?.player.fullName ?? null,
            chem: ev.chem.get(slot) ?? null,
            active,
            connected,
            signGain: active ? sp!.signScore : 0,
            connectionGain: connected ? conn : 0,
        };
    });
    const signed = (slot: string) => !!lineup[slot]?.player.sign;
    const count = (m: Map<string, boolean>) => {
        let active = 0, total = 0;
        for (const [slot, on] of m) if (signed(slot)) { total++; if (on) active++; }
        return { active, total };
    };
    const effects = count(ev.active);
    const connections = signed("Setter") ? count(ev.connected) : { active: 0, total: 0 };
    const gain = starters.reduce((s, x) => s + x.signGain + x.connectionGain, 0);
    return { hasSigns, starters, effects, connections, gain };
}

// ─── Accumulated substitutions ───────────────────────────────────────────────

export interface SubstitutionState {
    /** 0 = starting 7, k = k substitutions made. */
    step: number;
    /** Substitution that led to this state (null for the starting 7). */
    entered: { slot: string; in: string; out: string } | null;
    /** The 7 players of the chemistry in this state. */
    lineup: Lineup;
    analysis: ChemistryAnalysis;
    /** Chemistry value (lineupChemValue) of this state. */
    value: number;
    /** Weight of the state in the lineup objective (1 for the starting 7, λ / K otherwise). */
    weight: number;
}

/**
 * Successive court states of a set: state 0 = starters, then, for each slot
 * of `order` that has a starter AND a substitute, the substitute replaces the
 * starter and stays (no return). `subs`: substitute by starter slot.
 */
export function substitutionStates(
    lineup: Lineup,
    subs: Record<string, ScoredPlayer | null>,
    order: string[],
    lambda: number,
    displayOrder: string[] = FIVE_ONE_COURT
): SubstitutionState[] {
    const steps = order.filter((slot) => lineup[slot] && subs[slot]);
    const states: SubstitutionState[] = [];
    let cur: Lineup = { ...lineup };
    const push = (entered: SubstitutionState["entered"]) => states.push({
        step: states.length, entered, lineup: cur,
        analysis: analyzeChemistry(cur, displayOrder), value: lineupChemValue(cur),
        weight: states.length === 0 ? 1 : lambda / steps.length,
    });
    push(null);
    for (const slot of steps) {
        const out = cur[slot]!.player.fullName;
        cur = { ...cur, [slot]: subs[slot] };
        push({ slot, in: subs[slot]!.player.fullName, out });
    }
    return states;
}

/** Bench chemistry term: λ · mean_k≥1 [C(state k) − C(state 0)] (0 without substitution). */
export function benchChemValue(states: SubstitutionState[]): number {
    return states.slice(1).reduce((s, st) => s + st.weight * (st.value - states[0].value), 0);
}

// ─── Shared formatting (console + markdown) ──────────────────────────────────

/** "+3", "-1"; "—" for an empty slot. */
export function fmtChem(value: number | null): string {
    return value === null ? "—" : value > 0 ? `+${value}` : `${value}`;
}

/** ✓ · ✗ · — (not applicable), with the points earned when active ("✓ +4.2"). */
export function fmtOn(value: boolean | null, gain = 0): string {
    if (value === null) return "—";
    if (!value) return "✗";
    return Math.abs(gain) >= 0.05 ? `✓ ${gain > 0 ? "+" : "−"}${Math.abs(gain).toFixed(1)}` : "✓";
}

/** Sign (+ libero effect in parentheses for the libero). */
export function fmtSign(s: StarterChemistry): string {
    if (!s.sign) return "—";
    return s.slot === "Libero" ? `${s.sign} (${LIBERO_SIGN_EFFECT[s.sign]})` : s.sign;
}

/** Summary verdict: "+12.4 pts · effects 5/6 · connections 4/5". */
export function fmtChemVerdict(a: ChemistryAnalysis): string {
    return `${a.gain >= 0 ? "+" : "−"}${Math.abs(a.gain).toFixed(1)} pts · effects ${a.effects.active}/${a.effects.total}` +
        ` · connections ${a.connections.active}/${a.connections.total}`;
}

/** "+3.2" / "−1.0" (points). */
export function fmtPts(v: number): string {
    return `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(1)}`;
}

/** State title: "Starting 7" / "2. Jiu Zi Cun Song in for Zhi Mei Pian Gang (Back Outside Hitter)". */
export function fmtStateTitle(st: SubstitutionState): string {
    return st.entered
        ? `${st.step}. ${st.entered.in} in for ${st.entered.out} (${st.entered.slot})`
        : "Starting 7";
}

/** State summary: "weight 0.13 · value −11.4 (Δ −18.7) · effects 0/6 · connections 1/5". */
export function fmtStateVerdict(st: SubstitutionState, start: SubstitutionState): string {
    const a = st.analysis;
    const delta = st.step ? ` (Δ ${fmtPts(st.value - start.value)})` : "";
    return `weight ${st.weight.toFixed(2)} · value ${fmtPts(st.value)}${delta} · ` +
        `effects ${a.effects.active}/${a.effects.total} · connections ${a.connections.active}/${a.connections.total}`;
}
