/**
 * CSV parser for player data
 */

import { Player, Progress, Sign } from "../types";
import { ALL_TRAITS } from "../config/constants";
import { ALL_SIGNS, SIGN_ALIASES } from "../config/signs";

/**
 * Correspondance des en-têtes CSV français (jeu traduit) vers les clés
 * canoniques anglaises utilisées en interne. La casse distingue les stats
 * composites (MAJUSCULES) des sous-stats (minuscules), ex. CONTRE→BLOCK vs
 * contre→block. Les en-têtes anglais restent supportés (passthrough).
 */
const HEADER_ALIASES: Record<string, string> = {
    "Prénom": "First name",
    "Nom": "Last name",
    "Âge": "Age",
    "Rareté": "Rarity",
    "Rôles": "Roles",
    "Progression": "Progress",
    "Signe": "Sign",
    // Stats composites (MAJUSCULES)
    "ATTAQUE": "ATTACK",
    "PASSE": "SETTING",
    "RÉCEPTION": "RECEPTION",
    "SERVICE": "SERVE",
    "CONTRE": "BLOCK",
    "ENDURANCE": "STAMINA",
    // Sous-stats (minuscules)
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
    // "Position" et "Traits" sont identiques en FR/EN.
};

/**
 * Correspondance des valeurs de cellules françaises (jeu traduit) vers les
 * valeurs canoniques anglaises attendues par le reste du code. Les en-têtes
 * étant traduits ci-dessus, les valeurs le sont aussi : rôles, traits,
 * raretés et positions. Les valeurs anglaises restent supportées (passthrough).
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
    // Nouvelle vague de traits — noms FR à confirmer en jeu. Un nom FR non
    // reconnu déclenche l'avertissement « trait inconnu » ci-dessous plutôt
    // que d'ignorer silencieusement le bonus.
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
 * Colonne « Progress » → statut canonique. Libellés EN/FR du jeu
 * (traduction/*.json : declining / consideringRetirement) reconnus par motif ;
 * cellule vide ou colonne absente (anciens CSV) ⇒ « Improving ». Une valeur
 * inconnue est traitée comme « Starting to decline » (non-improving ⇒ exclue
 * sauf joueur exceptionnel) avec un avertissement.
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
            `⚠️  Progression inconnue « ${v} » dans le CSV : traitée comme « Starting to decline » ` +
            `(alias manquant dans playerParser.ts ?).`
        );
    }
    return "Starting to decline";
}

/**
 * Colonne « Sign » / « Signe » → signe canonique. Vide/absente (anciens CSV)
 * ⇒ null (aucune chimie modélisée) ; valeur inconnue ⇒ null + avertissement.
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
        console.warn(`⚠️  Signe inconnu « ${v} » dans le CSV : ignoré (alias manquant dans signs.ts ?).`);
    }
    return null;
}

const tr = (map: Record<string, string>, v: string) => map[v] ?? v;

/**
 * Garde-fou : un trait qui n'est pas dans ALL_TRAITS après traduction ne
 * recevra JAMAIS de bonus (les params ne le connaissent pas). On avertit une
 * fois par nom inconnu — typiquement un nom FR absent de TRAIT_ALIASES.
 */
const KNOWN_TRAITS = new Set(ALL_TRAITS);
const warnedUnknownTraits = new Set<string>();
function warnIfUnknownTrait(trait: string): void {
    if (KNOWN_TRAITS.has(trait) || warnedUnknownTraits.has(trait)) return;
    warnedUnknownTraits.add(trait);
    console.warn(
        `⚠️  Trait inconnu « ${trait} » dans le CSV : aucun bonus ne sera appliqué ` +
        `(alias FR manquant dans playerParser.ts ?).`
    );
}

/**
 * Parse le CONTENU d'un CSV de joueurs (export du jeu, en-têtes EN ou FR).
 * Gère les champs entre guillemets, le BOM UTF-8, les fins de ligne CRLF et
 * les lignes vides. Pur (pas d'accès disque) : utilisable dans le navigateur.
 */
export function parseCSVText(text: string): Player[] {
    const raw = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
    const lines = raw.trim().split("\n").filter((l) => l.trim() !== "");
    if (lines.length === 0) throw new Error("CSV vide.");
    const header = lines[0].split(",").map((h) => {
        const trimmed = h.trim();
        return HEADER_ALIASES[trimmed] ?? trimmed;
    });

    const missing = ["First name", "Last name", "Roles"].filter((c) => !header.includes(c));
    if (missing.length) {
        throw new Error(
            `CSV : colonne(s) manquante(s) : ${missing.join(", ")} ` +
            `(export roster du jeu attendu, en-têtes anglais ou français).`
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
            // Academy : toute variante « Acad… » (Académie, Academie, Academy…) — le
            // libellé FR exact n'a pas encore été vu dans un export.
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
