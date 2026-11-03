/**
 * Affectation de valeur maximale (algorithme hongrois, O(n²·m)) : chaque slot
 * reçoit au plus un joueur, chaque joueur au plus un slot, un slot peut rester
 * vide (valeur 0). `value[s][p]` = valeur du joueur p au slot s, ou null si
 * inéligible. Sert de borne exacte « sans domination » au branch & bound de
 * la synergie (lineupBuilder) : beaucoup plus rapide qu'un MILP.
 */
export function maxAssignment(value: (number | null)[][], nPlayers: number): { total: number; colOf: number[] } {
    const n = value.length;
    if (n === 0) return { total: 0, colOf: [] };
    // Colonnes : joueurs puis une colonne « vide » par slot (valeur 0).
    const m = nPlayers + n;
    const BIG = 1e9;
    const cost = new Float64Array(n * m).fill(BIG);
    for (let i = 0; i < n; i++) {
        const row = value[i];
        for (let j = 0; j < nPlayers; j++) {
            const v = row[j];
            if (v !== null) cost[i * m + j] = -v;
        }
        cost[i * m + nPlayers + i] = 0;
    }
    // Hongrois (version potentiels, lignes ≤ colonnes), indices 1-based.
    const u = new Float64Array(n + 1);
    const v = new Float64Array(m + 1);
    const p = new Int32Array(m + 1);     // p[j] = ligne affectée à la colonne j
    const way = new Int32Array(m + 1);
    const minv = new Float64Array(m + 1);
    const usedCol = new Uint8Array(m + 1);
    for (let i = 1; i <= n; i++) {
        p[0] = i;
        let j0 = 0;
        minv.fill(Infinity);
        usedCol.fill(0);
        do {
            usedCol[j0] = 1;
            const i0 = p[j0];
            const base = (i0 - 1) * m - 1;
            const ui0 = u[i0];
            let delta = Infinity;
            let j1 = 0;
            for (let j = 1; j <= m; j++) {
                if (usedCol[j]) continue;
                const cur = cost[base + j] - ui0 - v[j];
                if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
                if (minv[j] < delta) { delta = minv[j]; j1 = j; }
            }
            for (let j = 0; j <= m; j++) {
                if (usedCol[j]) { u[p[j]] += delta; v[j] -= delta; }
                else minv[j] -= delta;
            }
            j0 = j1;
        } while (p[j0] !== 0);
        do {
            const j1 = way[j0];
            p[j0] = p[j1];
            j0 = j1;
        } while (j0);
    }
    const colOf = new Array(n).fill(-1);
    let total = 0;
    for (let j = 1; j <= nPlayers; j++) {
        if (!p[j]) continue;
        colOf[p[j] - 1] = j - 1;
        total += value[p[j] - 1][j - 1]!;
    }
    return { total, colOf };
}
