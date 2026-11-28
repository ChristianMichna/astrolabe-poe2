import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  exportItemArt,
  planItemArt,
  readItemArtIndex,
  toolOutputName,
  type FileRunner,
} from "../src/gamedata/item-art.ts";

const config = { pathPrefix: "Art/2DItems/", maxFailedShare: 0.2 };
const baseItems = [
  { _index: 0, Name: "Fixture Helm", ItemVisualIdentity: 0 },
  { _index: 1, Name: "Fixture Boots", ItemVisualIdentity: 1 },
  { _index: 2, Name: "Fixture Ring", ItemVisualIdentity: null },
  { _index: 3, Name: "Fixture Map", ItemVisualIdentity: 2 },
];
const visuals = [
  { _index: 0, Id: "a", DDSFile: "Art/2DItems/Armours/Helmets/FixtureHelm.dds" },
  { _index: 1, Id: "b", DDSFile: "Art/2DItems/Armours/Boots/FixtureBoots.dds" },
  { _index: 2, Id: "c", DDSFile: "Art/Other/FixtureMap.dds" },
];

describe("planItemArt", () => {
  it("plans the image of each wanted base item and says why one is missing", () => {
    const plan = planItemArt(
      baseItems,
      visuals,
      new Set(["Fixture Helm", "Fixture Boots", "Fixture Ring", "Fixture Map", "Unknown"]),
      config,
    );
    expect(plan.jobs).toEqual([
      {
        name: "Fixture Boots",
        source: "Art/2DItems/Armours/Boots/FixtureBoots.dds",
        file: "Armours_Boots_FixtureBoots.png",
      },
      {
        name: "Fixture Helm",
        source: "Art/2DItems/Armours/Helmets/FixtureHelm.dds",
        file: "Armours_Helmets_FixtureHelm.png",
      },
    ]);
    expect(plan.missing.map((m) => m.name).sort()).toEqual([
      "Fixture Map",
      "Fixture Ring",
      "Unknown",
    ]);
  });
});

describe("exportItemArt", () => {
  const patch = { version: "9.9.9", url: "https://example.invalid/9.9.9/" };

  it("keeps what converts, isolates the file that fails and lists it", async () => {
    const broken = visuals[1]?.DDSFile as string;
    const calls: number[] = [];
    const run: FileRunner = async ({ sources, workDir }) => {
      calls.push(sources.length);
      if (sources.includes(broken)) throw new Error("imagemagick exited with code 1.");
      await mkdir(join(workDir, "files"), { recursive: true });
      for (const s of sources) await writeFile(join(workDir, "files", toolOutputName(s)), "png");
    };
    const outDir = join(await mkdtemp(join(tmpdir(), "art-test-")), "art");
    const index = await exportItemArt({
      config,
      patch,
      tool: { version: "1.0.0", run },
      baseItems,
      visuals,
      wanted: new Set(["Fixture Helm", "Fixture Boots"]),
      outDir,
      timeoutMs: 1000,
      now: new Date("2026-01-01T00:00:00Z"),
    });
    expect(index.items).toEqual({ "Fixture Helm": "Armours_Helmets_FixtureHelm.png" });
    expect(index.failed).toEqual([
      { name: "Fixture Boots", reason: expect.stringContaining("imagemagick") as string },
    ]);
    expect(await readFile(join(outDir, "Armours_Helmets_FixtureHelm.png"), "utf8")).toBe("png");
    expect(await readItemArtIndex(outDir)).toEqual(index);
    expect(calls[0]).toBe(2);
  });

  it("does not list a file as converted when the tool wrote nothing", async () => {
    const run: FileRunner = async () => undefined;
    const outDir = join(await mkdtemp(join(tmpdir(), "art-test-")), "art");
    const index = await exportItemArt({
      config,
      patch,
      tool: { version: "1.0.0", run },
      baseItems,
      visuals,
      wanted: new Set(["Fixture Helm"]),
      outDir,
      timeoutMs: 1000,
    });
    expect(index.items).toEqual({});
    expect(index.failed[0]?.reason).toMatch(/no converted image/);
  });
});
