# @astrolabe/data-pipeline

Daten-Pipeline für den Spieldaten-Katalog (F-01, WS1). Sie baut aus dem
gepinnten Path of Building (PoE2) einen **Roh-Snapshot**, vergleicht zwei
Snapshots und bildet einen Snapshot auf die Katalog-Verträge
(`@astrolabe/contracts/catalog`) ab, geprüft gegen die Schemas. Das
Veröffentlichen als Daten-Release folgt in einem eigenen PR.

## Ablauf

1. `tools/setup_pob.sh` installiert PoB-PoE2 (Release-Tag) und LuaJIT nach `.pob/`.
2. `snapshot` startet `lua/extract.lua` in PoB. Das Skript lädt PoBs eigene
   Datenmodule (kein Lua-Parsing per Regex) und schreibt je Art eine JSON-Datei.
   Welche Module zu welcher Art gehören, steht in
   `config/data-pipeline/pob-sources.json`. Eine neue Datendatei in einem
   PoB-Release ist damit eine Konfigurationsänderung, kein Code.
3. `manifest.json` hält Release-ID (`poe2-<spielversion>+r<n>`), PoB-Version,
   Tree-Version, SHA-256 je Datei und die Hashes von Konfiguration und
   Extraktor.
4. `diff` vergleicht zwei Snapshots je Art: neu, entfernt, geändert mit
   Feldpfaden als JSON-Pointer (Form wie `CatalogDiff` im Vertragspaket).

```bash
tools/setup_pob.sh
pnpm --filter @astrolabe/data-pipeline build
node apps/data-pipeline/dist/cli.js snapshot --game-version 0.5 --revision 1 --out data-snapshots/poe2-0.5+r1
node apps/data-pipeline/dist/cli.js diff data-snapshots/alt data-snapshots/poe2-0.5+r1
```

`data-snapshots/` ist git-ignoriert. In GitHub Actions baut
`.github/workflows/data-snapshot.yml` den Snapshot (bei PRs als Smoke-Test,
per „Run workflow" mit Spielversion und optionalem Vergleich gegen einen
älteren PoB-Tag) und lädt ihn als Artefakt hoch.

## Arten im Roh-Snapshot

| Art                | Quelle in PoB                                                           | ID                                                    |
| ------------------ | ----------------------------------------------------------------------- | ----------------------------------------------------- |
| `itemBases`        | `Data/Bases/*.lua`                                                      | Basis-Name (PoB führt keine Metadata-ID für Basen)    |
| `mods`             | `Data/Mod*.lua`, Feld `domains` = Herkunftsdatei (Dateiname ohne `Mod`) | Mod-ID des Spiels                                     |
| `runes`            | `Data/ModRunes.lua`                                                     | Name                                                  |
| `essences`         | `Data/Essence.lua`                                                      | Metadata-ID                                           |
| `gems`             | `Data/Gems.lua`                                                         | Metadata-ID                                           |
| `skills`           | `Data/Skills/*.lua` (ohne `SkillAssets.lua`)                            | Granted-Effect-ID                                     |
| `statDescriptions` | `Data/StatDescriptions/*.lua` (Auswahl in der Konfig)                   | `<scope>:<index>`, mit `tradeHash` (PoBs `HashStats`) |
| `uniques`          | `main.uniqueDB` (von PoBs Item-Parser gelesen)                          | `Titel, Basis`                                        |
| `passiveTree`      | `TreeData/<version>/tree.lua`                                           | Knoten-ID; `group:<id>`, `class:<name>`, `constants`  |

Regeln des Extraktors:

- Ausgabe ist deterministisch (sortierte Schlüssel, festes Zahlenformat), damit
  Hashes und Diffs stabil sind.
- Funktionen, Zyklen und NaN/Unendlich brechen die Extraktion ab. Einzige
  Ausnahme: `skills` enthält PoBs Rechenfunktionen; dort steht sichtbar
  `"$lua-function"`.
- Dieselbe ID aus zwei Quellen ist nur erlaubt, wenn der Inhalt identisch ist
  (z. B. ein Mod für Flasks und Charms); sonst Fehler.
- `uniques` und `passiveTree` übernehmen eine feste Feldauswahl (siehe
  Loader in `lua/extract.lua`); neue PoB-Felder dort erscheinen erst nach
  Anpassung des Loaders im Snapshot und im Diff. Alle anderen Arten werden
  vollständig übernommen.
- `SkillType`-Werte werden als Namen ausgegeben, nicht als PoB-interne Zahlen.
- Eine leere Art, ein Glob ohne Treffer oder ein Snapshot mit falschem Hash ist
  ein Fehler, nie ein leeres Ergebnis.

## Stat-IDs für Mods

PoB führt Mods nur als Anzeigetext. `src/normalize/stat-matcher.ts` bildet
den Text auf Stat-IDs und Rohwerte zurück, ausschließlich mit PoB-Daten:

1. Jeder Mod nennt in `tradeHashes` PoBs Hash über die Stat-IDs einer
   Beschreibung. Darüber ist die Beschreibung eindeutig, auch wenn zwei
   Beschreibungen gleichen Text haben (z. B. lokal und global).
2. Der Text wird gegen die Vorlagen dieser Beschreibung geprüft; Handler wie
   `negate` oder `milliseconds_to_seconds` werden umgekehrt, Limits geprüft.
3. Wie PoB gilt nur die erste Variante, deren Limits passen.
4. Rundet die Anzeige (z. B. `per_minute_to_per_second_0dp`) so, dass mehrere
   Rohwerte denselben Text ergeben, ist die Zeile `lossy` und bleibt offen.
5. Zeilen ohne Hash laufen über einen Text-Index. Mehrdeutige, verlustbehaftete
   oder nicht passende Zeilen bleiben je Mod in `unresolved` sichtbar, nichts
   wird geraten.

`astrolabe-data stat-coverage <snapshot> [--out unresolved.json]` meldet die
Abdeckung. Stand PoB 0.23.1: 86,5 % der Zeilengruppen, 85,7 % der Mods voll
aufgelöst. Offen: 741 `hidden` (Text ohne Zahl, z. B. reine Effekt-Zeilen; der
Stat-Wert ist darin nicht sichtbar, die Stat-IDs stehen dabei), 435 ohne
passende Beschreibung (vor allem Radius-Jewel-Mods, deren Hash einen
Zusatz-Stat enthält), 138 verlustbehaftet gerundet, 14 mehrdeutig.

## Katalog aus dem Snapshot

```bash
node apps/data-pipeline/dist/cli.js catalog data-snapshots/poe2-0.5+r1 --out data-snapshots/catalog
```

`catalog` normalisiert den Roh-Snapshot (`src/normalize/catalog.ts`), prüft
jede Entität gegen ihr Vertragsschema, eindeutige IDs und alle Referenzen
(`src/normalize/validate.ts`) und schreibt je Art eine `CatalogShard`-Datei
plus `manifest.json` (`CatalogManifest`). Steuerung über
`config/data-pipeline/normalize.json` (Anzeigesprache, Stat-Scopes, Knotenarten,
Mod-Stufen, Eigenschaftsgruppen); nichts davon ist im Code an eine Spielversion
gebunden.

Release-Fakten für S5 und S7 im `DataRelease` (siehe unten zu `itemSlots`): `maxCharacterLevel` (höchste Stufe der
Game-Data-Tabelle aus `releaseFacts.maxLevelTable`, Ursprung `game-data`; nur mit
`--game-data <dir>`) und `passivePoints` (Hauptbaum-Punkte je Stufe als Regel aus
PoB-Code, Ursprung `pob-code`; Waffensatz-Punkte je Akt aus PoB `QuestRewards.lua`,
Ursprung `pob-data`). `passivePoints.ascendancy` (Gesamtgrenzen 8 und 8 aus PoBs `Build.lua`, `releaseFacts.ascendancy`, Ursprung `pob-code`, keine Aufteilung je Akt) hängt am selben Faktum; wann die Punkte vergeben werden, wird nicht gelesen (Finding `ascendancyByAct`: PoBs Daten haben kein Feld, die Spalte `AscendancyPointsRewarded` in `QuestStaticRewards` ist im dat-Schema unbenannt und für das Tool nicht exportierbar). Gibt PoB keine Quest-Belohnung mit Punkten an, entfällt `passivePoints` ganz, auch `ascendancy`. Was nicht gelesen werden kann, fehlt im Release und steht als
Warnung in `findings.json`, nie als `0`.

`classifications` (Schadensarten und Verteidigungsschichten, Ursprung `pob-code`): die Namen stehen in
`releaseFacts.classifications` (aus PoBs `dmgTypeList` und `resourceList`), die Release-IDs sind die Namen in
Snake-Case und müssen als Mod-Tags im Release vorkommen. Fehlt eines, entfällt das Feld und eine Warnung nennt
die fehlenden Tags.

`itemSlots` listet die Ausrüstungsplätze in PoBs Reihenfolge mit PoBs Slot-Namen
(wie in `EquippedItem.slot`). Was ein Slot annimmt, fragt der Extraktor bei PoBs
eigener Slot-Prüfung ab: `itemClasses` sind Klassen, von denen PoB jede Basis nimmt,
`partialBases` Basen aus Klassen, die PoB nur teilweise nimmt (Lebens- und
Manaflaschen, Arme und Beine). Die Nebenhand hängt in PoB vom Gegenstand in der
Haupthand ab (`dependsOnSlot`); ihre Klassen sind die Vereinigung über alle Zustände.
`optional` markiert Slots, die PoB nur unter einer Build-Bedingung zeigt (Ring 3).
Klassen, die kein Slot annimmt (Juwelen, Fallen-Werkzeuge), stehen als Warnung in
`findings.json`. Juwelen-Sockel stehen nicht in der Liste.

Währungen, Essenzen und Omen (nur mit `--game-data <dir>`, `src/normalize/currency.ts`):
`CurrencyItems`-Zeilen der Item-Klassen aus `currency.itemClasses` (normalize.json)
werden zu `baseItem`-Einträgen. ID = `BaseItemTypes.Id` (Metadaten-Pfad des Spiels;
anders als die namensbasierten PoB-IDs der Ausrüstung), Klasse = `ItemClasses.Id`.
Eigenschaften: `stackSize`, `useType`, bei gestuften Währungen `currencyTier` und
`minimumModLevel`, bei Essenzen `essenceTier`. Tags (Wortschatz in der Config): `currency_action:<Action>`,
`exchange_category:<Kategorie>`, `lower_tier:<ID der niedrigeren Stufe>`, `essence`,
`perfect`, `omen`. Mit `currency.includeExchangeItems` (an) kommt außerdem jedes Item dazu, das die
Börsenliste des Spiels (`CurrencyExchange`) führt, egal welcher Klasse (Runen, Uncut-Gems,
Idole, Fragmente, Seelenkerne …; Tag `exchange_category:<Kategorie>`, keine Eigenschaften
außer Drop-Level). Andere Klassen (Inkubatoren …) bleiben
draußen und stehen mit Anzahl als Warnung in `findings.json`; ein Fremdschlüssel ins
Leere oder eine doppelte ID ist ein Fehler. Offen: was eine Essenz bewirkt
(`Essences.UpgradeResult`) ist nicht abgebildet, bis die Crafting-Operation dafür
festgelegt ist.

Essenzen als Crafting-Aktionen (`src/normalize/essence.ts`, nur mit `--game-data`):
Je PoB-Essenz (Schlüssel = Metadaten-Pfad = ID der Währungs-Basis) entsteht eine
`craftingAction` (`kind` und Op aus `normalize.json` `essence`; Op `add-specific-mod`
mit `modByItemClass`; Name und Form mit dem Crafting-Thread abgesprochen, umgesetzt wird sie in `packages/crafting-sim`). Aufgenommen werden nur
Einträge, deren Basis, Item-Klasse und Mod im Release existieren; alles andere steht
als Befund (`kind: essence`) in `findings.json`. Eine Essenz ohne brauchbaren Eintrag
erzeugt keine Aktion. Aktionsname = PoB-Name (die Basis trägt den Namen aus den Game-Data). Rarität: PoB nennt keine Regel, deshalb setzt die Pipeline keine; der Simulator muss eine
fehlende Raritätsregel als unkalibriert behandeln (Anforderung an die Op-Umsetzung). `validate.ts` prüft Basis, Item-Klassen und Mod-IDs der Aktion.

IDs (Ausrüstung, Uniques, Gems, Mods aus PoB-Daten; Währungen aus den Game-Data-Tabellen, siehe ADR-0005):

| Art                   | ID                                            |
| --------------------- | --------------------------------------------- |
| Mod                   | PoB-Mod-ID                                    |
| Basis                 | Name der Basis (Ausrüstung)                   |
| Währung, Essenz, Omen | `BaseItemTypes.Id` (Metadaten-Pfad)           |
| Unique                | `Titel, Basis`                                |
| Gem                   | Spiel-ID des Gems                             |
| Passive               | numerische Knoten-ID (als Text)               |
| Passiv-Gruppe         | PoB-Gruppen-ID (als Text)                     |
| Klasse / Aufstieg     | Name bzw. PoB-interne Aufstiegs-ID            |
| Stat-Text             | Beschreibungs-ID aus PoBs Stat-Beschreibungen |

Tree-Geometrie (wie PoBs `Classes/PassiveTree.lua`): Jede Passive bekommt
`position.point` (Baum-Einheiten, y nach unten) aus Gruppenmitte,
`constants.orbitRadii` und `constants.orbitAnglesByOrbit` (`ProcessNode`).
`arcs` hält die Bögen aus `BuildConnector` mit Mittelpunkt und Radius (immer
der kürzere Bogen): Verbindungen mit Orbit ≠ 0 bei Abstand unter dem
Durchmesser, und Verbindungen mit Orbit 0 auf demselben Orbit derselben
Gruppe (Bogen um die Gruppenmitte). Alles andere zeichnet PoB gerade,
auch Verbindungen mit einem Orbit, den die Konstanten nicht kennen
(PoB-Platzhalterwert); das ist kein Befund. Wie PoB zeichnen Renderer keine
Verbindung in einen Klassenstart oder zwischen verschiedenen Aufstiegsklassen.
Reine Bildknoten (`isOnlyImage`) heißen `decoration` und haben wie in PoB
keine Verbindungen. `passiveGroup` hält Gruppenmitte und Orbit-Radien nur für
die Darstellung; die ID ist PoBs Layout-Index und wird von Builds nie
referenziert. Gespeicherte Werte sind auf 0,001 gerundet (Zwischenwerte nicht).
Fehlen die Konstanten, ist das ein Fehler; kann ein Knoten nicht platziert
werden, eine Warnung mit Grund, und er bleibt ohne `point` (nie `0,0`).

`findings.json` enthält:

- `errors`: fehlender Pflichtwert in PoB (nie durch `0` oder `""` ersetzt),
  Vertragsverstoß, doppelte ID, kaputte Referenz (auch Unique-Varianten). Der
  Lauf bricht ab; es werden keine Katalogdateien und kein Manifest geschrieben.
- `warnings`: Daten, die PoB nicht eindeutig hergibt, sichtbar statt geraten:
  Basis-Implicits ohne genau einen passenden Mod (z. B. „Grants Skill"-Zeilen),
  Baum-Verbindungen zu fehlenden Knoten, Startknoten unbekannter Klassen,
  Unique-Zeilen mit nicht vorhandenen Varianten, Aufstiege ohne Knoten.
- `unresolved`: offene Stat-Zeilen von Passiven mit Grund (zusätzlich tragen Passive,
  Mods und Uniques `unresolved` selbst, seit contracts 0.8.0).
- `hiddenStatGroups`: Mods mit Stats, deren Beschreibung keinen Text erzeugt.
- `summary`: Zählung aller offenen Zeilen je Art und Grund und von allem, was
  nicht in den Katalog übernommen wird (Mods ohne Generierungsart, von PoB zur
  Laufzeit interpolierte Gem-Werte, weitere Stat-Sets, Gem-Stufenfelder ohne
  Platz im Vertrag wie Kosten, übersprungene Stat-Text-Varianten).

Gem-Stufen enthalten unter `stats` nur Stat-IDs mit wörtlichen Werten aus dem
ersten Stat-Set von PoB plus dessen konstante Stats.

Stand PoB 0.23.1: 0 Fehler, 479 Warnungen, rund 2,5 s. Offene Stat-Zeilen:

| Art                      | unmatched | ambiguous | lossy | hidden |
| ------------------------ | --------- | --------- | ----- | ------ |
| Mod                      | 411       | 14        | 138   | 741    |
| Unique (von 4167 Zeilen) | 603       | 93        | 54    | 335    |
| Passive                  | 131       | 555       | 25    | 467    |

Bei Uniques fehlen PoB Trade-Hashes; mehrdeutig ist vor allem lokal gegen
global (gleicher Text), nicht passend sind v. a. PoB-eigene Zeilen wie
„Grants Skill: …" (117 von ursprünglich 1476) und Radius-Zeilen von Juwelen (25); die 874
„Allocates …"-Zeilen sind seit Release r5 zugeordnet (871).
„Allocates" nennt einen Passiv-Knoten beim Namen; der Vertrag hat dafür kein Feld an
Unique-Mods (inzwischen: `allocatesNodeId`, contracts 0.7.0). Die Pipeline ordnet
solche Zeilen über `uniqueLines.allocatesPattern` (Konfiguration) dem Knoten mit genau
diesem Namen zu und zählt sie in `uniqueLinesAllocatingNode`; ein unbekannter oder
mehrfach vergebener Name (alle Knotenarten zählen) bleibt `ambiguous` mit Warnung und
Knoten-IDs, nichts wird geraten; ein unbekannter Name bleibt `unmatched`. Erwartet für PoB
0.23.1: 872 von 874 Zeilen zugeordnet. `validateCatalog` prüft, dass der Knoten
existiert. Genauso ordnet `uniqueLines.grantsPattern` Zeilen „Grants Skill: <Name>" dem
Gem mit genau diesem Namen zu (`grantsGemId`, contracts 0.9.0, Zähler
`uniqueLinesGrantingSkill`); Der Stufenbereich („Level (1-20)") steht nur im `text`, nicht im Feld. Ein mehrfach
vergebener Name wird `ambiguous` mit Warnung; ein unbekannter Name oder mehrzeiliger Text
geht an den Stat-Matcher (normalerweise `unmatched`). Erwartet für Release r6: 111 von 117 Zeilen.

Eine mehrdeutige Unique-Zeile wird nach Beleg aus den Daten aufgelöst: Eine Beschreibung
zählt, wenn ein Mod mit einem ihrer Stats auf der Basis des Uniques spawnen kann. Dabei
gilt PoBs Regel (`Item.lua`, `GetModSpawnWeight`): der erste Tag der Gewichtsliste, den die
Basis hat, bestimmt das Gewicht; 0 heißt kein Spawn. Genau ein Treffer entscheidet, kein
oder mehrere Treffer lassen die Zeile mehrdeutig. Der Beleg ist indirekt (ein Stat, den es
nur auf Uniques gibt, hat keinen), deshalb zählt `uniqueLinesDisambiguated` in der
Zusammenfassung von `findings.json` jede so getroffene Entscheidung. Die Zahlen in der
Tabelle oben sind der Stand von Release r6 (Disambiguierung seit r4: 401 von 492 mehrdeutigen Zeilen
aufgelöst; vorher 492).

## Knoten mit Freischaltbedingung

PoB markiert manche Knoten des normalen Baums mit `unlockConstraint = { ascendancy, nodes }`: Sie
sind nur wählbar, solange die genannten Knoten belegt sind (heute 200 Knoten: 197 mit Präfix `oracle_`,
freigeschaltet durch den Oracle-Knoten 5571, und drei mit mehreren Knoten und ohne Ascendancy). Der Katalog führt das als `PassiveNode.unlockedBy`.
Eine Bedingung, die nicht lesbar ist (unbekannte Ascendancy, leere oder fehlende Knoten), ist ein
Fehler: Der Knoten würde sonst ohne Bedingung angeboten, und PoB lehnt ihn beim Allozieren ab.

## Spiel-IDs für den `.build`-Export

Mit `--game-data` setzt `catalog` `PassiveNode.gameId` (`PassiveSkills.Id`) und
`itemSlots.slots[].gameId` (`Inventories.Id`); `DataRelease.gameIds.origin` ist
dann `game-data`. Konfiguration: Block `gameIds` in `config/data-pipeline/normalize.json`,
Tabellen in `game-data.json` (Pflichttabellen, fehlen sie, bricht der Lauf ab).

- **Passive:** Tabellenzeile mit gleicher Knoten-ID (`PassiveSkillGraphId`, bei PoB
  `PassiveSkillNodeId`) und gleichem Namen (ohne Markup `[a|b]`, Groß-/Kleinschreibung und
  Leerraum egal). Keine Zeile, mehrere Zeilen oder anderer Name: kein Feld, gezählt in
  `summary.gameIds.passivesWithoutGameId` und in den Findings. Zeilen ohne PoB-Knoten sind kein Fehler.
- **Slots:** feste Zuordnung PoB-Slot-Name → Inventory-Id in der Konfiguration (`slots.map`).
  Ein Eintrag mit unbekannter Inventory-Id ist ein Fehler; nicht zugeordnete Slots (Flasks,
  Charms, Arme, Beine) bekommen keine ID und stehen in den Findings; das Finding nennt zusätzlich die `Inventories`-Zeilen, die keinem Slot zugeordnet sind, als Beleg für eine spätere geprüfte Zuordnung. Zugeordnet sind nur Slots, deren Inventory-Zeile
  gleich heißt; `Weapon 2` und die Swap-Slots bleiben offen, bis die Zuordnung im Spiel geprüft ist.
- Eine `gameId` darf in einem Release nur einmal vorkommen (Fehler sonst).

## Seltenheiten und Währungsaktionen

- **Seltenheiten** (`DataRelease.rarities`, Herkunft `pob-code`): Namen und Affix-Summen stehen in
  PoBs Code (`Item.lua`: magisch 2, selten 6), in `releaseFacts.rarities` der Konfiguration. Die
  Summe wird gleichmäßig auf die Generationstypen verteilt (Prefix, Suffix); geht sie nicht auf oder
  fehlt ein Typ, entfällt das Feld mit Finding. Je Seltenheit kann `affixLimitByItemClass` die Summe
  für eine Item-Klasse ersetzen (heute: seltene Juwelen 4, wie in PoBs `Item.lua`); das landet als
  `maxAffixesByItemClass` im Release. Eine Klasse ohne Basis-Item im Katalog ist ein Fehler (der Lauf bricht ab).
  Nicht abbildbar: PoBs Ausnahme für verderbte Abyss-Juwelen (6 statt 4); es gibt heute keine
  Abyss-Basen. Die Aktionen übernehmen die Grenzen zur Laufzeit (`limitsByRarity`) aus
  Seltenheit und Klasse des Items.
- **Währungsaktionen** (`currencyActions` in `normalize.json`): Eine Währung wird nur dann zur
  `CraftingAction`, wenn ihr `CurrencyItems.Action`-Schlüssel eine Regel hat **und** die Beschreibung
  des Spiels (ohne Markup) zum Muster der Regel passt. Sonst bleibt sie draußen und steht in den
  Findings. Höhere Stufen (`TieredCurrency.Tier` > 1 oder mit `LowerTierBaseItemType`) werden eigene
  Aktionen; ihre hinzugefügten Mods brauchen mindestens `TieredCurrency.MinimumModLevel`
  (`minModLevel` im Simulator). Ohne diesen Wert bleibt die Stufe draußen. Regeln ohne Treffer, Actions ohne Regel und Währungen
  ohne Katalog-Item stehen ebenfalls in den Findings. Regeln nutzen nur Ops von `crafting-sim`; ein Test prüft das gegen dessen
  Vokabular. Heute: Transmutation, Augmentation, Regal, Exalted, Chaos, Annulment, Scouring, Alchemie.
- **Essenzen** bekommen ihre Regel nur, wenn ihre eigene Beschreibung zu einer der Essenz-Regeln
  passt (normale: magisch → selten; Perfect: entfernt einen Mod einer seltenen Essenz und fügt den
  garantierten Mod hinzu); damit ist `add-specific-mod` im Simulator nicht mehr `uncalibrated`.
- Bekannte Lücken: Annulment und Scouring nennen keine Seltenheit und wirken damit auch auf
  einzigartige Items; keine Regel verbietet Flags (z. B. verderbt); Mods von Juwelen liegen in einer
  anderen Domäne als `Item` (Konfiguration der Aktionen); Juwelen-Crafting bleibt deshalb
  unkalibriert, auch wenn die Grenze stimmt. Items mit eigenen Grenzen fehlen.
- Findings `no-rule-text`: der Spieltext (ohne Markup) der ersten Währung je Action ohne Regel, dessen Text das Stichwort
  aus `currencyActions.evidence` trifft (Stichwort, Zeichen- und Eintragsgrenze stehen in der Config;
  Kürzungen sind mit „…“ und „(+N more not shown)“ markiert). Das ist der Beleg für neue Regeln, statt sie zu raten.
- Nicht abgebildet: Orb der Alteration (Text nennt keine Anzahl),
  alles, was keine Modänderung ist.

## Crafting-Daten aus den Update-Servern

PoB kennt Währungen und Omens nicht und Essences nur zum Teil. Christian hat am
25.11.2026 freigegeben, dafür (und nur dafür) Tabellen der Spieldaten zu
lesen. Das passiert **ausschließlich in CI** (GitHub Actions), nie auf dem
Rechner des Nutzers und ohne Spielclient:

```bash
node apps/data-pipeline/dist/cli.js gamedata --out data-snapshots/current/game-data
```

1. `src/gamedata/patch.ts` fragt den Update-Server nach der aktuellen
   Patch-Version (Host, Port und Handshake stehen in
   `config/data-pipeline/game-data.json`).
2. `pathofexile-dat` (MIT, fest gepinnt) liest die dort gelisteten Tabellen
   und Spalten aus den Daten-Bundles des Patches, je Tabelle ein Lauf. Die
   Spaltenlayouts stammen aus dem Community-Schema dat-schema; dessen Hash steht
   im Manifest.
3. `<out>/<Tabelle>.json` (Zeilen mit `_index` und den konfigurierten Spalten)
   und `manifest.json` mit Patch, Werkzeugversion, SHA-256 und Zeilenzahl je
   Tabelle. `readGameDataTable` prüft Hash und Zeilenzahl beim Lesen.

Eine Tabelle mit `"required": false`, die der Patch nicht enthält, steht unter
`missing` im Manifest und wird nirgends ersetzt. Alles andere (fehlende
Pflichttabelle, fehlende Spalte, falsche `_index`-Folge, Werkzeugfehler,
Zeitüberschreitung) bricht ab. Stand Patch 0.5.5.10: `Omens` fehlt, die
Omen-Basen stehen in `AchievementOmenTypes`.

## Rechtliches

PoB ist MIT-lizenziert; die Spieldaten darin sind © Grinding Gear Games. Der
Snapshot enthält nur Daten aus PoB, **keine Grafiken**: Icon- und Bildfelder
bleiben Pfadangaben, Tree-Grafiktabellen (`assets`, `ddsCoords` usw.) werden
verworfen. Ob und wie Icons in den Katalog kommen, wird separat entschieden.

## Tests

`pnpm --filter @astrolabe/data-pipeline test`. Diff, Konfiguration, Job und
Snapshot-Prüfung laufen mit synthetischen Daten. Der Integrationstest gegen
das echte PoB läuft nur, wenn `.pob/` existiert (lokal nach
`tools/setup_pob.sh` und im Workflow `data-snapshot.yml`), sonst wird er als
übersprungen gemeldet.

## Daten-Release veröffentlichen

`.github/workflows/data-release.yml` (nur per Hand von `main`, `workflow_dispatch`) baut
Snapshot, Game-Data und Katalog wie `data-snapshot.yml` (inklusive der Pipeline-Tests
gegen echtes PoB) und veröffentlicht den Katalog als GitHub-Release mit Tag
`data-poe2-<Version>-r<n>` (die Release-ID im Manifest ist `poe2-<Version>+r<n>`; im
Tag und in Dateinamen steht `-` statt `+`), standardmäßig als Pre-Release. Anhang:
`catalog-<ID>.tar.gz` (Shards, `manifest.json`, `findings.json` mit den offenen Stellen)
und seine SHA-256-Datei. Zwei Jobs: der Build läuft mit Lesezugriff, nur der
Veröffentlichen-Job hat Schreibrechte und führt nur die GitHub-CLI aus. Eingaben werden
geprüft; `game-version` muss der Patch-Version des Update-Servers entsprechen, und
ein vorhandener Tag oder ein vorhandenes Release wird nie überschrieben. Rohtabellen der
Game-Data gehören nicht ins Release (ADR-0005). Mit der Eingabe `previous-tag` (Tag des vorigen Daten-Releases) hängt der Lauf
`diff.json` (`CatalogDiff`) an den Katalog und trägt `previousReleaseId` und `diffPath`
im Manifest ein. Der Befehl dafür ist `catalog-diff <von> <nach>` (Katalog-Ordner,
Shard-Hashes werden geprüft; gleiche Arten auf beiden Seiten sind Pflicht). Der Befehl
`diff` vergleicht dagegen zwei Roh-Snapshots.

## Patch-Watcher (F-01, Day-0)

`.github/workflows/patch-watch.yml` läuft stündlich und ruft `astrolabe-data patch-watch` auf. Der Befehl vergleicht
den Spielpatch, den der Update-Server meldet, mit den veröffentlichten Daten-Releases dieses Repos und das neueste
PoB-PoE2-Release mit dem Pin (`config/data-pipeline/watch.json`: Repo, Pin-Datei, Muster). Gibt es etwas zu tun
(Exit-Code 3), legt der Workflow ein Issue mit dem Label `patch-watch` an oder aktualisiert es und schließt es, sobald
alles erledigt ist.

- Neues PoB-Release: Pin anheben, Golden Builds in CI vergleichen, danach „Data release“ starten.
- Neuer Spielpatch ohne neues PoB-Release: Der Watcher kann nicht wissen, ob das gepinnte PoB den Patch schon
  abdeckt (Pin früher angehoben, Fix-Release für den alten Patch). Er fragt deshalb nach den Release-Notes: Deckt es
  den Patch ab, „Data release“ starten; sonst **Katalog-only**: ein Daten-Release würde PoB-Daten eines älteren
  Patches tragen und darf nicht als vollständig veröffentlicht werden (Projektplan, „Grenzen und Umgang damit“).
- Als Daten-Release zählt, was auch die App lädt: veröffentlicht, mit Katalog- und Prüfsummen-Asset; Pre-Releases
  zählen mit (wie `includePrereleases` der App). Es werden die ersten 100 Releases gelesen.
- Der Plan sah einen automatisch geöffneten PR für den Pin vor. Der Watcher öffnet bewusst nur ein Issue: ein PR
  aus dem Workflow löst keine CI aus, und der Pin gehört erst nach dem Golden-Build-Vergleich angehoben.
- Ein dauerhaft fehlschlagender Lauf zeigt sich nur als roter Lauf; GitHub schaltet geplante Workflows nach 60 Tagen
  ohne Repository-Aktivität ab.

Der Watcher meldet nur. Pin-Anhebung und Veröffentlichung bleiben Entscheidungen von Menschen: Daten-Releases sind
unveränderlich, und ein PoB-Wechsel braucht den Vergleich der Golden Builds.

## Item-Grafiken (F-30, ADR-0007)

`astrolabe-data item-art <snapshotDir> --game-data <dir> --out <dir>` liest je Basis-Item des
Snapshots das Inventarbild (`ItemVisualIdentity.DDSFile`) aus den Patch-Bundles und schreibt
PNGs plus `index.json` (Name → Datei, `failed` mit Grund). Nur in CI; braucht ImageMagick
(`magick`). Der Werkzeuglauf bricht beim ersten nicht umwandelbaren Bild ab, deshalb wird ein
fehlschlagender Lauf halbiert, bis die einzelnen Dateien feststehen. Mehr als
`itemArt.maxFailedShare` (`game-data.json`) ohne Bild lässt den Schritt scheitern.
`catalog --item-art <dir>` setzt `BaseItem.icon` (`assets/items/<datei>`) und kopiert die Bilder
ins Release; ohne Bild bleibt das Feld leer und `findings.json` nennt es.
