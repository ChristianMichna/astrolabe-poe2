import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GUIDE_FILE_FORMAT, GuideFile, collectCalcIds } from "@astrolabe/contracts/guide";
import { QualityRubric, rubricFindings, type GuideDraft } from "@astrolabe/agents";
import { importExampleGuides } from "../src/guides/example-guides.js";
import { createMemoryLogger } from "../src/logger.js";
import { RunStore } from "../src/store/run-store.js";
import { guide } from "./guide-fixture.js";
import { RELEASE } from "./fixtures.js";

const validation = { gates: [], completenessScore: 100, scoringConfigVersion: "1", passed: true };
const stored = { ...guide, validation, metadata: { ...guide.metadata, dataReleaseId: RELEASE } };
const resultOf = (calcId: string) => ({
  calcId,
  pobVersion: "v0.23.1",
  dataReleaseId: RELEASE,
  calcProfile: "default",
  inputHash: "a".repeat(64),
  computedAt: "2026-11-26T12:00:00Z",
  stats: { FixtureStatA: 1 },
  warnings: [],
  unsupportedMods: [],
});
const file = {
  format: GUIDE_FILE_FORMAT,
  version: 1,
  guide: stored,
  results: Object.fromEntries(collectCalcIds(stored).map((id) => [id, resultOf(id)])),
};
const now = () => new Date("2026-11-26T12:00:00Z");

function folderWith(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "astrolabe-examples-"));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

describe("importExampleGuides", () => {
  it("imports a guide file once and leaves it alone on the next start", async () => {
    const store = new RunStore(":memory:");
    const dir = folderWith({ "a.json": JSON.stringify(file) });
    const logger = createMemoryLogger();
    expect(await importExampleGuides(dir, store, logger, now)).toEqual({
      imported: 1,
      alreadyStored: 0,
      failed: [],
    });
    expect(store.listGuideIds()).toEqual([guide.metadata.guideId]);
    expect(await importExampleGuides(dir, store, logger, now)).toEqual({
      imported: 0,
      alreadyStored: 1,
      failed: [],
    });
  });

  it("replaces a stored example that a newer file revises", async () => {
    const store = new RunStore(":memory:");
    const dir = folderWith({ "a.json": JSON.stringify(file) });
    await importExampleGuides(dir, store, createMemoryLogger(), now);
    const revised = {
      ...file,
      guide: { ...stored, summary: { ...stored.summary, mainSkillId: "Fixture/Gems/Other" } },
    };
    const newer = folderWith({ "a.json": JSON.stringify(revised) });
    expect(await importExampleGuides(newer, store, createMemoryLogger(), now)).toMatchObject({
      imported: 1,
      alreadyStored: 0,
    });
    expect(store.findGuide(guide.metadata.guideId)).toMatchObject({
      summary: { mainSkillId: "Fixture/Gems/Other" },
    });
  });

  it("logs and lists a file it cannot import, and still imports the others", async () => {
    const store = new RunStore(":memory:");
    const dir = folderWith({
      "a.json": JSON.stringify(file),
      "broken.json": "not json",
      "wrong.json": JSON.stringify({ ...file, format: "other" }),
      "notes.txt": "ignored",
    });
    const logger = createMemoryLogger();
    const outcome = await importExampleGuides(dir, store, logger, now);
    expect(outcome).toEqual({
      imported: 1,
      alreadyStored: 0,
      failed: ["broken.json", "wrong.json"],
    });
    expect(logger.entries.filter((e) => e.level === "error")).toHaveLength(2);
  });

  it("reports an unreadable folder as a failure, not as no examples", async () => {
    const logger = createMemoryLogger();
    const outcome = await importExampleGuides(
      join(tmpdir(), "astrolabe-no-such-folder"),
      new RunStore(":memory:"),
      logger,
      now,
    );
    expect(outcome.failed).toEqual([]);
    expect(outcome.folderError).toBeDefined();
    expect(logger.entries.some((e) => e.level === "error")).toBe(true);
  });
});

describe("the guides shipped in examples/guides", () => {
  it("are all valid guide files that import into an empty store", async () => {
    const store = new RunStore(":memory:");
    const dir = fileURLToPath(new URL("../../../examples/guides", import.meta.url));
    const outcome = await importExampleGuides(
      dir,
      store,
      createMemoryLogger(),
      () => new Date("2026-11-27T00:00:00Z"),
    );
    expect(outcome.failed).toEqual([]);
    expect(outcome.imported).toBeGreaterThan(0);
  });
});

describe("the quality of the guides shipped in examples/guides", () => {
  const rubric = QualityRubric.parse(
    JSON.parse(
      readFileSync(new URL("../../../config/agents/guide-rubric.json", import.meta.url), "utf8"),
    ),
  );
  const dir = fileURLToPath(new URL("../../../examples/guides", import.meta.url));
  const names = readdirSync(dir).filter((n) => n.endsWith(".json"));

  it("ships example guides", () => {
    expect(names.length).toBeGreaterThan(0);
  });

  it.each(names)("%s meets every measured rule of the guide rubric", (name) => {
    const { guide: shipped } = GuideFile.parse(JSON.parse(readFileSync(join(dir, name), "utf8")));
    const draft: Record<string, unknown> = { ...shipped };
    delete draft["metadata"];
    delete draft["validation"];
    const found = rubricFindings(draft as unknown as GuideDraft, rubric);
    expect(found.map((f) => `${f.code} ${f.path ?? ""}`)).toEqual([]);
  });
});
