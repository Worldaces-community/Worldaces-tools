/**
 * Console reporter for roster analysis
 * Toute la mise en forme du rapport console (français, sections numérotées
 * dynamiquement, couleurs ANSI sobres — cf. formatters).
 */

import { ScoredPlayer, RoleName, Params, Rarity } from "../types";
import { WeaknessAnalysis } from "../analysis/weaknessAnalyzer";
import { RecruitmentAnalysis, RoleUrgency, TraitUrgency } from "../analysis/recruitmentAnalyzer";
import { RosterBalanceResult, rosterTarget, targetCounts } from "../analysis/rosterBalanceAnalyzer";
import { Substitute } from "../lineup/lineupBuilder";
import { LiberoRotationAnalysis } from "../analysis/liberoRotationAnalyzer";
import { AvailabilityResult } from "../analysis/availabilityAnalyzer";
import { AcademyAnalysis, AcademyMove } from "../analysis/academyAnalyzer";
import { SETTINGS } from "../config/settings";
import { Reporter } from "./reporter";
import { ChemistryAnalysis, fmtChem, fmtChemVerdict, fmtOn, fmtSign } from "../lineup/signChemistry";
import { formatPlayer, createBox, rarityName, padEndAnsi, paint, HR, HR2 } from "./formatters";
import { ROLE_LABELS } from "../config/constants";

/** Couleur d'un score normalisé 0-99 (échelle commune à tout le rapport). */
function scoreColor(score: number): (s: string) => string {
    if (score >= 65) return paint.green;
    if (score >= 50) return paint.yellow;
    return paint.red;
}

/** Δ des remplaçants : toujours <= 0 par construction (domination du MILP). */
function formatDelta(delta: number): string {
    const rounded = Math.round(delta);
    const label = `Δ${rounded === 0 ? "0" : rounded > 0 ? `+${rounded}` : rounded}`;
    return rounded < 0 ? paint.dim(label) : label;
}

/**
 * Console Reporter class
 * Handles all console output for the analysis
 */
export class ConsoleReporter implements Reporter {
    /** Compteur de sections — la numérotation suit ce qui est réellement affiché. */
    private sectionCount = 0;

    /** Affiche les formules de score et bonus de traits par rôle (--verbose). */
    verbose = false;

    /** Bandeau de section numérotée (═══ N · TITRE ═══). */
    section(title: string): void {
        this.sectionCount += 1;
        console.log("\n" + paint.dim(HR2));
        console.log(`  ${paint.bold(paint.cyan(`${this.sectionCount} · ${title}`))}`);
        console.log(paint.dim(HR2));
    }

    /** Bandeau non numéroté (header, roster…). */
    banner(title: string): void {
        console.log("\n" + paint.dim(HR2));
        console.log(`  ${paint.bold(paint.cyan(title))}`);
        console.log(paint.dim(HR2));
    }

    subSection(title: string): void {
        console.log("\n" + paint.dim(HR));
        console.log(`  ${paint.bold(`▶ ${title}`)}`);
        console.log(paint.dim(HR));
    }

    /**
     * Display the header
     */
    header(rosterCount: number, paramsPath: string, availableCount?: number): void {
        this.banner("🏐  WORLD ACES – ROSTER ANALYSIS");
        const avail = availableCount !== undefined && availableCount !== rosterCount
            ? ` (${availableCount} available for the lineup)` : "";
        console.log(`  Roster: ${rosterCount} players${avail}   |   Params: ${paramsPath}`);
        if (!this.verbose) {
            console.log(paint.dim("  (--verbose shows the score formulas per role)"));
        }
    }

    /**
     * Classements par rôle (section 1)
     */
    reportRoleRankings(
        allRankings: Record<RoleName, ScoredPlayer[]>,
        roleLabels: Record<RoleName, string>,
        params: Params
    ): void {
        this.section("ROLE RANKINGS");

        for (const roleName of Object.keys(allRankings) as RoleName[]) {
            const config = params.roles[roleName];
            const ranked = allRankings[roleName];

            this.subSection(`${roleLabels[roleName]} – top 10`);
            ranked.slice(0, 10).forEach((s, i) => {
                console.log(formatPlayer(s, i + 1));
            });

            if (this.verbose) {
                const fmtBonus = (v: number) => (v >= 0 ? `+${v}` : `${v}`);
                console.log(paint.dim(`\n  Stat weights: ${Object.entries(config.statsWeights)
                    .filter(([, v]) => v !== 0)
                    .map(([k, v]) => `${k}×${v}`)
                    .join(" + ")}`));
                console.log(paint.dim(`  Trait bonuses: ${Object.entries(config.traitBonuses)
                    .filter(([, v]) => v !== 0)
                    .map(([k, v]) => `${k}(${fmtBonus(Math.round(v * 10) / 10)})`)
                    .join(", ")}`));
                const signs = Object.entries(config.signBonuses ?? {}).filter(([, v]) => v !== 0);
                if (signs.length) {
                    console.log(paint.dim(`  Sign bonuses: ${signs
                        .map(([k, v]) => `${k}(${fmtBonus(v)})`)
                        .join(", ")}`));
                }
            }
        }
    }

    /**
     * Lineup 5-1 (récap + titulaires + banc + réservistes). Affichage dans l'ordre des positions
     * terrain (1 = passeur, 2 = Front OH, … 7 = libéro), banc et réserve alignés.
     */
    reportLineup(
        title: string,
        lineup: Record<string, ScoredPlayer | null>,
        lineupOrder: string[],
        substitutes: Substitute[]
    ): void {
        this.section(title);

        // Récapitulatif saisie en jeu : une ligne par position, les 3 étages côte
        // à côte (titulaire / remplaçant avec Δ / remplaçant blessure).
        const recapLines: string[] = [
            paint.bold("  SUMMARY (in-game entry)"),
            paint.bold(`     ${"Position".padEnd(20)} ${"Starter".padEnd(24)} ${"Substitute".padEnd(30)} Injury reserve`),
        ];
        lineupOrder.forEach((slot, i) => {
            const starter = lineup[slot]?.player.fullName ?? paint.red("—");
            const sub = substitutes[i];
            const subName = sub?.sub
                ? `${sub.sub.player.fullName} (${formatDelta(sub.delta)})`
                : paint.dim("—");
            const resName = sub?.reserve ? sub.reserve.player.fullName : paint.dim("—");
            recapLines.push(
                `  ${i + 1}. ${slot.padEnd(20)} ${padEndAnsi(starter, 24)} ${padEndAnsi(subName, 30)} ${resName}`
            );
        });
        console.log("\n" + createBox(recapLines, 80).join("\n"));

        // Titulaires — numérotés par position terrain (ordre de service).
        const starterLines: string[] = [];
        lineupOrder.forEach((slot, i) => {
            const pos = `${i + 1}.`;
            const s = lineup[slot];
            if (!s) {
                starterLines.push(`  ${pos} ${slot.padEnd(20)} ${paint.red("── NO ELIGIBLE PLAYER")}`);
                return;
            }
            const p = s.player;
            starterLines.push(
                `  ${pos} ${slot.padEnd(20)} ${p.fullName.padEnd(24)} ` +
                `${padEndAnsi(rarityName(p.rarity as Rarity), 10)} ` +
                `Score: ${scoreColor(s.score)(s.score.toFixed(0).padStart(3))}`
            );
        });
        console.log("\n" + createBox([paint.bold("  STARTERS"), ...starterLines], 80).join("\n"));

        // Banc — même ordre de positions que les titulaires.
        const subLines: string[] = [];
        substitutes.forEach((sub, i) => {
            const pos = `${i + 1}.`;
            if (sub.sub) {
                const p = sub.sub.player;
                subLines.push(
                    `  ${pos} ${sub.label.padEnd(17)} ${p.fullName.padEnd(24)} ` +
                    `${padEndAnsi(rarityName(p.rarity as Rarity), 10)} ` +
                    `Score: ${scoreColor(sub.sub.score)(sub.sub.score.toFixed(0).padStart(3))}  ` +
                    `→ replaces ${sub.replaces} (${formatDelta(sub.delta)})`
                );
            } else {
                subLines.push(
                    `  ${pos} ${sub.label.padEnd(17)} ${paint.dim("── no eligible player")}` +
                    " ".repeat(14) + `→ replaces ${sub.replaces}`
                );
            }
        });
        console.log("\n" + createBox([paint.bold("  BENCH"), ...subLines], 80).join("\n"));

        // Réservistes (blessures) : montent au banc quand le titulaire du slot
        // est blessé (son remplaçant entre alors dans le six de base).
        const reserveLines: string[] = [
            paint.bold("  INJURY RESERVES"),
        ];
        substitutes.forEach((sub, i) => {
            const pos = `${i + 1}.`;
            const resLabel = sub.label.replace(/^Sub /, "Res. ");
            if (sub.reserve) {
                const p = sub.reserve.player;
                reserveLines.push(
                    `  ${pos} ${resLabel.padEnd(17)} ${p.fullName.padEnd(24)} ` +
                    `${padEndAnsi(rarityName(p.rarity as Rarity), 10)} ` +
                    `Score: ${scoreColor(sub.reserve.score)(sub.reserve.score.toFixed(0).padStart(3))}  ` +
                    `→ bench if ${sub.replaces} injured (${formatDelta(sub.reserveDelta)})`
                );
            } else {
                reserveLines.push(
                    `  ${pos} ${resLabel.padEnd(17)} ${paint.dim("── no eligible player")}` +
                    " ".repeat(14) + `→ bench if ${sub.replaces} injured`
                );
            }
        });
        console.log("\n" + createBox(reserveLines, 80).join("\n"));
    }

    /**
     * Rotation du 2ᵉ libéro (substitution réception / service).
     * Compare nos 2 libéros retenus sur des sous-profils réception vs défense
     * séparés (sous-stats ET traits différenciés) et indique s'il faut activer
     * la rotation entre phase de réception et phase de service.
     */
    reportSignChemistry(a: ChemistryAnalysis): void {
        if (!a.hasSigns) return;
        const mark = (v: string) =>
            v === "✓" ? paint.green(v) : v === "✗" ? paint.red(v) : v === "½" ? paint.yellow(v) : paint.dim(v);
        const lines: string[] = [
            paint.bold(`  SIGN CHEMISTRY — ${fmtChemVerdict(a)}`),
            "",
            paint.bold(`     ${"Position".padEnd(20)} ${"Sign".padEnd(22)} ${"Chem.".padStart(7)}  Effect Setter link`),
        ];
        a.starters.forEach((s, i) => {
            lines.push(
                `  ${i + 1}. ${s.slot.padEnd(20)} ${fmtSign(s).padEnd(22)} ${fmtChem(s.chem).padStart(7)}  ` +
                `${padEndAnsi(mark(fmtOn(s.active)), 5)}  ${mark(fmtOn(s.connected))}`
            );
        });
        lines.push("", paint.dim("  Chemistry: front-MB phase / back-MB phase · ✓ active · ½ one phase · ✗ inactive"));
        console.log("\n" + createBox(lines, 80).join("\n"));
    }

    reportLiberoRotation(analysis: LiberoRotationAnalysis): void {
        const lines: string[] = [
            paint.bold("  LIBERO — RECEPTION / SERVE ROTATION (2nd libero)"),
        ];

        if (analysis.liberos.length > 0) {
            lines.push("");
            lines.push(paint.bold(
                `  ${"Libero".padEnd(24)} ${"Overall".padStart(7)} ${"Recep.".padStart(7)} ` +
                `${"Defense".padStart(8)}  Phase-specific traits`
            ));
            for (const l of analysis.liberos) {
                const marks =
                    (analysis.verdict !== "single" && analysis.receptionSpecialist?.player === l.player
                        ? " " + paint.cyan("◄ recep") : "") +
                    (analysis.verdict !== "single" && analysis.defenseSpecialist?.player === l.player
                        ? " " + paint.magenta("◄ def") : "");
                const tags = [
                    ...l.receptionOnlyTraits.map((t) => `${t} (recep)`),
                    ...l.defenseOnlyTraits.map((t) => `${t} (def)`),
                ].join(", ") || paint.dim("—");
                lines.push(
                    `  ${l.player.fullName.padEnd(24)} ` +
                    `${scoreColor(l.overallScore)(l.overallScore.toFixed(0).padStart(7))} ` +
                    `${scoreColor(l.receptionScore)(l.receptionScore.toFixed(0).padStart(7))} ` +
                    `${scoreColor(l.defenseScore)(l.defenseScore.toFixed(0).padStart(8))}  ` +
                    `${tags}${marks}`
                );
            }
        }

        const badge = {
            system:      paint.green("✓ ROTATION ADVISED"),
            situational: paint.yellow("~ SITUATIONAL ROTATION"),
            none:        paint.dim("• NO ROTATION"),
            single:      paint.yellow("⚠ ONLY ONE LIBERO"),
        }[analysis.verdict];

        lines.push("");
        lines.push(`  ${badge}`);
        for (const l of this.wrapText(analysis.note, 76)) lines.push(`  ${l}`);

        console.log("\n" + createBox(lines, 80).join("\n"));
    }

    /** Coupe un texte en lignes de largeur <= width (aux espaces), pour les boxes. */
    private wrapText(text: string, width: number): string[] {
        const words = text.split(/\s+/);
        const out: string[] = [];
        let cur = "";
        for (const w of words) {
            if (cur && (cur.length + 1 + w.length) > width) {
                out.push(cur);
                cur = w;
            } else {
                cur = cur ? `${cur} ${w}` : w;
            }
        }
        if (cur) out.push(cur);
        return out.length ? out : [""];
    }

    /**
     * Academy (entrées / sorties) + exclusions liées à la progression.
     */
    reportAcademyAndProgress(av: AvailabilityResult, academy: AcademyAnalysis): void {
        this.section("ACADEMY & PROGRESSION");

        const fmtMove = (m: AcademyMove, withSlot: boolean): string => {
            const sc = m.score !== null ? `Score: ${scoreColor(m.score)(m.score.toFixed(0).padStart(3))}` : "Score:   —";
            const slot = withSlot && m.slot
                ? `→ ${m.slot}${m.displaces ? paint.dim(` (instead of ${m.displaces})`) : ""}`
                : paint.dim(m.reason);
            const tooOld = withSlot && m.player.age > SETTINGS.academy.maxAge ? paint.dim(` · ${m.reason}`) : "";
            return `  ${m.player.fullName.padEnd(24)} ${String(m.player.age).padStart(2)} y.o.  ${sc}  ${slot}${tooOld}`;
        };

        const lines: string[] = [paint.bold(`  ACADEMY (eligible up to age ${SETTINGS.academy.maxAge})`), ""];
        lines.push(paint.bold(`  ${paint.green("⬆")} MOVE OUT OF THE ACADEMY (${academy.out.length})`));
        if (academy.out.length === 0) lines.push(paint.dim("  — none"));
        for (const m of academy.out) lines.push(fmtMove(m, m.slot !== null));
        lines.push("", paint.bold(`  ${paint.cyan("⬇")} SEND TO THE ACADEMY (${academy.in.length})`));
        if (academy.in.length === 0) lines.push(paint.dim("  — none"));
        for (const m of academy.in) lines.push(fmtMove(m, false));
        lines.push("", paint.bold(`  • STAYING AT THE ACADEMY (${academy.stay.length})`));
        if (academy.stay.length === 0) lines.push(paint.dim("  — none"));
        for (const m of academy.stay) lines.push(fmtMove(m, false));
        console.log("\n" + createBox(lines, 80).join("\n"));

        const prog: string[] = [paint.bold("  PROGRESS — PLAYERS NO LONGER IMPROVING")];
        if (av.declining.length === 0 && av.retiring.length === 0) {
            prog.push("", `  ${paint.green("✓")} All active players are still improving.`);
        }
        if (av.declining.length > 0) {
            prog.push("", paint.bold(`  STARTING TO DECLINE (kept if starting-six gain ≥ +${SETTINGS.availability.declineExceptionalMinGain})`));
            for (const d of av.declining) {
                const verdict = d.kept
                    ? paint.green("✓ exceptional: available")
                    : paint.red("✗ excluded, release");
                prog.push(
                    `  ${d.player.fullName.padEnd(24)} ${String(d.player.age).padStart(2)} y.o.  ` +
                    `gain ${(d.gain >= 0 ? "+" : "") + d.gain.toFixed(1)}  ${verdict}`
                );
            }
        }
        if (av.retiring.length > 0) {
            prog.push("", paint.bold("  CONSIDERING RETIREMENT (excluded, release)"));
            for (const p of av.retiring) {
                prog.push(`  ${p.fullName.padEnd(24)} ${String(p.age).padStart(2)} y.o.  ${paint.red("✗ excluded")}`);
            }
        }
        console.log("\n" + createBox(prog, 80).join("\n"));
    }

    /**
     * Points faibles de l'équipe (section 5).
     */
    reportWeaknessAnalysis(analysis: WeaknessAnalysis): void {
        this.section("TEAM WEAK SPOTS (5-1)");
        console.log();

        for (const rw of analysis.roleWeaknesses) {
            const bar = "▓".repeat(Math.min(20, Math.round(rw.topNormalized / 5)));
            const color = scoreColor(rw.topScore);
            console.log(
                `  ${rw.label.padEnd(24)} ${rw.topPlayer.padEnd(24)} ` +
                `${color(bar.padEnd(20))} Score: ${color(rw.topScore.toFixed(0))}`
            );
            console.log(paint.dim(`  ${" ".padEnd(24)} Priority stats: ${rw.keyWeakStats.join(", ")}`));
            console.log();
        }

        console.log("  Trait coverage in the starting six:");
        console.log(`  ${paint.green("Solid (≥2)")}  : ${analysis.presentTraits.join(", ") || "—"}`);
        if (analysis.weakTraits.length) {
            console.log(`  ${paint.yellow("Fragile (1×)")} : ${analysis.weakTraits.join(", ")}`);
        }
        if (analysis.missingTraits.length) {
            console.log(`  ${paint.red("Missing")}     : ${analysis.missingTraits.join(", ")}`);
        }
    }

    /**
     * Filtre de recrutement (rôles + traits à cibler).
     */
    reportRecruitmentAnalysis(analysis: RecruitmentAnalysis): void {
        const lines: string[] = [
            paint.bold("  RECRUITMENT FILTER"),
            analysis.top3Signs.length
                ? "  Set the 3 roles + 3 traits + 3 signs below in the recruitment screen."
                : "  Set the 3 roles + 3 traits below in the recruitment screen.",
            "",
            paint.bold("  ROLES (by priority)"),
            ...analysis.top3Roles.map(({ label, reason }: RoleUrgency, i: number) =>
                `  ${i + 1}. ${label.padEnd(22)} ${paint.dim(`— ${reason}`)}`
            ),
            "",
            paint.bold("  TRAITS (for these 3 roles)"),
            ...analysis.top3Traits.map(({ trait, reason }: TraitUrgency, i: number) =>
                `  ${i + 1}. ${trait.padEnd(22)} ${paint.dim(`— ${reason}`)}`
            ),
        ];
        if (analysis.top3Signs.length) {
            lines.push("", paint.bold("  SIGNS (for these 3 roles)"));
            analysis.top3Signs.forEach(({ sign, reason }, i) => {
                lines.push(
                    `  ${i + 1}. ${sign.padEnd(22)} ` +
                    `${paint.dim(`— ${reason}`)}`
                );
            });
        }
        console.log("\n" + createBox(lines, 80).join("\n"));
    }

    /**
     * Gestion du roster — joueurs à vendre (affiché si > ROSTER_TARGET joueurs).
     */
    reportRosterBalance(result: RosterBalanceResult): void {
        this.section("ROSTER MANAGEMENT — PLAYERS TO SELL");

        const roleCountStr = Object.entries(targetCounts())
            .map(([r, n]) => `${n} ${ROLE_LABELS[r as keyof typeof ROLE_LABELS].replace(" (OH)", "").replace(" (MB)", "").replace(" (OP)", "")}`)
            .join(" · ");

        console.log(`\n  Current roster: ${result.totalPlayers} players  |  Target: ${rosterTarget()}`);
        console.log(`  Target composition: ${roleCountStr}\n`);

        if (!result.feasible) {
            for (const s of result.shortfalls) {
                const label = ROLE_LABELS[s.role];
                console.log(`  ${paint.yellow("⚠")} Not enough players: ${label} — ${s.eligible} eligible / ${s.target} required (${s.kept} kept)`);
            }
            if (result.flexKeeps.length > 0) {
                const names = result.flexKeeps
                    .map(f => `${f.player.fullName}${f.bestRole ? ` (${ROLE_LABELS[f.bestRole]})` : ""}`)
                    .join(", ");
                console.log(paint.dim(`    → ${result.flexKeeps.length} slot${result.flexKeeps.length > 1 ? "s" : ""} reassigned to the best remaining players: ${names}`));
            }
            console.log();
        }

        console.log(
            `  To sell: ${result.toSell}` +
            (result.forcedCount > 0 ? paint.dim(` (including ${result.forcedCount} first: no longer improving)`) : "") +
            "\n"
        );

        if (result.sellCandidates.length === 0) {
            console.log(`  ${paint.green("✓")} No player to sell.`);
            return;
        }

        const lines: string[] = [];
        for (const [i, c] of result.sellCandidates.entries()) {
            if (i === 0 && result.forcedCount > 0) {
                lines.push(paint.bold("  FIRST — NO LONGER IMPROVING"));
            }
            if (i === result.forcedCount) {
                if (i > 0) lines.push("");
                lines.push(paint.bold("  ROSTER QUOTA (worst to best on their best role)"));
            }
            const name    = c.player.fullName.padEnd(25);
            const rarity  = `[${c.player.rarity}]`.padEnd(12);
            const roleTag = c.bestRole ? ROLE_LABELS[c.bestRole].padEnd(24) : "—".padEnd(24);
            const score   = c.bestScore > 0 ? `Score: ${c.bestScore.toFixed(0).padStart(3)}` : "not eligible";
            const why     = c.reason ? `  ${paint.dim(c.reason)}` : "";
            lines.push(`  ${String(i + 1).padStart(2)}. ${name} ${rarity} ${roleTag} ${score}${why}`);
        }
        console.log(createBox(lines, 90).join("\n") + "\n");
    }

    /**
     * Display footer
     */
    footer(): void {
        console.log("\n" + paint.dim(HR2));
        console.log("  Analysis complete.");
        console.log(paint.dim(HR2) + "\n");
    }
}
