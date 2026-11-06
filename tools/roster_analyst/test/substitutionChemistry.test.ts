import { describe, it, expect, beforeEach } from "vitest";
import { Player, RoleName, ScoredPlayer, Sign } from "../src/types";
import {
    analyzeChemistry, benchChemValue, FIVE_ONE_COURT, lineupChemValue, substitutionStates,
} from "../src/lineup/signChemistry";
import { LineupBuilder } from "../src/lineup/lineupBuilder";
import { applySettings, resolveSettings, SETTINGS } from "../src/config/settings";

/** Minimal scored player (only what the chemistry and the builder read). */
function sp(fullName: string, sign: Sign, score = 80, signScore = 3, connectionScore = 0): ScoredPlayer {
    const player = { fullName, sign } as unknown as Player;
    return { player, score, statScore: score - signScore, traitScore: 0, signScore, connectionScore };
}

// Real configuration (roster export of 2026-11): setter Đoàn Bảo Long, libero Fu Gang.
const DOAN = sp("Bảo Long Đoàn", "Libra", 90, 0, 5.2);
const FU_GANG = sp("Zheng Nan Fu Gang", "Taurus");
const PIAN_GANG = sp("Zhi Mei Pian Gang", "Sagittarius");
const PHUNG = sp("Bảo Uyên Phùng", "Capricorn");
const CATARSI = sp("Basilia Catarsi", "Scorpio");
const PIAZZOLLA = sp("Roberto Piazzolla", "Cancer");
const MADRID = sp("Marilu Madrid Aranda", "Aries");
const CUN_SONG = sp("Jiu Zi Cun Song", "Taurus");
const ZUO_TENG = sp("Hui Mei Zi Zuo Teng", "Virgo");
const LECOMTE = sp("Bertrand Lecomte", "Taurus");
const LUO_HE = sp("Qing Luo He", "Virgo");

type Lineup = Record<string, ScoredPlayer | null>;
const START: Lineup = {
    "Setter": DOAN,
    "Front Outside Hitter": PHUNG,
    "Back Outside Hitter": PIAN_GANG,
    "Opposite": CATARSI,
    "Front Middle Blocker": PIAZZOLLA,
    "Back Middle Blocker": MADRID,
    "Libero": FU_GANG,
};
const SUBS: Lineup = {
    "Back Outside Hitter": CUN_SONG,
    "Opposite": ZUO_TENG,
    "Front Middle Blocker": LECOMTE,
    "Front Outside Hitter": LUO_HE,
};

/** name → [chemistry, effect active, setter link] (effect/link null when not applicable). */
function summary(lineup: Lineup) {
    const a = analyzeChemistry(lineup, FIVE_ONE_COURT);
    return Object.fromEntries(a.starters.map((s) => [s.name, [s.chem, s.active, s.connected]]));
}
const activeOf = (lineup: Lineup) =>
    analyzeChemistry(lineup, FIVE_ONE_COURT).starters.filter((s) => s.active).map((s) => s.name);
const linkedOf = (lineup: Lineup) =>
    analyzeChemistry(lineup, FIVE_ONE_COURT).starters.filter((s) => s.connected).map((s) => s.name);

beforeEach(() => applySettings(resolveSettings({})));

describe("chemistry of the real configuration", () => {
    it("starting 7: only Catarsi's effect, setter linked with the 5 attackers", () => {
        expect(summary(START)).toEqual({
            "Bảo Long Đoàn": [3, null, null],
            "Bảo Uyên Phùng": [0, false, true],
            "Zhi Mei Pian Gang": [0, false, true],
            "Basilia Catarsi": [3, true, true],
            "Roberto Piazzolla": [1, false, true],
            "Marilu Madrid Aranda": [1, false, true],
            "Zheng Nan Fu Gang": [0, false, null],
        });
        expect(activeOf(START)).toEqual(["Basilia Catarsi"]);
        expect(linkedOf(START)).toHaveLength(5);
    });

    it("Cun Song for Pian Gang AND Zuo Teng for Catarsi: only Piazzolla (effect + link)", () => {
        const L = { ...START, "Back Outside Hitter": CUN_SONG, "Opposite": ZUO_TENG };
        expect(summary(L)).toEqual({
            "Bảo Long Đoàn": [3, null, null],
            "Bảo Uyên Phùng": [-3, false, false],
            "Jiu Zi Cun Song": [-1, false, false],
            "Hui Mei Zi Zuo Teng": [-3, false, false],
            "Roberto Piazzolla": [3, true, true],
            "Marilu Madrid Aranda": [-1, false, false],
            "Zheng Nan Fu Gang": [-1, false, null],
        });
        expect(activeOf(L)).toEqual(["Roberto Piazzolla"]);
        expect(linkedOf(L)).toEqual(["Roberto Piazzolla"]);
    });

    it("plus Lecomte for Piazzolla and Luo He for Phùng: no effect, no link", () => {
        const L = { ...START, ...SUBS };
        expect(activeOf(L)).toEqual([]);
        expect(linkedOf(L)).toEqual([]);
    });

    it("one substitution at a time: Cun Song keeps the 5 links, Zuo Teng leaves only one", () => {
        expect(linkedOf({ ...START, "Back Outside Hitter": CUN_SONG })).toHaveLength(5);
        expect(linkedOf({ ...START, "Opposite": ZUO_TENG })).toHaveLength(1);
    });
});

describe("substitutionStates (accumulated substitutions)", () => {
    const order = ["Back Outside Hitter", "Opposite", "Front Middle Blocker", "Front Outside Hitter"];

    it("state 0 = starting 7, then one substitution more per state, in the configured order", () => {
        const states = substitutionStates(START, SUBS, order, 0.5);
        expect(states.map((s) => s.entered?.in ?? null)).toEqual(
            [null, CUN_SONG, ZUO_TENG, LECOMTE, LUO_HE].map((x) => x?.player.fullName ?? null));
        // Cun Song alone keeps the 5 links (but Catarsi drops to 2: effect lost);
        // Zuo Teng next leaves Piazzolla only; 3 substitutions: 1 link
        // (Madrid Aranda) and no effect; 4: nothing left.
        expect(states.map((s) => s.analysis.connections.active)).toEqual([5, 5, 1, 1, 0]);
        expect(states.map((s) => s.analysis.effects.active)).toEqual([1, 0, 1, 0, 0]);
        // The substitutes stay on the court (no return).
        expect(states[4].lineup["Back Outside Hitter"]).toBe(CUN_SONG);
    });

    it("weights: 1 for the start, λ / K for each of the K substitution states", () => {
        const states = substitutionStates(START, SUBS, order, 0.6);
        expect(states.map((s) => s.weight)).toEqual([1, 0.15, 0.15, 0.15, 0.15]);
    });

    it("bench term = λ · mean of (C(state k) − C(start)), with the existing chemistry value", () => {
        const states = substitutionStates(START, SUBS, order, 0.5);
        const c0 = lineupChemValue(START);
        expect(states[0].value).toBeCloseTo(c0);
        const mean = states.slice(1).reduce((s, st) => s + st.value - c0, 0) / 4;
        expect(benchChemValue(states)).toBeCloseTo(0.5 * mean);
        // Every substitution state loses chemistry here.
        expect(benchChemValue(states)).toBeLessThan(0);
    });

    it("slots outside the order are never replaced; a listed slot without substitute = unchanged state", () => {
        const states = substitutionStates(START, { ...SUBS, "Setter": sp("Sub setter", "Leo") },
            ["Opposite", "Back Middle Blocker"], 0.5);
        // The setter is not in the order; Back MB has no substitute: the starter stays.
        expect(states).toHaveLength(3);
        expect(states[1].entered?.in).toBe(ZUO_TENG.player.fullName);
        expect(states[2].entered).toEqual({ slot: "Back Middle Blocker", in: null, out: MADRID.player.fullName });
        expect(states[2].value).toBeCloseTo(states[1].value);
        expect(states.map((x) => x.weight)).toEqual([1, 0.25, 0.25]);
        expect(benchChemValue(substitutionStates(START, SUBS, [], 0.5))).toBe(0);
    });

    it("the order is a setting (unknown slots and duplicates dropped)", () => {
        const s = resolveSettings({ lineup: { substitutionOrder: ["Opposite", "Nope", "Opposite", "Setter"] } });
        expect(s.lineup.substitutionOrder).toEqual(["Opposite", "Setter"]);
        expect(resolveSettings({}).lineup.substitutionOrder).toEqual([
            "Front Outside Hitter", "Back Outside Hitter", "Front Middle Blocker", "Back Middle Blocker", "Opposite",
        ]);
    });
});

describe("LineupBuilder: the bench is chosen on the accumulated chemistry", () => {
    // Starters far above the bench (score 99 vs ≤ 72): only the bench is at stake.
    const S = (p: ScoredPlayer, score: number) => ({ ...p, score, statScore: score - p.signScore });
    const rankings = (oh: ScoredPlayer[], op: ScoredPlayer[]): Record<RoleName, ScoredPlayer[]> => ({
        setter: [S(DOAN, 99), sp("Sub Setter", "Gemini", 60, 0, 5.2)],
        libero: [S(FU_GANG, 99), sp("Sub Libero", "Capricorn", 60)],
        outsideHitter: [S(PHUNG, 99), S(PIAN_GANG, 99), ...oh],
        middleBlocker: [S(PIAZZOLLA, 99), S(MADRID, 99), S(LECOMTE, 70), sp("Capricorn MB", "Capricorn", 70)],
        oppositeHitter: [S(CATARSI, 99), ...op],
    });
    type Lineup = Record<string, ScoredPlayer | null>;
    const SLOTS = ["Front Outside Hitter", "Back Outside Hitter", "Front Middle Blocker", "Back Middle Blocker", "Opposite"];

    /**
     * Bench part of the objective: λ·substitutes + λᵣ·reserves (per role, the
     * best leftovers not above the weakest substitute) + bench chemistry.
     */
    function benchPart(lineup: Lineup, subs: Lineup, r: Record<RoleName, ScoredPlayer[]>): number {
        const lam = SETTINGS.lineup.subObjectiveWeight;
        const lamR = SETTINGS.lineup.reserveObjectiveWeight;
        const taken = new Set([...Object.values(lineup), ...Object.values(subs)]);
        let value = Object.values(subs).reduce((s, x) => s + lam * (x?.score ?? 0), 0);
        const slots = LineupBuilder.getFiveOneSubSlots();
        for (const role of Object.keys(r) as RoleName[]) {
            const mine = slots.filter((d) => d.role === role).map((d) => subs[d.replacesSlot]);
            const thr = Math.min(...mine.map((x) => x?.score ?? 0));
            const left = r[role].filter((p) => !taken.has(p) && p.score <= thr).sort((a, b) => b.score - a.score);
            value += left.slice(0, mine.length).reduce((s, x) => s + lamR * x.score, 0);
        }
        return value + benchChemValue(substitutionStates(lineup, subs, SETTINGS.lineup.substitutionOrder, lam));
    }

    /** Builds the lineup, checks the starters and that the bench is the exhaustive optimum. */
    function solve(r: Record<RoleName, ScoredPlayer[]>) {
        LineupBuilder.clearCache();
        const b = new LineupBuilder(r);
        const res = b.buildFiveOneLineup();
        const slots = LineupBuilder.getFiveOneSubSlots();
        const bench = b.getSubstitutes(res.lineup, slots);
        for (const role of Object.keys(r) as RoleName[]) {
            const starters = slots.filter((d) => d.role === role).map((d) => res.lineup[d.replacesSlot]?.score);
            expect(starters.every((x) => x === 99)).toBe(true);
        }
        const subs: Lineup = Object.fromEntries(slots.map((d, j) => [d.replacesSlot, bench[j].sub]));
        // Exhaustive check over the OH / MB / OP substitutes and their assignment.
        const pick = (role: RoleName) => r[role].filter((p) => p.score < 99);
        let best = -Infinity;
        for (const fo of pick("outsideHitter")) for (const bo of pick("outsideHitter")) {
            if (fo === bo) continue;
            for (const fm of pick("middleBlocker")) for (const bm of pick("middleBlocker")) {
                if (fm === bm) continue;
                for (const op of pick("oppositeHitter")) {
                    const cand: Lineup = {
                        ...subs, [SLOTS[0]]: fo, [SLOTS[1]]: bo, [SLOTS[2]]: fm, [SLOTS[3]]: bm, [SLOTS[4]]: op,
                    };
                    best = Math.max(best, benchPart(res.lineup, cand, r));
                }
            }
        }
        expect(benchPart(res.lineup, subs, r)).toBeCloseTo(best, 6);
        const top = (role: RoleName) => pick(role).sort((a, b) => b.score - a.score);
        const scoreOnly: Lineup = {
            ...subs,
            [SLOTS[0]]: top("outsideHitter")[0], [SLOTS[1]]: top("outsideHitter")[1],
            [SLOTS[2]]: top("middleBlocker")[0], [SLOTS[3]]: top("middleBlocker")[1],
            [SLOTS[4]]: top("oppositeHitter")[0],
        };
        return { res, subs, value: (L: Lineup) => benchPart(res.lineup, L, r), scoreOnly };
    }

    it("picks the assignment (which substitute for which starter) on the chemistry", () => {
        // Score only: Gemini (72) in for the Front OH (first to leave), Aquarius (71) for the Back OH.
        const { subs, value, scoreOnly } = solve(rankings(
            [sp("Gemini OH", "Gemini", 72), sp("Aquarius OH", "Aquarius", 71)],
            [S(ZUO_TENG, 70)]));
        expect(value(subs)).toBeGreaterThan(value(scoreOnly) + 0.5);
        expect(subs[SLOTS[0]]?.player.fullName).toBe("Aquarius OH");
        expect(subs[SLOTS[1]]?.player.fullName).toBe("Gemini OH");
    });

    it("picks the substitutes themselves on the chemistry", () => {
        // Score only: Gemini (72) + Aquarius (71); the Libra (68) breaks less
        // (two OH reserves just below it keep the reserve loss small).
        const { subs, value, scoreOnly } = solve(rankings(
            [sp("Gemini OH", "Gemini", 72), sp("Aquarius OH", "Aquarius", 71), sp("Libra OH", "Libra", 68),
                sp("Reserve OH 1", "Leo", 66), sp("Reserve OH 2", "Pisces", 65)],
            [S(ZUO_TENG, 71)]));
        expect(value(subs)).toBeGreaterThan(value(scoreOnly) + 0.5);
        expect([subs[SLOTS[0]], subs[SLOTS[1]]].map((x) => x?.player.fullName)).toContain("Libra OH");
    });
});
