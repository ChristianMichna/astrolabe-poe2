import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { TreeIconAtlas } from "@astrolabe/contracts/guide";
import { decodeBc1 } from "../src/tree-icons/bc1.js";
import { buildIconAtlas, findTreeDataDir } from "../src/tree-icons/atlas.js";
import { encodePng } from "../src/tree-icons/png.js";
import type { CatalogPort } from "../src/ports/catalog.js";
import { withCatalogIds } from "../src/tree-icons/catalog-ids.js";
import { treeIconSource, type TreeIconSource } from "../src/tree-icons/source.js";
import { CalcFake } from "../src/calc/calc-fake.js";
import { PersistedCalc } from "../src/calc/persisted-calc.js";
import { ForgeEngine } from "../src/engine/forge-engine.js";
import { createApp } from "../src/http/app.js";
import { createMemoryLogger } from "../src/logger.js";
import { createPocPipeline } from "../src/pipelines/poc-pipeline.js";
import { RunStore } from "../src/store/run-store.js";
import { CONFIG, RELEASE, fixtureCatalog } from "./fixtures.js";

/** A BC1 block that is one solid colour (565 value `c`). */
function solidBlock(c: number): number[] {
  return [c & 255, c >> 8, c & 255, c >> 8, 0, 0, 0, 0];
}

/** DDS texture array of 8x8 BC1 slices, each one solid colour, one mip level. */
function sheet(colours: number[]): Buffer {
  const header = Buffer.alloc(148);
  header.write("DDS ", 0, "latin1");
  header.writeUInt32LE(8, 12); // height
  header.writeUInt32LE(8, 16); // width
  header.writeUInt32LE(1, 28); // mip levels
  header.write("DX10", 84, "latin1");
  header.writeUInt32LE(71, 128); // BC1
  header.writeUInt32LE(colours.length, 140);
  const blocks = colours.flatMap((c) => [
    ...solidBlock(c),
    ...solidBlock(c),
    ...solidBlock(c),
    ...solidBlock(c),
  ]);
  return Buffer.concat([header, Buffer.from(blocks)]);
}

async function treeFolder(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tree-icons-"));
  for (const version of ["0_4", "0_10"])
    await mkdir(join(root, "src", "TreeData", version), { recursive: true });
  const dir = join(root, "src", "TreeData", "0_10");
  const name = "skills_8_8_BC1.dds.zst";
  await writeFile(join(dir, name), zstdCompressSync(sheet([0xf800, 0x07e0])));
  await writeFile(
    join(dir, "tree.json"),
    JSON.stringify({
      nodes: {
        "1": { icon: "a.dds" },
        "2": { icon: "b.dds" },
        "3": { icon: "a.dds" },
        "4": { icon: "elsewhere.dds" },
        "5": {},
      },
      ddsCoords: { [name]: { "a.dds": 1, "b.dds": 2 }, "other_BC7.dds.zst": { "x.dds": 1 } },
    }),
  );
  return root;
}

describe("decodeBc1", () => {
  it("decodes a solid red block", () => {
    const pixels = decodeBc1(Uint8Array.from(solidBlock(0xf800)), 0, 4, 4);
    expect([...pixels.subarray(0, 4)]).toEqual([255, 0, 0, 255]);
    expect(pixels).toHaveLength(64);
  });
  it("refuses a slice that reaches past the data", () => {
    expect(() => decodeBc1(new Uint8Array(4), 0, 4, 4)).toThrow(/past the end/);
  });
});

describe("encodePng", () => {
  it("writes a PNG header with the size", () => {
    const png = encodePng(new Uint8Array(2 * 3 * 4), 2, 3);
    expect(png.subarray(1, 4).toString("latin1")).toBe("PNG");
    expect(png.readUInt32BE(16)).toBe(2);
    expect(png.readUInt32BE(20)).toBe(3);
  });
});

describe("buildIconAtlas", () => {
  it("picks the newest tree folder by number, not by text", async () => {
    const root = await treeFolder();
    expect(await findTreeDataDir(root)).toMatch(/0_10$/);
  });

  it("gives nodes with the same icon one cell and leaves out nodes without a picture", async () => {
    const root = await treeFolder();
    const { index, png } = await buildIconAtlas(await findTreeDataDir(root));
    expect(index.icons["1"]).toBe(index.icons["3"]);
    expect(index.icons["2"]).not.toBe(index.icons["1"]);
    expect(Object.keys(index.icons).sort()).toEqual(["1", "2", "3"]);
    expect(png.readUInt32BE(16)).toBe(index.width);
  });

  it("refuses a sheet whose header claims absurd sizes", async () => {
    const root = await treeFolder();
    const dir = await findTreeDataDir(root);
    const broken = sheet([0xf800]);
    broken.writeUInt32LE(4_000_000_000, 28); // mip levels
    await writeFile(join(dir, "skills_8_8_BC1.dds.zst"), zstdCompressSync(broken));
    await expect(buildIconAtlas(dir)).rejects.toThrow(/implausible header/);
  });

  it("does not keep a failure: a later request builds again", async () => {
    const root = await mkdtemp(join(tmpdir(), "tree-icons-empty-"));
    const source = treeIconSource(root);
    await expect(source()).rejects.toThrow("Could not build");
    const real = await treeFolder();
    const again = treeIconSource(real);
    expect((await again()).index.cell).toBeGreaterThan(0);
  });
});

describe("withCatalogIds", () => {
  const node = (id: string, pobNodeId?: number) => ({
    id,
    name: id,
    kind: "small",
    stats: [],
    position: { groupId: "g1", orbit: 0, orbitIndex: 0 },
    connections: [],
    ...(pobNodeId === undefined ? {} : { pobNodeId }),
  });
  const catalog = {
    list: (kind: string) =>
      kind === "passiveNode"
        ? [node("Cat/A", 10), node("Cat/B", 11), node("Cat/C"), { id: "Broken", entity: {} }].map(
            (entity) => ({ kind, id: entity.id, entity }),
          )
        : [],
  } as unknown as CatalogPort;
  const index = { cell: 96, columns: 2, width: 192, height: 96, icons: { "10": 1 } };

  it("re-keys by catalog id and lists catalog nodes that have no picture", () => {
    const atlas = TreeIconAtlas.parse(withCatalogIds(index, catalog));
    expect(atlas.icons).toEqual({ "Cat/A": 1 });
    expect(atlas.missing).toEqual(["Cat/B", "Cat/C"]);
  });
});

describe("GET /api/tree/icons.*", () => {
  const token = "e".repeat(64);
  const headers = { host: "127.0.0.1:1", authorization: `Bearer ${token}` };
  function app(treeIcons?: TreeIconSource) {
    const store = new RunStore(":memory:");
    const catalog = fixtureCatalog();
    const calc = new PersistedCalc(new CalcFake({ dataReleaseId: RELEASE }), store);
    return createApp({
      engine: new ForgeEngine({
        store,
        catalog,
        calc,
        config: CONFIG,
        pipelines: [createPocPipeline(CONFIG.pipelines.poc)],
        calcProfiles: ["default"],
      }),
      catalog,
      calc,
      calcProfiles: ["default"],
      waitLongPollSeconds: 0,
      logger: createMemoryLogger(),
      port: 1,
      allowedOrigins: [],
      defaultPipelineId: "poc",
      accessToken: token,
      ...(treeIcons === undefined ? {} : { treeIcons }),
    });
  }
  const get = (a: ReturnType<typeof app>, url: string) => a.inject({ method: "GET", url, headers });

  it("answers 404 with a reason when the server has no Path of Building folder", async () => {
    const res = await get(app(), "/api/tree/icons.json");
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("no_icons");
  });

  it("answers 503 and not an empty atlas when building fails", async () => {
    const res = await get(
      app(() => Promise.reject(new Error("no sheets"))),
      "/api/tree/icons.png",
    );
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("icons_unavailable");
  });

  it("serves the index and the picture", async () => {
    const root = await treeFolder();
    const a = app(treeIconSource(root));
    const index = await get(a, "/api/tree/icons.json");
    expect(TreeIconAtlas.parse(index.json()).columns).toBeGreaterThan(0);
    const png = await get(a, "/api/tree/icons.png");
    expect(png.headers["content-type"]).toBe("image/png");
    expect(png.rawPayload.subarray(1, 4).toString("latin1")).toBe("PNG");
  });
});
