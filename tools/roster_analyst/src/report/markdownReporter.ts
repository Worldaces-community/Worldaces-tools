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
import { SIGN_LABELS_FR } from "../config/signs";
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
            ? ` (${availableCount} disponibles pour la lineup)` : "";
        this.push(
            "# 🏐 World Aces – Analyse de roster",
            "",
            `**Roster** : ${rosterCount} joueurs${avail} · **Params** : \`${paramsPath}\``
        );
    }

    reportRoleRankings(
        allRankings: Record<RoleName, ScoredPlayer[]>,
        roleLabels: Record<RoleName, string>,
        params: Params
    ): void {
        this.section("CLASSEMENTS PAR RÔLE");

        for (const roleName of Object.keys(allRankings) as RoleName[]) {
            const ranked = allRankings[roleName];
            const top = ranked[0];
            this.openBlock(
                `${roleLabels[roleName]} – top 10`,
                top ? `n°1 : ${top.player.fullName} (${top.score.toFixed(0)})` : undefined
            );
            this.push("| # | Joueur | Rareté | Âge | Score | Traits |");
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
                    `*Poids des stats : ${Object.entries(config.statsWeights)
                        .filter(([, v]) => v !== 0)
                        .map(([k, v]) => `${k}×${v}`)
                        .join(" + ")}*`,
                    `*Bonus de traits : ${Object.entries(config.traitBonuses)
                        .filter(([, v]) => v !== 0)
                        .map(([k, v]) => `${k} (${fmtBonus(Math.round(v * 10) / 10)})`)
                        .join(", ")}*`
                );
                const signs = Object.entries(config.signBonuses ?? {}).filter(([, v]) => v !== 0);
                if (signs.length) {
                    this.push(`*Bonus de signes : ${signs.map(([k, v]) => `${k} (${fmtBonus(v)})`).join(", ")}*`);
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
        this.push("| # | Poste | Titulaire | Remplaçant | Rés. blessure |");
        this.push("|--:|---|---|---|---|");
        lineupOrder.forEach((slot, i) => {
            const starter = lineup[slot] ? `**${lineup[slot]!.player.fullName}**` : "⚠️ —";
            const sub = substitutes[i];
            const subName = sub?.sub ? `${sub.sub.player.fullName} (${delta(sub.delta)})` : "—";
            const resName = sub?.reserve ? sub.reserve.player.fullName : "—";
            this.push(`| ${i + 1} | ${slot} | ${starter} | ${subName} | ${resName} |`);
        });

        this.openBlock("Titulaires (rareté & score)");
        this.push("| # | Poste | Joueur | Rareté | Score |");
        this.push("|--:|---|---|---|--:|");
        lineupOrder.forEach((slot, i) => {
            const s = lineup[slot];
            this.push(
                s
                    ? `| ${i + 1} | ${slot} | **${s.player.fullName}** | ${rarity(s.player.rarity as Rarity)} | ${scoreBadge(s.score)} |`
                    : `| ${i + 1} | ${slot} | ⚠️ *aucun joueur éligible* | — | — |`
            );
        });
        this.closeBlock();

        this.openBlock("Banc (rareté & score)");
        this.push("| # | Slot | Joueur | Rareté | Score | Remplace |");
        this.push("|--:|---|---|---|--:|---|");
        substitutes.forEach((sub, i) => {
            this.push(
                sub.sub
                    ? `| ${i + 1} | ${sub.label} | ${sub.sub.player.fullName} | ${rarity(sub.sub.player.rarity as Rarity)} | ` +
                      `${scoreBadge(sub.sub.score)} | ${sub.replaces} (${delta(sub.delta)}) |`
                    : `| ${i + 1} | ${sub.label} | *aucun joueur éligible* | — | — | ${sub.replaces} |`
            );
        });
        this.closeBlock();

        this.openBlock("Réservistes blessures (rareté & score)");
        this.push("| # | Slot | Joueur | Rareté | Score | Banc si blessé |");
        this.push("|--:|---|---|---|--:|---|");
        substitutes.forEach((sub, i) => {
            const resLabel = sub.label.replace(/^Remp\./, "Rés.");
            this.push(
                sub.reserve
                    ? `| ${i + 1} | ${resLabel} | ${sub.reserve.player.fullName} | ${rarity(sub.reserve.player.rarity as Rarity)} | ` +
                      `${scoreBadge(sub.reserve.score)} | ${sub.replaces} (${delta(sub.reserveDelta)}) |`
                    : `| ${i + 1} | ${resLabel} | *aucun joueur éligible* | — | — | ${sub.replaces} |`
            );
        });
        this.closeBlock();
    }

    reportSignChemistry(a: ChemistryAnalysis): void {
        if (!a.hasSigns) return;
        this.openBlock("Chimie des signes", fmtChemVerdict(a));
        this.push("| # | Poste | Joueur | Signe | Chimie | Effet | Connexion passeur |");
        this.push("|--:|---|---|---|--:|:-:|:-:|");
        a.starters.forEach((s, i) => {
            this.push(
                `| ${i + 1} | ${s.slot} | ${s.name ?? "—"} | ${fmtSign(s)} | ${fmtChem(s.chem)} | ` +
                `${fmtOn(s.active)} | ${fmtOn(s.connected)} |`
            );
        });
        this.push("", "*Chimie : phase MB avant / phase MB arrière (le libéro remplace le MB arrière) · ✓ actif · ½ une phase sur deux · ✗ inactif.*");
        this.closeBlock();
    }

    reportLiberoRotation(analysis: LiberoRotationAnalysis): void {
        const badge = {
            system:      "✅ rotation conseillée",
            situational: "🟡 rotation situationnelle",
            none:        "pas de rotation",
            single:      "⚠️ un seul libéro",
        }[analysis.verdict];

        this.openBlock("Libéro — rotation réception / service (2ᵉ libéro)", badge);

        if (analysis.liberos.length > 0) {
            this.push("| Libéro | Global | Récep. | Défense | Traits spécifiques |");
            this.push("|---|--:|--:|--:|---|");
            for (const l of analysis.liberos) {
                const marks =
                    (analysis.verdict !== "single" && analysis.receptionSpecialist?.player === l.player ? " ◄ récep" : "") +
                    (analysis.verdict !== "single" && analysis.defenseSpecialist?.player === l.player ? " ◄ déf" : "");
                const tags = [
                    ...l.receptionOnlyTraits.map((t) => `${t} (récep)`),
                    ...l.defenseOnlyTraits.map((t) => `${t} (déf)`),
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
                this.push("*Aucun.*");
                return;
            }
            this.push(withSlot ? "| Joueur | Âge | Score | Slot visé | Motif |" : "| Joueur | Âge | Score | Motif |");
            this.push(withSlot ? "|---|--:|--:|---|---|" : "|---|--:|--:|---|");
            for (const m of moves) {
                const slot = m.slot ? `${m.slot}${m.displaces ? ` (à la place de ${m.displaces})` : ""}` : "—";
                this.push(
                    withSlot
                        ? `| **${m.player.fullName}** | ${m.player.age} | ${score(m)} | ${slot} | ${m.reason} |`
                        : `| ${m.player.fullName} | ${m.player.age} | ${score(m)} | ${m.reason} |`
                );
            }
        };

        this.push(`**Academy** (éligible ≤ ${SETTINGS.academy.maxAge} ans)`, "");
        this.push(`#### ⬆️ Sortir de l'Academy (${academy.out.length})`, "");
        table(academy.out, true);
        this.push("", `#### ⬇️ Envoyer à l'Academy (${academy.in.length})`, "");
        table(academy.in, false);

        this.openBlock("Restent à l'Academy", `${academy.stay.length} joueur(s)`);
        table(academy.stay, false);
        this.closeBlock();

        const excluded = av.declining.filter((d) => !d.kept).length + av.retiring.length;
        this.openBlock(
            "Progression — joueurs qui ne progressent plus",
            excluded > 0 ? `🔴 ${excluded} exclu(s) de la lineup` : "✅ aucun exclu"
        );
        if (av.declining.length === 0 && av.retiring.length === 0) {
            this.push("✅ Tous les joueurs actifs progressent encore.");
        } else {
            this.push("| Joueur | Âge | Progression | Gain six de départ | Verdict |");
            this.push("|---|--:|---|--:|---|");
            for (const d of av.declining) {
                const g = (d.gain >= 0 ? "+" : "") + d.gain.toFixed(1);
                this.push(
                    `| ${d.player.fullName} | ${d.player.age} | Starting to decline | ${g} | ` +
                    `${d.kept ? "🟢 exceptionnel : disponible" : "🔴 exclu, à libérer"} |`
                );
            }
            for (const p of av.retiring) {
                this.push(`| ${p.fullName} | ${p.age} | Considering retirement | — | 🔴 exclu, à libérer |`);
            }
            this.push("", `*Déclinant gardé si gain ≥ +${SETTINGS.availability.declineExceptionalMinGain}.*`);
        }
        this.closeBlock();
    }

    reportWeaknessAnalysis(analysis: WeaknessAnalysis): void {
        this.section("POINTS FAIBLES DE L'ÉQUIPE (5-1)");
        this.push(
            "| Rôle | Titulaire le plus faible | Score | Stats prioritaires |",
            "|---|---|--:|---|"
        );
        for (const rw of analysis.roleWeaknesses) {
            this.push(
                `| ${rw.label} | **${rw.topPlayer}** | ${scoreBadge(rw.topScore)} | ${rw.keyWeakStats.join(", ")} |`
            );
        }
        this.push(
            "",
            "**Couverture des traits dans le six de départ :**",
            "",
            `- 🟢 Solide (≥2) : ${analysis.presentTraits.join(", ") || "—"}`
        );
        if (analysis.weakTraits.length) this.push(`- 🟡 Fragile (1×) : ${analysis.weakTraits.join(", ")}`);
        if (analysis.missingTraits.length) this.push(`- 🔴 Absents : ${analysis.missingTraits.join(", ")}`);
    }

    reportRecruitmentAnalysis(analysis: RecruitmentAnalysis): void {
        this.openBlock(
            "Filtre de recrutement",
            analysis.top3Roles.map((r) => r.label).join(" · ")
        );
        this.push(
            analysis.top3Signs.length
                ? "Règle les 3 rôles + 3 traits + 3 signes ci-dessous dans l'écran de recrutement."
                : "Règle les 3 rôles + 3 traits ci-dessous dans l'écran de recrutement.",
            ""
        );
        this.push("**Rôles (dans l'ordre de priorité)**", "");
        analysis.top3Roles.forEach(({ label, reason }, i) => {
            this.push(`${i + 1}. **${label}** — *${reason}*`);
        });
        this.push("", "**Traits (pour ces 3 rôles)**", "");
        analysis.top3Traits.forEach(({ trait, reason }, i) => {
            this.push(`${i + 1}. **${trait}** — *${reason}*`);
        });
        if (analysis.top3Signs.length) {
            this.push("", "**Signes (pour ces 3 rôles)**", "");
            analysis.top3Signs.forEach(({ sign, reason }, i) => {
                this.push(`${i + 1}. **${SIGN_LABELS_FR[sign]}** (${sign}) — *${reason}*`);
            });
        }
        this.closeBlock();
    }

    reportRosterBalance(result: RosterBalanceResult): void {
        this.section("GESTION DU ROSTER — JOUEURS À VENDRE");

        const roleCountStr = Object.entries(targetCounts())
            .map(([r, n]) => `${n} ${ROLE_LABELS[r as keyof typeof ROLE_LABELS].replace(" (OH)", "").replace(" (MB)", "").replace(" (OP)", "")}`)
            .join(" · ");
        this.push(
            `**Roster actuel** : ${result.totalPlayers} joueurs · **Cible** : ${rosterTarget()} (${roleCountStr})`,
            ""
        );

        if (!result.feasible) {
            for (const s of result.shortfalls) {
                this.push(
                    `> ⚠️ Effectif insuffisant : ${ROLE_LABELS[s.role]} — ${s.eligible} éligible(s) / ${s.target} requis (${s.kept} gardé(s))`
                );
            }
            if (result.flexKeeps.length > 0) {
                const names = result.flexKeeps
                    .map((f) => `${f.player.fullName}${f.bestRole ? ` (${ROLE_LABELS[f.bestRole]})` : ""}`)
                    .join(", ");
                this.push(`> → ${result.flexKeeps.length} slot(s) réattribué(s) aux meilleurs joueurs restants : ${names}`);
            }
            this.push("");
        }

        this.push(
            `**À vendre : ${result.toSell}**` +
            (result.forcedCount > 0 ? ` (dont ${result.forcedCount} en priorité : ne progressent plus)` : ""),
            ""
        );

        if (result.sellCandidates.length === 0) {
            this.push("✅ Aucun joueur à vendre.");
            return;
        }

        this.push("| # | Joueur | Rareté | Meilleur rôle | Score | Motif |");
        this.push("|--:|---|---|---|--:|---|");
        result.sellCandidates.forEach((c, i) => {
            const roleTag = c.bestRole ? ROLE_LABELS[c.bestRole] : "—";
            const score = c.bestScore > 0 ? c.bestScore.toFixed(0) : "*non éligible*";
            const why = c.reason ? `🔴 ${c.reason}` : "quota roster";
            this.push(`| ${i + 1} | ${c.player.fullName} | ${rarity(c.player.rarity as Rarity)} | ${roleTag} | ${score} | ${why} |`);
        });
    }

    footer(): void {
        this.closeSection();
    }
}
