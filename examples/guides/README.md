# Beispiel-Guides

Guide-Dateien (`*.json`, Format `GuideFile` aus `packages/contracts`, siehe `guide/file`), die der
lokale Server beim Start einspielt, wenn sein Speicher sie noch nicht kennt. Der Installer bringt
diesen Ordner als `example-guides/` mit, damit die Guide-Seite ohne eigenen Lauf echte Guides zeigt.

- `lightning-arrow.json`: Lightning-Arrow-Build auf Daten-Release poe2-0.5.5.10+r15, mit dem Pipeline-Stand
  inklusive Detail-Durchgang und Qualitätsurteilen erzeugt (alle Zahlen aus PoB).
- `boneshatter.json`: Boneshatter-Build auf derselben Daten-Release r15, ebenso erzeugt.
- Jede Datei ist ein echter Guide mit den gespeicherten PoB-Ergebnissen, auf die seine Zahlen
  verweisen; nichts davon ist geschätzt oder von Hand gesetzt.
- Ein Guide zeigt Namen und Baum nur, wenn die Daten-Release der App die seines Laufs ist; sonst
  steht „Older game data“ dabei.
- Eine Datei, die sich nicht einspielen lässt, steht mit Grund im Log; der Server startet trotzdem.

## Datei erzeugen

Aus einem Guide und seinen gespeicherten PoB-Ergebnissen entsteht die Datei mit

```bash
node tools/make-guide-file.mjs <guide.json> <results.json> examples/guides/<name>.json
```

Das Skript prüft die Datei gegen `GuideFile` und bricht bei Fehlern ab; die Ausgabedatei muss ein neuer Pfad sein, nie eine der Eingaben.
- `apps/server/test/example-guides.test.ts` prüft jede Datei hier gegen die gemessenen Regeln von
  `config/agents/guide-rubric.json`; ein neuer Beispiel-Guide muss sie erfüllen.
