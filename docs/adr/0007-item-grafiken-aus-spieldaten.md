# ADR-0007: Original-Item-Grafiken aus den Spieldaten, mit Credit

- Status: **angenommen** (Christian, 2026-11-28: „Nein es müssen die Original Icons sein. Ich
  kenne die GGG Devs und die haben da nichts dagegen.")
- Datum: 2026-11-28
- Ändert: Regel „Keine kopierten Spielgrafiken" in `CLAUDE.md` (nur für Item-Inventarbilder),
  ergänzt ADR-0005 (Extraktion nur in CI)

## Kontext

Die Gear-Ansicht zeigt Slots als Paperdoll. Eigene Strichzeichnungen (PR #205) reichen Christian
nicht; er will wie im Spiel und bei Maxroll die Original-Inventarbilder. PoB liefert keine
Item-Bilder.

## Entscheidung

- Die Inventarbilder der Basis-Items des Katalogs werden **nur in CI** aus den Patch-Bundles
  gelesen (`astrolabe-data item-art`, gleiches Werkzeug `pathofexile-dat` und gleicher
  Patch-Server wie ADR-0005; Tabelle `ItemVisualIdentity`, Spalte `DDSFile`; ImageMagick wandelt
  DDS in PNG). Nie beim Nutzer, keine Interaktion mit dem Spielclient.
- Die Bilder liegen im Daten-Release unter `assets/items/`, `BaseItem.icon` verweist darauf
  (Vertrag kennt das Feld bereits). Ein Item ohne Bild behält die eigene Linien-Ikone, die Lücke
  steht in `findings.json` und im Index (`failed`), nie ein Ersatzbild.
- Die App zeigt überall, wo Spielgrafiken erscheinen, den Hinweis „Graphics © Grinding Gear
  Games" neben dem bestehenden Third-Party-Hinweis. Es bleibt dabei: keine Logos, kein Anschein
  offizieller Herkunft.
- Nicht Teil dieser Entscheidung: Tree-Icons, Gem-Icons, Währungsbilder (eigene Freigabe/ADR).

## Folgen

- Das Daten-Release enthält jetzt Spielgrafiken (Größe: ein PNG je Basis-Item).
- Die Freigabe durch GGG ist mündlich über Christian; eine schriftliche Bestätigung wäre für
  eine öffentliche Weitergabe an Dritte sinnvoll.
- Uniques haben eigene Bilder; sie folgen in einem Schritt danach (Tabelle der Unique-Optik).
