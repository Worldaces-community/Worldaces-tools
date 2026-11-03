/**
 * Roster Analyst — browser UI.
 *   1. Settings: params.json editor (sliders / inputs), import + export.
 *   2. Roster: CSV import + quick summary.
 *   3. Report: analysis in a Web Worker, markdown report rendered as HTML.
 */

import { marked } from "marked";
import DOMPurify from "dompurify";
import { parseCSVText } from "../src/models/playerParser";
import { hasRole } from "../src/utils/helpers";
import type { Player, Sign } from "../src/types";
import {
    EditableParams, ROLES, ROLE_TITLES, STATS, TRAITS, SIGNS, RANGES,
    neutralParams, importParams, exportParams,
    STAT_HELP, TRAIT_HELP, SIGN_HELP, LIBERO_SIGN_HELP, SETTER_SIGN_HELP,
} from "./schema";
import type { WorkerMessage, WorkerRequest } from "./worker";
import type { RoleName } from "../src/types";

// ─── DOM helpers ────────────────────────────────────────────────────────────

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

function el<K extends keyof HTMLElementTagNameMap>(
    tag: K, attrs: Record<string, string> = {}, ...children: (Node | string | null)[]
): HTMLElementTagNameMap[K] {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
        if (k === "class") e.className = v;
        else e.setAttribute(k, v);
    }
    for (const c of children) if (c !== null) e.append(c);
    return e;
}

let uid = 0;

/**
 * Slider + number input bound to a getter / setter. `fmt` is the readout
 * precision; the number input accepts values beyond the slider range.
 */
function slider(opts: {
    label: string; help?: string; min: number; max: number; step: number;
    get: () => number; set: (v: number) => void; compact?: boolean;
}): HTMLElement {
    const id = `ctl${++uid}`;
    const range = el("input", { type: "range", min: String(opts.min), max: String(opts.max), step: String(opts.step), id, "aria-label": opts.label });
    const num = el("input", { type: "number", step: String(opts.step), class: "num-input", "aria-label": `${opts.label} value` });
    const sync = (v: number) => { range.value = String(v); num.value = String(v); markZero(v); };
    const wrap = el("div", { class: opts.compact ? "ctl compact" : "ctl" });
    const markZero = (v: number) => wrap.classList.toggle("zero", v === 0);
    range.addEventListener("input", () => { const v = Number(range.value); num.value = range.value; opts.set(v); markZero(v); changed(); });
    num.addEventListener("change", () => {
        const v = Number(num.value);
        if (!Number.isFinite(v)) { sync(opts.get()); return; }
        range.value = String(v); opts.set(v); markZero(v); changed();
    });
    const label = el("label", { for: id }, opts.label);
    if (opts.help) label.title = opts.help;
    wrap.append(el("div", { class: "ctl-head" }, label, num), range);
    if (opts.help && !opts.compact) wrap.append(el("p", { class: "ctl-help" }, opts.help));
    sync(opts.get());
    return wrap;
}

function numberField(opts: {
    label: string; help?: string; min?: number; max?: number; step?: number;
    get: () => number; set: (v: number) => void;
}): HTMLElement {
    const id = `ctl${++uid}`;
    const input = el("input", { type: "number", id, class: "num-input wide" });
    if (opts.min !== undefined) input.min = String(opts.min);
    if (opts.max !== undefined) input.max = String(opts.max);
    input.step = String(opts.step ?? 1);
    input.value = String(opts.get());
    input.addEventListener("change", () => {
        const v = Number(input.value);
        if (Number.isFinite(v)) { opts.set(v); changed(); } else input.value = String(opts.get());
    });
    const wrap = el("div", { class: "ctl" }, el("div", { class: "ctl-head" }, el("label", { for: id }, opts.label), input));
    if (opts.help) wrap.append(el("p", { class: "ctl-help" }, opts.help));
    return wrap;
}

function checkbox(label: string, get: () => boolean, set: (v: boolean) => void, help?: string): HTMLElement {
    const input = el("input", { type: "checkbox" });
    input.checked = get();
    input.addEventListener("change", () => { set(input.checked); changed(); });
    const wrap = el("div", { class: "ctl" }, el("label", { class: "check" }, input, ` ${label}`));
    if (help) wrap.append(el("p", { class: "ctl-help" }, help));
    return wrap;
}

function download(name: string, text: string, type: string): void {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = el("a", { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ─── State & persistence (per-browser convenience only) ─────────────────────

const STORE_KEY = "wa-roster-analyst:params";
const restored = loadStored();
let params: EditableParams = restored ?? neutralParams();
let activeRole: RoleName = "setter";
let saveTimer: number | undefined;

function loadStored(): EditableParams | null {
    try {
        const raw = localStorage.getItem(STORE_KEY);
        return raw ? importParams(JSON.parse(raw)).params : null;
    } catch {
        return null;
    }
}

function changed(): void {
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
        try { localStorage.setItem(STORE_KEY, JSON.stringify(params)); } catch { /* storage unavailable */ }
    }, 300);
}

function setStatus(html: string): void {
    $("paramsStatus").innerHTML = html;
}

// ─── 1. Settings editor ─────────────────────────────────────────────────────

function renderGlobal(): void {
    const box = $("globalControls");
    box.replaceChildren(
        slider({
            label: "Trait weight", min: 0, max: 3, step: 0.05,
            help: "Multiplies every trait bonus — how much traits count against stats.",
            get: () => params.traitWeight, set: (v) => (params.traitWeight = v),
        }),
        slider({
            label: "Balance exponent", min: 0.1, max: 1, step: 0.05,
            help: "1 = plain weighted average of the stats. Below 1, low stats are penalised more (favours balanced profiles).",
            get: () => params.settings.balanceExponent, set: (v) => (params.settings.balanceExponent = v),
        }),
    );
}

function renderRoleTabs(): void {
    const tabs = $("roleTabs");
    tabs.replaceChildren(...ROLES.map((r) => {
        const b = el("button", { type: "button", role: "tab", class: r === activeRole ? "tab active" : "tab", "aria-selected": String(r === activeRole) }, ROLE_TITLES[r]);
        b.addEventListener("click", () => { activeRole = r; renderRoleTabs(); renderRolePanel(); });
        return b;
    }));

    const copy = el("select", { "aria-label": "Copy another role's profile" },
        el("option", { value: "" }, "Copy profile from…"),
        ...ROLES.filter((r) => r !== activeRole).map((r) => el("option", { value: r }, ROLE_TITLES[r])));
    copy.addEventListener("change", () => {
        const from = copy.value as RoleName;
        if (!from) return;
        params.roles[activeRole] = JSON.parse(JSON.stringify(params.roles[from]));
        changed(); renderRolePanel(); copy.value = "";
    });
    const reset = el("button", { type: "button", class: "secondary small" }, "Reset this role");
    reset.addEventListener("click", () => {
        params.roles[activeRole] = neutralParams().roles[activeRole];
        changed(); renderRolePanel();
    });
    $("roleTools").replaceChildren(copy, reset);
}

function group(title: string, hint: string, controls: HTMLElement[]): HTMLElement {
    return el("div", { class: "group" },
        el("h4", {}, title, el("span", { class: "hint" }, ` — ${hint}`)),
        el("div", { class: "grid3" }, ...controls));
}

function renderRolePanel(): void {
    const role = activeRole;
    const cfg = params.roles[role];
    const statCtl = STATS.map((s) => slider({
        label: s, help: STAT_HELP[s], ...RANGES.stat, compact: true,
        get: () => cfg.statsWeights[s] ?? 0, set: (v) => (cfg.statsWeights[s] = v),
    }));
    const traitCtl = TRAITS.map((t) => slider({
        label: t, help: TRAIT_HELP[t], ...RANGES.trait, compact: true,
        get: () => cfg.traitBonuses[t] ?? 0, set: (v) => (cfg.traitBonuses[t] = v),
    }));
    const signCtl = SIGNS.map((s) => slider({
        label: s,
        help: role === "libero" ? LIBERO_SIGN_HELP[s] : role === "setter" ? SETTER_SIGN_HELP : SIGN_HELP[s],
        ...RANGES.sign, compact: true,
        get: () => cfg.signBonuses[s] ?? 0, set: (v) => (cfg.signBonuses[s] = v),
    }));
    $("rolePanel").replaceChildren(
        group("Stat weights", "0 = ignored, 10 = key stat; only the ratios matter (hover a name for its in-game effect)", statCtl),
        group("Trait bonuses", "points added to the 0-99 stat score when the player has the trait (negative = harmful)", traitCtl),
        group("Sign bonuses", "value of the sign effect for this role, assuming it is active", signCtl),
    );
}

function renderAdvanced(): void {
    const s = params.settings;
    const sec = (title: string, ...ctl: HTMLElement[]) =>
        el("div", { class: "group" }, el("h4", {}, title), el("div", { class: "grid2" }, ...ctl));

    const singletonList = el("div", { class: "chips" }, ...TRAITS.map((t) => {
        const input = el("input", { type: "checkbox" });
        input.checked = s.recruitment.singletonTraits.includes(t);
        input.addEventListener("change", () => {
            const set = new Set(s.recruitment.singletonTraits);
            if (input.checked) set.add(t); else { set.delete(t); delete s.recruitment.singletonTraitPositions[t]; }
            s.recruitment.singletonTraits = TRAITS.filter((x) => set.has(x));
            changed(); renderAdvanced();
        });
        return el("label", { class: "chip" }, input, ` ${t}`);
    }));

    const positions = el("div", { class: "positions" }, ...s.recruitment.singletonTraits.map((t) => {
        const cur = s.recruitment.singletonTraitPositions[t] ?? [];
        return el("div", { class: "pos-row" }, el("span", { class: "pos-trait" }, t),
            ...ROLES.map((r) => {
                const input = el("input", { type: "checkbox" });
                input.checked = cur.includes(r);
                input.addEventListener("change", () => {
                    const set = new Set(s.recruitment.singletonTraitPositions[t] ?? []);
                    if (input.checked) set.add(r); else set.delete(r);
                    if (set.size) s.recruitment.singletonTraitPositions[t] = ROLES.filter((x) => set.has(x));
                    else delete s.recruitment.singletonTraitPositions[t];
                    changed();
                });
                return el("label", { class: "chip" }, input, ` ${ROLE_TITLES[r]}`);
            }));
    }));

    $("advancedControls").replaceChildren(
        sec("5-1 lineup",
            slider({ label: "Bench weight (λ)", min: 0.05, max: 0.95, step: 0.05,
                help: "Weight of the substitutes in the lineup objective. Must stay below 1 so the best players start.",
                get: () => s.lineup.subObjectiveWeight, set: (v) => (s.lineup.subObjectiveWeight = v) }),
            slider({ label: "Injury reserve weight (λr)", min: 0.05, max: 0.95, step: 0.05,
                help: "Weight of the injury reserves. Must stay below the bench weight.",
                get: () => s.lineup.reserveObjectiveWeight, set: (v) => (s.lineup.reserveObjectiveWeight = v) }),
            checkbox("Optimise sign chemistry", () => s.lineup.signSynergy, (v) => (s.lineup.signSynergy = v),
                "Exact search of the lineup with the best sign chemistry (needs a Sign column). Slower: up to a few minutes."),
            numberField({ label: "Chemistry search time limit (s)", min: 5, step: 5,
                help: "Past this limit the best lineup found so far is kept (optimality not proven).",
                get: () => s.lineup.synergyTimeLimitSec, set: (v) => (s.lineup.synergyTimeLimitSec = v) }),
        ),
        sec("Progression & academy",
            numberField({ label: "Decliner kept if lineup gain ≥", min: 0, step: 0.5,
                help: "A “Starting to decline” player stays available only if they raise the starters' total (scores + chemistry) by at least this many points.",
                get: () => s.availability.declineExceptionalMinGain, set: (v) => (s.availability.declineExceptionalMinGain = v) }),
            numberField({ label: "Academy max age", min: 0, step: 1,
                help: "Players up to this age (included) are academy-eligible.",
                get: () => s.academy.maxAge, set: (v) => (s.academy.maxAge = v) }),
        ),
        sec("Libero rotation",
            numberField({ label: "Min. gap to rotate liberos", min: 0, step: 0.5,
                help: "Score gap (0-99 scale) needed on a phase (reception / defense) to advise swapping liberos between phases.",
                get: () => s.libero.subMinDelta, set: (v) => (s.libero.subMinDelta = v) }),
        ),
        sec("Roster quotas (players to sell)",
            numberField({ label: "Roster size target", min: 1, step: 1,
                help: "Above this size, the report lists the players to sell.",
                get: () => s.roster.target, set: (v) => (s.roster.target = v) }),
            ...ROLES.map((r) => numberField({ label: `Max ${ROLE_TITLES[r]}`, min: 0, step: 1,
                get: () => s.roster.targetCounts[r] ?? 0, set: (v) => (s.roster.targetCounts[r] = v) })),
        ),
        el("div", { class: "group" },
            el("h4", {}, "Recruitment — single-carrier traits"),
            el("p", { class: "ctl-help" }, "Traits for which one carrier in the lineup is enough: never recommended again once present, boosted while absent."),
            singletonList,
            s.recruitment.singletonTraits.length
                ? el("div", {}, el("p", { class: "ctl-help" }, "Optional: only count a carrier playing one of these roles (none ticked = any starter)."), positions)
                : null,
            el("div", { class: "grid2" }, slider({ label: "Priority boost while absent", min: 1, max: 3, step: 0.1,
                get: () => s.recruitment.singletonPriorityBonus, set: (v) => (s.recruitment.singletonPriorityBonus = v) })),
        ),
    );
}

function renderEditor(): void {
    renderGlobal();
    renderRoleTabs();
    renderRolePanel();
    renderAdvanced();
}

$("paramsFile").addEventListener("change", async (ev) => {
    const input = ev.target as HTMLInputElement;
    const f = input.files?.[0];
    input.value = "";
    if (!f) return;
    try {
        const { params: p, notes } = importParams(JSON.parse(await f.text()));
        params = p;
        changed();
        renderEditor();
        const esc = (t: string) => t.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));
        setStatus(`Imported <b>${esc(f.name)}</b>.` + (notes.length ? ` <span class="warn">${notes.length} note(s): ${esc(notes.slice(0, 5).join("; "))}${notes.length > 5 ? "…" : ""}</span>` : ""));
    } catch (e) {
        setStatus(`<span class="err">Could not import this file: ${(e as Error).message}</span>`);
    }
});

$("exportParams").addEventListener("click", () => {
    download("params.json", exportParams(params), "application/json");
    setStatus("Exported <b>params.json</b> — import it next time (or pass it to the CLI) to reuse this configuration.");
});

$("resetParams").addEventListener("click", () => {
    if (!confirm("Replace the current settings with the neutral template?")) return;
    params = neutralParams();
    changed();
    renderEditor();
    setStatus("Neutral template loaded.");
});

// ─── 2. Roster ──────────────────────────────────────────────────────────────

let csvText: string | null = null;
let csvName = "";

function withWarnings<T>(fn: () => T): { value: T; warnings: string[] } {
    const warnings: string[] = [];
    const orig = console.warn;
    console.warn = (...a: unknown[]) => warnings.push(a.join(" "));
    try { return { value: fn(), warnings }; } finally { console.warn = orig; }
}

function summarize(players: Player[], warnings: string[]): void {
    const box = $("rosterSummary");
    const academy = players.filter((p) => p.position === "Academy").length;
    const declining = players.filter((p) => p.progress === "Starting to decline").length;
    const retiring = players.filter((p) => p.progress === "Considering retirement").length;
    const signs = players.filter((p) => p.sign).length;
    const stat = (n: number | string, label: string) => el("div", { class: "stat" }, el("b", {}, String(n)), el("span", {}, label));
    box.replaceChildren(
        el("p", { class: "file" }, el("b", {}, csvName), ` — ${players.length} players`),
        el("div", { class: "stats" },
            ...ROLES.map((r) => stat(players.filter((p) => hasRole(p, r)).length, ROLE_TITLES[r])),
            stat(academy, "Academy"),
            stat(declining + retiring, "Not improving"),
            stat(signs ? "yes" : "no", "Signs"),
        ),
        ...warnings.map((w) => el("p", { class: "warn" }, w)),
    );
    box.hidden = false;
}

function loadCsv(name: string, text: string): void {
    try {
        const { value: players, warnings } = withWarnings(() => parseCSVText(text));
        if (players.length === 0) throw new Error("no player rows");
        csvText = text;
        csvName = name;
        summarize(players, warnings);
        ($("run") as HTMLButtonElement).disabled = false;
    } catch (e) {
        csvText = null;
        ($("run") as HTMLButtonElement).disabled = true;
        const box = $("rosterSummary");
        box.replaceChildren(el("p", { class: "err" }, `Could not read ${name}: ${(e as Error).message}`));
        box.hidden = false;
    }
}

$("csvFile").addEventListener("change", async (ev) => {
    const input = ev.target as HTMLInputElement;
    const f = input.files?.[0];
    input.value = "";
    if (f) loadCsv(f.name, await f.text());
});

const drop = $("drop");
drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", async (e) => {
    e.preventDefault();
    drop.classList.remove("over");
    const f = e.dataTransfer?.files?.[0];
    if (f) loadCsv(f.name, await f.text());
});

$("loadExample").addEventListener("click", async () => {
    try {
        const r = await fetch("example_roster.csv");
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        loadCsv("example_roster.csv", await r.text());
    } catch (e) {
        const box = $("rosterSummary");
        box.replaceChildren(el("p", { class: "err" }, `Could not load the example roster: ${(e as Error).message}`));
        box.hidden = false;
    }
});

// ─── 3. Run & report ────────────────────────────────────────────────────────

const STEP_LABELS: Record<string, string> = {
    availability: "Role scores & availability (lineup with / without each declining player)",
    lineup: "5-1 lineups: recommended + Academy hypothesis (exact search, sign chemistry)",
    report: "Report: rankings, chemistry, Academy moves, weak spots, recruitment, roster",
};

let worker: Worker | null = null;
let timer: number | undefined;
let lastMarkdown = "";

function finishRun(): void {
    worker?.terminate();
    worker = null;
    window.clearInterval(timer);
    ($("run") as HTMLButtonElement).disabled = !csvText;
    $("cancel").hidden = true;
}

function renderReport(md: string): void {
    const html = DOMPurify.sanitize(marked.parse(md, { async: false, gfm: true }) as string, {
        ADD_ATTR: ["open"],
    });
    const body = $("reportBody");
    body.innerHTML = html;
    // Wide tables scroll inside their own box on small screens.
    body.querySelectorAll("table").forEach((t) => {
        const w = el("div", { class: "table-wrap" });
        t.replaceWith(w);
        w.append(t);
    });
}

$("run").addEventListener("click", () => {
    if (!csvText) return;
    finishRun();
    const progress = $("progress");
    const logs = $("logs");
    logs.replaceChildren();
    logs.hidden = true;
    const t0 = Date.now();
    const seen: string[] = [];
    const elapsed = el("span", { class: "elapsed" }, "0 s");
    const list = el("ol", {});
    progress.replaceChildren(el("div", { class: "progress-head" }, el("b", {}, "Running…"), elapsed), list);
    progress.hidden = false;
    timer = window.setInterval(() => { elapsed.textContent = `${Math.round((Date.now() - t0) / 1000)} s`; }, 500);
    ($("run") as HTMLButtonElement).disabled = true;
    $("cancel").hidden = false;

    const renderSteps = (current: string | null) => {
        list.replaceChildren(...seen.map((s) => el("li", { class: s === current ? "now" : "done" }, STEP_LABELS[s] ?? s)));
    };

    worker = new Worker("worker.js");
    worker.onmessage = (ev: MessageEvent<WorkerMessage>) => {
        const m = ev.data;
        if (m.type === "progress") {
            if (m.step !== "done") { seen.push(m.step); renderSteps(m.step); }
        } else if (m.type === "log") {
            if (m.level === "warn") { logs.append(el("p", { class: "warn" }, m.text)); logs.hidden = false; }
        } else if (m.type === "result") {
            lastMarkdown = m.markdown;
            renderReport(m.markdown);
            renderSteps(null);
            progress.querySelector(".progress-head b")!.textContent = `Done in ${Math.round((Date.now() - t0) / 1000)} s`;
            ($("downloadMd") as HTMLButtonElement).disabled = false;
            ($("printReport") as HTMLButtonElement).disabled = false;
            finishRun();
            $("report").scrollIntoView({ behavior: "smooth" });
        } else if (m.type === "error") {
            progress.querySelector(".progress-head b")!.textContent = "Failed";
            progress.append(el("p", { class: "err" }, m.message));
            finishRun();
        }
    };
    worker.onerror = (e) => {
        progress.append(el("p", { class: "err" }, `Worker error: ${e.message}`));
        finishRun();
    };
    const req: WorkerRequest = {
        csvText,
        params: JSON.parse(exportParams(params)),
        verbose: ($("verbose") as HTMLInputElement).checked,
        paramsLabel: "web editor settings",
    };
    worker.postMessage(req);
});

$("cancel").addEventListener("click", () => {
    const head = $("progress").querySelector(".progress-head b");
    if (head) head.textContent = "Cancelled";
    finishRun();
});

$("downloadMd").addEventListener("click", () => {
    const base = csvName.replace(/\.csv$/i, "") || "roster";
    download(`report_${base}.md`, lastMarkdown, "text/markdown");
});
$("printReport").addEventListener("click", () => {
    $("reportBody").querySelectorAll("details").forEach((d) => (d.open = true));
    window.print();
});

renderEditor();
if (restored) setStatus("Restored your last settings from this browser. Export them to keep a copy.");
