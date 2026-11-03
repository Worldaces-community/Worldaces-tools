/**
 * Web Worker de calcul de lineup (lancé par worker.ts, un par cœur) : résout
 * en parallèle les lineups 5-1 indépendantes de l'analyse.
 *
 * Entrée  : { type: "init", csvText, params } puis { type: "job", id, job }
 * Sorties : { type: "done", id, lineup } · { type: "log", level, text }
 *           { type: "error", id, message }
 */

import { parseCSVText, normalizeParams, solveLineupJob, SerializedLineup } from "../src/analyze";
import type { Player, Params } from "../src/types";

export type LineupWorkerRequest =
    | { type: "init"; csvText: string; params: unknown }
    | { type: "job"; id: number; job: number[] };

export type LineupWorkerMessage =
    | { type: "done"; id: number; lineup: SerializedLineup }
    | { type: "log"; level: "warn" | "info"; text: string }
    | { type: "error"; id: number; message: string };

const ctx = self as unknown as {
    postMessage(m: LineupWorkerMessage): void;
    onmessage: ((ev: MessageEvent<LineupWorkerRequest>) => void) | null;
};

const fmt = (args: unknown[]): string => args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
console.warn = (...args: unknown[]) => ctx.postMessage({ type: "log", level: "warn", text: fmt(args) });
console.log = (...args: unknown[]) => ctx.postMessage({ type: "log", level: "info", text: fmt(args) });

let players: Player[] = [];
let params: Params;

ctx.onmessage = (ev) => {
    const m = ev.data;
    if (m.type === "init") {
        params = normalizeParams(m.params);
        players = parseCSVText(m.csvText);
        return;
    }
    try {
        ctx.postMessage({ type: "done", id: m.id, lineup: solveLineupJob(players, params, m.job) });
    } catch (e) {
        ctx.postMessage({ type: "error", id: m.id, message: (e as Error).message ?? String(e) });
    }
};
