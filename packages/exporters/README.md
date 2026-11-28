# @astrolabe/exporters

Exporte eines veröffentlichten Guides (`PublishedGuide`).

| Export | Stand |
|---|---|
| Markdown (`guideToMarkdown`) | fertig; Namen und Zahlen kommen über `MarkdownResolvers` (Katalog, gespeicherte Berechnungen). Nicht auflösbare Referenzen lassen den Export mit allen Fundstellen fehlschlagen. |
| `.build` (In-Game-Planner, `guideToBuildFile`) | fertig als reine Funktion. Passive, Skills mit Supports und Inventar-Hinweise (Unique-Name, bei Rares Basis und Pflicht-Mods als Text) je Stufe mit `level_interval` aus den Levelbereichen der Stufen; ein Eintrag überspannt die aufeinanderfolgenden Stufen, in denen er gleich bleibt. Spiel-IDs und Namen kommen über `BuildFileResolvers` aus dem Katalog (`PassiveNode.gameId`, `ItemSlot.gameId`, Gem-IDs sind schon die Pfade). Ein Item ohne Modifikatoren ist die Platzhalter-Waffe der Rechnung (Skelett, S3), keine Empfehlung: Es fehlt in der Datei und der Slot steht in `omitted`. Was keine Spiel-ID hat, steht in `omitted` und fehlt in der Datei, nichts wird geraten. Offen: Anbindung im Server, Test im Spiel (ob `level_interval` das Charakterlevel meint und ob die Grenzen inklusive sind; ob Waffensatz 0 weggelassen werden darf; Meta-Gems werden vom Format nicht unterstützt und noch nicht herausgefiltert) |
| PoB-Code je Stufe | offen |
