/**
 * Console formatting utilities — couleurs ANSI + boxes + format joueur.
 */

import { ScoredPlayer, Rarity } from "../types";

// ─── Couleurs ANSI ────────────────────────────────────────────────────────────
// Activées seulement sur un vrai terminal (ou FORCE_COLOR=1), désactivées par
// NO_COLOR — la sortie redirigée vers un fichier reste propre.

// `process` n'existe pas dans le navigateur (bundle web) → pas de couleurs.
interface ProcLike { env?: Record<string, string | undefined>; stdout?: { isTTY?: boolean } }
const proc = (globalThis as { process?: ProcLike }).process;
const colorsEnabled =
    !!proc?.env && !!proc.stdout &&
    proc.env.NO_COLOR === undefined &&
    proc.env.FORCE_COLOR !== "0" &&
    (proc.stdout?.isTTY === true || proc.env.FORCE_COLOR !== undefined);

const wrap = (code: string) => (s: string): string =>
    colorsEnabled ? `\x1b[${code}m${s}\x1b[0m` : s;

/** Palette sobre du rapport. */
export const paint = {
    bold:    wrap("1"),
    dim:     wrap("2"),
    red:     wrap("31"),
    green:   wrap("32"),
    yellow:  wrap("33"),
    magenta: wrap("35"),
    cyan:    wrap("36"),
};

/** Retire les codes ANSI (pour calculer les largeurs d'affichage). */
export function stripAnsi(s: string): string {
    // eslint-disable-next-line no-control-regex
    return s.replace(/\x1b\[[0-9;]*m/g, "");
}

/** Longueur visible (hors codes couleur). */
export function visibleLength(s: string): number {
    return stripAnsi(s).length;
}

/** padEnd qui ignore les codes couleur dans le calcul de largeur. */
export function padEndAnsi(s: string, width: number): string {
    const pad = width - visibleLength(s);
    return pad > 0 ? s + " ".repeat(pad) : s;
}

// ─── Lignes & boxes ───────────────────────────────────────────────────────────

export const HR = "─".repeat(72);  // ─
export const HR2 = "═".repeat(72); // ═

const TL = "┌"; // ┌
const TR = "┐"; // ┐
const BL = "└"; // └
const BR = "┘"; // ┘
const VL = "│"; // │
const HL = "─"; // ─

/**
 * Encadre des lignes de contenu (largeur auto, codes couleur ignorés dans le
 * calcul de largeur, bordures atténuées).
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

// ─── Format joueur ────────────────────────────────────────────────────────────

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

/** Icône de rareté colorée (largeur visible fixe = 4). */
export function rarityIcon(rarity: Rarity): string {
    const icon = RARITY_ICONS[rarity] ?? "    ";
    return (RARITY_COLOR[rarity] ?? ((s: string) => s))(icon);
}

/** Nom de rareté coloré. */
export function rarityName(rarity: Rarity): string {
    return (RARITY_COLOR[rarity] ?? ((s: string) => s))(rarity);
}

/**
 * Format a scored player for display (ligne de classement).
 */
export function formatPlayer(s: ScoredPlayer, rank: number): string {
    const p = s.player;
    const traits = p.traits.length ? paint.dim(` [${p.traits.join(", ")}]`) : "";
    return `  ${String(rank).padStart(2)}. ${rarityIcon(p.rarity)} ${p.fullName.padEnd(26)} ` +
           `Score : ${paint.bold(s.score.toFixed(1).padStart(5))}  Âge : ${p.age}${traits}`;
}
