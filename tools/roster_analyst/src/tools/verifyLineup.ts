// Independent check of the lineup builder (sign synergy):
// enumerates ALL starter sets of a sub-roster, solves the bench by MILP
// and compares the optimum to the branch & bound. Usage:
//   npx ts-node src/tools/verifyLineup.ts <roster.csv> <params.json> [nbPlayers=14] [seed=0]
import { solve } from "yalps";
import * as fs from "fs";
import { parseCSVText } from "../models"; import { parseParams } from "../config";
import { rankAll } from "../analysis/availabilityAnalyzer"; import { LineupBuilder } from "../lineup/lineupBuilder";
import { lineupChemValue, evaluateCourt, courtRoleOf, FIVE_ONE_COURT, FIVE_ONE_SLOT_ROLES } from "../lineup/signChemistry";
import { ScoredPlayer } from "../types";
const N = Number(process.argv[4] ?? 14), seed = Number(process.argv[5] ?? 0);
let all = parseCSVText(fs.readFileSync(process.argv[2], "utf-8")).filter(p => p.position !== "Academy");
all = all.map((p, i) => ({ p, k: (i * 7919 + seed * 104729) % 1009 })).sort((a, b) => a.k - b.k).map(x => x.p).slice(0, N);
const r = rankAll(all, parseParams(fs.readFileSync(process.argv[3], "utf-8")));
const order = ["Setter","Libero","Front Outside Hitter","Back Outside Hitter","Front Middle Blocker","Back Middle Blocker","Opposite"];
const subs = LineupBuilder.getFiveOneSubSlots();
LineupBuilder.signSynergy = true;
const t = Date.now(); const b = new LineupBuilder(r); const res = b.buildFiveOneLineup(); const bs = b.getSubstitutes(res.lineup, subs);
const tB = Date.now() - t;
const lam = 0.5, lamR = 0.25;
function bonus(L: Record<string, ScoredPlayer|null>, sp: ScoredPlayer, j: number) {
  const slot = subs[j].replacesSlot; let u = 0, lost = 0;
  const K = courtRoleOf(subs[j].role) === "setter" ? sp.connectionScore : L["Setter"]?.connectionScore ?? 0;
  { const mem = FIVE_ONE_COURT.filter(s => s !== slot && L[s]).map(s => ({ key: s, role: courtRoleOf(FIVE_ONE_SLOT_ROLES[s]), sign: L[s]!.player.sign }));
    mem.push({ key: "sub", role: courtRoleOf(subs[j].role), sign: sp.player.sign });
    const ev = evaluateCourt(mem);
    if (courtRoleOf(subs[j].role) === "setter") { for (const ok of ev.connected.values()) if (ok) u++; }
    else { if (!ev.active.get("sub")) lost = sp.signScore; if (ev.connected.get("sub")) u++; } }
  return lam * (K * u - lost);
}
function bench(L: Record<string, ScoredPlayer|null>) {
  const inS = new Set(Object.values(L).filter(Boolean).map(x => x!.player.fullName));
  const vars: any = {}, cons: any = {};
  subs.forEach((d, j) => { cons["su"+j] = { max: 1 }; cons["re"+j] = { max: 1 };
    for (const sp of r[d.role]) { const n = sp.player.fullName; if (inS.has(n)) continue; cons["pl"+n] = { max: 1 };
      vars[`b|${n}|${j}`] = { obj: lam*sp.score + bonus(L, sp, j), ["su"+j]: 1, ["pl"+n]: 1 };
      vars[`r|${n}|${j}`] = { obj: lamR*sp.score, ["re"+j]: 1, ["pl"+n]: 1 }; } });
  subs.forEach((dj, j) => subs.forEach((dk, k) => { if (dj.role !== dk.role) return; const c = `d${j}_${k}`; cons[c] = { min: 0 };
    for (const sp of r[dj.role]) { const n = sp.player.fullName; if (vars[`b|${n}|${j}`]) vars[`b|${n}|${j}`][c] = sp.score;
      if (vars[`r|${n}|${k}`]) vars[`r|${n}|${k}`][c] = (vars[`r|${n}|${k}`][c] ?? 0) - sp.score; } }));
  const sol = solve({ direction: "maximize", objective: "obj", constraints: cons, variables: vars, binaries: true });
  return sol.result;
}
const F = (L: Record<string, ScoredPlayer|null>) => Object.values(L).reduce((s, x) => s + (x?.score ?? 0), 0) + lineupChemValue(L) + bench(L);
const fB = F(res.lineup);
let best = -Infinity, leaves = 0; const L: Record<string, ScoredPlayer|null> = {}; const used = new Set<string>();
const roles = order.map(s => FIVE_ONE_SLOT_ROLES[s]);
function rec(i: number, minIdx: number) {
  if (i === order.length) { leaves++; const f = F(L); if (f > best) best = f; return; }
  const pool = r[roles[i]]; let any = false;
  const start = i > 0 && roles[i-1] === roles[i] ? minIdx : 0;
  for (let c = start; c < pool.length; c++) { const n = pool[c].player.fullName; if (used.has(n)) continue; any = true;
    used.add(n); L[order[i]] = pool[c]; rec(i + 1, c + 1); used.delete(n); }
  if (!any) { L[order[i]] = null; rec(i + 1, 0); }
}
rec(0, 0);
console.log(`N=${all.length} seed=${seed} leaves=${leaves} B&B=${fB.toFixed(3)} (${tB}ms) brute=${best.toFixed(3)} ${Math.abs(fB-best)<1e-6 ? "OK" : "MISMATCH"}`);
