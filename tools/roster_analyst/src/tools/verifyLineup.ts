// Independent check of the lineup builder (sign synergy): enumerates ALL
// starter sets of a sub-roster and, for each, ALL benches (substitutes;
// optimal reserves under the substitute ≥ reserve domination), and compares
// the optimum of the objective to the builder's lineup (branch & bound over
// the starters + local search over the bench). Usage:
//   npx ts-node src/tools/verifyLineup.ts <roster.csv> <params.json> [nbPlayers=14] [seed=0]
import * as fs from "fs";
import { parseCSVText } from "../models"; import { parseParams } from "../config";
import { rankAll } from "../analysis/availabilityAnalyzer"; import { LineupBuilder } from "../lineup/lineupBuilder";
import { lineupChemValue, substitutionStates, benchChemValue, FIVE_ONE_SLOT_ROLES } from "../lineup/signChemistry";
import { maxAssignment } from "../lineup/assignment";
import { ScoredPlayer } from "../types";
const N = Number(process.argv[4] ?? 14), seed = Number(process.argv[5] ?? 0);
let all = parseCSVText(fs.readFileSync(process.argv[2], "utf-8")).filter(p => p.position !== "Academy");
all = all.map((p, i) => ({ p, k: (i * 7919 + seed * 104729) % 1009 })).sort((a, b) => a.k - b.k).map(x => x.p).slice(0, N);
const r = rankAll(all, parseParams(fs.readFileSync(process.argv[3], "utf-8")));
const order = ["Setter","Libero","Front Outside Hitter","Back Outside Hitter","Front Middle Blocker","Back Middle Blocker","Opposite"];
const subs = LineupBuilder.getFiveOneSubSlots();
LineupBuilder.signSynergy = true;
const lam = LineupBuilder.subObjectiveWeight, lamR = LineupBuilder.reserveObjectiveWeight;
const t = Date.now(); const b = new LineupBuilder(r); const res = b.buildFiveOneLineup(); const bs = b.getSubstitutes(res.lineup, subs);
const tB = Date.now() - t;
type L = Record<string, ScoredPlayer | null>;
const name = (sp: ScoredPlayer | null) => sp?.player.fullName;
function reserves(inUse: Set<string>, B: (ScoredPlayer | null)[]) {
  const thr = new Map<string, number>();
  subs.forEach((d, j) => thr.set(d.role, Math.min(thr.get(d.role) ?? Infinity, B[j]?.score ?? 0)));
  const cols = [...new Set(subs.flatMap(d => r[d.role].map(sp => sp.player.fullName)))].filter(n => !inUse.has(n));
  const value = subs.map(d => cols.map(n => { const sp = r[d.role].find(x => x.player.fullName === n);
    return sp && sp.score <= thr.get(d.role)! ? lamR * sp.score : null; }));
  return maxAssignment(value, cols.length).total;
}
function benchPart(S: L, B: (ScoredPlayer | null)[]) {
  const inUse = new Set([...Object.values(S), ...B].filter(Boolean).map(x => x!.player.fullName));
  const m: L = {}; subs.forEach((d, j) => (m[d.replacesSlot] = B[j]));
  return B.reduce((s, sp) => s + lam * (sp?.score ?? 0), 0) + reserves(inUse, B) +
    benchChemValue(substitutionStates(S, m, LineupBuilder.substitutionOrder, lam));
}
/**
 * Exhaustive bench optimum over the MAXIMAL benches (an empty substitute slot
 * has no free eligible player left — the builder never empties a slot it
 * could fill; it may leave one empty when the players are used elsewhere).
 */
function bench(S: L) {
  const used = new Set(Object.values(S).filter(Boolean).map(x => x!.player.fullName));
  const B: (ScoredPlayer | null)[] = []; let best = -Infinity;
  const maximal = () => subs.every((d, j) => B[j] || r[d.role].every(sp => used.has(sp.player.fullName)));
  const rec = (j: number) => {
    if (j === subs.length) { if (maximal()) best = Math.max(best, benchPart(S, B)); return; }
    for (const sp of r[subs[j].role]) { const n = sp.player.fullName; if (used.has(n)) continue;
      used.add(n); B[j] = sp; rec(j + 1); used.delete(n); }
    B[j] = null; rec(j + 1);
  };
  rec(0); return best;
}
const scores = (S: L) => Object.values(S).reduce((s, x) => s + (x?.score ?? 0), 0) + lineupChemValue(S);
const fB = scores(res.lineup) + benchPart(res.lineup, bs.map(s => s.sub));
let best = -Infinity, leaves = 0; const S: L = {}; const used = new Set<string>();
const roles = order.map(s => FIVE_ONE_SLOT_ROLES[s]);
const orderOk = (S: L) => !(S["Front Outside Hitter"] && S["Back Outside Hitter"] && S["Front Outside Hitter"]!.score < S["Back Outside Hitter"]!.score) &&
  !(S["Front Middle Blocker"] && S["Back Middle Blocker"] && S["Back Middle Blocker"]!.score < S["Front Middle Blocker"]!.score);
function rec(i: number) {
  if (i === order.length) { if (!orderOk(S)) return; leaves++; const f = scores(S) + bench(S); if (f > best) best = f; return; }
  const pool = r[roles[i]]; let any = false;
  for (const sp of pool) { const n = sp.player.fullName; if (used.has(n)) continue; any = true;
    used.add(n); S[order[i]] = sp; rec(i + 1); used.delete(n); }
  if (!any) { S[order[i]] = null; rec(i + 1); }
}
rec(0);
console.log(`N=${all.length} seed=${seed} leaves=${leaves} builder=${fB.toFixed(3)} (${tB}ms) brute=${best.toFixed(3)} ` +
  `${Math.abs(fB - best) < 1e-6 ? "OK" : fB < best ? `GAP ${(best - fB).toFixed(3)}` : "BUILDER > BRUTE (bug)"}` +
  ` · starters ${order.map(s => name(res.lineup[s]) ?? "—").join(", ")} · bench ${bs.map(s => name(s.sub) ?? "—").join(", ")}`);
