/**
 * Web Worker: runs the analysis off the UI thread (the synergy branch &
 * bound can take several seconds per lineup). The
 * independent lineups are spread over lineupWorker.js workers (one
 * per core); without nested workers, everything runs here, sequentially.
 *
 * Input  : { csvText, params (params.json object), verbose, paramsLabel }
 * Outputs: { type: "progress", step } · { type: "log", level, text }
 *          { type: "result", markdown } · { type: "error", message }
 */

import {
    parseCSVText, normalizeParams, runAnalysis, runAnalysisParallel, poolSolver, MarkdownReporter,
    SerializedLineup, AnalysisOptions,
} from "../src/analyze";
import type { LineupWorkerMessage, LineupWorkerRequest } from "./lineupWorker";

export interface WorkerRequest {
    csvText: string;
    params: unknown;
    verbose: boolean;
    paramsLabel: string;
}

export type WorkerMessage =
    | { type: "progress"; step: string }
    | { type: "log"; level: "warn" | "info"; text: string }
    | { type: "result"; markdown: string }
    | { type: "error"; message: string };

const ctx = self as unknown as {
    postMessage(m: WorkerMessage): void;
    onmessage: ((ev: MessageEvent<WorkerRequest>) => void) | null;
};

const fmt = (args: unknown[]): string => args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
console.warn = (...args: unknown[]) => ctx.postMessage({ type: "log", level: "warn", text: fmt(args) });
console.log = (...args: unknown[]) => ctx.postMessage({ type: "log", level: "info", text: fmt(args) });

/** Executors: one lineup worker per core (current thread included). */
function spawnRunners(csvText: string, rawParams: unknown): ((job: number[]) => Promise<SerializedLineup>)[] {
    const n = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 2) - 1));
    return Array.from({ length: n }, () => {
        const w = new Worker("lineupWorker.js");
        const pending = new Map<number, { resolve: (l: SerializedLineup) => void; reject: (e: Error) => void }>();
        let nextId = 0;
        w.onmessage = (ev: MessageEvent<LineupWorkerMessage>) => {
            const m = ev.data;
            if (m.type === "log") { ctx.postMessage(m); return; }
            const p = pending.get(m.id);
            pending.delete(m.id);
            if (m.type === "done") p?.resolve(m.lineup);
            else p?.reject(new Error(m.message));
        };
        w.onerror = (e) => { for (const p of pending.values()) p.reject(new Error(`Lineup worker: ${e.message}`)); };
        const init: LineupWorkerRequest = { type: "init", csvText, params: rawParams };
        w.postMessage(init);
        return (job: number[]) => new Promise<SerializedLineup>((resolve, reject) => {
            const id = nextId++;
            pending.set(id, { resolve, reject });
            const req: LineupWorkerRequest = { type: "job", id, job };
            w.postMessage(req);
        });
    });
}

ctx.onmessage = async (ev) => {
    const { csvText, params: rawParams, verbose, paramsLabel } = ev.data;
    try {
        const params = normalizeParams(rawParams);
        const players = parseCSVText(csvText);
        const md = new MarkdownReporter();
        md.verbose = verbose;
        const options: AnalysisOptions = {
            paramsLabel,
            onProgress: (step) => ctx.postMessage({ type: "progress", step }),
        };
        if (typeof Worker === "undefined") runAnalysis(players, params, [md], options);
        else await runAnalysisParallel(players, params, [md], poolSolver(spawnRunners(csvText, rawParams)), options);
        ctx.postMessage({ type: "result", markdown: md.toMarkdown() });
    } catch (e) {
        ctx.postMessage({ type: "error", message: (e as Error).message ?? String(e) });
    }
};
