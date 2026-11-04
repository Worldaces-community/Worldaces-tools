/**
 * Console formatting utilities — ANSI colors + boxes + player format.
 */

import { ScoredPlayer, Rarity } from "../types";

// ─── ANSI colors ──────────────────────────────────────────────────────────────
// Enabled only on a real terminal (or FORCE_COLOR=1), disabled by
// NO_COLOR — output redirected to a file stays clean.

// `process` does not exist in the browser (web bundle) → no colors.
interface ProcLike { env?: Record<string, string | undefined>; stdout?: { isTTY?: boolean } }
const proc = (globalThis as { process?: ProcLike }).process;
const colorsEnabled =
    !!proc?.env && !!proc.stdout &&
    proc.env.NO_COLOR === undefined &&
    proc.env.FORCE_COLOR !== "0" &&
    (proc.stdout?.isTTY === true || proc.env.FORCE_COLOR !== undefined);

const wrap = (code: string) => (s: string): string =>
    colorsEnabled ? `\x1b[${code}m${s}\x1b[0m` : s;

/** Sober report palette. */
export const paint = {
    bold:    wrap("1"),
    dim:     wrap("2"),
    red:     wrap("31"),
    green:   wrap("32"),
    yellow:  wrap("33"),
    magenta: wrap("35"),
    cyan:    wrap("36"),
};

/** Strips ANSI codes (to compute display widths). */
export function stripAnsi(s: string): string {
    // eslint-disable-next-line no-control-regex
    return s.replace(/\x1b\[[0-9;]*m/g, "");
}

/** Visible length (excluding color codes). */
export function visibleLength(s: string): number {
    return stripAnsi(s).length;
}

/** padEnd that ignores color codes when computing the width. */
export function padEndAnsi(s: string, width: number): string {
    const pad = width - visibleLength(s);
    return pad > 0 ? s + " ".repeat(pad) : s;
}

// ─── Lines & boxes ────────────────────────────────────────────────────────────

export const HR = "─".repeat(72);  // ─
export const HR2 = "═".repeat(72); // ═

const TL = "┌"; // ┌
const TR = "┐"; // ┐
const BL = "└"; // └
const BR = "┘"; // ┘
const VL = "│"; // │
const HL = "─"; // ─

/**
 * Frames content lines (auto width, color codes ignored in the
 * width computation, dimmed borders).
 */
export function createBox(lines: string[], minWidth: number = 60): string[] {
    const maxWidth = Math.max(...lines.map(visibleLength), minWidth);

    const border = (l: string, m: string, r: string) =>
        paint.dim(l + m.repeat(maxWidth + 2) + r);

    const result: string[] = [border(TL, HL, TR)];
    for (const line of lines) {
        result.push(paint.dim(VL) + " " + padEndAnsi(line, maxWidth) + " " + paint.dim(VL));
    }
    result.push(border(BL, HL, BR));
    return result;
}

// ─── Player format ────────────────────────────────────────────────────────────

const RARITY_ICONS: Record<Rarity, string> = {
    Special:   "❆❆❆❆", // ❆❆❆❆
    Mythic:    "❆❆❆ ",
    Legendary: "❆❆  ",
    Rare:      "❆   ",
    Common:    "    ",
};

const RARITY_COLOR: Record<Rarity, (s: string) => string> = {
    Special:   paint.magenta,
    Mythic:    paint.cyan,
    Legendary: paint.yellow,
    Rare:      (s) => s,
    Common:    paint.dim,
};

/** Colored rarity icon (fixed visible width = 4). */
export function rarityIcon(rarity: Rarity): string {
    const icon = RARITY_ICONS[rarity] ?? "    ";
    return (RARITY_COLOR[rarity] ?? ((s: string) => s))(icon);
}

/** Colored rarity name. */
export function rarityName(rarity: Rarity): string {
    return (RARITY_COLOR[rarity] ?? ((s: string) => s))(rarity);
}

/**
 * Points of the score due to the stats, traits and sign (they add up to the
 * score; the sign part assumes its effect active unless `signActive` is
 * false: it then counts 0, marked ✗). `withSign` false for the setter (no
 * sign effect).
 */
export function fmtScoreParts(s: ScoredPlayer, withSign = true, signActive = true): string {
    const n = (v: number) => v.toFixed(1).padStart(4);
    const parts = [`stats ${n(s.statScore)}`, `traits ${n(s.traitScore)}`];
    if (withSign) parts.push(signActive ? `sign ${n(s.signScore)}` : `sign ${n(0)} ✗`);
    return parts.join(" · ");
}

/**
 * Average share of the score due to the stats, traits and sign over `players`
 * (e.g. a role's top 10) — shows what traitWeight / signWeight really weigh.
 */
export function fmtScoreShares(players: ScoredPlayer[], withSign = true): string {
    const sum = (f: (s: ScoredPlayer) => number) => players.reduce((a, s) => a + f(s), 0);
    const total = sum((s) => s.score);
    if (!players.length || total <= 0) return "—";
    const pct = (v: number) => `${Math.round((v / total) * 100)}%`;
    const parts = [`stats ${pct(sum((s) => s.statScore))}`, `traits ${pct(sum((s) => s.traitScore))}`];
    if (withSign) parts.push(`sign ${pct(sum((s) => s.signScore))}`);
    return parts.join(" · ");
}

/**
 * Format a scored player for display (ranking line).
 */
export function formatPlayer(s: ScoredPlayer, rank: number, withSign = true): string {
    const p = s.player;
    const traits = p.traits.length ? paint.dim(` [${p.traits.join(", ")}]`) : "";
    return `  ${String(rank).padStart(2)}. ${rarityIcon(p.rarity)} ${p.fullName.padEnd(26)} ` +
           `Score: ${paint.bold(s.score.toFixed(1).padStart(5))} ` +
           `${paint.dim(`(${fmtScoreParts(s, withSign)})`)}  Age: ${p.age}${traits}`;
}
