/**
 * 2nd libero rotation — reception / serve substitution.
 *
 * The game lets the 2nd libero come in / go out depending on the game PHASE:
 *   - RECEPTION: we receive the opponent's serve
 *   - SERVE    : we serve, then defend the opponent's attack (dig)
 *
 * This module compares our 2 selected liberos (5-1 starter + their
 * substitute) on TWO distinct sub-profiles derived from the libero config:
 *   - a RECEPTION profile (libero stats + traits useful in reception)
 *   - a DEFENSE   profile (libero stats + traits useful in defense)
 *
 * Sub-stats count in both phases: only traits distinguish the
 * profiles. The trait split is a user setting:
 * settings.libero (by default Guardian in reception, Defensive Specialist and
 * Last Resort in defense).
 *
 * Decision: the main libero (best overall score) plays by default; the
 * rotation brings the other one in for the ONLY phase where they do
 * better. The rotation gain is therefore a single number — their lead over the
 * main libero in that phase — compared to settings.libero.subMinDelta (margin
 * for the uncertainty of trait bonuses and the unmodeled sign chemistry).
 */

import { Player, RoleConfig } from "../types";
import { scorePlayer } from "../scoring";
import { deriveLiberoReception, deriveLiberoDefense } from "../config/roleConfig";
import { SETTINGS } from "../config/settings";

export interface LiberoPhaseScore {
    player: Player;
    /** Overall libero score (base profile) — picks the main libero. */
    overallScore: number;
    /** Score on the RECEPTION sub-profile (normalized ~0-99). */
    receptionScore: number;
    /** Score on the DEFENSE sub-profile (normalized ~0-99). */
    defenseScore: number;
    /** Traits held that are useful only in reception (e.g. Guardian). */
    receptionOnlyTraits: string[];
    /** Traits held that are useful only in defense (e.g. Defensive Specialist). */
    defenseOnlyTraits: string[];
}

/**
 * - `single`: only one libero → rotation impossible.
 * - `rotate`: the 2nd libero gains at least subMinDelta in one phase → bring them in there.
 * - `none`  : one libero is better in both phases, or the gain is too small.
 */
export type LiberoRotationVerdict = "single" | "rotate" | "none";

export type LiberoPhase = "reception" | "defense";

export interface LiberoRotationAnalysis {
    liberos: LiberoPhaseScore[];
    /** Main libero (best overall score) — the one who plays by default. */
    primary: LiberoPhaseScore | null;
    /** Recommended libero in the reception phase (= main unless rotating). */
    receptionLibero: LiberoPhaseScore | null;
    /** Recommended libero in the serve / defense phase (= main unless rotating). */
    defenseLibero: LiberoPhaseScore | null;
    /** Phase where the 2nd libero beats the main one (null: nowhere). */
    rotationPhase: LiberoPhase | null;
    /** Lead of the 2nd libero over the main one in `rotationPhase` (0 if none). */
    gain: number;
    verdict: LiberoRotationVerdict;
    /** Human-readable explanation of the decision. */
    note: string;
}

function phaseScore(
    player: Player,
    liberoConfig: RoleConfig,
    receptionConfig: RoleConfig,
    defenseConfig: RoleConfig
): LiberoPhaseScore {
    return {
        player,
        overallScore:   scorePlayer(player, liberoConfig).score,
        receptionScore: scorePlayer(player, receptionConfig).score,
        defenseScore:   scorePlayer(player, defenseConfig).score,
        receptionOnlyTraits: SETTINGS.libero.receptionOnlyTraits.filter((t) => player.traits.includes(t)),
        defenseOnlyTraits:   SETTINGS.libero.defenseOnlyTraits.filter((t) => player.traits.includes(t)),
    };
}

const PHASE_SCORE = { reception: "receptionScore", defense: "defenseScore" } as const;
const PHASE_LABEL = { reception: "RECEPTION phase", defense: "SERVE / DEFENSE phase" };

/**
 * Analyzes the 2nd libero rotation for our selected liberos.
 *
 * @param liberos      Selected liberos (starter + substitute) — nullish ones are ignored.
 * @param liberoConfig Base libero config (params.roles.libero).
 */
export function analyzeLiberoRotation(
    liberos: (Player | null | undefined)[],
    liberoConfig: RoleConfig
): LiberoRotationAnalysis {
    const receptionConfig = deriveLiberoReception(liberoConfig);
    const defenseConfig   = deriveLiberoDefense(liberoConfig);

    // Filter out nullish + dedupe by name (the same player cannot hold
    // both libero slots, but guard against it anyway).
    const seen = new Set<string>();
    const scored: LiberoPhaseScore[] = [];
    for (const p of liberos) {
        if (!p || seen.has(p.fullName)) continue;
        seen.add(p.fullName);
        scored.push(phaseScore(p, liberoConfig, receptionConfig, defenseConfig));
    }

    // Fewer than 2 liberos → no rotation possible.
    if (scored.length < 2) {
        const only = scored[0] ?? null;
        return {
            liberos: scored,
            primary: only,
            receptionLibero: only,
            defenseLibero: only,
            rotationPhase: null,
            gain: 0,
            verdict: "single",
            note: only
                ? `Only one libero selected (${only.player.fullName}) — no reception/serve rotation ` +
                  `possible. Recruit or develop a 2nd libero to enable it.`
                : "No libero selected.",
        };
    }

    const [a, b] = scored;
    const recBest = b.receptionScore > a.receptionScore ? b : a;
    const defBest = b.defenseScore   > a.defenseScore   ? b : a;

    // A libero better in both phases plays the whole match.
    if (recBest === defBest) {
        const other = recBest === a ? b : a;
        return {
            liberos: scored,
            primary: recBest,
            receptionLibero: recBest,
            defenseLibero: recBest,
            rotationPhase: null,
            gain: 0,
            verdict: "none",
            note:
                `${recBest.player.fullName} is better in both reception AND defense — no useful rotation. ` +
                `${other.player.fullName} stays as backup (injury).`,
        };
    }

    // Otherwise each has "their" phase: the main libero (best overall) keeps
    // theirs, the 2nd can only contribute in the other one.
    const primary = b.overallScore > a.overallScore ? b : a;
    const second  = primary === a ? b : a;
    const rotationPhase: LiberoPhase = second === recBest ? "reception" : "defense";
    const key  = PHASE_SCORE[rotationPhase];
    const gain = second[key] - primary[key];
    const rotate = gain >= SETTINGS.libero.subMinDelta;

    const note = rotate
        ? `Keep ${primary.player.fullName} as starting libero and bring ${second.player.fullName} in ` +
          `for the ${PHASE_LABEL[rotationPhase]}: Δ+${gain.toFixed(1)} on that phase.`
        : `${second.player.fullName} is slightly better in the ${PHASE_LABEL[rotationPhase]} ` +
          `(Δ+${gain.toFixed(1)} < ${SETTINGS.libero.subMinDelta}) — not worth rotating, keep ` +
          `${primary.player.fullName} for both phases.`;

    return {
        liberos: scored,
        primary,
        receptionLibero: rotate && rotationPhase === "reception" ? second : primary,
        defenseLibero:   rotate && rotationPhase === "defense"   ? second : primary,
        rotationPhase,
        gain,
        verdict: rotate ? "rotate" : "none",
        note,
    };
}
