/**
 * CSV parser for player data
 */

import { Player, Progress, Sign } from "../types";
import { ALL_TRAITS } from "../config/constants";
import { ALL_SIGNS, SIGN_ALIASES } from "../config/signs";

/**
 * Mapping of French CSV headers (translated game) to the canonical
 * English keys used internally. Case distinguishes composite stats
 * (UPPERCASE) from sub-stats (lowercase), e.g. CONTRE→BLOCK vs
 * contre→block. English headers remain supported (passthrough).
 */
const HEADER_ALIASES: Record<string, string> = {
    "Prénom": "First name",
    "Nom": "Last name",
    "Âge": "Age",
    "Rareté": "Rarity",
    "Rôles": "Roles",
    "Progression": "Progress",
    "Signe": "Sign",
    // Composite stats (UPPERCASE)
    "ATTAQUE": "ATTACK",
    "PASSE": "SETTING",
    "RÉCEPTION": "RECEPTION",
    "SERVICE": "SERVE",
    "CONTRE": "BLOCK",
    "ENDURANCE": "STAMINA",
    // Sub-stats (lowercase)
    "passe": "setting",
    "service": "serve",
    "smash": "spike",
    "rapide": "quick",
    "puissance": "power",
    "conscience du jeu": "awareness",
    "attaque": "attack",
    "attaque arrière": "back attack",
    "réception": "reception",
    "touche haute": "overhand",
    "manchette": "bump",
    "contre": "block",
    "lecture du contre": "read block",
    "engagement au contre": "commit block",
    "concentration": "focus",
    "défense": "defense",
    "endurance": "stamina",
    "réflexe": "reflex",
    // "Position" and "Traits" are identical in FR/EN.
};

/**
 * Mapping of French cell values (translated game) to the
 * canonical English values expected by the rest of the code. Since the headers
 * are translated above, so are the values: roles, traits,
 * rarities and positions. English values remain supported (passthrough).
 */
const ROLE_ALIASES: Record<string, string> = {
    "Passeur": "Setter",
    "Libéro": "Libero",
    "Réceptionneur-attaquant": "Outside Hitter",
    "Pointu": "Opposite Hitter",
    "Central": "Middle Blocker",
};

const TRAIT_ALIASES: Record<string, string> = {
    "Stratège": "Master Mind",
    "Mur mouvant": "Moving Wall",
    "Attaque surprise": "Surprise Attack",
    "Franc-tireur": "Marksman",
    "Service météore": "Meteor Serve",
    "Vigoureux": "Vigorous",
    "Gardien": "Guardian",
    "Service flottant": "Float Serve",
    "Spécialiste défensif": "Defensive Specialist",
    // New wave of traits — FR names to be confirmed in game. An unrecognized
    // FR name triggers the "unknown trait" warning below rather
    // than silently ignoring the bonus.
    "Apprenti Rapide": "Quick Learner",
    "Accro à l'Élan": "Momentum Addict",
    "Grande Gueule": "Loudmouth",
    "Vrai Leader": "True Leader",
    "Battant": "Overachiever",
    "Rusé": "Crafty",
    "Tenace": "Tenacious",
    "Chasseur": "Hunter",
    "Dernier Recours": "Last Resort",
};

const RARITY_ALIASES: Record<string, string> = {
    "Commun": "Common",
    "Rare": "Rare",
    "Légendaire": "Legendary",
    "Mythique": "Mythic",
    "Spécial": "Special",
};

const POSITION_ALIASES: Record<string, string> = {
    "Réserve": "Reserve",
    "Libéro": "Libero",
};

/**
 * "Progress" column → canonical status. EN/FR game labels
 * (traduction/*.json: declining / consideringRetirement) recognized by pattern;
 * empty cell or missing column (old CSVs) ⇒ "Improving". An unknown
 * value is treated as "Starting to decline" (non-improving ⇒ excluded
 * unless exceptional player) with a warning.
 */
const warnedUnknownProgress = new Set<string>();
function parseProgress(raw: string | undefined): Progress {
    const v = (raw ?? "").trim();
    const l = v.toLowerCase();
    if (!v || l.startsWith("improv") || l.startsWith("progress") || l.startsWith("en progr")) {
        return "Improving";
    }
    if (l.includes("retire") || l.includes("retraite")) return "Considering retirement";
    if (l.includes("declin") || l.includes("déclin")) return "Starting to decline";
    if (!warnedUnknownProgress.has(v)) {
        warnedUnknownProgress.add(v);
        console.warn(
            `⚠️  Unknown progress value "${v}" in the CSV: treated as "Starting to decline" ` +
            `(missing alias in playerParser.ts?).`
        );
    }
    return "Starting to decline";
}

/**
 * "Sign" / "Signe" column → canonical sign. Empty/missing (old CSVs)
 * ⇒ null (no chemistry modeled); unknown value ⇒ null + warning.
 */
const KNOWN_SIGNS = new Set<string>(ALL_SIGNS);
const warnedUnknownSigns = new Set<string>();
function parseSign(raw: string | undefined): Sign | null {
    const v = (raw ?? "").trim();
    if (!v) return null;
    const canon = SIGN_ALIASES[v] ?? v;
    if (KNOWN_SIGNS.has(canon)) return canon as Sign;
    if (!warnedUnknownSigns.has(v)) {
        warnedUnknownSigns.add(v);
        console.warn(`⚠️  Unknown sign "${v}" in the CSV: ignored (missing alias in signs.ts?).`);
    }
    return null;
}

const tr = (map: Record<string, string>, v: string) => map[v] ?? v;

/**
 * Safety net: a trait that is not in ALL_TRAITS after translation will
 * NEVER receive a bonus (the params do not know it). We warn once
 * per unknown name — typically a FR name missing from TRAIT_ALIASES.
 */
const KNOWN_TRAITS = new Set(ALL_TRAITS);
const warnedUnknownTraits = new Set<string>();
function warnIfUnknownTrait(trait: string): void {
    if (KNOWN_TRAITS.has(trait) || warnedUnknownTraits.has(trait)) return;
    warnedUnknownTraits.add(trait);
    console.warn(
        `⚠️  Unknown trait "${trait}" in the CSV: no bonus will be applied ` +
        `(missing French alias in playerParser.ts?).`
    );
}

/**
 * Parses the CONTENT of a player CSV (game export, EN or FR headers).
 * Handles quoted fields, the UTF-8 BOM, CRLF line endings and
 * empty lines. Pure (no disk access): usable in the browser.
 */
export function parseCSVText(text: string): Player[] {
    const raw = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
    const lines = raw.trim().split("\n").filter((l) => l.trim() !== "");
    if (lines.length === 0) throw new Error("empty CSV.");
    const header = lines[0].split(",").map((h) => {
        const trimmed = h.trim();
        return HEADER_ALIASES[trimmed] ?? trimmed;
    });

    const missing = ["First name", "Last name", "Roles"].filter((c) => !header.includes(c));
    if (missing.length) {
        throw new Error(
            `CSV: missing column(s): ${missing.join(", ")} ` +
            `(expected the in-game roster export, English or French headers).`
        );
    }

    return lines.slice(1).map((line: string) => {
        // Handle quoted fields
        const values: string[] = [];
        let current = "";
        let inQuotes = false;
        for (const char of line) {
            if (char === '"') {
                inQuotes = !inQuotes;
            } else if (char === "," && !inQuotes) {
                values.push(current.trim());
                current = "";
            } else {
                current += char;
            }
        }
        values.push(current.trim());

        const row: Record<string, string> = {};
        header.forEach((h: string, i: number) => (row[h] = values[i] ?? ""));

        const roles = (row["Roles"] || "")
            .split(";")
            .map((r) => tr(ROLE_ALIASES, r.trim()))
            .filter(Boolean);

        const traits = (row["Traits"] || "")
            .split(";")
            .map((t) => tr(TRAIT_ALIASES, t.trim()))
            .filter(Boolean);
        traits.forEach(warnIfUnknownTrait);

        const n = (key: string) => parseInt(row[key] ?? "0", 10) || 0;

        return {
            firstName: row["First name"],
            lastName: row["Last name"],
            fullName: `${row["First name"]} ${row["Last name"]}`,
            age: n("Age"),
            rarity: tr(RARITY_ALIASES, row["Rarity"]),
            // Academy: any "Acad…" variant (Académie, Academie, Academy…) — the
            // exact FR label has not been seen in an export yet.
            position: /^acad/i.test((row["Position"] ?? "").trim())
                ? "Academy"
                : tr(POSITION_ALIASES, row["Position"]),
            progress: parseProgress(row["Progress"]),
            roles,
            traits,
            sign: parseSign(row["Sign"]),
            ATTACK: n("ATTACK"),
            SETTING: n("SETTING"),
            RECEPTION: n("RECEPTION"),
            SERVE: n("SERVE"),
            BLOCK: n("BLOCK"),
            STAMINA: n("STAMINA"),
            setting: n("setting"),
            serve: n("serve"),
            spike: n("spike"),
            quick: n("quick"),
            power: n("power"),
            awareness: n("awareness"),
            attack: n("attack"),
            "back attack": n("back attack"),
            reception: n("reception"),
            overhand: n("overhand"),
            bump: n("bump"),
            block: n("block"),
            "read block": n("read block"),
            "commit block": n("commit block"),
            focus: n("focus"),
            defense: n("defense"),
            stamina: n("stamina"),
            reflex: n("reflex"),
        } as Player;
    });
}
