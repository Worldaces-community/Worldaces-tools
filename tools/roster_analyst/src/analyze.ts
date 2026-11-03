/**
 * World Aces – 5-1 Roster Analyst: analysis orchestration.
 *
 * Common entry point for the CLI (`cli.ts`) and the web app
 * (`web/worker.ts`): no Node dependency (files, process…).
 *
 * Report (dynamically numbered sections):
 *   1. Role rankings
 *   2. Recommended 5-1 lineup (starters / bench / reserves, sign
 *      chemistry, reception / serve rotation of the 2 liberos)
 *   3. Academy & progression
 *   4. Weak spots + recruitment filter
 *   5. Roster management — players to sell (if roster > target, or if there are
 *      non-improving players to release first)
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
 * Steps reported to `onProgress` (progress display in the web app), in
 * actual computation order:
 *   availability : per-role scores + lineup with / without each decliner
 *   lineup       : recommended 5-1 + hypothetical Academy lineup
 *   report       : report sections (fast: lineups cached)
 */
export type AnalysisStep = "availability" | "lineup" | "report" | "done";

export interface AnalysisOptions {
    /** Params label shown in the report header (path, file name…). */
    paramsLabel?: string;
    onProgress?: (step: AnalysisStep) => void;
}

/**
 * Runs the full analysis and sends it to each reporter.
 * `params` must come from `normalizeParams` / `parseParams` (settings enabled).
 */
export function runAnalysis(
    players: Player[],
    params: Params,
    reporters: Reporter[],
    options: AnalysisOptions = {}
): void {
    const progress = options.onProgress ?? (() => undefined);
    const report = (fn: (r: Reporter) => void): void => reporters.forEach(fn);

    // Availability (Academy + progress), then scores of the available
    // players for each role
    progress("availability");
    const availability = analyzeAvailability(players, params);
    const allRankings: Record<RoleName, ScoredPlayer[]> = rankAll(availability.pool, params);

    // 5-1 lineup, then hypothetical Academy lineup (read back from cache by
    // analyzeAcademy): the two remaining expensive computations.
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

    // ── Role rankings ───────────────────────────────────────────────────────
    report((r) => r.reportRoleRankings(allRankings, ROLE_LABELS, params));

    // ── 5-1 lineup (+ chemistry, reception / serve libero rotation) ─────────

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

    // ── Weak spots + recruitment filter ─────────────────────────────────────
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

    // ── Roster management — players to sell ────────────────────────────────
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

// ─── Parallel lineup computation ─────────────────────────────────────────────

/**
 * Solves 5-1 lineups off the current thread: each job = indices (in
 * `players`) of the pool's players, in order; results in the same order.
 */
export type LineupSolver = (jobs: number[][]) => Promise<SerializedLineup[]>;

/** Spreads jobs over executors (one job at a time each). */
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

/** Executor side: 5-1 lineup of one job (see LineupSolver). */
export function solveLineupJob(players: Player[], params: Params, job: number[]): SerializedLineup {
    return LineupBuilder.solveFiveOne(rankAll(job.map((i) => players[i]), params));
}

/**
 * `runAnalysis` with the independent lineups computed in parallel by
 * `solve` ("Improving" base + each decliner, then recommended 5-1 +
 * Academy lineup), cached before the analysis proper.
 * `solve` must use the same players (same CSV) and params.
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
