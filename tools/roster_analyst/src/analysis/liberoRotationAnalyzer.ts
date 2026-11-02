/**
 * Rotation du 2ᵉ libéro — substitution réception / service.
 *
 * Le jeu permet de faire entrer/sortir le 2ᵉ libéro selon la PHASE de jeu :
 *   - RÉCEPTION : on reçoit le service adverse
 *   - SERVICE   : on sert, puis on défend l'attaque adverse (dig)
 *
 * Ce module compare nos 2 libéros sélectionnés (titulaire du 5-1 + son
 * remplaçant) sur DEUX sous-profils distincts dérivés de la config libéro :
 *   - un profil RÉCEPTION (sous-stats de réception + traits utiles en réception)
 *   - un profil DÉFENSE   (sous-stats de dig + traits utiles en défense)
 *
 * Les traits sont différenciés : Guardian ne compte qu'en réception, Defensive
 * Specialist et Last Resort ne comptent qu'en défense (cf. constants). On en
 * déduit lequel est le meilleur receveur et lequel le meilleur défenseur, et si
 * l'écart entre les deux justifie d'activer la rotation réception/service.
 */

import { Player, RoleConfig } from "../types";
import { scorePlayer } from "../scoring";
import { deriveLiberoReception, deriveLiberoDefense } from "../config/roleConfig";
import {
    LIBERO_RECEPTION_ONLY_TRAITS,
    LIBERO_DEFENSE_ONLY_TRAITS,
} from "../config/constants";
import { SETTINGS } from "../config/settings";

export interface LiberoPhaseScore {
    player: Player;
    /** Score libéro global (profil de base) — départage / choix du primaire. */
    overallScore: number;
    /** Score sur le sous-profil RÉCEPTION (normalisé ~0-99). */
    receptionScore: number;
    /** Score sur le sous-profil DÉFENSE (normalisé ~0-99). */
    defenseScore: number;
    /** Traits présents utiles seulement en réception (ex. Guardian). */
    receptionOnlyTraits: string[];
    /** Traits présents utiles seulement en défense (ex. Defensive Specialist). */
    defenseOnlyTraits: string[];
}

/**
 * - `single`      : un seul libéro → rotation impossible.
 * - `system`      : spécialisation nette dans les DEUX phases → rotation conseillée.
 * - `situational` : spécialisation nette dans UNE seule phase → rotation partielle.
 * - `none`        : un libéro domine les deux phases, ou écarts négligeables.
 */
export type LiberoRotationVerdict = "single" | "system" | "situational" | "none";

export interface LiberoRotationAnalysis {
    liberos: LiberoPhaseScore[];
    /** Meilleur receveur (score réception max). */
    receptionSpecialist: LiberoPhaseScore | null;
    /** Meilleur défenseur (score défense max). */
    defenseSpecialist: LiberoPhaseScore | null;
    /** Libéro primaire (meilleur score global) — celui qui joue par défaut. */
    primary: LiberoPhaseScore | null;
    /** Δ réception = score du meilleur receveur − score de l'autre libéro (≥ 0). */
    receptionDelta: number;
    /** Δ défense = score du meilleur défenseur − score de l'autre libéro (≥ 0). */
    defenseDelta: number;
    /** Le meilleur receveur et le meilleur défenseur sont-ils 2 joueurs différents ? */
    specialistsDiffer: boolean;
    verdict: LiberoRotationVerdict;
    /** Explication lisible de la décision. */
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
        receptionOnlyTraits: LIBERO_RECEPTION_ONLY_TRAITS.filter((t) => player.traits.includes(t)),
        defenseOnlyTraits:   LIBERO_DEFENSE_ONLY_TRAITS.filter((t) => player.traits.includes(t)),
    };
}

/**
 * Analyse la rotation du 2ᵉ libéro pour nos libéros sélectionnés.
 *
 * @param liberos      Libéros retenus (titulaire + remplaçant) — les nullish sont ignorés.
 * @param liberoConfig Config libéro de base (params.roles.libero).
 */
export function analyzeLiberoRotation(
    liberos: (Player | null | undefined)[],
    liberoConfig: RoleConfig
): LiberoRotationAnalysis {
    const receptionConfig = deriveLiberoReception(liberoConfig);
    const defenseConfig   = deriveLiberoDefense(liberoConfig);

    // Filtre les nullish + dédoublonne par nom (un même joueur ne peut pas
    // occuper les deux slots libéro, mais on se protège).
    const seen = new Set<string>();
    const scored: LiberoPhaseScore[] = [];
    for (const p of liberos) {
        if (!p || seen.has(p.fullName)) continue;
        seen.add(p.fullName);
        scored.push(phaseScore(p, liberoConfig, receptionConfig, defenseConfig));
    }

    // Moins de 2 libéros → pas de rotation possible.
    if (scored.length < 2) {
        const only = scored[0] ?? null;
        return {
            liberos: scored,
            receptionSpecialist: only,
            defenseSpecialist:   only,
            primary:             only,
            receptionDelta: 0,
            defenseDelta:   0,
            specialistsDiffer: false,
            verdict: "single",
            note: only
                ? `Only one libero selected (${only.player.fullName}) — no reception/serve rotation ` +
                  `possible. Recruit or develop a 2nd libero to enable it.`
                : "No libero selected.",
        };
    }

    const primary = scored.reduce((a, b) => (b.overallScore   > a.overallScore   ? b : a));
    const recSpec = scored.reduce((a, b) => (b.receptionScore > a.receptionScore ? b : a));
    const defSpec = scored.reduce((a, b) => (b.defenseScore   > a.defenseScore   ? b : a));

    // « L'autre » libéro d'une paire de 2.
    const otherThan = (s: LiberoPhaseScore) => scored.find((x) => x !== s)!;
    const receptionDelta = recSpec.receptionScore - otherThan(recSpec).receptionScore;
    const defenseDelta   = defSpec.defenseScore   - otherThan(defSpec).defenseScore;

    const specialistsDiffer = recSpec.player.fullName !== defSpec.player.fullName;

    let verdict: LiberoRotationVerdict;
    if (!specialistsDiffer) {
        verdict = "none";
    } else if (receptionDelta >= SETTINGS.libero.subMinDelta && defenseDelta >= SETTINGS.libero.subMinDelta) {
        verdict = "system";
    } else if (receptionDelta >= SETTINGS.libero.subMinDelta || defenseDelta >= SETTINGS.libero.subMinDelta) {
        verdict = "situational";
    } else {
        verdict = "none";
    }

    const rec = (d: number) => `Δ+${d.toFixed(0)}`;
    let note: string;
    switch (verdict) {
        case "system":
            note =
                `Clear specialisation: ${recSpec.player.fullName} receives better (${rec(receptionDelta)}) ` +
                `and ${defSpec.player.fullName} defends better (${rec(defenseDelta)}). ` +
                `Bring ${recSpec.player.fullName} in for the RECEPTION phase and ` +
                `${defSpec.player.fullName} for the SERVE (defense) phase.`;
            break;
        case "situational":
            if (receptionDelta >= SETTINGS.libero.subMinDelta) {
                note =
                    `Difference mostly in RECEPTION: ${recSpec.player.fullName} is a clearly better ` +
                    `receiver (${rec(receptionDelta)}). Bring them in when receiving; in defense the gap ` +
                    `(${rec(defenseDelta)}) is small, keep ${defSpec.player.fullName} otherwise.`;
            } else {
                note =
                    `Difference mostly in DEFENSE: ${defSpec.player.fullName} is a clearly better ` +
                    `defender (${rec(defenseDelta)}). Bring them in when serving; in reception the gap ` +
                    `(${rec(receptionDelta)}) is small, keep ${recSpec.player.fullName} otherwise.`;
            }
            break;
        case "none":
            if (!specialistsDiffer) {
                note =
                    `${recSpec.player.fullName} is better in both reception AND defense — no useful rotation. ` +
                    `${otherThan(recSpec).player.fullName} stays as backup (injury).`;
            } else {
                note =
                    `Negligible gaps (reception ${rec(receptionDelta)}, defense ${rec(defenseDelta)}, ` +
                    `< ${SETTINGS.libero.subMinDelta} pts) — keep ${primary.player.fullName} for both phases, ` +
                    `the rotation is not worth it.`;
            }
            break;
        default:
            note = "";
    }

    return {
        liberos: scored,
        receptionSpecialist: recSpec,
        defenseSpecialist:   defSpec,
        primary,
        receptionDelta,
        defenseDelta,
        specialistsDiffer,
        verdict,
        note,
    };
}
