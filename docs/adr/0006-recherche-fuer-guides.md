# ADR-0006: Recherche für Guides ohne Zahlen aus dem Netz

- Status: **angenommen** (Christian, 2026-11-28, Entscheidungskarte: Option A, Recherche über Claude Desktop mit Websuche)
- Datum: 2026-11-28
- Auslöser: Christians Rückmeldung vom 27.11.2026: Viele Ratschläge im Guide seien generisch; ein
  Guide brauche gründliche Recherche.

## Kontext

Die Pipeline schreibt Guides heute nur aus dem Katalog, den PoB-Messungen und den Plänen. Das
sichert die Leitprinzipien (keine Zahl ohne Engine, keine Entität ohne Katalog-ID), liefert aber
nur, was sich aus den Daten ableiten lässt. Was gute Community-Guides zusätzlich tragen, fehlt:
Spielgefühl, bekannte Fallstricke, Bosskämpfe, Reihenfolgen im Alltag, Meta-Wissen zu Patches.
Das steht nicht im Katalog, und aus dem Modellgedächtnis darf es nicht kommen (CLAUDE.md).

## Entscheidung (Vorschlag)

Eine **Rechercheaufgabe** vor dem Guide-Text (zwischen S6 und S9), mit eigenem Antwortschema und
denselben Prüfungen wie jede andere Aufgabe:

1. **Befund statt Fließtext.** Claude liefert Befunde: `{ id, thema, aussage, quelleUrl,
   quelleTitel, abgerufenAm, bezug: [Katalog-Referenzen], gilt für: [Abschnitt/Stufe/Slot] }`.
   Die Aussage ist eine kurze eigene Paraphrase, kein kopierter Text. Fehlt die Quelle, wird der
   Befund abgelehnt.
2. **Katalog-IDs wie überall (G1).** Alles, was ein Befund benennt (Skill, Item, Mod, Passiv),
   muss im Katalog der Ziel-Version existieren, sonst geht der Befund zurück.
3. **Keine Zahlen aus dem Netz.** Zahlen in Befunden werden nicht in den Guide übernommen. Der
   bestehende Zahlen-Linter gilt auch für Befunde. Zahlen kommen weiter nur per Rechnung aus PoB.
   Widerspricht ein Befund einer Messung, gilt die Messung, und der Widerspruch wird im Lauf
   sichtbar gemacht.
4. **Gezielte Auslieferung.** Die Befunde liegen im Lauf; `forge.next` liefert einer
   Schreibaufgabe nur die Befunde, die für ihren Abschnitt gelten (wie bei der Guide-Spec,
   ADR-Entwurf F-31).
5. **Belegpflicht im Guide.** Ratschläge, die auf einer Recherche beruhen, verweisen auf die
   Befund-Id; ein neues Gate prüft, dass jede Id existiert. Ratschläge ohne Befund bleiben
   erlaubt, wenn sie aus Katalog und Rechnung folgen. Im Guide stehen die Quellen als Liste
   („Sources") mit Link.

## Wer ruft das Netz ab

- **Empfohlen (A): Claude im Claude Desktop des Nutzers mit dessen Websuche.** Die App ruft keine
  fremden Seiten ab, speichert nur die Befunde. Passt zu „keine Claude-Zugangsdaten durchreichen"
  und zu GGG- und Urheberrecht: kein Scraping durch die App, keine kopierten Texte.
- (B) Die App holt Seiten selbst. Verworfen: Robots- und Nutzungsregeln jeder Quelle, Parser je
  Seite, identifizierbarer User-Agent pro Quelle, mehr Angriffsfläche im lokalen Server.
- (C) Keine Recherche, Tiefe nur über mehr Katalog- und Messdaten. Sicherste Variante, liefert
  aber nie das Spielgefühl, das Christian meint.

## Folgen

- Vertrags-PR zuerst: `ResearchFinding`, neue MCP-Aufgabe, `GuideDocument.sources`.
- Laufzeit pro Guide steigt um die Recherche (je Abschnitt eine kleine Aufgabe).
- Quellen können sich ändern oder verschwinden: Befunde tragen das Abrufdatum, die Neuprüfung
  nach einem Patch markiert alte Befunde als „ungeprüft", nie stillschweigend als gültig.
- Eine Allowlist der Quellen (Patchnotes, Wikis, Community-Guides) liegt in `config/`; Foren und
  Videos nur auf ausdrückliche Freigabe.

## Festlegungen zu den offenen Fragen (Empfehlungen, in `config/` änderbar)

1. Abruf über Claude Desktop mit Websuche des Nutzers (entschieden).
2. Recherche ist standardmäßig an, mit Schalter in `config/agents/stages.json` für schnelle Läufe.
3. Quellen: Patchnotes, Wiki und Community-Guides (nur als Paraphrase mit Link); die Liste der erlaubten Hosts steht in `config/agents/research.json`. Foren und Videos nur nach ausdrücklicher Freigabe.
