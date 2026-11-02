// Builds the browser app into web/dist/ (published by the Pages workflow at
// docs/roster_analyst/). Usage: npm run build:browser
import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const out = join(here, "dist");

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

await build({
    entryPoints: { app: join(here, "app.ts"), worker: join(here, "worker.ts") },
    outdir: out,
    bundle: true,
    format: "iife",
    platform: "browser",
    target: ["es2020"],
    minify: true,
    sourcemap: true,
    legalComments: "linked",
    logLevel: "info",
});

cpSync(join(here, "index.html"), join(out, "index.html"));
cpSync(join(here, "style.css"), join(out, "style.css"));
cpSync(join(root, "example_roster.csv"), join(out, "example_roster.csv"));
cpSync(join(root, "example_params.json"), join(out, "example_params.json"));
console.log(`browser app written to ${out}`);
