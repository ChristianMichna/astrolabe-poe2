# @astrolabe/server

Lokaler Astrolabe-Server (ADR-0004): läuft in der App, lauscht **nur auf
`127.0.0.1`** und bietet

- den **MCP-Endpunkt** `/mcp` (Streamable HTTP, zustandslos) für Claude Code
  und für die `.mcpb`-Brücke von Claude Desktop,
- die **REST-API** und **Live-Events (SSE)** für das Frontend,
- die **forge-Schleife** (ADR-0003) als Zustandsmaschine mit SQLite.

## forge-Schleife

Claude bekommt nie den ganzen Auftrag, sondern je Aufruf genau eine kleine
Aufgabe mit eigenem Antwortschema (`ForgeTask` aus `@astrolabe/contracts`).
Jede Abgabe prüft der Server sofort, in dieser Reihenfolge:

1. **Schema** der Aufgabe (Zod → JSON-Pointer im Befund)
2. **G1** – jede ID existiert im Katalog des Daten-Release
3. **Zahlen** – `text`-Segmente enthalten keine Ziffern (`free_number`, G8);
   `calc`-Verweise zeigen auf ein vorhandenes Ergebnis und einen vorhandenen
   Stat (`unknown_calc_ref`, G2)
4. **eigene Prüfung** der Aufgabe (z. B. Ascendancy passt zur Klasse,
   Rechnung über die Engine; fehlgeschlagene Rechnung = Befund `calc_failed`)

Bei Befunden bleibt dieselbe Aufgabe offen (`attempt + 1`, Befunde in
`findings`). Nach `maxAttemptsPerTask` Fehlversuchen entscheidet der Nutzer im
Frontend (Frage „Retry the task" / „Abort the run"). Deterministische Schritte
(z. B. S3-Skelettrechnung) macht der Server ohne Claude.

| MCP-Werkzeug                    | Vertrag          | Zweck                                                                                                                                                                                                          |
| ------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `forge_attach`                  | `forge.attach`   | Sitzungscode → Lauf, erste Aufgabe                                                                                                                                                                             |
| `forge_next`                    | `forge.next`     | nächste Aufgabe; wartet bis zu `waitLongPollSeconds`, solange der Nutzer dran ist                                                                                                                              |
| `forge_submit`                  | `forge.submit`   | Abgabe; Antwort enthält Befunde und immer den nächsten Schritt                                                                                                                                                 |
| `forge_ask_user`                | `forge.ask_user` | Rückfrage als Karte im Frontend                                                                                                                                                                                |
| `forge_status`                  | `forge.status`   | Zustand des Laufs                                                                                                                                                                                              |
| `catalog_search`, `catalog_get` | –                | IDs und Katalogdaten (als Daten gekennzeichnet); `catalog_search` filtert nach Text, Art und `tags` (mindestens eines von beiden nötig ist nicht gefordert, ohne Filter kommen Einträge in Katalogreihenfolge) |
| `calc_evaluate`                 | –                | Build-Zustand rechnen, Ergebnis mit `calcId`, Engine und PoB-Version                                                                                                                                           |

Werkzeugnamen nutzen `_` statt `.`, weil Claude-Werkzeugnamen nur
`[a-zA-Z0-9_-]` erlauben; die Verträge behalten die Punkt-Namen. Dazu gibt es
den MCP-Prompt `astrolabe` (Startsatz mit Sitzungscode) und Server-
Instructions, die Claude anweisen, die Schleife bis `done` selbst
weiterzuführen.

## REST-API (Frontend)

| Methode | Pfad                             | Inhalt                                                                             |
| ------- | -------------------------------- | ---------------------------------------------------------------------------------- |
| `GET`   | `/api/health`                    | `calcEngine` (`fake`/`pob`), `dataReleaseId`                                       |
| `GET`   | `/api/claude/status`             | `mcpLastCallAt`: Zeitpunkt des letzten Aufrufs von `/mcp` mit gültigem Token (`null`: noch keiner seit Start) |
| `POST`  | `/api/runs`                      | `{ request: BuildRequest, pipelineId? }` → `runId`, `sessionCode`, `expiresAt`     |
| `GET`   | `/api/runs/:runId`               | ganzer Laufzustand (Ergebnisse, offene Fragen, aktuelle Aufgabe)                   |
| `POST`  | `/api/runs/:runId/session-code`  | neuer Code, z. B. für einen neuen Chat                                             |
| `POST`  | `/api/runs/:runId/interventions` | `UserIntervention` (Variante wählen, sperren, ablehnen, Pause, Antwort, Stufe neu) |
| `GET`   | `/api/runs/:runId/events`        | SSE, `id` = `seq` des Laufs; `Last-Event-ID` spielt Verpasstes nach                |

Schutz:

- Anfragen mit fremdem `Host` (DNS-Rebinding) oder fremdem `Origin`
  (Webseiten im Browser) werden mit 403 abgewiesen; erlaubte Origins setzt die
  App (`allowedOrigins`, nur exakte Origins).
- **Zugriffstoken je Installation**: Alles außer `/api/health` verlangt
  `Authorization: Bearer <token>`. Der Server legt das Token beim ersten Start
  an (`%APPDATA%\Astrolabe\access-token`, sonst
  `~/.config/astrolabe/access-token`, nur für den Besitzer lesbar). Die
  `.mcpb`-Brücke liest es dort; Claude Code bekommt es per
  `claude mcp add --transport http astrolabe http://127.0.0.1:47615/mcp --header "Authorization: Bearer <token>"`
  (die App zeigt den Befehl an).
- Falsche Sitzungscodes: höchstens `attachFailuresPerMinute` je Minute.
- Höchstens 16 offene Event-Streams, 1 MB je Anfrage.

## Pipelines

`Pipeline.plan(ctx)` liefert für den aktuellen Laufzustand deterministisch den
nächsten Schritt (`task`, `server`, `wait_user`, `done`). Dadurch übersteht ein
Lauf Neustarts und Chatwechsel. Enthalten ist nur die **PoC-Pipeline**
(`poc`: S2-Kandidaten → S3-Skelettrechnung → S4-Auswahl im Frontend →
S5-Gems → S5-Rechnung), die die Mechanik mit echten Vertragsschemas beweist.
Die echten Stufen und Prompts kommen aus `packages/agents`.

Einstellungen (Versuche, Wartezeiten, Code-Gültigkeit, Kandidatenzahl,
Calc-Profile) stehen in `config/forge/forge.json`.

## Rechnen

`CalcPort` ist die schmale Sicht des Servers auf den Rechendienst. Bis der
PoB-Worker-Pool (`apps/calc`) mit der Umwandlung BuildState → PoB angebunden
ist, rechnet **calc-fake**: deterministische Fantasiewerte mit Stat-Namen
`fake.*` und PoB-Version `v0.0.0-calc-fake`. Er muss ausdrücklich gewählt
werden (`--calc fake`), `GET /api/health` und `calc_evaluate` melden
`engine: "fake"`.

## Entwicklung

```bash
pnpm --filter @astrolabe/server build
node apps/server/dist/main.js --catalog <daten-release-ordner> --calc fake \
  [--port 47615] [--db astrolabe.sqlite] [--origin http://127.0.0.1:5173]
claude mcp add --transport http astrolabe http://127.0.0.1:47615/mcp --header "Authorization: Bearer $(cat ~/.config/astrolabe/access-token)"
```

Zum Ausprobieren ohne Abo-Verbrauch: `npx @modelcontextprotocol/inspector`.

Speicher: `node:sqlite` (in Node/Electron enthalten, kein natives Modul für
Windows zu bauen; ohne Flag ab Node 22.13, daher `engines` ≥ 22.13; Node meldet
es noch als experimentell). Rechenergebnisse werden mitgespeichert
(`PersistedCalc`), damit calc-Verweise einen Neustart überstehen.

## Lange Schleifen in Claude

Stand der Recherche (24.11.2026, nicht selbst in Claude Desktop gemessen):

- Claude Desktop/claude.ai beenden eine Antwort nach einer nicht
  veröffentlichten Zahl von Werkzeugaufrufen („Claude reached its tool-use
  limit for this turn", Berichte: etwa 20 seit März 2026) mit einem
  **Continue**-Knopf; der Kontext bleibt erhalten. Claude Code hat diese
  Grenze in der Praxis nicht so eng.
- Claude Desktop bricht MCP-Aufrufe nach etwa **60 s** ab (Fehlerberichte).

Folgen im Server:

- `forge_submit` liefert immer schon den nächsten Schritt mit, ein eigener
  `forge_next`-Aufruf je Aufgabe entfällt (≈ 1 Aufruf pro Aufgabe plus
  Katalog-/Rechenaufrufe).
- `forge_next` wartet höchstens `waitLongPollSeconds` (20 s), deutlich unter
  60 s, und meldet dann `wait_user` mit `retryAfterSeconds`.
- Der Lauf liegt vollständig im Server: Nach „Continue", einer neuen
  Antwort oder einem neuen Chat (neuer Code über
  `POST /api/runs/:runId/session-code`) geht es an derselben Stelle weiter.
- Erwartung für einen ganzen Guide (40–80 Aufgaben): in Claude Desktop
  mehrere „Continue", in Claude Code meist am Stück. Das Frontend soll
  „Paused in Claude – press Continue" anzeigen, wenn eine Weile keine
  Abgabe kommt. Messung im Ende-zu-Ende-Test mit echtem Abo steht aus.

Quellen: [startdebugging.net](https://startdebugging.net/2026/05/fix-claude-reached-its-tool-use-limit-for-this-turn/),
[jdhodges.com](https://www.jdhodges.com/blog/claude-reached-tool-use-limit-fix/),
[Fehlerbericht 60-s-Abbruch](https://claudeissues.com/issue/63379-bug-desktop-app-cancels-stdio-mcp-tool-calls-at-60s-and-ignores-mcp-tool-timeout).

## Offen

- Adapter `CalcPort` → `@astrolabe/calc` (sobald BuildState → PoB existiert)
- echte Stufen-Aufgaben und Prompts aus `packages/agents`, Gates G3–G8
- Pipeline-Ergebnis als `GuideDocument`: Die PoC-Pipeline meldet `done` und
  `guide.ready` mit einer `guideId`, zu der es noch **kein** Guide-Dokument
  gibt; das Ergebnis sind die Stufenergebnisse unter `GET /api/runs/:runId`.
- calc-Verweise sind an Daten-Release und Calc-Profile des Laufs gebunden,
  noch nicht an den Lauf selbst (Herkunft je Lauf speichern).
- Ereignis-Nachlieferung per SSE seitenweise statt auf einmal; Grenzen für
  Anzahl und Größe gespeicherter Läufe; Log-Schwärzung (Pfade, später Keys).
- Einbindung in `apps/desktop` (Port, Pfade im App-Datenordner, Origin des Fensters)

## Pipelines

- `poc`: Proof of Concept (S2 → S3 → S4 → S5.gems) zum Prüfen der Schleife.
- `forge`: echte Planungsstufen aus `packages/agents` (S0 bis S2). Danach endet
  der Lauf mit dem `PlanStep` `blocked` und dem Fehler `stage_not_implemented`,
  bis S3 ff. gebaut sind. Einstellungen: `config/agents/stages.json`
  (Option `--stages`, Standard `config/agents/stages.json`).

## PoB-Adapter (`PobCalc`)

`src/calc/pob-calc.ts` setzt den `CalcPort` auf den PoB-Rechendienst (`CalcPool`
aus `apps/calc`): Basis-Build laden (`build.load`, je Basis einmal), per
`diffBuildState` aus `packages/calc-client` auf den gewünschten Zustand patchen
(`build.applyPatch`), je Profil `calc.stats`, danach den Patch-Handle freigeben.
Fehler werden zu `failed`-Ergebnissen mit Ursache, nie zu Ersatzwerten.

`src/calc/item-text.ts` rendert `ItemSpec` als PoB-Itemtext aus Katalogdaten
(`createItemRenderer`). Wertbereiche `(min-max)` bleiben im Text, der Roll geht
als `{range:F}` an PoB, das selbst rechnet und rundet. Grenzen: Uniques
erscheinen mit `Implicits: 0` (der Katalog trennt Implicits nicht) und mit PoBs
Standard-Roll; Socketables, Uniques mit ungewählter Variante, fehlende Texte
und unbekannte Raritäten führen zu einem Fehler statt zu einem abweichenden
Item. `src/calc/base-builds.ts` (`ClassBaseBuilds`) liefert den Ausgangs-Build
je Klasse aus `BaseBuildSource` (PoB erzeugt ihn; `CalcPool.baseBuild` folgt
im PoB-Thread).

Calc-Profile: Die Stufen rechnen mit festen Standardprofilen aus
`config/agents/stages.json` (S3: `mapping` und `pinnacle`, das erste ist das
Profil des Baum-Optimierers). Der Spieler passt Gegner und Buffs über
`BuildRequest.calcOverrides` an (PoB-Optionsnamen, Freitext gesperrt). Die
Engine hängt sie an jede Berechnung eines Laufs, auch an die des Optimierers;
sie gewinnen gegen das Profil und gegen `BuildState.config`. Ein Ändern der
Overrides während eines Laufs gibt es noch nicht (die App setzt sie beim
Anlegen).

`--calc pob` startet den echten PoB-Pool (`--pob-root`, `--optimizer`).

## Hintergrund-Jobs und S3

Der `PlanStep` `job` startet rechenintensive Arbeit (S3: Skelett-Builds mit
Baum-Optimierung in PoB) außerhalb des Run-Locks. `forge_next` antwortet bis
zum Ende mit "wait" (Long-Poll wie beim Warten auf den Nutzer); das Ergebnis
wird danach wie ein Server-Schritt gespeichert, ein Fehler beendet den Lauf mit
`job_failed`. Ein Job ohne Gedächtnis im Record startet nach einem Neustart
beim nächsten `forge_next` neu; ein `redoStage` während des Laufs verwirft die
Antwort des alten Jobs. Ein Job, der länger als `jobTimeoutMinutes` (`config/forge/forge.json`) läuft, beendet den Lauf mit `job_failed`; die späte Antwort wird verworfen, ein Abbruch der Rechnung selbst gibt es noch nicht. Beim Beenden des Servers (`stopJobs`, vor dem Schließen des
Pools) werden laufende Jobs verworfen, ohne den Lauf als fehlgeschlagen zu speichern; der Job
startet beim nächsten Planen neu. Ein Lauf, der an einem Job scheiterte (`job_failed`), setzt der
Spieler mit `resume` fort (der Job läuft neu); nach `job_failed`, `returns_exhausted` oder
`validation_failed` startet `redoStage` die Stufe neu, mit frischen Rücksprüngen. Alle
gespeicherten Ergebnisse bleiben.

`src/calc/skeleton.ts` (`PobSkeleton`) ist der `SkeletonPort` auf PoB und
`optimizeTree`; er wird mit `PobCalc` in `start.ts` verdrahtet, sobald
`CalcPool.baseBuild` in main ist.

## Crafting und Preise als MCP-Werkzeuge

`craft_simulate` (Monte-Carlo-Simulation, Paket `crafting-sim`) und `economy_price`
(Marktpreise, Paket `economy`) sind registriert, wenn `StartOptions.craftConfigPath`
bzw. `StartOptions.economy` gesetzt sind (Entwicklungs-Einstieg: `--craft-config`,
Standard `config/crafting/sim.json`; `--economy <cache-dir>` schaltet die Preise ein).
Ohne Konfiguration gibt es das Werkzeug nicht, statt einen Platzhalter zu liefern.
Fehlschläge (unbekannte Katalog-IDs, Abruf gescheitert) sind Fehlerantworten mit Code,
nie leere Ergebnisse. Mit Economy rechnet der Simulator Kosten aus dem Preisbuch der
Liga der Anfrage, nennt sie keine, aus der aktuellen Challenge-Liga des Anbieters (jede Kostenangabe trägt die Liga ihres Preisbuchs); ohne Preise bleiben Kosten `uncalibrated`. Offen (siehe
`packages/economy/README.md`): Abbildung der Währungs-Items und der Kontakt im
User-Agent; bis dahin scheitert `economy_price` mit einem klaren Fehler. Die Desktop-App
muss `economy.cacheDir` und `appVersion` setzen.

## Gem-Level je Stufe

Der Zielbuild trägt die Gem-Level seines Endziels. `scaleGemLevels` setzt in S6 die Gems jeder
Stufe auf das höchste Level, dessen Level-Anforderung aus den Katalogstufen des Gems das
Charakterlevel der Stufe erfüllt (nie über dem Ziellevel). Ein Gem, das in der Stufe noch nicht
nutzbar ist, behält sein niedrigstes Level, damit G3 es benennen kann. Die Berechnungen der Stufen
laufen mit diesen Leveln.

## Patch-Revalidierung (F-19)

`src/tools/revalidate.ts` prüft einen gespeicherten Guide gegen neuere Daten-Releases:
`revalidateStoredGuide({ guide, releaseDirs, now })` validiert den Guide gegen `GuideDocument`, liest
die Manifeste der Release-Verzeichnisse (das des Guides zuerst, das geprüfte zuletzt) samt Diff je
späterem Release und ruft `revalidateGuide` aus `@astrolabe/revalidate`. Ergebnis ist ein
`PatchStatus`. Fehlt ein Diff oder passt die Kette nicht, gibt es einen `RevalidationError`, nie
`unaffected`. Noch nicht angebunden: ein MCP-Tool (braucht einen Vertrags-PR; dort dürfen keine
freien Pfade ankommen, nur Release-IDs, die der Server auf sein Datenverzeichnis abbildet) und die
Ablage gespeicherter Guides.

## MCP-Tool `guide_revalidate` (F-19)

Mit `--releases-dir <Ordner>` (oder `releasesDir` in `startServer`) bietet der MCP-Endpunkt das Tool
`guide_revalidate` an: `{ guideId, toReleaseId }` → `PatchStatus`. Ohne die Option gibt es das Tool nicht.

- Der Ordner enthält je entpacktem Daten-Release einen Unterordner mit dem Namen der Release-ID.
- Der Guide kommt aus dem eigenen Speicher (`RunStore.findGuide`: Ergebnis `S11.guide` des zuletzt
  gespeicherten Laufs mit dieser `guideId`); Pfade kommen nie vom Client.
- Die Kette wird von `toReleaseId` über `previousReleaseId` bis zum Release des Guides gebaut.
- Fehlercodes (Tool-Fehler): `guide_not_found`, `release_unknown`, `release_not_newer`, `diff_missing`,
  `guide_invalid`. Nie ein stilles „unaffected", wenn die Prüfung nicht möglich ist.

## Nur-Katalog-Modus (F-01, Day-0)

Gibt es für einen Daten-Release noch keine passende PoB-Version (neuer Patch,
`release.pobVersion` ≠ installierte PoB), startet der Server trotzdem: mit
`--calc none` ausdrücklich, mit `--calc pob` automatisch, wenn die PoB-Version
des Pools nicht zum Release passt (der Pool wird beim Beenden geschlossen).
Dann gilt `calc.engine = "none"` (`CalcNone`):

- Gespeicherte Rechenergebnisse früherer Läufe bleiben lesbar; neue Rechnungen
  scheitern mit `calc_unavailable`.
- Katalog, Suche, `guide_revalidate` und das Fenster laufen weiter.
- Neue Läufe (`POST /api/runs`) und `calc_evaluate` antworten mit dem Fehler
  `calc_unavailable` (HTTP 409 / MCP-Fehler) und nennen Grund und fehlende
  PoB-Version; es gibt nie `0` oder leere Ersatzwerte.
- `GET /api/health` meldet `calcEngine: "none"`, `catalogOnly: true` und
  `catalogOnlyReason`.

## Automatische Neuprüfung gespeicherter Guides (F-19)

Mit `--releases-dir` prüft der Server direkt nach dem Start jeden gespeicherten
Guide, der mit einem älteren Release gebaut wurde, gegen das Release, mit dem
er läuft (`GuideSweeper`, im Hintergrund). Die Desktop-App startet den Server
nach jeder Installation eines Daten-Releases neu, damit läuft die Prüfung
automatisch nach einem Patch.

- Ergebnis je Guide und Release in SQLite (`patch_checks`): das `PatchStatus`
  oder der Fehlercode (`diff_missing`, `guide_invalid`, ...), nie ein stilles
  „unverändert".
- `GET /api/guides` listet die gespeicherten Guides (neueste zuerst) mit Release, Ascendancy- und
  Hauptskill-Name `current` (mit dem geladenen Release gebaut) und `origin` (`run`: Guide eines eigenen Laufs, `imported`: aus einer Guide-Datei, auch die Beispiel-Guides), Form `GuideListView` der
  Verträge; ein Name fehlt, wenn der Katalog die ID nicht kennt (nie durch die ID ersetzt), und ein
  nicht lesbarer Guide steht mit `error` in der Liste (auch ein beschädigter Datensatz). `GET /api/guides/:guideId` liefert den Guide (`PublishedGuide`, 404
  unbekannt, 400 beschädigt).
- `GET /api/guides/:guideId/view` liefert `GuideView` der Verträge: den Guide, die Anzeigenamen
  aller Katalog-Referenzen (`names`, Schlüssel `<kind>:<id>`, gesammelt mit `collectGuideRefs`), die
  gespeicherten Rechenergebnisse aller `calcId` im Guide (`results`) und was nicht aufgelöst
  werden konnte (`unresolved`). Nichts wird ersetzt oder geschätzt; nur Mods haben im Katalog
  keinen Namen, ihr Text (Zeilen mit „; " verbunden) dient als Name, und ein leerer Text bleibt
  in `unresolved`. Gehört der Guide zu einem
  anderen Daten-Release als dem geladenen (`current: false`), werden keine Namen aufgelöst; die
  Ergebnisse bleiben, ungültige gespeicherte Ergebnisse stehen als `calc:<id>` in `unresolved`.
  Die Antwort enthält je eindeutiger `calcId` ein vollständiges `CalcResult` (einige hundert KB
  bei großen Guides, lokal unkritisch).
- `GET /api/guides/:guideId/file` liefert den Guide als `GuideFile` (Guide und die gespeicherten
  PoB-Ergebnisse, auf die seine Zahlen verweisen), zum Weitergeben. Fehlt ein gültiges Ergebnis,
  endet der Export mit einem Fehler, der die `calcId`s nennt (nie eine Datei mit fehlenden Zahlen).
  `POST /api/guides/import` (Body bis 32 MB) liest so eine Datei ein: Format und Vertrag werden
  geprüft, auch dass jede `calcId` des Guides ihr Ergebnis in der Datei hat (400 sonst; die
  Ergebnisse sind die Messungen der anderen Installation und werden nicht neu berechnet), die Ergebnisse unverändert gespeichert (ein anderes Ergebnis unter einer
  schon gespeicherten `calcId` lehnt den Import ab), dann der Guide in `imported_guides`
  (derselbe Guide noch einmal ersetzt die Kopie; ein Guide, den ein eigener Lauf erzeugt hat,
  wird nicht überschrieben). Importierte Guides stehen in `GET /api/guides` nach denen der Läufe.
- Option `exampleGuidesDir` (`StartOptions`): beim Start liest `importExampleGuides` die `*.json`
  dieses Ordners als `GuideFile` und spielt jeden Guide ein, den der Speicher noch nicht hat (ein
  späterer Start lässt eine unveränderte Kopie in Ruhe, eine abweichende Fassung ersetzt sie). Eine Datei, die sich nicht einspielen lässt, steht mit Grund
  im Log und im Ergebnis; ein nicht lesbarer Ordner ist ein Fehler, kein „keine Beispiele“. Der
  Server startet in jedem Fall.
- `GET /api/tree` liefert `PassiveTreeData`: alle Passive-Knoten und -Gruppen des geladenen
  Releases mit Geometrie für die Baumansicht im Fenster; Einträge, die ihr Schema verletzen,
  stehen in `skipped`.
- `GET /api/tree/icons.json` (`TreeIconAtlas`) und `GET /api/tree/icons.png`: die Original-Symbole der
  Notables, Keystones, Ascendancy-Knoten und Klassenstarts. Der Server baut den Atlas beim ersten
  Aufruf aus den Baumdaten von Path of Building (`TreeData/<neueste Version>/tree.json` und die
  Sheets `skills_*_BC1.dds.zst`; BC1-Dekodierung, runde Maske, ein PNG) und hält ihn im Speicher.
  Im Repository liegen keine Grafiken; der Installer liefert nur diese Sheets (ca. 4 MB) mit.
  Grafiken © Grinding Gear Games. Ohne PoB-Ordner 404 (`no_icons`), bei einem Fehler beim Bauen
  503 (`icons_unavailable`) mit Eintrag im Log; das Fenster zeigt dann einen Hinweis und den Baum
  mit einfachen Formen. Knoten ohne Symbol im Sheet (z. B. Meisterschaften) stehen in `missing`.
- `GET /api/guides/:guideId/build-file` liefert den Guide als `.build`-Datei des Build Planners
  (F-12): `{ file, omitted }`. Die Spiel-IDs und Namen kommen aus dem geladenen Release
  (`src/export/build-file-resolvers.ts`: Knoten-`gameId`, Slot-`gameId`, Unique-, Ascendancy-
  und Raritätsnamen); was das Release nicht kennt, steht in `omitted`, nie erfunden. Ein Guide
  eines anderen Releases wird abgelehnt (400, erst neu prüfen), ein unbekannter ist 404. Offene Annahme: Der Ascendancy-Name im Export ist die Katalog-ID (PoBs `internalId`, z. B. `Druid1`); ob das die Schreibweise des Spiels ist, steht noch nicht fest (docs/data-model.md).
- `GET /api/guides/patch-status` liefert `{ enabled, releaseId, running, error?, guides }`
  (`enabled: false` ohne `--releases-dir`: dann wurde nichts geprüft).
  `POST /api/guides/patch-status/refresh` prüft alle Guides erneut (202; läuft schon
  eine Prüfung, ändert sich nichts).
- Beim Start werden Guides mit vorhandenem Ergebnis für dieses Release nicht erneut
  geprüft, Guides mit einem Fehler schon. Beim Beenden stoppt der Server die Prüfung
  nach dem laufenden Guide, bevor er die Datenbank schließt.
- Die Antwortform ist `GuidePatchStatusView` aus `@astrolabe/contracts` (0.16.0). Eine gespeicherte Zeile, die nicht zum Vertrag passt, erscheint als `internal`-Fehler dieses Guides.

## Abschnitts-Kommentare (F-07)

`GET/POST /api/guides/:guideId/comments` (`GuideCommentsView`, `GuideCommentRequest`). Ein Kommentar
ist die `UserIntervention` `comment` auf einen S9-Abschnitt (`S9.summary`, `S9.stage-…` usw.):
Die Engine öffnet den fertigen Lauf wieder, legt den Guide als frühere Revision ab
(`RunRecord.revisions`), verwirft nur das Ergebnis des Abschnitts samt S10/S11 und gibt den
Kommentar samt altem Text (`previous`) nur der Aufgabe dieses Abschnitts. Claude schreibt ihn neu,
Schema, Katalog-IDs, Zahlenlinter und Rubrik prüfen wie beim ersten Mal; nach S10/S11 ist der Guide
`metadata.revision + 1` unter derselben Guide-ID. Bis dahin liefert `findGuide` die letzte
Revision. Der Status je Kommentar (`queued`/`working`/`applied`/`failed`) wird aus dem Lauf
abgeleitet. Importierte Guides haben keinen Lauf und sind nicht kommentierbar. Auch die
Crafting-Strategie (`S8.craft-<Stufe>-<Slot>`) ist kommentierbar: Die Engine verwirft sie samt
`S8.plan` (Simulator und Preise rechnen neu) und dem Plan-Text `S9.craft-…` (`commentDependents` in
`packages/agents`); `GuideSectionInfo.effect` (`rewrite`/`remeasure`/`rebuild`) sagt es der App.
Baustellen-Entscheidungen (`S5.gems`, `S6.notes`, `S7.gear-<tier>`) haben den Effekt `rebuild`:
Die Engine verwirft die Aufgabe per `dropFrom` samt allem Nachfolgenden (PoB misst alles ab dieser
Stufe neu, Crafting, Texte und Kosten entstehen über die normale Schleife neu). Der Kommentar geht
nur an die Aufgabe des Abschnitts. `GET /api/guides/:id/view?revision=n` liefert eine frühere
Fassung; die App rechnet daraus den Vorher-Nachher-Vergleich aus den gespeicherten PoB-Ergebnissen.
