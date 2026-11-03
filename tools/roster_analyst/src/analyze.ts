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
import { LineupBuilder, SerializedLineup } from "./lineup/lineupBuilder";
import { analyzeWeaknesses } from "./analysis/weaknessAnalyzer";
import { analyzeRecruitment } from "./analysis/recruitmentAnalyzer";
import { analyzeRosterBalance, rosterTarget } from "./analysis/rosterBalanceAnalyzer";
import { analyzeLiberoRotation } from "./analysis/liberoRotationAnalyzer";
import { analyzeAvailability, availabilityLineupPools, rankAll } from "./analysis/availabilityAnalyzer";
import { analyzeAcademy, academyLineupPlayers } from "./analysis/academyAnalyzer";
import { Reporter } from "./report";
import { analyzeChemistry } from "./lineup/signChemistry";

export { parseCSVText } from "./models";
export { normalizeParams, parseParams } from "./config";
export { MarkdownReporter, ConsoleReporter } from "./report";
export type { SerializedLineup } from "./lineup/lineupBuilder";

/**
 * Étapes signalées à `onProgress` (affichage d'avancement dans le web), dans
 * l'ordre du calcul réel :
 *   availability : scores par rôle + lineup avec / sans chaque déclinant
 *   lineup       : 5-1 recommandé + lineup hypothétique de l'Academy
 *   report       : sections du rapport (rapide : lineups en cache)
 */
export type AnalysisStep = "availability" | "lineup" | "report" | "done";

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

    // Lineup 5-1, puis lineup hypothétique de l'Academy (relue en cache par
    // analyzeAcademy) : les deux calculs coûteux restants.
    progress("lineup");
    const lineupBuilder = new LineupBuilder(allRankings);
    const fiveOneResult = lineupBuilder.buildFiveOneLineup();
    const fiveOneSubs = lineupBuilder.getSubstitutes(
        fiveOneResult.lineup,
        LineupBuilder.getFiveOneSubSlots()
    );
    new LineupBuilder(rankAll(academyLineupPlayers(availability.pool, availability.academy), params))
        .buildFiveOneLineup();

    progress("report");
    report((r) => r.header(players.length, options.paramsLabel ?? "params.json", availability.pool.length));

    // ── Classements par rôle ────────────────────────────────────────────────
    report((r) => r.reportRoleRankings(allRankings, ROLE_LABELS, params));

    // ── Lineup 5-1 (+ chimie, rotation réception / service des libéros) ─────

    report((r) => r.reportLineup(
        "RECOMMENDED 5-1 LINEUP",
        fiveOneResult.lineup,
        LineupBuilder.getFiveOneOrder(),
        fiveOneSubs
    ));

    report((r) => r.reportSignChemistry(
        analyzeChemistry(fiveOneResult.lineup, LineupBuilder.getFiveOneOrder())
    ));

    const liberoSub = fiveOneSubs.find((s) => s.label === "Sub Libero");
    const liberoRotation = analyzeLiberoRotation(
        [fiveOneResult.lineup["Libero"]?.player, liberoSub?.sub?.player],
        params.roles["libero"]
    );
    report((r) => r.reportLiberoRotation(liberoRotation));

    // ── Academy & progression ───────────────────────────────────────────────
    const academyAnalysis = analyzeAcademy(
        availability.pool,
        availability.academy,
        params,
        fiveOneResult.lineup,
        fiveOneSubs
    );
    report((r) => r.reportAcademyAndProgress(availability, academyAnalysis));

    // ── Points faibles + filtre de recrutement ──────────────────────────────
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
    const forcedSales = [
        ...availability.retiring.map((player) => ({
            player, reason: "Considering retirement: no longer improving",
        })),
        ...availability.declining.filter((d) => !d.kept).map((d) => ({
            player: d.player, reason: "Starting to decline, not exceptional",
        })),
    ];
    if (players.length > rosterTarget() || forcedSales.length > 0) {
        const balanceResult = analyzeRosterBalance(players, params, forcedSales);
        report((r) => r.reportRosterBalance(balanceResult));
    }

    report((r) => r.footer());
    progress("done");
}

// ─── Calcul parallèle des lineups ────────────────────────────────────────────

/**
 * Résout des lineups 5-1 hors du thread courant : chaque job = indices (dans
 * `players`) des joueurs du pool, dans l'ordre ; résultats dans le même ordre.
 */
export type LineupSolver = (jobs: number[][]) => Promise<SerializedLineup[]>;

/** Répartit les jobs sur des exécutants (un job à la fois chacun). */
export function poolSolver(runners: ((job: number[]) => Promise<SerializedLineup>)[]): LineupSolver {
    return async (jobs) => {
        const out: SerializedLineup[] = new Array(jobs.length);
        let next = 0;
        await Promise.all(runners.map(async (run) => {
            while (next < jobs.length) {
                const k = next++;
                out[k] = await run(jobs[k]);
            }
        }));
        return out;
    };
}

/** Côté exécutant : lineup 5-1 d'un job (cf. LineupSolver). */
export function solveLineupJob(players: Player[], params: Params, job: number[]): SerializedLineup {
    return LineupBuilder.solveFiveOne(rankAll(job.map((i) => players[i]), params));
}

/**
 * `runAnalysis` avec les lineups indépendantes calculées en parallèle par
 * `solve` (base « Improving » + chaque déclinant, puis 5-1 recommandé +
 * lineup de l'Academy), mises en cache avant l'analyse proprement dite.
 * `solve` doit utiliser les mêmes joueurs (même CSV) et params.
 */
export async function runAnalysisParallel(
    players: Player[],
    params: Params,
    reporters: Reporter[],
    solve: LineupSolver,
    options: AnalysisOptions = {}
): Promise<void> {
    const progress = options.onProgress ?? (() => undefined);
    const index = new Map(players.map((p, i) => [p, i]));
    const prewarm = async (pools: Player[][]): Promise<void> => {
        const jobs = new Map<string, Player[]>();
        for (const pool of pools) jobs.set(pool.map((p) => index.get(p)).join(","), pool);
        const list = [...jobs.values()];
        const out = await solve(list.map((pool) => pool.map((p) => index.get(p)!)));
        list.forEach((pool, k) => LineupBuilder.importFiveOne(rankAll(pool, params), out[k]));
    };

    progress("availability");
    await prewarm(availabilityLineupPools(players));
    const { pool, academy } = analyzeAvailability(players, params);
    progress("lineup");
    await prewarm([pool, academyLineupPlayers(pool, academy)]);
    runAnalysis(players, params, reporters, {
        ...options,
        onProgress: (step) => { if (step === "report" || step === "done") progress(step); },
    });
}
