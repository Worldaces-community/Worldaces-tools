#!/usr/bin/env node
/**
 * World Aces – 5-1 Roster Analyst (ligne de commande)
 *
 * Usage :
 *   npm run analyze -- <roster.csv> <params.json> [--verbose] [--md <rapport.md>]
 *
 * Le params.json se crée avec l'éditeur de l'application web (export), ou à
 * partir de example_params.json. --md écrit en plus le rapport en markdown
 * (ex. job summary GitHub Actions).
 */

import * as fs from "fs";
import * as path from "path";
import { parseCSVText, parseParams, runAnalysis, ConsoleReporter, MarkdownReporter } from "./analyze";
import { Reporter } from "./report";

function usage(): never {
    console.error("Usage: npm run analyze -- <roster.csv> <params.json> [--verbose] [--md <report.md>]");
    process.exit(1);
}

function main(): void {
    const rawArgs = process.argv.slice(2);
    const verbose = rawArgs.some((a) => a === "--verbose" || a === "-v");

    let mdPath: string | null = null;
    const args: string[] = [];
    for (let i = 0; i < rawArgs.length; i++) {
        const a = rawArgs[i];
        if (a === "--verbose" || a === "-v") continue;
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

    const players = parseCSVText(fs.readFileSync(path.resolve(csvPath), "utf-8"));
    const params = parseParams(fs.readFileSync(path.resolve(paramsPath), "utf-8"));

    const consoleReporter = new ConsoleReporter();
    consoleReporter.verbose = verbose;
    const mdReporter = mdPath ? new MarkdownReporter() : null;
    if (mdReporter) mdReporter.verbose = verbose;
    const reporters: Reporter[] = mdReporter ? [consoleReporter, mdReporter] : [consoleReporter];

    runAnalysis(players, params, reporters, { paramsLabel: paramsPath });

    if (mdReporter && mdPath) {
        fs.writeFileSync(mdPath, mdReporter.toMarkdown(), "utf-8");
        console.log(`  Markdown report written: ${mdPath}`);
    }
}

try {
    main();
} catch (e) {
    console.error(`Error: ${(e as Error).message}`);
    process.exit(1);
}
