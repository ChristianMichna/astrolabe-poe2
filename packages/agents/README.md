# @astrolabe/agents

Die Planungsstufen von Astrolabe als kleine, einzeln geprüfte Aufgaben
(keine Single-Shot-Prompts). Jede Stufe liefert eine `TaskSpec`: Anweisung,
Kontext, Antwortschema, erlaubte Werkzeuge und Prüfungen. Die Schleife
(`forge_attach/next/submit`) läuft in `apps/server`.

## Stand

| Stufe | Inhalt | Status |
|---|---|---|
| S0 | Hauptskill aus der Idee bestimmen (nur ohne `mainSkillId`) | fertig |
| S1 | Skill-Profil: `profileBase` rechnet der Server aus dem Katalog, `profileTask` ergänzt die KI | fertig |
| S2 | Archetyp-Kandidaten, eine Aufgabe je Kandidat | fertig |
| S3 | Skelett-Build je Kandidat, Baum per Optimierer, Messung mit PoB; läuft als Hintergrund-Job (`PlanStep` `job`) über den `SkeletonPort`; ohne PoB-Engine endet der Lauf mit `skeleton_unavailable` | fertig, im Server mit `--calc pob` verdrahtet |
| S4 | Der Spieler wählt einen Kandidaten in der App (`chooseVariant`); bis dahin `wait_user`, nie automatisch; die Wahl wird als `S4.selection` festgehalten | fertig |
| S5 | Zielbuild: Gem-Setup (Claude, mit PoB geprüft), Endgame-Tree (PoB-Optimierer als Job), `TargetBuild`. Level und Passivpunkte kommen aus dem Daten-Release (`maxCharacterLevel`, `passivePoints`; Hauptbaum plus Waffensatz-Punkte), fehlen sie, endet der Lauf mit `release_facts_missing`. Calc-Profile und Ziel stehen im Block `s5` von `config/agents/stages.json`; fehlt er, endet der Lauf mit `s5_not_configured`. Ascendancy-Punkte fehlen noch | gebaut |
| S6 | Progression: verschachtelte Tree-Stufen aus dem Ziel-Tree (PoB-Optimierer als Job), Texte je Stufe (Claude), `ProgressionPlan`. Die Stufentabelle (Akt-Bänder, Passivpunkte) wird aus dem Daten-Release abgeleitet (Annahme: Charakter-Level ≈ Gebietslevel am Aktende, siehe `s6-table.ts`); eine Liste `stages` im Block `s6` überschreibt sie. Calc-Profile und Ziel stehen im Block `s6` von `config/agents/stages.json`; fehlt er, endet der Lauf mit `s6_not_configured`, fehlen Release-Werte mit `release_facts_missing`. Leveling-Skills, Gem-Wechsel und Respec-Kosten fehlen noch | gebaut |
| S7 | Gear je Budget-Stufe: Item-Wahl je Slot (Claude, Katalog-ID und PoB geprüft; die Seltenheit eines gecrafteten Items muss eine Id aus `DataRelease.rarities` sein, sonst `unknown_rarity` (G1) mit den gültigen Ids; ohne `DataRelease.rarities` bleibt die Prüfung offen und meldet die Warnung `rarity_unchecked`). Danach ein Job `S7.plan`: Preise der Uniques aus der Economy (ohne Quote oder Dienst `unkalibriert`, bei Abruffehler `failed`, gecraftete Rares erst in S8), Upgrade-Reihenfolge nach PoB-Gewinn je Preis (Gewicht je Stat im Block `s7.objective`). Slots, ihre erlaubten Item-Klassen und die Pflicht-Slots kommen aus `DataRelease.itemSlots` (ohne sie: `release_facts_missing`, eine Config-Liste `slots` wählt Slots des Release aus; ohne Release-Slots gilt sie ohne Klassenprüfung, unbekannte Ids sind ein Fehler). Der Block `s7` in `config/agents/stages.json` hält Budget-Stufen und Calc-Profile; ohne ihn endet der Lauf mit `s7_not_configured` | teilweise |
| S8 | Crafting: je gecraftetem Rare jeder Gear-Stufe eine Strategie (Task `S8.craft-<Stufe>-<Slot>`, `CraftingPlan.tier`) (Claude, vom Simulator sofort geprüft; `startRarity` muss eine Id aus `DataRelease.rarities` sein, sonst `unknown_rarity`, sonst käme der Simulator nur zu „unkalibriert“; ohne Release-Seltenheiten die Warnung `rarity_unchecked`). Danach ein Job `S8.plan`: erneute Simulation mit Preisen; Startpreis nur für eine Basis ohne Mods, Versuche je Schritt `unkalibriert` (der Simulator liefert sie nur für die ganze Strategie) | teilweise |
| S9 | Autorenschaft: je Abschnitt (summary, mechanics, playstyle, atlas, variants, faq) eine Aufgabe; Zahlen nur als `calc`-Segmente auf Messungen des Ziel-Builds, Entitäten als Katalog-Referenzen. Mit dem Block `s9` in `config/agents/stages.json` folgt der Detail-Durchgang (`stages/s9-detail.ts`): je Progressionsstufe, Gear-Tier, Gear-Slot und Crafting-Plan eine eigene Aufgabe (`S9.stage-*`, `S9.tier-*`, `S9.slot-*`, `S9.craft-*`) mit eigenem Schema; Mindestmengen je Abschnitt kommen aus `s9.depth`, Gem-Wechsel einer Stufe müssen Gems der Pläne nennen. Das `GuideDocument` wird erst nach der Validierung zusammengesetzt | teilweise |
| S10 | Validierung: setzt aus den gespeicherten Plänen und Abschnitten den Guide-Entwurf zusammen (Vertrag `GuideDocument` ohne Metadaten) und prüft G1 (alle Katalog-IDs aus Builds, Plänen, Preisen, Anfrage und Text), G2 (Rechnung je Stufe vorhanden und erfolgreich), G6 (gemessene Respec-Kosten) und G7 (Crafting-Plan je Rare jeder Gear-Stufe). Ein Gate gilt nur als bestanden, wenn alles Geprüfte geprüft wurde: Mit dem Block `s10` in `config/agents/stages.json` kommen G3 (freier Spirit und Attribute gegen die höchste Anforderung von Item oder Gem aus PoB, `s10.stats.attributes`; Kampagnenstufen werden dafür mit der Ausrüstung der ersten Gear-Stufe gemessen, Befunde gehen an `S7.gear-<erste Stufe>` (Entscheidung: alle Kampagnenstufen tragen dieselbe Ausrüstung dieser Stufe; schlägt die Messung fehl, meldet G3 `calc_failed`); Punktzahl der allokierten Passive je Stufe gegen die Stufentabelle der Release; die Gem-Level jeder Stufe gegen die Level-Anforderungen der Katalogstufen des Gems (`gem_level_requirement_unmet`, Rücksprung an S6, das die Level je Stufe setzt); G3 prüft je Stufe, dass alle allokierten Knoten über allokierte Nachbarn mit dem Startknoten der Klasse (und Ascendancy-Knoten mit dem der Ascendancy) verbunden sind, `tree_node_unconnected`, Rücksprung an S6; G3 prüft am Zielbuild (S5) dieselbe Verbindung (Rücksprung an S5) und die Ascendancy-Punkte gegen `passivePoints.ascendancy` der Release (`ascendancy_points_overspent`; der Startknoten der Ascendancy ist frei); fehlt das Feld in der Release, bleibt G3 mit `check_not_built` offen und nennt den Grund. S5 sucht die Ascendancy-Knoten mit dem Punktelimit der Release (`TargetRequest.ascendancyPoints`); nicht verteilte Punkte sind eine Warnung; `s5.unsupportedMods` (`avoid`, Standard) lässt die Suche des Hauptbaums und der Ascendancy Knoten meiden, deren Mods PoB nicht berechnet (der Server misst das Ergebnis und sucht ohne diese Knoten erneut, höchstens `s5.unsupportedMaxRounds` Runden je Suche), `accept` behält sie, dann muss `s10.acceptedUnsupportedModPatterns` sie abdecken. Offen: die Progressionsstufen (S6) tragen keine Ascendancy-Knoten, eine Zuordnung je Stufe braucht Release-Daten, die PoB nicht liefert), G4 (Resistenzen am Cap über PoBs `Missing…Resist` je Stufenart, EHP-Minimum; für Endgame-Stufen misst es den Zielbuild mit der Ausrüstung der letzten Gear-Stufe, `GearPlan.tiers[].calcs`, und schickt Befunde an deren Teil `S7.gear-<Stufe>`; `s10.calcProfile` muss `s7.objective.calcProfile` entsprechen) und G5 (Schadens-Minimum) dazu; Statnamen sind PoBs eigene, die Mindestwerte stehen in `thresholds`; die Startwerte sind die Hälfte der von PoB gemessenen Werte eines Laufs auf r12 und gelten als unkalibriert (`thresholdsCalibrated: false` ergibt die Warnung `thresholds_uncalibrated` in G4 und G5), ohne Mindestwerte meldet G4/G5 `check_not_built`. Mit `s10.derived.minRatioToBest` (Entscheidung des Produktverantwortlichen 26.11.2026: automatisch) leiten G4 und G5 die Mindestwerte aus den Messwerten des Guides ab: jede Stufe muss EHP und Schaden über null haben und mindestens diesen Anteil der besten Stufe davor behalten (`ehp_below_minimum`, `dps_below_minimum`; ein langsamer Abfall über viele Stufen fällt so auf); die Stufen müssen im Level aufsteigen (`stage_level_not_ascending`, Rücksprung an S6); `thresholds` bleibt dann leer, der Bericht trägt statt „unkalibriert“ die Warnung `thresholds_relative` (es ist ein Plausibilitätstest, kein absoluter Mindestwert), und keine Zahl hängt von der Spielversion ab. G8 ist eine Critic-Aufgabe `S10.critic` (Claude liest den Entwurf und meldet Widersprüche zwischen Text und Daten; ohne Befund und mit allen gelesenen Abschnitten besteht G8). G2 prüft zusätzlich `s10.requiredCalcProfiles` je Stufe und meldet von PoB nicht berechnete Mods (`unsupported_mod`), außer sie passen auf ein Muster in `s10.acceptedUnsupportedModPatterns` (Entscheidung des Produktverantwortlichen: Mods mit Auslösebedingung „Used when …“; die Zeichenfolge verrät nicht, ob sie von einem Flask stammt). Akzeptierte Mods bleiben als Warnung im Bericht (`unsupported_mod_accepted`), der Guide muss sie als nicht von PoB berechnet kennzeichnen und keine Zahl darf auf ihnen beruhen; ein Gate besteht, wenn kein Befund mit Schwere `error` bleibt. G6 prüft die Kontinuität der Skills zwischen Stufen (Skill, aktives Gem und Zahl der Supports bleiben). G7 prüft die Mindestanzahl von Stufen und Gear-Stufen (`s10.minProgressionStages`, `s10.minGearTiers`) und einen Crafting-Plan für jeden Rare jeder Gear-Stufe (Rücksprung an S8). Skill-Befunde aus G6 gehen an S5, Zähl- und Konfigurationsbefunde tragen keinen Rücksprung. Offen bleiben nicht berechnete Mods anderer Profile als `s10.calcProfile`. `S10.report` hält Entwurf und Gate-Ergebnisse (ohne Vollständigkeits-Score, der braucht die Gewichte aus `config/`) | teilweise |
| S10 (Rücksprung) | Nach dem Bericht schickt der Schritt `return` die früheste verursachende Stufe (Befund mit `returnTo`) zurück: ihre Ergebnisse und alle späteren fallen weg, die Befunde stehen in der neu gestellten Aufgabe. Je Stufe sind `s10.maxReturnsPerStage` Rücksprünge erlaubt, danach endet der Lauf mit `returns_exhausted`. Befunde ohne `returnTo` (z. B. `check_not_built`) beenden den Lauf mit `validation_failed` | teilweise |
| S11 | Veröffentlichung: gespeicherter `PublishedGuide` (Metadaten, Validierungsbericht, Vollständigkeitswert aus `s11`-Gewichten) | Schritt `S11.guide`; Exporte (.build, PoB-Codes, Markdown) folgen |

S3-Grenzen: Das Skelett hat keine Items und keine Ascendancy-Knoten (Kandidaten
mit gleicher Klasse und anderer Ascendancy werden gleich gemessen), und eine
unvollständige Optimierung wird nur geloggt. Jobs haben noch kein Zeitlimit und
keinen Abbruch.

## Minion-Builds

Ist die Hauptfertigkeit ein Gem einer Art aus `minion.skillKinds` (`config/agents/stages.json`), liegt ihr
Schaden in PoBs `Minion…`-Werten; der eigene DPS des Spielers ist dann 0. Die Werte aus `minion.statMap` ersetzen
dann `FullDPS`/`CombinedDPS` in den Zielen der Baumsuche (S3, S5, S6, im Server), im Gear-Ziel (S7) und im
Schadens-Gate G5 (`src/minion-stats.ts`). Es gibt keine Ersatzrechnung: Fehlt der Wert in PoB, schlägt die Suche
bzw. G5 sichtbar fehl. Das Tag `minion` taugt nicht als Kriterium, weil auch Fertigkeiten es tragen, die selbst Schaden machen.

## Regeln

- Keine Zahlen im Text; Zahlen kommen per `calcRef`.
- Entitäten nur mit Katalog-ID (G1, vom Server geprüft).
- Schwellen, Gem-Arten und Kandidatenzahl stehen in `config/agents/stages.json`.
- Prompts enthalten kein Spielwissen aus dem Modellgedächtnis.

`createForgePipeline(config)` liefert die Pipeline mit der ID `forge`.

## Platzhalter-Waffe im Skelett

Angriffsskills machen ohne Waffe in PoB keinen Schaden; Zielbaum und Stufen wären dann blind für DPS und
zeigten flache Nullkurven. `s3.placeholderWeapon` (`config/agents/stages.json`, Slot und Seltenheit aus dem
Daten-Release) lässt das Skelett (S3) eine Waffe tragen: Aus jeder Waffenklasse, die der Slot nimmt
(`DataRelease.itemSlots`), wird die Basis mit der niedrigsten Anforderung gerechnet; gewinnt die Klasse, die PoB
für den Hauptskill am besten misst, und nur wenn sie besser ist als der Build ohne Waffe (Zauber und Minions
brauchen keine). Die Waffe hat keine Modifikatoren und wandert über S4 bis S6 in Zielbaum und Stufen; die
Gear-Stufen (S7) ersetzen alle Items. Fehlt der Slot im Release oder die Rechnung scheitert, ist das ein
sichtbarer Fehler, kein stiller Verzicht.

Grenzen: Die Platzhalter-Waffe steht im Zustand der Stufen; der `.build`-Export lässt Items ohne Modifikatoren weg und
nennt den Slot in `omitted`; die Gear-Stufen ersetzen sie in den Messungen von S7 und S10, nicht in den
veröffentlichten Stufen. Gewählt wird nach der Zielfunktion von S3
(roh gewichtete Summe); die Wahl wird je Server und Skill gecacht. Attribut-Anforderungen der Basis fließen nicht
in die Wahl ein (nur die Anforderungsstufe).
