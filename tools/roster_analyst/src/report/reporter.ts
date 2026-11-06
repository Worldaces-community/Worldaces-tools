/**
 * Common interface of the reporters (console + markdown).
 *
 * index.ts drives a list of reporters and calls each method on
 * each one: the console stays the reference output locally, markdown
 * (--md <file>) is used for the GitHub Actions job summary (readable on mobile).
 */

import { ScoredPlayer, RoleName, Params } from "../types";
import { WeaknessAnalysis } from "../analysis/weaknessAnalyzer";
import { RecruitmentAnalysis } from "../analysis/recruitmentAnalyzer";
import { RosterBalanceResult } from "../analysis/rosterBalanceAnalyzer";
import { Substitute } from "../lineup/lineupBuilder";
import { LiberoRotationAnalysis } from "../analysis/liberoRotationAnalyzer";
import { AvailabilityResult } from "../analysis/availabilityAnalyzer";
import { AcademyAnalysis } from "../analysis/academyAnalyzer";
import { ChemistryAnalysis, SubstitutionState } from "../lineup/signChemistry";

export interface Reporter {
    verbose: boolean;

    /** `availableCount`: players available for the lineup (Academy / excluded non-improving players left out). */
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

    /** Starters' sign chemistry (sub-block of the 5-1; nothing if no signs). */
    reportSignChemistry(analysis: ChemistryAnalysis): void;

    /** Chemistry of the successive court states as substitutions accumulate (nothing if no signs). */
    reportSubstitutionChemistry(states: SubstitutionState[]): void;

    /** Academy (in / out) + players excluded for progress. */
    reportAcademyAndProgress(availability: AvailabilityResult, academy: AcademyAnalysis): void;

    reportWeaknessAnalysis(analysis: WeaknessAnalysis): void;
    reportRecruitmentAnalysis(analysis: RecruitmentAnalysis): void;
    reportRosterBalance(result: RosterBalanceResult): void;

    footer(): void;
}
