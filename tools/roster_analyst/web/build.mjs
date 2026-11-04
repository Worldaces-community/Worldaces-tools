// Builds the browser app into web/dist/ (published by the Pages workflow at
// docs/roster_analyst/). Usage: npm run build:browser
import { build } from "esbuild";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const out = join(here, "dist");
// Cache buster: the scripts are loaded as `file.js?v=<build id>`, otherwise
// browsers keep running a stale worker after a deploy (Ctrl+F5 does not
// reload worker scripts).
const buildId = Date.now().toString(36);

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

await build({
    entryPoints: {
        app: join(here, "app.ts"),
        worker: join(here, "worker.ts"),
        lineupWorker: join(here, "lineupWorker.ts"),
    },
    outdir: out,
    bundle: true,
    format: "iife",
    platform: "browser",
    target: ["es2020"],
    minify: true,
    sourcemap: true,
    legalComments: "linked",
    define: { __BUILD_ID__: JSON.stringify(buildId) },
    logLevel: "info",
});

writeFileSync(join(out, "index.html"), readFileSync(join(here, "index.html"), "utf8")
    .replace(/(href="style\.css|src="app\.js)"/g, `$1?v=${buildId}"`));
cpSync(join(here, "style.css"), join(out, "style.css"));
cpSync(join(root, "example_roster.csv"), join(out, "example_roster.csv"));
cpSync(join(root, "example_params.json"), join(out, "example_params.json"));
console.log(`browser app written to ${out}`);
