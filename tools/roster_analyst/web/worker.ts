/**
 * Web Worker : exécute l'analyse hors du thread de l'interface (le branch &
 * bound de la synergie peut prendre plusieurs minutes).
 *
 * Entrée  : { csvText, params (objet params.json), verbose, paramsLabel }
 * Sorties : { type: "progress", step } · { type: "log", level, text }
 *           { type: "result", markdown } · { type: "error", message }
 */

import { parseCSVText, normalizeParams, runAnalysis, MarkdownReporter } from "../src/analyze";

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

ctx.onmessage = (ev) => {
    const { csvText, params: rawParams, verbose, paramsLabel } = ev.data;
    try {
        const params = normalizeParams(rawParams);
        const players = parseCSVText(csvText);
        const md = new MarkdownReporter();
        md.verbose = verbose;
        runAnalysis(players, params, [md], {
            paramsLabel,
            onProgress: (step) => ctx.postMessage({ type: "progress", step }),
        });
        ctx.postMessage({ type: "result", markdown: md.toMarkdown() });
    } catch (e) {
        ctx.postMessage({ type: "error", message: (e as Error).message ?? String(e) });
    }
};
