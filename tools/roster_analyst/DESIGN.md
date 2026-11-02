# Roster Analyst — règles du moteur

Documentation de référence du moteur d'analyse (en français, comme le rapport).
Pour l'utilisation, voir [README.md](./README.md).

Le moteur lit un CSV de joueurs + un `params.json` (profils par rôle + réglages) et produit
un rapport : classements par rôle, lineup 5-1 recommandé (titulaires / banc / réservistes +
chimie des signes + rotation réception/service des libéros), Academy & progression, points
faibles & filtre de recrutement, joueurs à vendre.

**Aucun profil n'est fourni** : chaque manager construit le sien (éditeur web → export
`params.json`). `example_params.json` est un template neutre (toutes les stats à 5, aucun
bonus) qui sert uniquement d'exemple et de test.

## Structure du code
- `src/analyze.ts` — orchestration (`runAnalysis`), sans dépendance Node : partagé par la CLI et le web.
- `src/cli.ts` — CLI Node (lecture des fichiers, sortie console + `--md`).
- `src/models/playerParser.ts` — `parseCSVText` : lecture du CSV (colonnes FR, alias de traits et de signes FR→EN).
- `src/config/` — `constants.ts` (libellés, stats, traits, constantes libéro, paires
  exclusives), `settings.ts` (**réglages utilisateur** : seuils, poids du MILP, quotas — bloc
  `settings` du params.json, défauts neutres), `roleConfig.ts` (`normalizeParams` /
  `parseParams`, `idealScore`, sous-profils libéro), `signs.ts` (signes, alias FR, matrice de
  chimie, seuils, effets libéro).
- `src/scoring/scorer.ts` — `scorePlayer`, `rankForRole`.
- `src/lineup/lineupBuilder.ts` — MILP mono-passe du 5-1 (titulaires + banc + réservistes)
  + optimisation exacte de la synergie des signes.
- `src/lineup/assignment.ts` — affectation max (algorithme hongrois) pour les bornes du
  branch & bound de la synergie.
- `src/lineup/signChemistry.ts` — modèle de chimie du terrain 5-1.
- `src/analysis/` — `availabilityAnalyzer` (Academy + progression → pool lineup),
  `academyAnalyzer`, `liberoRotationAnalyzer`, `weaknessAnalyzer`, `recruitmentAnalyzer`,
  `rosterBalanceAnalyzer`.
- `src/report/` — interface `Reporter`, `ConsoleReporter`, `MarkdownReporter`, `formatters`.
- `src/tools/verifyLineup.ts` — vérification du lineup builder contre une énumération
  exhaustive (`npm run verify-lineup -- <roster.csv> <params.json> [nbJoueurs] [graine]`).
- `web/` — application navigateur : `app.ts` (éditeur de params, import CSV, rendu du
  rapport), `worker.ts` (analyse dans un Web Worker), `schema.ts` (template neutre,
  import/export du params.json, aides), `build.mjs` (esbuild → `web/dist/`).

**Règle** : rien sous `src/` (hors `cli.ts` et `src/tools/`) ne doit dépendre de Node —
`npm run typecheck` le vérifie (le tsconfig web n'a pas les types Node).

## Réglages (`settings`)
Tout ce qui est un choix de l'utilisateur est dans `settings` (cf. `src/config/settings.ts`,
défauts dans `DEFAULT_SETTINGS`). Un réglage absent prend sa valeur par défaut ; une clé
inconnue ou d'un mauvais type est ignorée avec un avertissement.

| Réglage | Rôle |
|---|---|
| `balanceExponent` | exposant de la moyenne de puissance des stats (1 = moyenne pondérée) |
| `lineup.subObjectiveWeight` / `reserveObjectiveWeight` | λ / λᵣ du MILP 5-1 (0 < λᵣ < λ < 1) |
| `lineup.signSynergy` | optimisation exacte de la chimie des signes |
| `lineup.synergyTimeLimitSec` | garde-fou du branch & bound |
| `availability.declineExceptionalMinGain` | gain mini pour garder un « Starting to decline » |
| `academy.maxAge` | âge max (inclus) d'éligibilité à l'Academy |
| `libero.subMinDelta` | Δ mini pour conseiller la rotation des libéros |
| `roster.target` / `roster.targetCounts` | taille de roster visée et quota max par rôle |
| `recruitment.singletonTraits` / `singletonPriorityBonus` / `singletonTraitPositions` | traits « à un seul porteur » au recrutement |

Les constantes de **mécanique du jeu** (matrice des signes, seuils d'activation, +10 % de
victoire, paires exclusives, traits redondants, découpage réception/défense du libéro)
restent dans le code.

## Règles d'affichage & modélisation du rapport

- **Sections du rapport** (numérotées dynamiquement, la numérotation suit ce qui est
  réellement affiché) : 1. Classements par rôle · 2. Lineup 5-1 recommandé · 3. Academy &
  progression · 4. Points faibles + filtre de recrutement · 5. Gestion du roster — joueurs
  à vendre (si roster > `settings.roster.target` **ou** s'il y a des non-progressants à libérer). Tout le reste (6-2, lineup d'entraînement, comparatif des lineups,
  instructions de rotation / % de passe / tempo, profils tactiques, priorités
  d'entraînement, placement du libéro) a été **supprimé à la demande de l'utilisateur**.
- **Double sortie console + markdown** : `--md <fichier>` écrit en plus le rapport en
  markdown GitHub (`MarkdownReporter`, même contenu que la console via l'interface
  commune `Reporter`). L'application web affiche ce même markdown (rendu HTML) ; en CI on peut le publier dans
  le **job summary** (`$GITHUB_STEP_SUMMARY`), lisible sur mobile.
- **Markdown navigable par blocs repliables** (demande utilisateur) : chaque section
  numérotée est un `<details open>` avec son `<h2>` dans le `<summary>` (titre
  cliquable, repliable), et chaque sous-bloc (tables détaillées, rotation libéro,
  recrutement…) un `<details>` replié par défaut avec son **verdict résumé dans le titre**.
- **Tableau RÉCAPITULATIF du lineup (saisie en jeu)** : toujours visible en tête de la
  section 5-1 — une ligne par position (ordre terrain), colonnes Titulaire /
  Remplaçant (avec Δ) / Rés. blessure. Les tables détaillées (rareté, scores) restent
  dessous (repliées en markdown).
- **Pas de texte méthodologique dans le rapport** (demande utilisateur) : c'est CE
  fichier qui documente les règles. Ne garder dans le rapport que les données, verdicts
  et légendes de symboles courtes.
- **Ordre des positions terrain** : titulaires, banc et réservistes sont affichés dans
  l'ordre de service — 1 Setter · 2 Front OH · 3 Front MB · 4 Opposite · 5 Back OH ·
  6 Back MB · 7 Libéro (`getFiveOneOrder` / `getFiveOneSubSlots`, `lineupBuilder.ts`).
- **MILP du 5-1** (`LineupBuilder`) : sélection conjointe titulaires (poids 1), banc
  (λ = `settings.lineup.subObjectiveWeight`) et réservistes (λᵣ = `settings.lineup.reserveObjectiveWeight`, 0 < λᵣ < λ < 1),
  domination à 2 étages titulaire ≥ remplaçant ≥ réserviste par rôle, slots à `max: 1`
  (un rôle sans éligible laisse le slot vide au lieu de rendre le modèle infaisable).
  **Ordre avant/arrière** en post-traitement : Front OH ≥ Back OH (meilleur attaquant
  devant), Back MB ≥ Front MB (meilleur bloqueur sur la ligne du passeur). L'ancien swap
  « placement du libéro » (`receptionOptimizer`) qui pouvait inverser ces paires pour la
  réception a été **abandonné** (demande utilisateur).
- **Disponibilité pour la lineup** (`availabilityAnalyzer`, demande utilisateur) : sont
  **exclus** des classements, du 5-1, des points faibles et du recrutement :
  - les joueurs `Position = Academy` (toute variante « Acad… », ex. FR « Académie ») ;
  - les joueurs dont la colonne `Progress` (FR « Progression ») ≠ `Improving` :
    `Considering retirement` (FR « Envisage la retraite ») **sans exception** (ne progresse
    plus : le faire jouer est du gâchis, on laisse jouer les jeunes) ; `Starting to decline`
    (FR « Début de déclin ») **sauf s'il est exceptionnel** = sa présence augmente la somme
    des scores des 7 titulaires du 5-1 (MILP, effets de cascade compris) d'au moins
    `settings.availability.declineExceptionalMinGain` vs la meilleure lineup sans lui (valeur =
    somme des scores + valeur de la synergie des signes) (chaque déclinant
    évalué seul face à la base « Improving »).
  Valeurs FR vérifiées sur un export réel : « En progression », « Début de déclin ».
  Colonne `Progress` absente/vide (anciens CSV) ⇒ `Improving` ; valeur inconnue ⇒ traitée
  comme déclin + avertissement.
- **Academy** (`academyAnalyzer`) : éligible ⇔ âge ≤ `settings.academy.maxAge`. On reconstruit
  le 5-1 sur le pool disponible + les joueurs Academy éligibles ; un jeune **titulaire ou
  remplaçant** (banc — un réserviste ne compte pas) de cette lineup hypothétique doit
  **sortir** de l'Academy (slot visé + occupant actuel affichés) ; un joueur Academy au-delà de cet âge
  sort dans tous les cas ; un joueur actif éligible (âge) hors titulaires/banc doit **entrer** à
  l'Academy. La lineup de la section 5-1 reste celle de l'état actuel (Academy exclue).
- **Libérations prioritaires** (`rosterBalanceAnalyzer`, param `forced`) : les
  `Considering retirement` et les `Starting to decline` non exceptionnels sont listés **en
  tête** des joueurs à vendre (motif affiché), hors MILP, même si le roster ne dépasse pas la cible ; le MILP à
  quotas ne départage ensuite que les autres (pénuries de rôle signalées seulement s'il y a
  des ventes « quota »).
- **Chimie des signes** : sous-bloc « Chimie des signes » de la section 5-1 (non numéroté,
  verdict « unités/9 · ≈ +x % de victoire » dans le titre) : signe (FR ; effet libéro entre
  parenthèses), chimie par phase, effet actif, connexion passeur. Absent si le CSV n'a pas
  de colonne `Sign`/`Signe`. Un remplaçant au Δ **positif** = joueur au meilleur score
  individuel laissé sur le banc pour la chimie.
- **Réservistes (mécanique de blessures du jeu)** : 3ᵉ étage après le banc — un
  réserviste par slot, le joueur qui monte au banc quand le titulaire est blessé (son
  remplaçant entrant alors dans le six de base). Un slot remplaçant vide ⇒ slot
  réserviste vide.
- **Gestion du roster à quotas souples** (`rosterBalanceAnalyzer`) : la sélection des
  `settings.roster.target` joueurs à garder est un MILP à contraintes `max` (au plus N joueurs par rôle :
  `settings.roster.targetCounts` ; chaque joueur sur au
  plus 1 rôle) qui maximise d'abord le **nombre de gardés** (`KEEP_BONUS`) puis la somme
  des scores. Si un rôle manque d'éligibles, le modèle reste **faisable** : les slots
  vacants sont réattribués aux meilleurs joueurs restants tous rôles confondus
  (« flex »), la pénurie est affichée par rôle, et la **liste des joueurs à vendre est
  toujours produite**.
- **Rotation du 2ᵉ libéro (substitution réception / service)** (`liberoRotationAnalyzer.ts`) :
  le jeu permet de faire entrer/sortir le 2ᵉ libéro selon la **phase** (réception = on
  reçoit le service ; service = on sert puis on défend/digge). On compare nos 2 libéros
  retenus (titulaire du 5-1 + son remplaçant « Remp. Libéro ») sur **deux sous-profils
  séparés** dérivés de la config libéro (`deriveLiberoReception` / `deriveLiberoDefense`,
  `roleConfig.ts`) : un profil **RÉCEPTION** (sous-stats `LIBERO_RECEPTION_SUBSTATS` =
  `reception` + communes) et un profil **DÉFENSE** (`LIBERO_DEFENSE_SUBSTATS` = `defense`
  + communes). Côté stats **seules `reception` et `defense` discriminent** ; toutes les
  autres sous-stats (overhand, bump, awareness, focus, stamina, reflex, setting) sont
  **communes** aux deux phases. Les **traits sont différenciés** :
  `LIBERO_RECEPTION_ONLY_TRAITS` = Guardian (masqué du profil défense — « meilleures stats
  de réception ») ; `LIBERO_DEFENSE_ONLY_TRAITS` = Defensive Specialist (« pas la réception
  service ») + Last Resort (dig de sauvetage, masqués du profil réception). Les traits
  partagés (Master Mind 1ʳᵉ/2ᵉ touche, Quick Learner, Overachiever, Vigorous, traits
  d'équipe) comptent dans les deux. On en déduit le **meilleur receveur** et le **meilleur
  défenseur** ; verdict selon `settings.libero.subMinDelta` (échelle 0-99) : `system`
  (spécialisation nette dans les 2 phases → rotation réception/service conseillée),
  `situational` (nette dans 1 seule phase), `none` (un libéro domine les 2 phases, ou
  écarts négligeables → garder le meilleur global), `single` (un seul libéro retenu).
  Sous-bloc rattaché à la section 5-1 (non numéroté).
- **Recrutement — 3 signes** (`selectSigns`) : pour chaque signe, sur chacun des 3 rôles
  ciblés, on remplace le titulaire le plus faible du rôle par une recrue de même score
  portant ce signe ; apport = bonus de signe du rôle (normalisé 0-99) + variation des unités
  de chimie des titulaires × valeur d'une unité (même calibrage que le 5-1). Top 3.
- **Recrutement (règle utilisateur)** : les 3 rôles prioritaires cumulent le moins bon
  score normalisé du titulaire le plus faible et le plus gros gap de banc
  (`urgence = shortage×1e6 + (100 − score) + benchDelta`, le manque d'effectifs prime).
  Les 3 traits recommandés sont choisis **conjointement par MILP** (`selectTraitTrio`) :
  le trio qui maximise l'apport cumulé (somme des `traitBonuses`, atténuée si déjà
  couverts ≥ 2× dans la lineup) aux 3 rôles ciblés, avec pénalité de recouvrement pour
  les paires redondantes (`REDUNDANT_TRAIT_GROUPS`, ex. Meteor/Float Serve) — pas un
  simple top 3 trait par trait.
- **Score courant = performance du jour, sans rareté ni progression** (stats + traits +
  signe) : `RARITY_COEFF`
  puis le terme `alpha·(cap − statScore)` ont été **supprimés à la demande de
  l'utilisateur**. `scorePlayer` = stats + traits normalisés, point — la rareté n'affecte
  pas le score (rankings, MILP 5-1, rotation libéro, recrutement, gestion du roster : tous
  comparables).
- **Alias FR des 9 nouveaux traits** (`playerParser.ts`) : traductions à confirmer en
  jeu ; tout trait non reconnu après traduction déclenche un avertissement « trait
  inconnu » (sinon son bonus serait perdu silencieusement).

## Signes & chimie (mécanique officielle, source jeu)

- **Chimie d'un joueur** = Σ sur chaque coéquipier sur le terrain de son côté (zone libéro
  comprise) de +1 (il aime le signe), −1 (n'aime pas), 0. Matrice **non symétrique**
  `signs.ts` (lignes = joueur, colonnes = coéquipier, Aries → Pisces). Effets à partir du
  niveau de compte 20. Remplacements = la chimie change en cours de match.
- **Effet du signe** actif si chimie ≥ 3 (`SIGN_ACTIVATION_THRESHOLD`). **Passeur** : aucun
  effet de signe ; connexion renforcée avec l'attaquant si chimie(passeur) + chimie(attaquant)
  ≥ 3 (`SETTER_SYNERGY_THRESHOLD`). **Libéro** : effet propre selon le groupe de son signe
  (Taurus/Leo/Scorpio/Aquarius = récupération d'énergie sur réception/dig parfait ;
  Gemini/Virgo/Sagittarius/Pisces = réflexes ; Aries/Cancer/Libra/Capricorn = prend toutes
  les balles disputées).
- **Synergie parfaite = +10 % de chance de victoire** (`SIGN_SYNERGY_MAX_WIN_GAIN`).

| Signe | Effet (joueur hors passeur/libéro) |
|---|---|
| Aries | sur un kill, retire les buffs non permanents adverses |
| Taurus | se fait moins avoir par les feintes au contre |
| Gemini | ses feintes attirent plus les contreurs |
| Cancer | rattrape toujours tip/dump/down ball à sa portée |
| Leo | contre plus de tips, transforme des touches en stuffs |
| Virgo | toutes stats ↑ aux balles de set/match et tie-break |
| Libra | face au contre, tipe plus, tips plus durs à contrer/digger |
| Scorpio | réduit l'efficacité des contreurs engagés sur lui |
| Sagittarius | moins de fautes de service |
| Capricorn | place mieux services et attaques |
| Aquarius | 3 attaques connectées d'affilée ⇒ la suivante passe et frappe plus fort |
| Pisces | ses traits se déclenchent plus souvent |


### Modélisation
- **Score** (`scorePlayer`) : `signBonuses[rôle][signe]` s'ajoute brut (comme un trait) ;
  `idealScore` inclut le meilleur bonus de signe du rôle. Poids à garder **léger** : c'est la valeur de l'effet *supposé actif* ; l'activation dépend des
  coéquipiers et relève du lineup builder.
- **Terrain 5-1 en 2 phases** (½ chacune, `signChemistry.ts`) : le libéro remplace le MB
  arrière, les 2 MB ne sont jamais ensemble → phase A = Setter, 2 OH, OP, Front MB, Libéro ;
  phase B = idem avec Back MB. **Unités** par phase (max 9) : 5 activations (non-passeurs)
  + 4 connexions passeur ↔ attaquant (OH, OP, MB).
- **Lineup builder — résolution EXACTE** (demande utilisateur : fiable plutôt que rapide).
  Objectif F = Σ scores titulaires + V·unités(titulaires) + λ·(score + synergie d'entrée) des
  remplaçants + λᵣ·score des réservistes, avec V = 10 % × Σ scores des titulaires du MILP de
  base / 9 (synergie parfaite = +10 % de la valeur des titulaires). La chimie étant
  quadratique, la linéariser dans le MILP joint ne termine pas (> 2 min sans solution) ; une
  recherche locale a été essayée puis **abandonnée** (optimum non garanti, prouvé sous-optimal
  sur un roster réel). Méthode retenue (`optimizeSignSynergy`) :
  1. MILP de base sans synergie + recherche locale ⇒ solutions de départ ;
  2. **branch & bound** sur les 7 titulaires avec bornes supérieures valides : affectation
     optimale (algorithme hongrois, `assignment.ts`) titulaires restants + banc (bonus d'entrée
     max) + réserve sans domination, et borne de chimie (meilleur signe encore disponible par
     relation ; énumération exacte quand ≤ 2 slots libres) ; symétrie des 2 OH / 2 MB cassée ;
  3. à chaque feuille, banc + réserve **exacts** : affectation hongroise, puis MILP joint si
     la domination remplaçant ≥ réserviste n'est pas respectée.
  Vérifié contre une énumération exhaustive (titulaires × MILP du banc) sur des sous-rosters.
  Temps : ~10-80 s par lineup, ~1-3 min par rapport ; résultats mis en cache par pool
  (la base des déclinants = lineup principale). Garde-fou `settings.lineup.synergyTimeLimitSec` :
  au-delà, meilleure lineup trouvée + avertissement « optimalité non prouvée ».
  La **domination titulaire ≥ remplaçant est levée** quand il y a des signes (le Δ > 0 d'un
  remplaçant signale un joueur écarté pour la chimie). Le remplaçant/réserviste suit son
  titulaire lors des swaps avant/arrière. `settings.lineup.signSynergy = false` désactive tout.

## Effets des traits (mécaniques officielles, source jeu)

Référence pour calibrer les `traitBonuses` du params.json. La colonne « Mécanique »
décrit le **déclenchement réel** (et non une saveur marketing) ; c'est elle qui fixe les rôles
qui en profitent.

| Trait | Mécanique exacte | Profite surtout à |
|-------|------------------|-------------------|
| **Master Mind** | Chance de se déclencher sur la **1ʳᵉ ou 2ᵉ touche** de l'équipe si un joueur impliqué a le trait. Donne un bonus à **toutes les actions suivantes jusqu'à ce que le ballon franchisse le filet**. Un seul bonus Master Mind actif à la fois. | **Setter** (2ᵉ touche systématique) **et Libéro/réceptionneur** (1ʳᵉ touche très fréquente) |
| **Moving Wall** | En zone avant, si l'adversaire **directement en face** attaque, participe **toujours** au contre + chance de réagir aux attaques qui passeraient ; bonus au contre quand déclenché. Hors face-à-face : chance décroissante (et d'autant plus faible que le contre est déjà nombreux). | Middle Blocker, Opposite (bloc côté droit), Setter avant |
| **Surprise Attack** | **En tant que passeur** : joue plus souvent la **2ᵉ main**, plus dure à anticiper. **En tant qu'attaquant** : smash plus dur à contrer. Quand déclenché, **ne fait face qu'à 1 contreur au plus**. | **Setter** (2ᵉ main), Middle Blocker (quick), Opposite, Outside Hitter |
| **Marksman** | Se déclenche **sur les attaques ET les services**. Léger bonus à l'action + permet de **viser le défenseur le plus faible**. | Outside Hitter, Opposite (frappeurs) ; appoint pour tout serveur |
| **Meteor Serve** | Quand déclenché, le service devient un **service sauté** : bonus à l'action, **+chance d'ace**, **−chance de faute**. | Opposite, Outside Hitter (serveurs de puissance). **Pas le libéro.** |
| **Vigorous** | Chance, **à chaque action**, de la réaliser **sans dépenser d'énergie**. | Joueurs à fort volume d'actions sur 6 rotations : Setter, OH, Libéro |
| **Guardian** | Si le porteur a de **meilleures stats de réception** que le joueur sur le point de recevoir, chance de **prendre l'action à sa place** (meilleur RCV prioritaire, un seul prend le ballon). | Libéro (top), Outside Hitter (bon receveur) ; **contre-productif setter** (le sortirait de sa planque RCV) |
| **Float Serve** | Quand déclenché, service flottant : bonus le rendant **plus dur à recevoir** + fait intervenir **d'autres stats** chez le réceptionneur. | Tout serveur (Setter, OH, OP). **Pas le libéro.** Redondant avec Meteor (cf. `REDUNDANT_TRAIT_GROUPS`). |
| **Defensive Specialist** | Chance, en **défendant un smash puissant OU en posant un contre**, d'avoir un bonus (à forces égales) ou une meilleure réussite (adversaire supérieur). **Ne s'applique PAS à la réception service.** | Libéro (dig), Outside Hitter (dig) **ET Middle Blocker / Opposite (contre)** |
| **Quick Learner** | Après **3 bonnes réceptions / digs / passes d'affilée**, la touche suivante (récep/dig/passe) **ne peut pas rater** et sort en **action critique**. Une touche ratée/faible remet le compteur à 0. | **Libéro** (volume récep+dig max → construit la série) **et Setter** (passe quasi systématique) ; OH (récep+dig). Pas MB/OP (peu de touches défensives, pas de passe) |
| **Momentum Addict** | **Démarre avec un malus d'attaque.** Chaque attaque **sans faute** monte la puissance (un kill encore plus), jusqu'à un cap. Une **faute d'attaque** remet au malus de départ. | Gros volume d'attaques **fiable** : Outside Hitter, Opposite ; MB (quick). **Négatif/nul** au Setter (peu d'attaques → reste au malus) et **inutile au libéro** (n'attaque jamais). |
| **Loudmouth** | Chance, quand le joueur **marque en zone avant au smash ou au contre**, de **saper l'adversaire en face** : toutes ses actions affaiblies pendant **3 échanges** (ne cumule pas, réappliquer relance le timer). | Attaquants/contreurs avant : Opposite, Middle Blocker, Outside Hitter. **Pas le libéro** (jamais en avant). |
| **True Leader** | Chance, quand **un coéquipier sur le terrain rate une action (hors contre)**, de le **stabiliser** : sa prochaine action ne peut pas rater et ses debuffs sont purgés. | Trait **d'équipe** ~uniforme (dépend de la présence sur le terrain) : tous les titulaires. |
| **Overachiever** | Chance, en **contrant / réceptionnant / diggant une attaque ou un service plus fort**, de **hausser sa propre action jusqu'au niveau de celle subie**. Réservé aux **raretés Mythic et en dessous**. | Défenseurs face au feu : **Libéro** (récep+dig), Outside Hitter, Middle Blocker & Opposite (contre). Appoint Setter (contre). |
| **Crafty** | Chance, sur **ses services et attaques**, de faire **dépenser de l'énergie en plus** à l'adversaire qui suit ses actions. Quand ça se déclenche, **Vigorous ne peut pas se déclencher**. | Serveurs/attaquants à volume : OH, OP, MB, Setter (sert chaque rotation). **Nul au libéro** (ne sert ni n'attaque). Anti-synergie partielle avec Vigorous non modélisée (les deux restent additifs : périmètres différents). |
| **Tenacious** | Si l'équipe a **perdu ≥ 3 points d'affilée**, **tous les coéquipiers** reçoivent un bonus à toutes leurs actions, **croissant** avec le nb de points perdus. Disparaît dès un point gagné. | Trait **d'équipe** anti-passage-à-vide ~uniforme (présence sur le terrain) : tous les titulaires. |
| **Hunter** | Chance, **au service**, de **cibler le setter (ou l'opposite) adverse** et de le mettre **hors système** (bonus au service) : attaque de la cible réduite pour l'échange, et **Guardian ne peut pas prendre la réception** à sa place. Service **overhand/float** atteint le setter partout ; **service sauté** ne cible que la rangée arrière. | Serveurs : Opposite, Outside Hitter, **Setter** (sert chaque rotation ; float/overhand atteint le setter partout → synergie). Pas MB moins. **Nul au libéro** (ne sert jamais). |
| **Last Resort** | Chance, quand la touche d'un coéquipier **allait perdre l'échange**, pour **le LIBÉRO** de la digger et de la renvoyer en **free ball** (échange sauvé). Seulement si le dig serait une touche légale et que le libéro n'a pas fait le contact précédent. | **Libéro uniquement** (mécanique liée au poste). **0 partout ailleurs.** |

## Calcul du score (`scorePlayer`)
- **Base = 18 attributs minuscules uniquement.** Les clés MAJUSCULES (ATTACK, SETTING,
  RECEPTION, SERVE, BLOCK, STAMINA) sont une **agrégation déterministe** de leurs sous-stats
  minuscules (vérifié par régression sur 50 joueurs, R² 0.98–1.00) : les pondérer dans
  `statsWeights` en plus des minuscules serait du **double comptage**. Ne pas remettre de
  poids majuscules dans le params.json (un garde-fou les ignore + avertit). Les composites
  restent utilisés par `weaknessAnalyzer` (stats faibles affichées), pas pour le score.
- **Normalisation cross-rôle** : le score final est rescalé à `~0-99` par rôle via
  `score / idealScore(rôle) × 99`, pour que les notes soient **comparables entre rôles**
  (sans ça, les rôles avec plus de bonus de traits avaient un plafond plus haut).
  `idealScore` = `99 + somme des 4 meilleurs traits du rôle` (4 = max de traits, rareté Special).
- **Ni rareté ni terme de progression dans le score** (`applyRarityScore` et
  `DEFAULT_ALPHA` supprimés) : le score reflète la performance du jour.
- **Moyenne de puissance** (`settings.balanceExponent` = p) : part stats = (Σ wᵢ·statᵢᵖ)^(1/p),
  poids normalisés. p = 1 ⇒ moyenne pondérée classique ; p < 1 pénalise les stats basses
  (favorise les profils équilibrés).
- **Paires de stats exclusives (pair-max)** (`EXCLUSIVE_STAT_PAIRS`, appliqué dans
  `computeRawScores`) : dans une
  action réelle une seule des deux stats joue, donc quand les deux sont pondérées par
  le rôle, **seule celle de plus forte valeur chez le joueur garde son poids** (l'autre
  est retirée avant normalisation) :
  - `read block` / `commit block` (règle utilisateur : le score de bloc prend le max) —
    à égalité read gagne (compétence principale). Des poids asymétriques
    (read > commit) font scorer un lecteur un peu mieux qu'un committer à valeurs égales.
  - `quick` / `power` (règle utilisateur : **aucun tempo privilégié par rôle**, un MB
    peut attaquer en passe haute) — à égalité power gagne. Pour
    qu'aucun style ne soit structurellement avantagé, donner le même poids à quick et power.

## Formules des composites (reverse-engineering, validé sur 117 joueurs)
Les 6 attributs MAJUSCULES sont des **moyennes pondérées globales** des attributs minuscules.
Version affinée sur **117 joueurs** (révèle des termes `max/min` sur ATTACK et BLOCK) :

| Composite | Formule |
|-----------|---------|
| STAMINA   | `stamina` |
| SERVE     | `0.85·serve + 0.075·awareness + 0.075·attack` |
| SETTING   | `0.75·setting + 0.10·overhand + 0.075·attack + 0.075·awareness` |
| RECEPTION | `0.75·reception + 0.15·bump + 0.055·defense + 0.015·overhand + 0.015·focus + 0.015·reflex` |
| ATTACK    | `0.55·spike + 0.20·max(power,quick) + 0.05·min(power,quick) + 0.10·back attack + 0.05·attack + 0.05·awareness` |
| BLOCK     | `0.65·block + 0.20·max(read block,commit block) + 0.05·min(read block,commit block) + 0.04·defense + 0.04·focus + 0.02·reflex` |

Les poids somment à ≈ 1 → vraies moyennes pondérées.

### ⚠️ Les composites ne servent qu'au SCORE D'AFFICHAGE — pas à modéliser le jeu
Confirmé par le développeur : les 6 notes MAJUSCULES sont une **synthèse affichée** pour donner
une idée aux joueurs qui ne veulent pas creuser. **Le jeu réel fonctionne par SEUILS de
sous-stats qui débloquent des actions** (ex. un overhand suffisant débloque tel tempo de passe).
Conséquence directe sur les `statsWeights` :
- **Ne PAS répartir les poids selon les coefficients des formules ci-dessus.** Une sous-stat à
  faible coefficient d'affichage (ex. `overhand` = 10 % de SETTING) peut être **fonctionnellement
  critique** parce qu'elle garde la porte d'une action clé.
- On calibre **par fonction réelle du poste** : pour chaque sous-stat, qu'est-ce qu'elle
  débloque/porte dans le job du rôle ? On charge fort les stats qui *gardent la porte* des actions
  importantes. Le scorer étant une moyenne pondérée (pas de vrai seuil dur), on **approxime un
  seuil par un poids élevé** sur la stat déclencheuse.
- Les formules composites restent utiles au **score d'affichage** seulement.

### Constats validés
- **Agrégation linéaire.** Les termes carrés ne sont jamais retenus utilement (gain LOO nul,
  poids ≈ 0) → pas de non-linéarité. 3 composites sont parfaitement linéaires (R² > 0.9996).
- **Formule globale, PAS par rôle.** La cross-validation montre que caler par rôle ne fait pas
  mieux que global (souvent pire) ; le « gain par rôle » observé sur un petit échantillon était
  du surapprentissage. **Conséquence : les joueurs multi-rôles suivent la même formule que tout
  le monde** (ils sont même légèrement mieux prédits).
- **`reflex` quasi absent des composites** : ~1,5 % dans RECEPTION, ~2 % dans BLOCK, nul ailleurs.
  Ne pas en conclure qu'il est inutile : son **effet gameplay réel** (réaction défense/dig,
  débloqué par seuil) n'est pas reflété dans la note d'affichage — il garde donc un poids
  fonctionnel non négligeable dans les `statsWeights` des postes défensifs.
- **Anomalies irréductibles** : quelques joueurs isolés ne suivent aucune formule (ex. un ATTACK de 63 alors que toutes les
  sous-stats sont ≥ 74 — mathématiquement impossible pour une moyenne positive ; d'autres écarts
  de ~8-9 points sur ATTACK ou BLOCK).
  Aucune stat, terme carré ou rôle ne les explique → incohérences de données côté jeu. C'est ce
  qui maintient la MAE d'ATTACK/BLOCK à ~1 au lieu de ~0.2.

## Descriptions officielles des sous-stats (source jeu)
Référence de calibrage des `statsWeights`. C'est cette table qui a motivé le pair-max
read/commit block et quick/power.

| Sous-stat | Effet officiel |
|---|---|
| setting | Qualité des passes + capacité à mener un jeu rapide (tempo Rapide) |
| serve | Force du service ; haut niveau = débloque services sautés et plus d'aces |
| spike | Puissance et précision des attaques normales |
| quick | Attaque sur passes rapides et basses |
| power | Attaque sur passes hautes et balles lentes |
| awareness | Fréquence des attaques/services/passes **exceptionnels** + fréquence des dumps du passeur avant |
| attack | **Force** de ces actions exceptionnelles (attaques, services, dumps) |
| back attack | Contribue à la note d'attaque **en rangée arrière** |
| reception | Qualité de réception des services et digs ; bas = ciblé par les serveurs adverses |
| overhand | Passe à deux mains hautes : utilisée pour passer ET recevoir les services flottants |
| bump | Manchette : contre les services durs et pour digger les smashes |
| block | Force de contre au filet |
| read block | Lecture de la passe pour former/timer le contre — **compétence principale de contre** |
| commit block | Engagement sur un attaquant désigné — **ne s'applique que si le bloc dédié est configuré** |
| focus | Chance de produire un dig ou un contre **exceptionnel** (le pendant défensif d'awareness) |
| defense | Qualité des digs et sauvetages |
| stamina | Endurance : fatigue, taux d'erreur, récupération sur le banc |
| reflex | Réaction aux balles rapides : services durs, dumps du passeur, attaques surprises |

## Méthode de calibrage des profils (par fonction)
Les `statsWeights` de chaque rôle sont calibrés **par fonction réelle du poste** (cf. section
composites), pas par les coefficients d'affichage. Pour chaque rôle on liste ses actions (attaque
avant/arrière, réception, dig, bloc, service, passe de secours…), puis on charge les sous-stats
qui gardent la porte de ces actions. Les `traitBonuses` suivent les **mécaniques exactes** des
traits (1ʳᵉ/2ᵉ touche pour Master Mind, 2ᵉ main pour Surprise Attack côté setter, contre pour
Defensive Specialist, etc.).


## Format du params.json
```jsonc
{
  "traitWeight": 1,            // multiplie tous les traitBonuses (appliqué au chargement)
  "settings": { ... },         // cf. section Réglages (facultatif, défauts sinon)
  "roles": {                   // setter, outsideHitter, middleBlocker, oppositeHitter, libero
    "setter": {
      "statsWeights": { "setting": 10, ... },   // 18 sous-stats minuscules, échelle libre
      "traitBonuses": { "Master Mind": 0, ... }, // points ajoutés au score de stats 0-99
      "signBonuses":  { "Aries": 0, ... }        // valeur de l'effet du signe (supposé actif)
    }
  }
}
```
Un `traitBonus` s'ajoute **brut** au score de stats normalisé (~0-99) : un bonus de 10 ≈
+10-14 % de score → significatif mais non écrasant.
