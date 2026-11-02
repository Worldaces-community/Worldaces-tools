/**
 * Lineup builder — MILP mono-passe (yalps)
 *
 * Sélectionne conjointement les 7 titulaires, les 7 remplaçants ET les
 * 7 réservistes (blessures) en un seul programme : titulaires pondérés à
 * plein, remplaçants pondérés par λ (< 1), réservistes par λᵣ (< λ) pour
 * que les meilleurs joueurs titularisent. La sélection globale évite
 * l'écueil du glouton, qui titularise des joueurs polyvalents sur des
 * slots non critiques et vide ainsi les pools du banc.
 *
 * Le réserviste couvre la nouvelle mécanique de BLESSURES du jeu : quand
 * le titulaire d'un slot est blessé, son remplaçant entre dans le six de
 * base et le réserviste prend la place laissée libre sur le banc.
 *
 * Contraintes clés :
 *   - chaque slot titulaire : au plus 1 joueur (rempli dès qu'un candidat
 *     éligible existe — le gain d'objectif est toujours positif — mais pas
 *     `equal 1` : un rôle sans aucun éligible, ou avec moins de candidats
 *     que de slots, laisse le(s) slot(s) restant(s) vide(s) au lieu de
 *     rendre tout le modèle infaisable)
 *   - chaque slot remplaçant / réserviste : au plus 1 joueur (banc
 *     incomplet toléré si le roster est trop petit, plutôt qu'un modèle
 *     infaisable)
 *   - chaque joueur : au plus 1 slot (titulaire, remplaçant OU réserviste)
 *   - domination : pour un rôle donné, tout titulaire >= tout remplaçant
 *     >= tout réserviste (garantit delta <= 0 à chaque étage ; un slot
 *     reste vide si aucun joueur restant n'est à la fois éligible et plus
 *     faible que l'étage supérieur — pas de remplaçant ⇒ pas de réserviste)
 *
 * Contraintes tactiques post-MILP (5-1) :
 *   score(Front OH) >= score(Back OH)
 *     → le meilleur OH attaque depuis l'avant
 *   score(Back MB)  >= score(Front MB)
 *     → le meilleur MB bloque depuis l'arrière (ligne du passeur)
 *
 * Synergie des signes (cf. signChemistry.ts) — résolution EXACTE :
 *   F = Σ scores titulaires + valeur de la chimie des titulaires (synergie
 *       parfaite = +10 % de la somme des scores des titulaires ≙ +10 % de
 *       victoire) + λ·(score + synergie d'entrée) des remplaçants
 *       + λᵣ·score des réservistes.
 * La chimie est quadratique (paires de joueurs) : linéarisée dans le MILP,
 * yalps ne termine pas. On maximise donc F par branch & bound sur les 7
 * titulaires (bornes valides : affectation optimale par algorithme hongrois +
 * borne de chimie selon les signes encore possibles), le banc et la réserve
 * étant résolus exactement à titulaires fixés (affectation, puis MILP si la
 * domination remplaçant ≥ réserviste n'est pas respectée). La domination
 * titulaire ≥ remplaçant est levée : un joueur écarté pour la chimie peut
 * aller sur le banc (Δ > 0). Vérifié contre une énumération exhaustive.
 *
 * Ces contraintes sont appliquées en post-traitement par simple swap :
 * le MILP sélectionne les deux meilleurs joueurs disponibles,
 * puis on les affecte au bon slot selon leur score.
 * Le résultat est identique à un MILP contraint car la sélection
 * des joueurs ne change pas — seule leur affectation au slot change.
 */

import { solve } from "yalps";
import { ScoredPlayer, RoleName } from "../types";
import { AFFINITY, NO_SIGN, signIndex, signAffinity, SIGN_SYNERGY_MAX_WIN_GAIN, SIGN_ACTIVATION_THRESHOLD, SETTER_SYNERGY_THRESHOLD } from "../config/signs";
import { Sign } from "../types";
import {
    courtRoleOf, evaluateCourt, CourtMember, FIVE_ONE_COURTS, UNITS_PER_PHASE,
} from "./signChemistry";
import { maxAssignment } from "./assignment";
import { SETTINGS, onSettingsChange } from "../config/settings";

// ─── Types publics (inchangés) ───────────────────────────────────────────────

export interface SlotDef {
    slot: string;
    role: RoleName;
}

export interface LineupResult {
    lineup: Record<string, ScoredPlayer | null>;
    usedPlayers: Set<string>;
    /**
     * Valeur (points de score) de la synergie des signes des titulaires :
     * unités atteintes × valeur d'une unité (0 sans signes / synergie off).
     */
    synergyValue: number;
}

export interface SubSlot {
    label: string;
    role: RoleName;
    replacesSlot: string;
}

export interface Substitute {
    label: string;
    sub: ScoredPlayer | null;
    replaces: string;
    delta: number;
    /** Réserviste : monte au banc quand le titulaire du slot est blessé. */
    reserve: ScoredPlayer | null;
    /** Écart de score réserviste − remplaçant (<= 0 par domination). */
    reserveDelta: number;
}

// ─── Contraintes d'ordre tactique ────────────────────────────────────────────

/**
 * Paire de slots dont le score doit être ordonné après résolution du MILP.
 *   higher : slot qui doit recevoir le joueur au score le plus élevé
 *   lower  : slot qui doit recevoir le joueur au score le plus faible
 */
interface OrderConstraint {
    higher: string;
    lower:  string;
}

interface ModelSolution {
    starters:  (ScoredPlayer | null)[];
    subs:      (ScoredPlayer | null)[];
    reserves:  (ScoredPlayer | null)[];
    /** Valeur de l'objectif (scores pondérés + bonus de synergie du banc). */
    objective: number;
}

// ─── LineupBuilder ───────────────────────────────────────────────────────────

export class LineupBuilder {
    private allRankings: Record<RoleName, ScoredPlayer[]>;
    private used: Set<string>;

    /**
     * Poids nominal des remplaçants dans l'objectif mono-MILP (0 < λ < 1).
     * < 1 garantit que les meilleurs joueurs sont titularisés ; > 0 pousse
     * à fournir le banc le plus fort possible sous la contrainte de domination.
     */
    static get subObjectiveWeight(): number { return SETTINGS.lineup.subObjectiveWeight; }
    static set subObjectiveWeight(v: number) { SETTINGS.lineup.subObjectiveWeight = v; LineupBuilder.cache.clear(); }

    /**
     * Poids des réservistes (blessures) dans l'objectif (0 < λᵣ < λ).
     * < λ garantit que le banc est servi avant la réserve ; > 0 pousse à
     * fournir la meilleure réserve possible sous la double domination
     * titulaire >= remplaçant >= réserviste.
     */
    static get reserveObjectiveWeight(): number { return SETTINGS.lineup.reserveObjectiveWeight; }
    static set reserveObjectiveWeight(v: number) { SETTINGS.lineup.reserveObjectiveWeight = v; LineupBuilder.cache.clear(); }

    /** Active l'optimisation de la synergie des signes (si le CSV a des signes). */
    static get signSynergy(): boolean { return SETTINGS.lineup.signSynergy; }
    static set signSynergy(v: boolean) { SETTINGS.lineup.signSynergy = v; }

    /**
     * Garde-fou du branch & bound de la synergie (ms). Au-delà, la meilleure
     * lineup trouvée est gardée avec un avertissement (optimalité non prouvée).
     */
    static get synergyTimeLimitMs(): number { return SETTINGS.lineup.synergyTimeLimitSec * 1000; }

    /** Résultats déjà optimisés, par contenu des pools (cf. buildOptimalLineup). */
    private static cache = new Map<string, { best: ModelSolution; synergyValue: number }>();

    /** Vide le cache des lineups (à appeler quand les scores ou réglages changent). */
    static clearCache(): void { LineupBuilder.cache.clear(); }

    constructor(allRankings: Record<RoleName, ScoredPlayer[]>) {
        this.allRankings = allRankings;
        this.used = new Set();
    }

    // ─── API publique (signatures inchangées) ─────────────────────────────────

    buildFiveOneLineup(): LineupResult {
        const starterDefs: SlotDef[] = [
            { slot: "Setter",               role: "setter"         },
            { slot: "Libero",               role: "libero"         },
            { slot: "Front Outside Hitter", role: "outsideHitter"  },
            { slot: "Back Outside Hitter",  role: "outsideHitter"  },
            { slot: "Front Middle Blocker", role: "middleBlocker"  },
            { slot: "Back Middle Blocker",  role: "middleBlocker"  },
            { slot: "Opposite",             role: "oppositeHitter" },
        ];

        // Contraintes d'ordre tactique 5-1 :
        //   Front OH >= Back OH  (meilleur attaquant en avant)
        //   Back MB  >= Front MB (meilleur bloqueur en arrière, ligne passeur)
        const orderConstraints: OrderConstraint[] = [
            { higher: "Front Outside Hitter", lower: "Back Outside Hitter"  },
            { higher: "Back Middle Blocker",  lower: "Front Middle Blocker" },
        ];

        return this.buildOptimalLineup(
            starterDefs,
            LineupBuilder.getFiveOneSubSlots(),
            orderConstraints
        );
    }

    getSubstitutes(
        lineup: Record<string, ScoredPlayer | null>,
        subSlotDefs: SubSlot[]
    ): Substitute[] {
        if (this._lastSubs) {
            const map      = this._lastSubs;
            const resMap   = this._lastReserves ?? {};
            this._lastSubs     = null;
            this._lastReserves = null;
            return subSlotDefs.map(({ label, replacesSlot }) => {
                const sub     = map[replacesSlot] ?? null;
                const reserve = resMap[replacesSlot] ?? null;
                const starter = lineup[replacesSlot] ?? null;
                const delta        = sub && starter ? sub.score - starter.score : 0;
                const reserveDelta = reserve && sub ? reserve.score - sub.score : 0;
                return {
                    label, sub, replaces: starter?.player.fullName ?? "—", delta,
                    reserve, reserveDelta,
                };
            });
        }
        return this._greedySubs(lineup, subSlotDefs);
    }

    // ─── Helpers statiques ────────────────────────────────────────────────────

    // Ordre d'affichage = position sur le terrain (ordre de service) :
    // 1 Setter · 2 Front OH · 3 Front MB · 4 Opposite · 5 Back OH · 6 Back MB,
    // puis le Libéro en 7. Les sub-slots suivent le même ordre pour que
    // titulaires, banc et réservistes s'alignent visuellement.

    static getFiveOneSubSlots(): SubSlot[] {
        return [
            { label: "Sub Setter",     role: "setter",        replacesSlot: "Setter"               },
            { label: "Sub Front OH",   role: "outsideHitter",  replacesSlot: "Front Outside Hitter" },
            { label: "Sub Front MB",   role: "middleBlocker",  replacesSlot: "Front Middle Blocker" },
            { label: "Sub OP",         role: "oppositeHitter", replacesSlot: "Opposite"             },
            { label: "Sub Back OH",    role: "outsideHitter",  replacesSlot: "Back Outside Hitter"  },
            { label: "Sub Back MB",    role: "middleBlocker",  replacesSlot: "Back Middle Blocker"  },
            { label: "Sub Libero",     role: "libero",         replacesSlot: "Libero"               },
        ];
    }

    static getFiveOneOrder(): string[] {
        return [
            "Setter",
            "Front Outside Hitter",
            "Front Middle Blocker",
            "Opposite",
            "Back Outside Hitter",
            "Back Middle Blocker",
            "Libero",
        ];
    }

    // ─── Cœur : MILP mono-passe (titulaires + remplaçants + réservistes) ─────

    private _lastSubs:     Record<string, ScoredPlayer | null> | null = null;
    private _lastReserves: Record<string, ScoredPlayer | null> | null = null;

    /** MILP mono-passe titulaires + remplaçants + réservistes (score pur). */
    private solveModel(
        starterDefs: SlotDef[],
        subSlotDefs: SubSlot[],
        pools:       Record<string, ScoredPlayer[]>
    ): ModelSolution {
        const nS = starterDefs.length;
        const starterPools = starterDefs.map((d) => pools[d.role] ?? []);
        const nB = subSlotDefs.length;

        const lambda  = LineupBuilder.subObjectiveWeight;
        const lambdaR = LineupBuilder.reserveObjectiveWeight;

        const vars: Record<string, Record<string, number>> = {};
        const cons: Record<string, { equal?: number; max?: number; min?: number }> = {};
        const seenPlayer = new Set<string>();

        const addPlayerCons = (nm: string) => {
            if (!seenPlayer.has(nm)) {
                cons[`pl_${nm}`] = { max: 1 };   // un joueur = au plus 1 slot
                seenPlayer.add(nm);
            }
        };

        // Slots : titulaires, remplaçants et réservistes tous à { max: 1 } (pas
        // `equal: 1`) — un slot titulaire reste vide, sans rendre le modèle
        // infaisable, si son rôle n'a pas (ou plus) de candidat disponible
        // (les slots réservistes miroitent les slots remplaçants : un par slot
        // titulaire, même rôle)
        for (let i = 0; i < nS; i++) cons[`sl_${i}`] = { max: 1 };
        for (let j = 0; j < nB; j++) cons[`su_${j}`] = { max: 1 };
        for (let j = 0; j < nB; j++) cons[`re_${j}`] = { max: 1 };

        // Variables titulaires (poids plein)
        for (let i = 0; i < nS; i++) {
            for (const sp of starterPools[i]) {
                const nm = sp.player.fullName;
                addPlayerCons(nm);
                vars[`xs_${nm}_${i}`] = {
                    obj:          sp.score,
                    [`sl_${i}`]:  1,
                    [`pl_${nm}`]: 1,
                };
            }
        }

        // Variables remplaçants (poids λ)
        for (let j = 0; j < nB; j++) {
            for (const sp of (pools[subSlotDefs[j].role] ?? [])) {
                const nm = sp.player.fullName;
                addPlayerCons(nm);
                vars[`xb_${nm}_${j}`] = {
                    obj:          lambda * sp.score,
                    [`su_${j}`]:  1,
                    [`pl_${nm}`]: 1,
                };
            }
        }

        // Variables réservistes (poids λᵣ < λ)
        for (let j = 0; j < nB; j++) {
            for (const sp of (pools[subSlotDefs[j].role] ?? [])) {
                const nm = sp.player.fullName;
                addPlayerCons(nm);
                vars[`xr_${nm}_${j}`] = {
                    obj:          lambdaR * sp.score,
                    [`re_${j}`]:  1,
                    [`pl_${nm}`]: 1,
                };
            }
        }

        // Domination : pour un rôle donné, tout titulaire >= tout remplaçant.
        //   StScore_i - SubScore_j >= 0   (contrainte linéaire, scores constants)
        // Un slot remplaçant reste vide (SubScore_j = 0) si aucun joueur restant
        // n'est à la fois éligible et plus faible que les titulaires.
        for (let i = 0; i < nS; i++) {
            for (let j = 0; j < nB; j++) {
                if (starterDefs[i].role !== subSlotDefs[j].role) continue;
                const cname = `dom_${i}_${j}`;
                cons[cname] = { min: 0 };
                for (const sp of starterPools[i]) {
                    const v = vars[`xs_${sp.player.fullName}_${i}`];
                    if (v) v[cname] = (v[cname] ?? 0) + sp.score;
                }
                for (const sp of (pools[subSlotDefs[j].role] ?? [])) {
                    const v = vars[`xb_${sp.player.fullName}_${j}`];
                    if (v) v[cname] = (v[cname] ?? 0) - sp.score;
                }
            }
        }

        // Domination 2ᵉ étage : tout remplaçant >= tout réserviste du même rôle.
        //   SubScore_j - ResScore_k >= 0
        // Un slot remplaçant vide (SubScore_j = 0) force donc le slot réserviste
        // du même rôle à rester vide lui aussi (pas de remplaçant ⇒ pas de
        // réserviste), et transitive­ment titulaire >= réserviste.
        for (let j = 0; j < nB; j++) {
            for (let k = 0; k < nB; k++) {
                if (subSlotDefs[j].role !== subSlotDefs[k].role) continue;
                const cname = `domr_${j}_${k}`;
                cons[cname] = { min: 0 };
                for (const sp of (pools[subSlotDefs[j].role] ?? [])) {
                    const vb = vars[`xb_${sp.player.fullName}_${j}`];
                    if (vb) vb[cname] = (vb[cname] ?? 0) + sp.score;
                    const vr = vars[`xr_${sp.player.fullName}_${k}`];
                    if (vr) vr[cname] = (vr[cname] ?? 0) - sp.score;
                }
            }
        }

        const sol = solve({
            direction:   "maximize",
            objective:   "obj",
            constraints: cons,
            variables:   vars,
            binaries:    true,
        });

        // ── Extraction ────────────────────────────────────────────────────────

        const starters: (ScoredPlayer | null)[] = new Array(nS).fill(null);
        const subs:     (ScoredPlayer | null)[] = new Array(nB).fill(null);
        const reserves: (ScoredPlayer | null)[] = new Array(nB).fill(null);

        if (sol.status === "optimal") {
            const sel = new Map(sol.variables);
            for (let i = 0; i < nS; i++) {
                for (const sp of starterPools[i]) {
                    if ((sel.get(`xs_${sp.player.fullName}_${i}`) ?? 0) > 0.5) {
                        starters[i] = sp;
                        break;
                    }
                }
            }
            for (let j = 0; j < nB; j++) {
                for (const sp of (pools[subSlotDefs[j].role] ?? [])) {
                    if ((sel.get(`xb_${sp.player.fullName}_${j}`) ?? 0) > 0.5) {
                        subs[j] = sp;
                        break;
                    }
                }
            }
            for (let j = 0; j < nB; j++) {
                for (const sp of (pools[subSlotDefs[j].role] ?? [])) {
                    if ((sel.get(`xr_${sp.player.fullName}_${j}`) ?? 0) > 0.5) {
                        reserves[j] = sp;
                        break;
                    }
                }
            }
        }

        return {
            starters, subs, reserves,
            objective: sol.status === "optimal" ? sol.result : -Infinity,
        };
    }

    private buildOptimalLineup(
        starterDefs:      SlotDef[],
        subSlotDefs:      SubSlot[],
        orderConstraints: OrderConstraint[] = []
    ): LineupResult {
        const nS = starterDefs.length;
        const nB = subSlotDefs.length;

        // Pools triés par score desc (titulaires + remplaçants)
        const pools: Record<string, ScoredPlayer[]> = {};
        for (const def of [...starterDefs, ...subSlotDefs]) {
            pools[def.role] ??= [...(this.allRankings[def.role] ?? [])].sort(
                (a, b) => b.score - a.score
            );
        }

        // Cache : un même pool est souvent re-optimisé (disponibilité,
        // Academy, lineup principale) — le branch & bound coûte cher.
        const cacheKey = JSON.stringify([
            starterDefs, subSlotDefs, LineupBuilder.signSynergy,
            LineupBuilder.subObjectiveWeight, LineupBuilder.reserveObjectiveWeight,
            Object.entries(pools).map(([r, pool]) =>
                [r, pool.map((sp) => [sp.player.fullName, sp.score, sp.player.sign])]),
        ]);
        let cached = LineupBuilder.cache.get(cacheKey);
        if (!cached) {
            // 1) MILP sans synergie (sélection par score pur, domination stricte).
            let best = this.solveModel(starterDefs, subSlotDefs, pools);
            let synergyValue = 0;

            // 2) Synergie des signes : branch & bound exact sur les titulaires,
            //    banc/réserve optimaux à titulaires fixés.
            if (LineupBuilder.signSynergy) {
                ({ best, synergyValue } = this.optimizeSignSynergy(starterDefs, subSlotDefs, pools, best));
            }
            cached = { best, synergyValue };
            LineupBuilder.cache.set(cacheKey, cached);
        }
        const synergyValue = cached.synergyValue;
        const starters = [...cached.best.starters];
        const subs     = [...cached.best.subs];
        const reserves = [...cached.best.reserves];

        const used = new Set<string>();
        for (const sp of [...starters, ...subs, ...reserves]) {
            if (sp) used.add(sp.player.fullName);
        }

        // ── Post-traitement : contraintes d'ordre (swap intra-rôle) ───────────
        //
        // Le MILP a sélectionné l'ensemble des joueurs ; on se contente de les
        // affecter au bon slot selon leur score. Swapper deux titulaires d'un
        // même rôle ne change pas l'ensemble, donc la domination reste valide.

        for (const { higher, lower } of orderConstraints) {
            const hiIdx = starterDefs.findIndex(d => d.slot === higher);
            const loIdx = starterDefs.findIndex(d => d.slot === lower);
            if (hiIdx === -1 || loIdx === -1) continue;

            const hiPlayer = starters[hiIdx];
            const loPlayer = starters[loIdx];
            if (!hiPlayer || !loPlayer) continue;

            if (hiPlayer.score < loPlayer.score) {
                starters[hiIdx] = loPlayer;
                starters[loIdx] = hiPlayer;
                // Le remplaçant / réserviste suit le titulaire qu'il couvre
                // (sa synergie d'entrée a été évaluée face aux autres titulaires).
                const hiJ = subSlotDefs.findIndex(d => d.replacesSlot === higher);
                const loJ = subSlotDefs.findIndex(d => d.replacesSlot === lower);
                if (hiJ !== -1 && loJ !== -1) {
                    [subs[hiJ], subs[loJ]]         = [subs[loJ], subs[hiJ]];
                    [reserves[hiJ], reserves[loJ]] = [reserves[loJ], reserves[hiJ]];
                }
            }
        }

        // ── Construire les maps de résultat ───────────────────────────────────

        const lineup: Record<string, ScoredPlayer | null> = {};
        for (let i = 0; i < nS; i++) {
            lineup[starterDefs[i].slot] = starters[i];
        }

        const subsMap:     Record<string, ScoredPlayer | null> = {};
        const reservesMap: Record<string, ScoredPlayer | null> = {};
        for (let j = 0; j < nB; j++) {
            subsMap[subSlotDefs[j].replacesSlot]     = subs[j];
            reservesMap[subSlotDefs[j].replacesSlot] = reserves[j];
        }

        this.used          = used;
        this._lastSubs     = subsMap;
        this._lastReserves = reservesMap;

        return { lineup, usedPlayers: new Set(used), synergyValue };
    }

    // ─── Synergie des signes : branch & bound EXACT ───────────────────────────
    //
    // Objectif (celui qu'aurait un MILP unique titulaires + banc + réserve) :
    //   F(S) = Σ scores titulaires + V·U(S) + B(S)
    //   U(S) : unités de chimie des titulaires (moyenne des 2 phases, ≤ 9)
    //   V    : valeur d'une unité = 10 % × Σ scores des titulaires de base / 9
    //   B(S) : optimum EXACT banc + réserve à titulaires S fixés (λ·score +
    //          synergie d'entrée du remplaçant, λᵣ·score réserviste, unicité
    //          des joueurs, domination remplaçant ≥ réserviste).
    // La chimie dépend de paires de joueurs (quadratique) : linéarisée dans le
    // MILP joint, yalps ne termine pas. On énumère donc IMPLICITEMENT tous les
    // jeux de titulaires par branch & bound avec des bornes supérieures valides
    // (affectation optimale sans domination pour titulaires restants + banc +
    // réserve, borne de chimie selon les signes encore possibles) : la lineup
    // retenue est l'optimum global de F (sauf dépassement de
    // `synergyTimeLimitMs`, signalé par un avertissement).

    private optimizeSignSynergy(
        starterDefs: SlotDef[],
        subSlotDefs: SubSlot[],
        pools:       Record<string, ScoredPlayer[]>,
        base:        ModelSolution
    ): { best: ModelSolution; synergyValue: number } {
        const anySign = Object.values(pools).some((pool) => pool.some((sp) => sp.player.sign));
        if (!anySign || base.objective === -Infinity) return { best: base, synergyValue: 0 };

        const t0 = Date.now();
        const nS = starterDefs.length;
        const nB = subSlotDefs.length;
        const lambda  = LineupBuilder.subObjectiveWeight;
        const lambdaR = LineupBuilder.reserveObjectiveWeight;
        const slotIdx = new Map(starterDefs.map((d, i) => [d.slot, i]));
        const courts = FIVE_ONE_COURTS
            .map((court) => court.map((slot) => slotIdx.get(slot)).filter((i): i is number => i !== undefined));
        const phaseW = 1 / courts.length;
        const crole = starterDefs.map((d) => courtRoleOf(d.role));
        const subCrole = subSlotDefs.map((d) => courtRoleOf(d.role));
        const subOf = subSlotDefs.map((d) => slotIdx.get(d.replacesSlot) ?? -1);

        const baseTotal = base.starters.reduce((s, sp) => s + (sp?.score ?? 0), 0);
        const unitValue = (SIGN_SYNERGY_MAX_WIN_GAIN * baseTotal) / UNITS_PER_PHASE;

        // Joueurs (un même joueur peut figurer dans plusieurs pools de rôle).
        const names: string[] = [];
        const nameIdx = new Map<string, number>();
        const signOfP: (Sign | null)[] = [];
        for (const pool of Object.values(pools)) {
            for (const sp of pool) {
                if (nameIdx.has(sp.player.fullName)) continue;
                nameIdx.set(sp.player.fullName, names.length);
                names.push(sp.player.fullName);
                signOfP.push(sp.player.sign);
            }
        }
        const nP = names.length;
        const roleScore = new Map<RoleName, Map<number, ScoredPlayer>>();
        for (const [role, pool] of Object.entries(pools) as [RoleName, ScoredPlayer[]][]) {
            roleScore.set(role, new Map(pool.map((sp) => [nameIdx.get(sp.player.fullName)!, sp])));
        }

        type Lineup = (ScoredPlayer | null)[];
        const sg = (S: Lineup, i: number) => S[i]?.player.sign ?? null;

        /** Unités de chimie (moyenne des phases) des titulaires S. */
        // Version numérique (chemin chaud du branch & bound) : sig[i] = index
        // du signe du titulaire i (NO_SIGN = sans signe, −1 = slot vide).
        const chemBuf = new Int32Array(nS);
        const unitsOfSigs = (sig: ArrayLike<number>): number => {
            let units = 0;
            for (const idxs of courts) {
                for (const m of idxs) {
                    if (sig[m] < 0) continue;
                    let c = 0;
                    const row = sig[m] * 13;
                    for (const o of idxs) if (o !== m && sig[o] >= 0) c += AFFINITY[row + sig[o]];
                    chemBuf[m] = c;
                }
                let setter = -1;
                for (const m of idxs) if (crole[m] === "setter" && sig[m] >= 0) setter = m;
                for (const m of idxs) {
                    if (sig[m] < 0 || sig[m] === NO_SIGN || crole[m] === "setter") continue;
                    if (chemBuf[m] >= SIGN_ACTIVATION_THRESHOLD) units += phaseW;
                    if (crole[m] === "hitter" && setter >= 0 && sig[setter] !== NO_SIGN &&
                        chemBuf[setter] + chemBuf[m] >= SETTER_SYNERGY_THRESHOLD) units += phaseW;
                }
            }
            return units;
        };
        const sigOf = (S: Lineup) => S.map((sp) => (sp ? signIndex(sp.player.sign) : -1));
        /** Unités de chimie (moyenne des phases) des titulaires S. */
        const starterUnits = (S: Lineup): number => unitsOfSigs(sigOf(S));

        /** Unités impliquant un remplaçant de signe k entrant au slot j (titulaires S). */
        const entryUnits = (S: Lineup, j: number, k: Sign): number => {
            const i = subOf[j];
            if (i < 0) return 0;
            let units = 0;
            for (const idxs of courts) {
                if (!idxs.includes(i)) continue;
                const others = idxs.filter((t) => t !== i && S[t]);
                let subChem = 0;
                for (const o of others) subChem += signAffinity(k, sg(S, o));
                const chemWithSub = (h: number) => {
                    let c = signAffinity(sg(S, h), k);
                    for (const o of others) if (o !== h) c += signAffinity(sg(S, h), sg(S, o));
                    return c;
                };
                if (subCrole[j] === "setter") {
                    for (const h of others) {
                        if (crole[h] === "hitter" && sg(S, h) &&
                            subChem + chemWithSub(h) >= SETTER_SYNERGY_THRESHOLD) units++;
                    }
                } else {
                    if (subChem >= SIGN_ACTIVATION_THRESHOLD) units++;
                    const setter = others.find((t) => crole[t] === "setter");
                    if (subCrole[j] === "hitter" && setter !== undefined && sg(S, setter) &&
                        chemWithSub(setter) + subChem >= SETTER_SYNERGY_THRESHOLD) units++;
                }
            }
            return units * phaseW;
        };
        const bonusTable = (S: Lineup) => {
            const cache = new Map<string, number>();
            return (sign: Sign | null, j: number): number => {
                if (!sign) return 0;
                const key = `${j}|${sign}`;
                let v = cache.get(key);
                if (v === undefined) {
                    v = lambda * unitValue * entryUnits(S, j, sign);
                    cache.set(key, v);
                }
                return v;
            };
        };
        /** Bonus d'entrée maximal d'un slot remplaçant (borne). */
        const maxBonus = subSlotDefs.map((d, j) => {
            const i = subOf[j];
            if (i < 0) return 0;
            const per = { setter: 4, hitter: 2, libero: 1 }[subCrole[j]];
            return lambda * unitValue * per * phaseW * courts.filter((idxs) => idxs.includes(i)).length;
        });

        /**
         * Affectation optimale SANS domination (algorithme hongrois) :
         * slots titulaires restants (score) + remplaçants (λ·score + bonus) +
         * réservistes (λᵣ·score), joueurs hors `used`. Borne supérieure ; égale
         * à B(S) quand la domination est respectée par la solution.
         */
        const assign = (
            used: Set<number>,
            starterSlots: number[],
            subBonus: (sign: Sign | null, j: number) => number
        ) => {
            const cols: number[] = [];
            for (let p = 0; p < nP; p++) if (!used.has(p)) cols.push(p);
            const rows: { kind: "s" | "b" | "r"; idx: number; role: RoleName }[] = [
                ...starterSlots.map((i) => ({ kind: "s" as const, idx: i, role: starterDefs[i].role })),
                ...subSlotDefs.map((d, j) => ({ kind: "b" as const, idx: j, role: d.role })),
                ...subSlotDefs.map((d, j) => ({ kind: "r" as const, idx: j, role: d.role })),
            ];
            const value = rows.map((row) => cols.map((p) => {
                const sp = roleScore.get(row.role)?.get(p);
                if (!sp) return null;
                if (row.kind === "s") return sp.score;
                if (row.kind === "b") return lambda * sp.score + subBonus(signOfP[p], row.idx);
                return lambdaR * sp.score;
            }));
            const { total, colOf } = maxAssignment(value, cols.length);
            const at = (kind: "b" | "r", j: number): ScoredPlayer | null => {
                const r = rows.findIndex((row) => row.kind === kind && row.idx === j);
                const c = colOf[r];
                return c >= 0 ? roleScore.get(subSlotDefs[j].role)!.get(cols[c])! : null;
            };
            return { total, at };
        };

        // ── Évaluation exacte d'un jeu de titulaires complet ─────────────────
        let best: ModelSolution = base;
        let bestTotal = -Infinity;
        let bestS: Lineup = base.starters;
        const scoreSum = (S: Lineup) => S.reduce((s, sp) => s + (sp?.score ?? 0), 0);
        const usedOf = (S: Lineup) => new Set(S.filter(Boolean).map((sp) => nameIdx.get(sp!.player.fullName)!));
        const consider = (S: Lineup): void => {
            const starterPart = scoreSum(S) + unitValue * starterUnits(S);
            const bonus = bonusTable(S);
            const a = assign(usedOf(S), [], bonus);
            if (starterPart + a.total <= bestTotal + 1e-9) return;
            const subs = subSlotDefs.map((_, j) => a.at("b", j));
            const reserves = subSlotDefs.map((_, j) => a.at("r", j));
            // Domination remplaçant ≥ réserviste (par rôle, slot vide = 0).
            const dominated = subSlotDefs.every((dj, j) => subSlotDefs.every((dk, k) =>
                dj.role !== dk.role || (subs[j]?.score ?? 0) >= (reserves[k]?.score ?? 0)));
            let sol = { subs, reserves, objective: a.total };
            if (!dominated) {
                sol = this.solveBench(subSlotDefs, pools, S,
                    (sp, j) => bonus(sp.player.sign, j), false);
            }
            const total = starterPart + sol.objective;
            if (total > bestTotal + 1e-9) {
                bestTotal = total;
                bestS = [...S];
                best = {
                    starters: [...S], subs: sol.subs, reserves: sol.reserves,
                    objective: scoreSum(S) + sol.objective,
                };
            }
        };

        // ── Incumbent : base + recherche locale (accélère l'élagage) ─────────
        consider(base.starters);
        for (const S of this.localSearch(starterDefs, pools, base.starters,
                (S) => scoreSum(S) + unitValue * starterUnits(S))) {
            consider(S);
        }

        // ── Branch & bound sur les titulaires ────────────────────────────────
        // Symétrie : les slots d'un même rôle (2 OH, 2 MB) sont interchangeables
        // pour F (même présence sur le terrain / phases permutées ; remplaçants
        // réaffectés par l'optimisation du banc) → indices croissants.
        const cand = starterDefs.map((d) => pools[d.role] ?? []);
        const prevSameRole = starterDefs.map((d, i) =>
            starterDefs.findIndex((e, k) => k < i && e.role === d.role));

        const S: Lineup = new Array(nS).fill(null);
        const fixed: boolean[] = new Array(nS).fill(false);
        const pick: number[] = new Array(nS).fill(-1);
        const used = new Set<number>();

        // Borne de chimie : un slot non fixé prend, indépendamment pour chaque
        // relation, le meilleur des signes encore disponibles dans son pool.
        const synergyBound = (): number => {
            const signsOf: (Sign | null)[][] = starterDefs.map((_, i) => {
                if (fixed[i]) return S[i] ? [S[i]!.player.sign] : [];
                const out = new Set<Sign | null>();
                for (const sp of cand[i]) {
                    if (!used.has(nameIdx.get(sp.player.fullName)!)) out.add(sp.player.sign);
                }
                return [...out];
            });
            // Peu de slots libres : énumération exacte des combinaisons de signes
            // (unicité des joueurs relâchée ⇒ borne toujours valide).
            const free = starterDefs.map((_, i) => i).filter((i) => !fixed[i] && signsOf[i].length > 0);
            if (free.length <= 2) {
                let bestU = 0;
                const T = sigOf(S);
                const rec = (k: number) => {
                    if (k === free.length) { bestU = Math.max(bestU, unitsOfSigs(T)); return; }
                    for (const sign of signsOf[free[k]]) { T[free[k]] = signIndex(sign); rec(k + 1); }
                };
                rec(0);
                return unitValue * bestU;
            }
            let units = 0;
            for (const idxs of courts) {
                const present = idxs.filter((i) => signsOf[i].length > 0);
                const chemUb = new Map<number, number>();
                for (const m of present) {
                    let bestC = -Infinity;
                    for (const k of signsOf[m]) {
                        if (!k) continue;
                        let c = 0;
                        for (const o of present) {
                            if (o === m) continue;
                            let mx = -Infinity;
                            for (const l of signsOf[o]) mx = Math.max(mx, signAffinity(k, l));
                            c += mx;
                        }
                        bestC = Math.max(bestC, c);
                    }
                    chemUb.set(m, bestC);
                }
                const setter = present.find((i) => crole[i] === "setter");
                for (const m of present) {
                    if (crole[m] === "setter") continue;
                    if (chemUb.get(m)! >= SIGN_ACTIVATION_THRESHOLD) units += phaseW;
                    if (crole[m] === "hitter" && setter !== undefined &&
                        chemUb.get(setter)! + chemUb.get(m)! >= SETTER_SYNERGY_THRESHOLD) units += phaseW;
                }
            }
            return unitValue * units;
        };
        const maxBonusFn = (_: Sign | null, j: number) => maxBonus[j];
        const assignBound = (fromSlot: number): number =>
            assign(used, Array.from({ length: nS - fromSlot }, (_, k) => fromSlot + k), maxBonusFn).total;

        let timedOut = false;
        let nodes = 0;
        const dfs = (i: number, partial: number): void => {
            if (timedOut) return;
            if ((++nodes & 0xff) === 0 && Date.now() - t0 > LineupBuilder.synergyTimeLimitMs) {
                timedOut = true;
                return;
            }
            if (i === nS) { consider(S); return; }
            const start = prevSameRole[i] >= 0 ? pick[prevSameRole[i]] + 1 : 0;
            // Borne sans le candidat (slot i hors affectation) : retirer un
            // joueur de plus ne peut que la baisser ⇒ partial + score(c) + rest
            // décroît avec c (tri par score) → arrêt dès qu'elle échoue.
            const restAssign = assignBound(i + 1);
            const rest = restAssign + synergyBound();
            let any = false;
            for (let c = start; c < cand[i].length; c++) {
                const sp = cand[i][c];
                const p = nameIdx.get(sp.player.fullName)!;
                if (used.has(p)) continue;
                any = true;
                if (partial + sp.score + rest <= bestTotal + 1e-9) break;
                used.add(p); S[i] = sp; pick[i] = c; fixed[i] = true;
                // Borne de chimie (c fixé) d'abord avec l'affectation sans retirer
                // c (≥ la vraie, peu coûteuse), puis l'affectation exacte.
                const syn = synergyBound();
                if (partial + sp.score + restAssign + syn > bestTotal + 1e-9 &&
                    partial + sp.score + assignBound(i + 1) + syn > bestTotal + 1e-9) {
                    dfs(i + 1, partial + sp.score);
                }
                used.delete(p); S[i] = null; pick[i] = -1; fixed[i] = false;
            }
            // Slot laissé vide uniquement s'il n'y a plus aucun éligible (même
            // règle que le MILP de base : un slot jouable est toujours rempli).
            if (!any) {
                pick[i] = cand[i].length; fixed[i] = true;
                dfs(i + 1, partial);
                pick[i] = -1; fixed[i] = false;
            }
        };
        dfs(0, 0);

        if (timedOut) {
            console.warn(
                `⚠️  Sign chemistry: ${LineupBuilder.synergyTimeLimitMs / 1000} s time limit reached, ` +
                `lineup = best found so far (optimality not proven).`
            );
        }
        return { best, synergyValue: unitValue * starterUnits(bestS) };
    }

    /**
     * Recherche locale (remplacements simples et doubles) : fournit de bons
     * jeux de titulaires de départ au branch & bound (élagage plus rapide).
     */
    private localSearch(
        starterDefs: SlotDef[],
        pools:       Record<string, ScoredPlayer[]>,
        start:       (ScoredPlayer | null)[],
        value:       (S: (ScoredPlayer | null)[]) => number
    ): (ScoredPlayer | null)[][] {
        const nS = starterDefs.length;
        const candidates = (S: (ScoredPlayer | null)[], i: number) => {
            const inS = new Set(S.filter(Boolean).map((sp) => sp!.player.fullName));
            return (pools[starterDefs[i].role] ?? []).filter((sp) => !inS.has(sp.player.fullName));
        };
        const path: (ScoredPlayer | null)[][] = [];
        let cur = [...start];
        let curVal = value(cur);
        for (let improved = true; improved; ) {
            improved = false;
            let bestS: (ScoredPlayer | null)[] | null = null;
            let bestVal = curVal + 1e-9;
            const tryS = (S: (ScoredPlayer | null)[]) => {
                const v = value(S);
                if (v > bestVal) { bestVal = v; bestS = [...S]; }
            };
            for (let i = 0; i < nS; i++) {
                for (const ci of candidates(cur, i)) {
                    const Si = [...cur]; Si[i] = ci; tryS(Si);
                    for (let k = i + 1; k < nS; k++) {
                        for (const ck of candidates(Si, k)) {
                            const Sk = [...Si]; Sk[k] = ck; tryS(Sk);
                        }
                    }
                }
            }
            if (bestS) { cur = bestS; curVal = bestVal; improved = true; path.push(cur); }
        }
        return path.reverse();
    }

    /**
     * MILP joint banc + réserve à titulaires FIXÉS (relax = relaxation LP,
     * borne supérieure). Objectif : λ·score + bonus de synergie d'entrée
     * (remplaçants) + λᵣ·score (réservistes) ; domination remplaçant ≥
     * réserviste par rôle (slot remplaçant vide ⇒ pas de réserviste). Pas de
     * domination titulaire ≥ remplaçant : les titulaires sont choisis par
     * l'objectif global (chimie comprise), un joueur écarté pour la chimie peut
     * aller sur le banc (Δ > 0).
     */
    private solveBench(
        subSlotDefs: SubSlot[],
        pools:       Record<string, ScoredPlayer[]>,
        starters:    (ScoredPlayer | null)[],
        bonus:       (sp: ScoredPlayer, j: number) => number,
        relax:       boolean
    ): { subs: (ScoredPlayer | null)[]; reserves: (ScoredPlayer | null)[]; objective: number } {
        const lambda  = LineupBuilder.subObjectiveWeight;
        const lambdaR = LineupBuilder.reserveObjectiveWeight;
        const inS = new Set(starters.filter(Boolean).map((sp) => sp!.player.fullName));
        const free = (j: number) => (pools[subSlotDefs[j].role] ?? []).filter((sp) => !inS.has(sp.player.fullName));

        const vars: Record<string, Record<string, number>> = {};
        const cons: Record<string, { max?: number; min?: number }> = {};
        subSlotDefs.forEach((_, j) => {
            cons[`su_${j}`] = { max: 1 };
            cons[`re_${j}`] = { max: 1 };
            for (const sp of free(j)) {
                const nm = sp.player.fullName;
                cons[`pl_${nm}`] = { max: 1 };
                vars[`xb_${nm}_${j}`] = { obj: lambda * sp.score + bonus(sp, j), [`su_${j}`]: 1, [`pl_${nm}`]: 1 };
                vars[`xr_${nm}_${j}`] = { obj: lambdaR * sp.score, [`re_${j}`]: 1, [`pl_${nm}`]: 1 };
            }
        });
        subSlotDefs.forEach((dj, j) => {
            subSlotDefs.forEach((dk, k) => {
                if (dj.role !== dk.role) return;
                const c = `domr_${j}_${k}`;
                cons[c] = { min: 0 };
                for (const sp of free(j)) vars[`xb_${sp.player.fullName}_${j}`][c] = sp.score;
                for (const sp of free(k)) {
                    const v = vars[`xr_${sp.player.fullName}_${k}`];
                    v[c] = (v[c] ?? 0) - sp.score;
                }
            });
        });

        const sol = solve({
            direction: "maximize", objective: "obj", constraints: cons, variables: vars,
            binaries: !relax,
        });
        if (sol.status !== "optimal") {
            return { subs: subSlotDefs.map(() => null), reserves: subSlotDefs.map(() => null), objective: -Infinity };
        }
        const sel = new Map(sol.variables);
        const pickTier = (prefix: string) => subSlotDefs.map((_, j) =>
            free(j).find((sp) => (sel.get(`${prefix}_${sp.player.fullName}_${j}`) ?? 0) > 0.5) ?? null);
        return relax
            ? { subs: [], reserves: [], objective: sol.result }
            : { subs: pickTier("xb"), reserves: pickTier("xr"), objective: sol.result };
    }


    // ─── Fallback glouton (rétro-compatibilité getSubstitutes standalone) ────

    private _greedySubs(
        lineup:      Record<string, ScoredPlayer | null>,
        subSlotDefs: SubSlot[]
    ): Substitute[] {
        const usedForSubs = new Set(this.used);

        // 1ʳᵉ passe : les remplaçants (le banc est servi avant la réserve,
        // comme la domination du MILP l'impose).
        const substitutes: Substitute[] = [];
        for (const { label, role, replacesSlot } of subSlotDefs) {
            const ranked  = this.allRankings[role] ?? [];
            const sub     = ranked.find(s => !usedForSubs.has(s.player.fullName)) ?? null;
            const starter = lineup[replacesSlot] ?? null;
            if (sub) usedForSubs.add(sub.player.fullName);
            const delta = sub && starter ? sub.score - starter.score : 0;
            substitutes.push({
                label, sub, replaces: starter?.player.fullName ?? "—", delta,
                reserve: null, reserveDelta: 0,
            });
        }

        // 2ᵉ passe : les réservistes (blessures) — pas de remplaçant ⇒ pas de
        // réserviste, cohérent avec le MILP.
        substitutes.forEach((entry, j) => {
            if (!entry.sub) return;
            const ranked  = this.allRankings[subSlotDefs[j].role] ?? [];
            const reserve = ranked.find(s => !usedForSubs.has(s.player.fullName)) ?? null;
            if (reserve) {
                usedForSubs.add(reserve.player.fullName);
                entry.reserve      = reserve;
                entry.reserveDelta = reserve.score - entry.sub.score;
            }
        });

        return substitutes;
    }
}
// Changement de réglages (λ, synergie…) ⇒ les lineups en cache sont caduques.
onSettingsChange.push(() => LineupBuilder.clearCache());
