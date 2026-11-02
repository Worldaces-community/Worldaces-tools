/**
 * Markdown reporter — même contenu que le rapport console, rendu en markdown
 * GitHub (titres, tableaux, emoji). Destiné au job summary GitHub Actions
 * ($GITHUB_STEP_SUMMARY) : lisible sur mobile là où les boxes ASCII des logs
 * se font rewrapper.
 *
 * Navigation par blocs repliables (`<details>`) : chaque section numérotée est
 * un bloc ouvert par défaut mais repliable (titre cliquable), et les sous-blocs
 * (tables détaillées, recrutement…) sont repliés par défaut avec leur
 * verdict résumé dans le titre. Seul le RÉCAPITULATIF du lineup (saisie en jeu)
 * est toujours visible.
 *
 * Usage : npm run a <roster.csv> [params.json] -- --md rapport.md
 */

import { ScoredPlayer, RoleName, Params, Rarity } from "../types";
import { WeaknessAnalysis } from "../analysis/weaknessAnalyzer";
import { RecruitmentAnalysis } from "../analysis/recruitmentAnalyzer";
import { RosterBalanceResult, rosterTarget, targetCounts } from "../analysis/rosterBalanceAnalyzer";
import { Substitute } from "../lineup/lineupBuilder";
import { LiberoRotationAnalysis } from "../analysis/liberoRotationAnalyzer";
import { AvailabilityResult } from "../analysis/availabilityAnalyzer";
import { AcademyAnalysis, AcademyMove } from "../analysis/academyAnalyzer";
import { SETTINGS } from "../config/settings";
import { Reporter } from "./reporter";
import { ChemistryAnalysis, fmtChem, fmtChemVerdict, fmtOn, fmtSign } from "../lineup/signChemistry";
import { ROLE_LABELS } from "../config/constants";

/** Icône compacte de rareté (pas de couleur en markdown). */
const RARITY_MD: Record<Rarity, string> = {
    Special:   "❆❆❆❆ Special",
    Mythic:    "❆❆❆ Mythic",
    Legendary: "❆❆ Legendary",
    Rare:      "❆ Rare",
    Common:    "Common",
};

function rarity(r: Rarity): string {
    return RARITY_MD[r] ?? String(r);
}

/** Pastille de score sur l'échelle commune 0-99. */
function scoreBadge(score: number): string {
    const icon = score >= 65 ? "🟢" : score >= 50 ? "🟡" : "🔴";
    return `${icon} ${score.toFixed(0)}`;
}

function delta(d: number): string {
    const r = Math.round(d);
    return `Δ${r === 0 ? "0" : r > 0 ? `+${r}` : r}`;
}

export class MarkdownReporter implements Reporter {
    verbose = false;

    private out: string[] = [];
    private sectionCount = 0;
    /** Section numérotée (details ouvert) en cours — fermée au section() suivant. */
    private sectionOpen = false;

    private push(...lines: string[]): void {
        this.out.push(...lines);
    }

    /** Rapport accumulé, en markdown (la CLI l'écrit dans un fichier). */
    toMarkdown(): string {
        this.closeSection();
        return this.out.join("\n") + "\n";
    }

    private closeSection(): void {
        if (this.sectionOpen) {
            this.push("", "</details>");
            this.sectionOpen = false;
        }
    }

    /** Section numérotée repliable (titre cliquable), ouverte par défaut. */
    private section(title: string): void {
        this.closeSection();
        this.sectionCount += 1;
        this.push("", `<details open><summary><h2>${this.sectionCount} · ${title}</h2></summary>`, "");
        this.sectionOpen = true;
    }

    /** Ouvre un sous-bloc replié par défaut ; `badge` résume le verdict dans le titre. */
    private openBlock(title: string, badge?: string): void {
        const suffix = badge ? ` — ${badge}` : "";
        this.push("", `<details><summary><b>${title}</b>${suffix}</summary>`, "");
    }

    private closeBlock(): void {
        this.push("", "</details>");
    }

    header(rosterCount: number, paramsPath: string, availableCount?: number): void {
        const avail = availableCount !== undefined && availableCount !== rosterCount
            ? ` (${availableCount} available for the lineup)` : "";
        this.push(
            "# 🏐 World Aces – Roster analysis",
            "",
            `**Roster**: ${rosterCount} players${avail} · **Params**: \`${paramsPath}\``
        );
    }

    reportRoleRankings(
        allRankings: Record<RoleName, ScoredPlayer[]>,
        roleLabels: Record<RoleName, string>,
        params: Params
    ): void {
        this.section("ROLE RANKINGS");

        for (const roleName of Object.keys(allRankings) as RoleName[]) {
            const ranked = allRankings[roleName];
            const top = ranked[0];
            this.openBlock(
                `${roleLabels[roleName]} – top 10`,
                top ? `#1: ${top.player.fullName} (${top.score.toFixed(0)})` : undefined
            );
            this.push("| # | Player | Rarity | Age | Score | Traits |");
            this.push("|--:|---|---|--:|--:|---|");
            ranked.slice(0, 10).forEach((s, i) => {
                const p = s.player;
                this.push(
                    `| ${i + 1} | ${p.fullName} | ${rarity(p.rarity)} | ${p.age} | ` +
                    `**${s.score.toFixed(1)}** | ${p.traits.join(", ") || "—"} |`
                );
            });
            if (this.verbose) {
                const config = params.roles[roleName];
                const fmtBonus = (v: number) => (v >= 0 ? `+${v}` : `${v}`);
                this.push(
                    "",
                    `*Stat weights: ${Object.entries(config.statsWeights)
                        .filter(([, v]) => v !== 0)
                        .map(([k, v]) => `${k}×${v}`)
                        .join(" + ")}*`,
                    `*Trait bonuses: ${Object.entries(config.traitBonuses)
                        .filter(([, v]) => v !== 0)
                        .map(([k, v]) => `${k} (${fmtBonus(Math.round(v * 10) / 10)})`)
                        .join(", ")}*`
                );
                const signs = Object.entries(config.signBonuses ?? {}).filter(([, v]) => v !== 0);
                if (signs.length) {
                    this.push(`*Sign bonuses: ${signs.map(([k, v]) => `${k} (${fmtBonus(v)})`).join(", ")}*`);
                }
            }
            this.closeBlock();
        }
    }

    reportLineup(
        title: string,
        lineup: Record<string, ScoredPlayer | null>,
        lineupOrder: string[],
        substitutes: Substitute[]
    ): void {
        this.section(title);

        // Récapitulatif saisie en jeu — toujours visible : une ligne par position,
        // les 3 étages côte à côte.
        this.push("| # | Position | Starter | Substitute | Injury reserve |");
        this.push("|--:|---|---|---|---|");
        lineupOrder.forEach((slot, i) => {
            const starter = lineup[slot] ? `**${lineup[slot]!.player.fullName}**` : "⚠️ —";
            const sub = substitutes[i];
            const subName = sub?.sub ? `${sub.sub.player.fullName} (${delta(sub.delta)})` : "—";
            const resName = sub?.reserve ? sub.reserve.player.fullName : "—";
            this.push(`| ${i + 1} | ${slot} | ${starter} | ${subName} | ${resName} |`);
        });

        this.openBlock("Starters (rarity & score)");
        this.push("| # | Position | Player | Rarity | Score |");
        this.push("|--:|---|---|---|--:|");
        lineupOrder.forEach((slot, i) => {
            const s = lineup[slot];
            this.push(
                s
                    ? `| ${i + 1} | ${slot} | **${s.player.fullName}** | ${rarity(s.player.rarity as Rarity)} | ${scoreBadge(s.score)} |`
                    : `| ${i + 1} | ${slot} | ⚠️ *no eligible player* | — | — |`
            );
        });
        this.closeBlock();

        this.openBlock("Bench (rarity & score)");
        this.push("| # | Slot | Player | Rarity | Score | Replaces |");
        this.push("|--:|---|---|---|--:|---|");
        substitutes.forEach((sub, i) => {
            this.push(
                sub.sub
                    ? `| ${i + 1} | ${sub.label} | ${sub.sub.player.fullName} | ${rarity(sub.sub.player.rarity as Rarity)} | ` +
                      `${scoreBadge(sub.sub.score)} | ${sub.replaces} (${delta(sub.delta)}) |`
                    : `| ${i + 1} | ${sub.label} | *no eligible player* | — | — | ${sub.replaces} |`
            );
        });
        this.closeBlock();

        this.openBlock("Injury reserves (rarity & score)");
        this.push("| # | Slot | Player | Rarity | Score | Bench if injured |");
        this.push("|--:|---|---|---|--:|---|");
        substitutes.forEach((sub, i) => {
            const resLabel = sub.label.replace(/^Sub /, "Res. ");
            this.push(
                sub.reserve
                    ? `| ${i + 1} | ${resLabel} | ${sub.reserve.player.fullName} | ${rarity(sub.reserve.player.rarity as Rarity)} | ` +
                      `${scoreBadge(sub.reserve.score)} | ${sub.replaces} (${delta(sub.reserveDelta)}) |`
                    : `| ${i + 1} | ${resLabel} | *no eligible player* | — | — | ${sub.replaces} |`
            );
        });
        this.closeBlock();
    }

    reportSignChemistry(a: ChemistryAnalysis): void {
        if (!a.hasSigns) return;
        this.openBlock("Sign chemistry", fmtChemVerdict(a));
        this.push("| # | Position | Player | Sign | Chemistry | Effect | Setter connection |");
        this.push("|--:|---|---|---|--:|:-:|:-:|");
        a.starters.forEach((s, i) => {
            this.push(
                `| ${i + 1} | ${s.slot} | ${s.name ?? "—"} | ${fmtSign(s)} | ${fmtChem(s.chem)} | ` +
                `${fmtOn(s.active)} | ${fmtOn(s.connected)} |`
            );
        });
        this.push("", "*Chemistry: front-MB phase / back-MB phase (the libero replaces the back MB) · ✓ active · ½ one phase out of two · ✗ inactive.*");
        this.closeBlock();
    }

    reportLiberoRotation(analysis: LiberoRotationAnalysis): void {
        const badge = {
            system:      "✅ rotation advised",
            situational: "🟡 situational rotation",
            none:        "no rotation",
            single:      "⚠️ only one libero",
        }[analysis.verdict];

        this.openBlock("Libero — reception / serve rotation (2nd libero)", badge);

        if (analysis.liberos.length > 0) {
            this.push("| Libero | Overall | Recep. | Defense | Phase-specific traits |");
            this.push("|---|--:|--:|--:|---|");
            for (const l of analysis.liberos) {
                const marks =
                    (analysis.verdict !== "single" && analysis.receptionSpecialist?.player === l.player ? " ◄ recep" : "") +
                    (analysis.verdict !== "single" && analysis.defenseSpecialist?.player === l.player ? " ◄ def" : "");
                const tags = [
                    ...l.receptionOnlyTraits.map((t) => `${t} (recep)`),
                    ...l.defenseOnlyTraits.map((t) => `${t} (def)`),
                ].join(", ") || "—";
                this.push(
                    `| **${l.player.fullName}**${marks} | ${scoreBadge(l.overallScore)} | ` +
                    `${scoreBadge(l.receptionScore)} | ${scoreBadge(l.defenseScore)} | ${tags} |`
                );
            }
            this.push("");
        }
        this.push(analysis.note);
        this.closeBlock();
    }

    reportAcademyAndProgress(av: AvailabilityResult, academy: AcademyAnalysis): void {
        this.section("ACADEMY & PROGRESSION");

        const score = (m: AcademyMove) => (m.score !== null ? scoreBadge(m.score) : "—");
        const table = (moves: AcademyMove[], withSlot: boolean): void => {
            if (moves.length === 0) {
                this.push("*None.*");
                return;
            }
            this.push(withSlot ? "| Player | Age | Score | Target slot | Reason |" : "| Player | Age | Score | Reason |");
            this.push(withSlot ? "|---|--:|--:|---|---|" : "|---|--:|--:|---|");
            for (const m of moves) {
                const slot = m.slot ? `${m.slot}${m.displaces ? ` (instead of ${m.displaces})` : ""}` : "—";
                this.push(
                    withSlot
                        ? `| **${m.player.fullName}** | ${m.player.age} | ${score(m)} | ${slot} | ${m.reason} |`
                        : `| ${m.player.fullName} | ${m.player.age} | ${score(m)} | ${m.reason} |`
                );
            }
        };

        this.push(`**Academy** (eligible up to age ${SETTINGS.academy.maxAge})`, "");
        this.push(`#### ⬆️ Move out of the Academy (${academy.out.length})`, "");
        table(academy.out, true);
        this.push("", `#### ⬇️ Send to the Academy (${academy.in.length})`, "");
        table(academy.in, false);

        this.openBlock("Staying at the Academy", `${academy.stay.length} player(s)`);
        table(academy.stay, false);
        this.closeBlock();

        const excluded = av.declining.filter((d) => !d.kept).length + av.retiring.length;
        this.openBlock(
            "Progress — players no longer improving",
            excluded > 0 ? `🔴 ${excluded} excluded from the lineup` : "✅ none excluded"
        );
        if (av.declining.length === 0 && av.retiring.length === 0) {
            this.push("✅ All active players are still improving.");
        } else {
            this.push("| Player | Age | Progress | Starting-six gain | Verdict |");
            this.push("|---|--:|---|--:|---|");
            for (const d of av.declining) {
                const g = (d.gain >= 0 ? "+" : "") + d.gain.toFixed(1);
                this.push(
                    `| ${d.player.fullName} | ${d.player.age} | Starting to decline | ${g} | ` +
                    `${d.kept ? "🟢 exceptional: available" : "🔴 excluded, release"} |`
                );
            }
            for (const p of av.retiring) {
                this.push(`| ${p.fullName} | ${p.age} | Considering retirement | — | 🔴 excluded, release |`);
            }
            this.push("", `*Declining player kept if gain ≥ +${SETTINGS.availability.declineExceptionalMinGain}.*`);
        }
        this.closeBlock();
    }

    reportWeaknessAnalysis(analysis: WeaknessAnalysis): void {
        this.section("TEAM WEAK SPOTS (5-1)");
        this.push(
            "| Role | Weakest starter | Score | Priority stats |",
            "|---|---|--:|---|"
        );
        for (const rw of analysis.roleWeaknesses) {
            this.push(
                `| ${rw.label} | **${rw.topPlayer}** | ${scoreBadge(rw.topScore)} | ${rw.keyWeakStats.join(", ")} |`
            );
        }
        this.push(
            "",
            "**Trait coverage in the starting six:**",
            "",
            `- 🟢 Solid (≥2): ${analysis.presentTraits.join(", ") || "—"}`
        );
        if (analysis.weakTraits.length) this.push(`- 🟡 Fragile (1×): ${analysis.weakTraits.join(", ")}`);
        if (analysis.missingTraits.length) this.push(`- 🔴 Missing: ${analysis.missingTraits.join(", ")}`);
    }

    reportRecruitmentAnalysis(analysis: RecruitmentAnalysis): void {
        this.openBlock(
            "Recruitment filter",
            analysis.top3Roles.map((r) => r.label).join(" · ")
        );
        this.push(
            analysis.top3Signs.length
                ? "Set the 3 roles + 3 traits + 3 signs below in the recruitment screen."
                : "Set the 3 roles + 3 traits below in the recruitment screen.",
            ""
        );
        this.push("**Roles (by priority)**", "");
        analysis.top3Roles.forEach(({ label, reason }, i) => {
            this.push(`${i + 1}. **${label}** — *${reason}*`);
        });
        this.push("", "**Traits (for these 3 roles)**", "");
        analysis.top3Traits.forEach(({ trait, reason }, i) => {
            this.push(`${i + 1}. **${trait}** — *${reason}*`);
        });
        if (analysis.top3Signs.length) {
            this.push("", "**Signs (for these 3 roles)**", "");
            analysis.top3Signs.forEach(({ sign, reason }, i) => {
                this.push(`${i + 1}. **${sign}** — *${reason}*`);
            });
        }
        this.closeBlock();
    }

    reportRosterBalance(result: RosterBalanceResult): void {
        this.section("ROSTER MANAGEMENT — PLAYERS TO SELL");

        const roleCountStr = Object.entries(targetCounts())
            .map(([r, n]) => `${n} ${ROLE_LABELS[r as keyof typeof ROLE_LABELS].replace(" (OH)", "").replace(" (MB)", "").replace(" (OP)", "")}`)
            .join(" · ");
        this.push(
            `**Current roster**: ${result.totalPlayers} players · **Target**: ${rosterTarget()} (${roleCountStr})`,
            ""
        );

        if (!result.feasible) {
            for (const s of result.shortfalls) {
                this.push(
                    `> ⚠️ Not enough players: ${ROLE_LABELS[s.role]} — ${s.eligible} eligible / ${s.target} required (${s.kept} kept)`
                );
            }
            if (result.flexKeeps.length > 0) {
                const names = result.flexKeeps
                    .map((f) => `${f.player.fullName}${f.bestRole ? ` (${ROLE_LABELS[f.bestRole]})` : ""}`)
                    .join(", ");
                this.push(`> → ${result.flexKeeps.length} slot(s) reassigned to the best remaining players: ${names}`);
            }
            this.push("");
        }

        this.push(
            `**To sell: ${result.toSell}**` +
            (result.forcedCount > 0 ? ` (including ${result.forcedCount} first: no longer improving)` : ""),
            ""
        );

        if (result.sellCandidates.length === 0) {
            this.push("✅ No player to sell.");
            return;
        }

        this.push("| # | Player | Rarity | Best role | Score | Reason |");
        this.push("|--:|---|---|---|--:|---|");
        result.sellCandidates.forEach((c, i) => {
            const roleTag = c.bestRole ? ROLE_LABELS[c.bestRole] : "—";
            const score = c.bestScore > 0 ? c.bestScore.toFixed(0) : "*not eligible*";
            const why = c.reason ? `🔴 ${c.reason}` : "roster quota";
            this.push(`| ${i + 1} | ${c.player.fullName} | ${rarity(c.player.rarity as Rarity)} | ${roleTag} | ${score} | ${why} |`);
        });
    }

    footer(): void {
        this.closeSection();
    }
}
