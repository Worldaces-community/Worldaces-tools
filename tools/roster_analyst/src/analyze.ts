/**
 * World Aces – 5-1 Roster Analyst : orchestration de l'analyse.
 *
 * Point d'entrée commun à la CLI (`cli.ts`) et à l'application web
 * (`web/worker.ts`) : aucune dépendance Node (fichiers, process…).
 *
 * Rapport (sections numérotées dynamiquement) :
 *   1. Classements par rôle
 *   2. Lineup 5-1 recommandé (titulaires / banc / réservistes, chimie des
 *      signes, rotation réception / service des 2 libéros)
 *   3. Academy & progression
 *   4. Points faibles + filtre de recrutement
 *   5. Gestion du roster — joueurs à vendre (si roster > cible, ou s'il y a des
 *      non-progressants à libérer en priorité)
 */

import { Player, ScoredPlayer, RoleName, Params } from "./types";
import { ROLE_LABELS } from "./config";
import { LineupBuilder } from "./lineup/lineupBuilder";
import { analyzeWeaknesses } from "./analysis/weaknessAnalyzer";
import { analyzeRecruitment } from "./analysis/recruitmentAnalyzer";
import { analyzeRosterBalance, rosterTarget } from "./analysis/rosterBalanceAnalyzer";
import { analyzeLiberoRotation } from "./analysis/liberoRotationAnalyzer";
import { analyzeAvailability, rankAll } from "./analysis/availabilityAnalyzer";
import { analyzeAcademy } from "./analysis/academyAnalyzer";
import { Reporter } from "./report";
import { analyzeChemistry } from "./lineup/signChemistry";

export { parseCSVText } from "./models";
export { normalizeParams, parseParams } from "./config";
export { MarkdownReporter, ConsoleReporter } from "./report";

/** Étapes signalées à `onProgress` (affichage d'avancement dans le web). */
export type AnalysisStep =
    | "availability" | "rankings" | "lineup" | "academy" | "recruitment" | "roster" | "done";

export interface AnalysisOptions {
    /** Libellé des params affiché dans l'en-tête du rapport (chemin, nom de fichier…). */
    paramsLabel?: string;
    onProgress?: (step: AnalysisStep) => void;
}

/**
 * Lance l'analyse complète et l'envoie à chaque reporter.
 * `params` doit sortir de `normalizeParams` / `parseParams` (réglages activés).
 */
export function runAnalysis(
    players: Player[],
    params: Params,
    reporters: Reporter[],
    options: AnalysisOptions = {}
): void {
    const progress = options.onProgress ?? (() => undefined);
    const report = (fn: (r: Reporter) => void): void => reporters.forEach(fn);

    // Disponibilité (Academy + progression), puis scores des joueurs
    // disponibles pour chaque rôle
    progress("availability");
    const availability = analyzeAvailability(players, params);
    const allRankings: Record<RoleName, ScoredPlayer[]> = rankAll(availability.pool, params);

    report((r) => r.header(players.length, options.paramsLabel ?? "params.json", availability.pool.length));

    // ── Classements par rôle ────────────────────────────────────────────────
    progress("rankings");
    report((r) => r.reportRoleRankings(allRankings, ROLE_LABELS, params));

    // ── Lineup 5-1 (+ chimie, rotation réception / service des libéros) ─────
    progress("lineup");
    const lineupBuilder = new LineupBuilder(allRankings);
    const fiveOneResult = lineupBuilder.buildFiveOneLineup();
    const fiveOneSubs = lineupBuilder.getSubstitutes(
        fiveOneResult.lineup,
        LineupBuilder.getFiveOneSubSlots()
    );

    report((r) => r.reportLineup(
        "LINEUP 5-1 RECOMMANDÉ",
        fiveOneResult.lineup,
        LineupBuilder.getFiveOneOrder(),
        fiveOneSubs
    ));

    report((r) => r.reportSignChemistry(
        analyzeChemistry(fiveOneResult.lineup, LineupBuilder.getFiveOneOrder())
    ));

    const liberoSub = fiveOneSubs.find((s) => s.label === "Remp. Libéro");
    const liberoRotation = analyzeLiberoRotation(
        [fiveOneResult.lineup["Libero"]?.player, liberoSub?.sub?.player],
        params.roles["libero"]
    );
    report((r) => r.reportLiberoRotation(liberoRotation));

    // ── Academy & progression ───────────────────────────────────────────────
    progress("academy");
    const academyAnalysis = analyzeAcademy(
        availability.pool,
        availability.academy,
        params,
        fiveOneResult.lineup,
        fiveOneSubs
    );
    report((r) => r.reportAcademyAndProgress(availability, academyAnalysis));

    // ── Points faibles + filtre de recrutement ──────────────────────────────
    progress("recruitment");
    const starterPlayerList = Object.values(fiveOneResult.lineup)
        .filter((x): x is ScoredPlayer => !!x)
        .map((s) => s.player);

    const weaknessAnalysis = analyzeWeaknesses(
        starterPlayerList,
        allRankings,
        fiveOneResult.lineup,
        params,
        ROLE_LABELS
    );
    report((r) => r.reportWeaknessAnalysis(weaknessAnalysis));

    const recruitmentAnalysis = analyzeRecruitment(
        starterPlayerList,
        allRankings,
        fiveOneResult.lineup,
        fiveOneSubs,
        LineupBuilder.getFiveOneSubSlots(),
        params,
        ROLE_LABELS
    );
    report((r) => r.reportRecruitmentAnalysis(recruitmentAnalysis));

    // ── Gestion du roster — joueurs à vendre ────────────────────────────────
    progress("roster");
    const forcedSales = [
        ...availability.retiring.map((player) => ({
            player, reason: "Considering retirement : ne progresse plus",
        })),
        ...availability.declining.filter((d) => !d.kept).map((d) => ({
            player: d.player, reason: "Starting to decline, pas exceptionnel",
        })),
    ];
    if (players.length > rosterTarget() || forcedSales.length > 0) {
        const balanceResult = analyzeRosterBalance(players, params, forcedSales);
        report((r) => r.reportRosterBalance(balanceResult));
    }

    report((r) => r.footer());
    progress("done");
}
