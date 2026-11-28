# @astrolabe/contracts

Einzige maßgebliche Quelle für die Datenformen von Astrolabe (Leitprinzip
„Verträge zuerst", Skill `contract-first`). Zod-Schemas, daraus abgeleitete
TS-Typen (`z.infer`) und generierte JSON-Schema-Dateien unter `schemas/`.
Andere Pakete koppeln nur hierüber; Änderungen laufen als eigener Vertrags-PR.

## Inhalt (v0.3)

| Export                         | Inhalt                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Konsumenten                         |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| `@astrolabe/contracts/common`  | Katalog-IDs (gebrandet je Art), `DataReleaseId`, `PobVersion`, `CalcProfileId`, `CalcId`, Herkunft `Source`, `sourced()`, `measured()`, `CalcRef`                                                                                                                                                                                                                                                                                                                       | alle                                |
| `@astrolabe/contracts/catalog` | `BaseItem`, `Mod`, `UniqueItem`, `Gem`, `PassiveNode` (mit `position.point` und `arcs`), `PassiveGroup`, `CharacterClass`, `Ascendancy`, `CraftingAction`, `StatTranslation`, `DataRelease`, `CatalogManifest`, `CatalogShard`, `CatalogDiff`                                                                                                                                                                                                                           | data-pipeline, catalog-sdk, ui      |
| `@astrolabe/contracts/calc`    | `CalcResult`, `PatchOp`, `CalcMethods` (JSON-RPC: `meta.version`, `build.*`, `calc.*`), `parseCalcParams`, `parseCalcResult`                                                                                                                                                                                                                                                                                                                                            | calc, calc-client, optimizer        |
| `@astrolabe/contracts/build`   | `BuildRequest` (S0), `BuildState`, `ItemSpec`, `RichText`, Stufen-Ergebnisse `SkillProfile` (S1), `ArchetypeCandidate`/`ArchetypeEvaluation` (S2/S3), `TargetBuild` (S5), `ProgressionPlan` (S6), `GearPlan` (S7), `CraftingPlan` (S8), `Finding` (mit `returnTo` für den gezielten Rücksprung), `ValidationReport` (S10)                                                                                                                                               | agents, optimizer, crafting-sim, ui |
| `@astrolabe/contracts/guide`   | `GuideDocument` mit den 11 Pflichtbausteinen des Plans, `PublishedGuide` (S11, nur mit bestandenem Prüfbericht), `PatchStatus` (F-19: Revalidierung eines Guides gegen ein neues Daten-Release; Urteil folgt aus den Befunden), `GuideTools` (`guide.revalidate`: nur IDs als Eingabe, nie Pfade), `GuidePatchStatusView` (Antwort von `GET /api/guides/patch-status`: Stand der automatischen Neuprüfung gespeicherter Guides, `enabled: false` heißt „nicht geprüft“) | agents, exporters, ui               |
| `@astrolabe/contracts/forge`   | MCP-Werkzeuge `forge.attach/next/submit/ask_user/status`, `ForgeTask`, `ForgeStep`, `UserIntervention`                                                                                                                                                                                                                                                                                                                                                                  | server, mcp-bridge, llm-gateway     |
| `@astrolabe/contracts/economy` | `PriceBook`, `PriceQuote`, Werkzeug `economy.price` (liefert auch `fetchedAt`, `freshness` fresh/stale und bei stale `refreshError`; Preise als `measured`: `market`, bei Umrechnung `derived`; Items per `PricedItemRef` (Basis oder Unique))                                                                                                                                                                                                                          | economy, server, crafting-sim       |
| `@astrolabe/contracts/craft`   | `CraftSimRequest`/`CraftSimResult`, `CraftStrategy`, `CraftGoal`, Werkzeug `craft.simulate`                                                                                                                                                                                                                                                                                                                                                                             | crafting-sim, server, agents        |
| `@astrolabe/contracts/events`  | `RunEvent` (Live-Status per SSE, `seq` je Lauf)                                                                                                                                                                                                                                                                                                                                                                                                                         | server, web                         |

Fehlende Quelldaten werden nicht erfunden: `BaseItem.dropLevel` und
`Ascendancy.pointUnlocks` sind optional; Mod-Zeilen, deren Werte sich nicht
eindeutig bestimmen lassen, stehen in `unresolved` (Grund `unmatched`,
`ambiguous`, `lossy` oder `hidden`). Support-Kompatibilität bekommt ein
eigenes Ausdrucksschema (UND/ODER über Skill-Typen).

Bekannte Lücken: Der Katalog kennt noch keine Bosse und keine
Atlas-Passives; `bossMechanics` und die Atlas-Strategie sind deshalb vorerst
`RichText` mit optionalem `EntityRef`. Kommen diese Entitäten ins Daten-Release,
wird `EntityKind` per Vertrags-PR erweitert. Der Zahlen-Linter muss neben
`text`-Segmenten auch Titel, Stufen-Labels und `forge.ask_user`-Fragen
prüfen.

Noch offen: IPC Electron-Main ⇄ Renderer, Teilen-Datei `.astrolabe.json`,
`.build`-Export (eigene Vertrags-PRs, sobald die Konsumenten feststehen).

## Zahlen in KI-Ausgaben

Alles, was die KI schreibt, ist `RichText`: Segmente `text`, `calc`
(Verweis auf eine Zahl eines PoB-Ergebnisses) und `entity` (Katalog-ID). Es
gibt kein Zahlen-Segment. Kosten, Chancen und Preise sind `measured()`;
Die erlaubte Herkunft ist je Größe eingeschränkt
(`measuredFrom`): Preise nur `market`/`derived`, Chancen und Versuche nur
`gamedata`/`derived`, Verhältnisse wie „Gewinn pro Kosten" nur `derived`.
Rechenergebnisse von Zuständen sind `CalcOutcome` (`ok` mit `calcId` oder
`failed`). Ob in `text`-Segmenten freie Zahlen stehen, prüft der Zahlen-Linter
in den Gates. Mindestanzahlen (Stufen, Varianten) kommen aus `config/`, das
Schema verlangt nur „nicht leer".

## Regeln im Schema

- **IDs statt Namen.** Katalog-IDs sind die internen Spiel-IDs aus dem
  Daten-Release, je Entitätsart gebrandet (`GemId` ist kein `ModId`).
- **Patch-agnostisch.** Spielklassifikationen (Item-Klasse,
  Mod-Generierungstyp, Gem-Art, Knotenart, Tags, Attribute) sind offene
  `ClassificationId`-Strings aus dem Daten-Release, keine Enums. Welche
  PoB-Stats es gibt, ist ein offenes `StatMap`; welche die UI zeigt, steht in
  `config/`. Crafting-Wirkungen sind deklarative Regeln (`op` + `params`),
  deren Vokabular `packages/crafting-sim` besitzt.
- **Keine Zahl ohne Herkunft.** `Source` ist `pob` (mit PoB-Version,
  Daten-Release, Calc-Profil, Rechen-ID), `gamedata`, `market` oder `derived`
  (Formel-ID, Version, Eingaben, ggf. Seed). Fehlende Werte sind über
  `measured()` ausdrücklich `uncalibrated` oder `failed`, nie `0`.
- **Vorwärtskompatibel lesen.** Katalog-Objekte verwerfen unbekannte Felder,
  damit eine ältere App ein neueres Daten-Release lesen kann. Formatbrüche
  zählen `CATALOG_SCHEMA_VERSION` bzw. `CALC_PROTOCOL_VERSION` hoch.

## Daten-Release-Layout

`manifest.json` (`CatalogManifest`) nennt das `DataRelease` und je
Entitätsart eine Datei (`CatalogShard`) mit SHA-256. Die ID hat die Form
`poe2-<spielversion>+r<revision>`; Spielversion und Revision im Objekt müssen
zur ID passen. `CatalogDiff` beschreibt Änderungen zur Vorversion mit
JSON-Pointer-Pfaden (Grundlage für F-19).

`DataRelease.maxCharacterLevel` und `passivePoints` (Hauptbaum-Punkte je Stufe ab
`fromLevel`, Waffensatz-Punkte je Akt) sind optional und fehlen, wenn die Pipeline
sie nicht lesen konnte, nie als `0`. Jeder Wert nennt seinen Ursprung (`game-data`,
`pob-data`, `pob-code`). Punkte aus Items oder Knoten gehören nicht ins Release.
`passivePoints.ascendancy` (seit 0.17.0, optional) nennt die Gesamtgrenzen für
Ascendancy- und Secondary-Ascendancy-Punkte aus PoBs Code (`Build.lua`, Ursprung
`pob-code`). PoB kennt keine Aufteilung je Akt oder Stufe, also gibt es keine; Nutzer
dürfen keine erfinden. `Ascendancy.pointUnlocks` einer Quelle hat Vorrang, `ascendancy`
ist die PoB-Obergrenze. Nach einem PoB-Update ist der Wert in der Config zu prüfen.

`GuideListView` (seit 0.18.0, `guide/list`) ist die Antwort von `GET /api/guides`: je gespeichertem Guide Release, Ascendancy- und Skill-Name (fehlt, wenn der Katalog die ID nicht kennt) und `current`, oder `{ guideId, error }` für einen nicht lesbaren.

`GuideView` (seit 0.19.0, `guide/view`) ist die Antwort von `GET /api/guides/:id/view`: der Guide mit den Anzeigenamen seiner Katalog-Entitäten (`names`, Schlüssel `<kind>:<id>`), den gespeicherten Rechenergebnissen hinter seinen Zahlen (`results`) und einer Liste dessen, was der Server nicht auflösen konnte (`unresolved`). `catalogReleaseId` und `current` sagen, ob der Guide zum geladenen Daten-Release gehört; bei `current: false` werden keine Namen aufgelöst (alle Katalog-Referenzen stehen in `unresolved`, der Guide muss revalidiert werden), die Ergebnisse tragen ihr Release selbst. Ein gespeichertes Ergebnis, das nicht mehr dem `CalcResult`-Schema entspricht, steht als `calc:<id>` in `unresolved`. Seit 0.20.0 enthält die Antwort `gear`: die Items des Gear-Plans (`GuideItemCard`: Name, Basis, Implicits und Explicits mit Text aus dem Katalog), in der Reihenfolge von `guide.gear.tiers`; ein dem Katalog unbekanntes Item ist `null` und steht in `unresolved`, eine Mod ohne Text hat kein `text`.

`GuideListItem.origin` (seit 0.23.0, `run` oder `imported`) sagt, woher ein Guide in der Liste kommt: `imported` heißt, die Zahlen sind Messungen einer anderen Installation (Guide-Datei, auch die Beispiel-Guides der App).

`CandidateComparisonView` (seit 0.24.0) bündelt für den Varianten-Vergleich vor der Auswahl (S2/S3/S4) die Kandidaten, ihre Bewertungen, Anzeigenamen (`<kind>:<id>`), die Messergebnisse je `calcRef` und nicht auflösbare Referenzen. `current` sagt wie bei `GuideView`, ob der Run mit dem Katalog des Servers entstand (sonst keine Namen). Der Vertrag prüft Schlüssel (Kandidaten eindeutig, je Bewertung ein Kandidat, `chosenKey` gelistet, Ergebnis unter seiner calcId, kein fehlendes Ergebnis ohne `calc:<id>` in `unresolved`); `chosenKey` ist gesetzt, sobald eine Variante gewählt wurde.

`GuideComment`, `GuideCommentRequest` und `GuideCommentsView` (seit 0.25.0, `guide/comments.ts`) tragen die Abschnitts-Kommentare: Der Spieler markiert einen Teil eines fertigen Guides (`GuideSectionKey`, z. B. `S9.mechanics`, nur Schlüssel von S9-Aufgaben) und sagt, was sich ändern soll. Dazu die `UserIntervention` `comment` (`commentId`, `section`, `text`, vom Server gesetztes `previous` = Abschnitt vorher): Nur die aufgerufene Aufgabe des Abschnitts sieht sie. Der Status (`queued`/`working`/`applied`/`failed`) wird aus dem Lauf abgeleitet, nicht gespeichert. Importierte Guides haben keinen Lauf und sind nicht kommentierbar (`reason`). Seit 0.28.0 auch Crafting-Strategien (`S8.craft-…`, `GuideSectionInfo.recalculates`) und die Schlüssel-Helfer `stageSectionKey`, `slotSectionKey`, `craftTextSectionKey` (ein Server-Test hält sie gleich mit den Schlüsseln der Pipeline). Seit 0.29.0 auch Baustellen-Entscheidungen (`S5.gems`, `S6.notes`, `S7.gear-<tier>`); `GuideSectionInfo.recalculates` wurde zu `effect` (`rewrite` = nur der Abschnitt, `remeasure` = Crafting neu gemessen, `rebuild` = Neuberechnung ab der Stufe, alles Abhängige wird verworfen und neu erzeugt), `GuideCommentsView.revisions` zählt die früheren Fassungen (`GET /api/guides/:id/view?revision=n` für den Vorher-Nachher-Vergleich).

`GuideFile` (seit 0.22.0, `guide/file`) ist ein Guide als Datei zum Weitergeben: Format-Marker `astrolabe-guide`, Version 1, der `PublishedGuide` und die gespeicherten PoB-Ergebnisse, auf die seine Zahlen verweisen (`results`, Schlüssel `calcId`, jeder Eintrag muss seine `calcId` tragen, und jede `calcId`, auf die der Guide verweist, braucht ihren Eintrag: eine unvollständige Datei ist ungültig). Ergebnisse und Prüfbericht sind die Messungen der Installation, die die Datei gemacht hat; der Import prüft Form und Zusammenhang, rechnet aber nicht neu. Der Server erzeugt sie (`GET /api/guides/:id/file`) und liest sie ein (`POST /api/guides/import`); Zahlen werden dabei nur geprüft, nie neu berechnet.

`PassiveTreeData` (seit 0.21.0, `guide/tree`) ist die Antwort von `GET /api/tree`: alle Passive-Knoten und -Gruppen des geladenen Releases mit Geometrie, damit das Fenster die Verteilung eines Guides zeichnen kann. Einträge, die ihr Schema verletzen, stehen in `skipped`, nie stillschweigend fehlend.

`DataRelease.itemSlots` listet die Ausrüstungsplätze mit PoBs Slot-Namen (wie in
`EquippedItem.slot`) und den Basis-Klassen (`BaseItem.itemClass`), die PoB je Slot
annimmt. Juwelen-Sockel gehören zum Passivbaum und stehen nicht darin.

`DataRelease.rarities` listet die Seltenheiten in aufsteigender Reihenfolge mit der
höchsten Zahl an Affixen je Generationstyp (`maxAffixes`) für das Crafting. Fehlt
`maxAffixes`, trägt die Seltenheit durch Crafting keine Affixe (normal) oder wird nicht
gecraftet (einzigartig). Die Grenzen gelten je Seltenheit; Abweichungen je Item-Klasse (PoB: seltene Juwelen 4
statt 6) stehen in `maxAffixesByItemClass` und haben Vorrang. Das Feld ist optional und fehlt, wenn die Pipeline es nicht ableiten konnte.

`DataRelease.classifications` nennt, welche Klassifikations-Ids des Release
Schadensarten und Verteidigungsschichten sind (`damageTypes`, `defenceLayers`).
Der Guide prüft seine Angaben dagegen. Das Feld ist optional und fehlt, wenn die
Pipeline es nicht ableiten konnte; Prüfer melden das dann sichtbar, statt zu raten.
Befüllen muss es die Daten-Pipeline aus den Spieldaten oder PoB, nie aus dem
Gedächtnis.

## Calc-RPC

JSON-RPC 2.0, eine Zeile JSON je Nachricht über stdin/stdout des
LuaJIT-Workers. Der Worker meldet beim Start `meta.version` mit
`protocolVersion`; der Supervisor lehnt Abweichungen ab. Build-Zustände sind
unveränderlich: `build.applyPatch` liefert einen neuen Handle. Fehler tragen
`data.kind` (`timeout`, `worker_crashed`, `calc_failed` …), nie einen
Ersatzwert. `calc.evalBatch` meldet Fehler je Kandidat einzeln (`CalcErrorKind`).
Die `calcId` eines Kandidaten (Batch, Node-/Item-Power) dient nur Log und
Cache; sie ist kein Ziel eines `CalcRef`. Zahlen im Guide stammen immer aus
einem vollen `calc.stats`. `meta.version` liefert zusätzlich `dataHash` der
geladenen PoB-Daten für Cache-Schlüssel. Feste Protokollgrenzen:
`MAX_BUILD_PAYLOAD_CHARS` (Build-Payload) und 20 000 Zeichen je Item-Text.

## Befehle

```bash
pnpm --filter @astrolabe/contracts test       # Vertragstests + Schema-Snapshot
pnpm --filter @astrolabe/contracts generate   # schemas/ neu erzeugen (nicht von Hand ändern)
```

Fixtures in `test/fixtures/` sind erfunden (`Fixture/…`) und enthalten kein
Spielwissen.

`ResearchFinding` und `ResearchSection` (seit 0.26.0, `guide/research.ts`, ADR-0006) tragen die Recherche: ein Befund hat eine Id, den Abschnitt, ein Thema, die Aussage als `RichText` (eigene Worte, Zahlen nur als `calc`-Segmente), die Quelle (nur https, Titel, Abrufdatum) und Katalog-Entitäten. `GuideDocument.research` (Standard leer) hält die Befunde eines Guides. Das Textsegment `source` zitiert einen Befund über seine Id; ob die Id existiert und welche Hosts erlaubt sind, prüfen die Gates mit Werten aus `config/`, nicht das Schema.

`TreeIconAtlas` (seit 0.27.0, `guide/tree.ts`) beschreibt den Symbol-Atlas des Passive Trees (`GET /api/tree/icons.json`, Bild unter `/api/tree/icons.png`): Zellgröße, Spalten, Bildmaße, je Knoten-Id der Zellindex und die Knoten, deren Symbol fehlt. Das Bild entsteht zur Laufzeit aus den Baumdaten der Rechen-Engine und gehört nicht zum Daten-Release.
