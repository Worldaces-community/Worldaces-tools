/**
 * Interface commune des reporters (console + markdown).
 *
 * index.ts pilote une liste de reporters et appelle chaque méthode sur
 * chacun : la console reste la sortie de référence en local, le markdown
 * (--md <fichier>) sert au job summary GitHub Actions (lisible sur mobile).
 */

import { ScoredPlayer, RoleName, Params } from "../types";
import { WeaknessAnalysis } from "../analysis/weaknessAnalyzer";
import { RecruitmentAnalysis } from "../analysis/recruitmentAnalyzer";
import { RosterBalanceResult } from "../analysis/rosterBalanceAnalyzer";
import { Substitute } from "../lineup/lineupBuilder";
import { LiberoRotationAnalysis } from "../analysis/liberoRotationAnalyzer";
import { AvailabilityResult } from "../analysis/availabilityAnalyzer";
import { AcademyAnalysis } from "../analysis/academyAnalyzer";
import { ChemistryAnalysis } from "../lineup/signChemistry";

export interface Reporter {
    verbose: boolean;

    /** `availableCount` : joueurs disponibles pour la lineup (hors Academy / non-progressants exclus). */
    header(rosterCount: number, paramsPath: string, availableCount?: number): void;

    reportRoleRankings(
        allRankings: Record<RoleName, ScoredPlayer[]>,
        roleLabels: Record<RoleName, string>,
        params: Params
    ): void;

    reportLineup(
        title: string,
        lineup: Record<string, ScoredPlayer | null>,
        lineupOrder: string[],
        substitutes: Substitute[]
    ): void;

    reportLiberoRotation(analysis: LiberoRotationAnalysis): void;

    /** Chimie des signes des titulaires (sous-bloc du 5-1 ; rien si pas de signes). */
    reportSignChemistry(analysis: ChemistryAnalysis): void;

    /** Academy (entrées / sorties) + joueurs exclus pour progression. */
    reportAcademyAndProgress(availability: AvailabilityResult, academy: AcademyAnalysis): void;

    reportWeaknessAnalysis(analysis: WeaknessAnalysis): void;
    reportRecruitmentAnalysis(analysis: RecruitmentAnalysis): void;
    reportRosterBalance(result: RosterBalanceResult): void;

    footer(): void;
}
