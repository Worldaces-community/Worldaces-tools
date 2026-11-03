#!/usr/bin/env node
/**
 * World Aces – 5-1 Roster Analyst (command line)
 *
 * Usage:
 *   npm run analyze -- <roster.csv> <params.json> [--verbose] [--md <report.md>] [--sequential]
 *
 * params.json is created with the web app's editor (export), or
 * from example_params.json. --md also writes the report as markdown
 * (e.g. GitHub Actions job summary). Independent lineups are computed
 * in parallel (worker_threads, this same file); --sequential disables it.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Worker, isMainThread, parentPort, workerData } from "worker_threads";
import {
    parseCSVText, parseParams, runAnalysis, runAnalysisParallel, poolSolver, solveLineupJob,
    ConsoleReporter, MarkdownReporter, SerializedLineup,
} from "./analyze";
import { Reporter } from "./report";

function usage(): never {
    console.error("Usage: npm run analyze -- <roster.csv> <params.json> [--verbose] [--md <report.md>] [--sequential]");
    process.exit(1);
}

interface LineupWorkerData { csvText: string; paramsText: string }

/** Executors: one lineup worker_thread per core (max 8). */
function spawnRunners(data: LineupWorkerData): { runners: ((job: number[]) => Promise<SerializedLineup>)[]; close: () => void } {
    const n = Math.max(1, Math.min(8, os.cpus().length - 1));
    // Under ts-node, the worker must register ts-node itself.
    const spawn = (): Worker => __filename.endsWith(".ts")
        ? new Worker(`require("ts-node").register({ transpileOnly: true }); require(${JSON.stringify(__filename)});`,
            { eval: true, workerData: data })
        : new Worker(__filename, { workerData: data });
    const workers = Array.from({ length: n }, spawn);
    const runners = workers.map((w) => (job: number[]) => new Promise<SerializedLineup>((resolve, reject) => {
        const onError = (e: Error) => { w.off("message", onMessage); reject(e); };
        const onMessage = (lineup: SerializedLineup) => { w.off("error", onError); resolve(lineup); };
        w.once("message", onMessage);
        w.once("error", onError);
        w.postMessage(job);
    }));
    return { runners, close: () => workers.forEach((w) => void w.terminate()) };
}

/** Worker mode: solves the lineup jobs sent by the main thread. */
function workerMain(): void {
    const { csvText, paramsText } = workerData as LineupWorkerData;
    const players = parseCSVText(csvText);
    const params = parseParams(paramsText);
    parentPort!.on("message", (job: number[]) => parentPort!.postMessage(solveLineupJob(players, params, job)));
}

async function main(): Promise<void> {
    const rawArgs = process.argv.slice(2);
    const verbose = rawArgs.some((a) => a === "--verbose" || a === "-v");
    const sequential = rawArgs.includes("--sequential");

    let mdPath: string | null = null;
    const args: string[] = [];
    for (let i = 0; i < rawArgs.length; i++) {
        const a = rawArgs[i];
        if (a === "--verbose" || a === "-v" || a === "--sequential") continue;
        if (a === "--md") {
            mdPath = rawArgs[i + 1] ?? null;
            i++;
            continue;
        }
        if (a.startsWith("--md=")) {
            mdPath = a.slice("--md=".length);
            continue;
        }
        args.push(a);
    }

    const [csvPath, paramsPath] = args;
    if (!csvPath || !paramsPath) usage();

    const csvText = fs.readFileSync(path.resolve(csvPath), "utf-8");
    const paramsText = fs.readFileSync(path.resolve(paramsPath), "utf-8");
    const players = parseCSVText(csvText);
    const params = parseParams(paramsText);

    const consoleReporter = new ConsoleReporter();
    consoleReporter.verbose = verbose;
    const mdReporter = mdPath ? new MarkdownReporter() : null;
    if (mdReporter) mdReporter.verbose = verbose;
    const reporters: Reporter[] = mdReporter ? [consoleReporter, mdReporter] : [consoleReporter];

    if (sequential) {
        runAnalysis(players, params, reporters, { paramsLabel: paramsPath });
    } else {
        const { runners, close } = spawnRunners({ csvText, paramsText });
        try {
            await runAnalysisParallel(players, params, reporters, poolSolver(runners), { paramsLabel: paramsPath });
        } finally {
            close();
        }
    }

    if (mdReporter && mdPath) {
        fs.writeFileSync(mdPath, mdReporter.toMarkdown(), "utf-8");
        console.log(`  Markdown report written: ${mdPath}`);
    }
}

if (isMainThread) {
    main().catch((e) => {
        console.error(`Error: ${(e as Error).message}`);
        process.exit(1);
    });
} else {
    workerMain();
}
