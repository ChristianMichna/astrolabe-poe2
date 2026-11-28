import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CalcFake } from "../src/calc/calc-fake.js";
import { PersistedCalc } from "../src/calc/persisted-calc.js";
import { ForgeEngine } from "../src/engine/forge-engine.js";
import { createApp } from "../src/http/app.js";
import { createMemoryLogger } from "../src/logger.js";
import { createPocPipeline } from "../src/pipelines/poc-pipeline.js";
import { RunStore } from "../src/store/run-store.js";
import { CONFIG, RELEASE, fixtureCatalog } from "./fixtures.js";

const TOKEN = "e".repeat(64);
const headers = { host: "127.0.0.1:1", authorization: `Bearer ${TOKEN}` };

function app(assetsDir?: string) {
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
    accessToken: TOKEN,
    ...(assetsDir === undefined ? {} : { assetsDir }),
  });
}

const get = (a: ReturnType<typeof app>, file: string, auth = true) =>
  a.inject({
    method: "GET",
    url: `/api/release-assets/assets/items/${file}`,
    headers: auth ? headers : { host: headers.host },
  });

describe("release item images", () => {
  it("serves an image of the data release, and only with the access token", async () => {
    const dir = await mkdtemp(join(tmpdir(), "assets-"));
    await mkdir(join(dir, "assets", "items"), { recursive: true });
    await writeFile(join(dir, "assets", "items", "Fixture_Helm.png"), "png-bytes");
    const a = app(dir);
    const ok = await get(a, "Fixture_Helm.png");
    expect(ok.statusCode).toBe(200);
    expect(ok.headers["content-type"]).toBe("image/png");
    expect(ok.body).toBe("png-bytes");
    expect((await get(a, "Fixture_Helm.png", false)).statusCode).toBe(401);
  });

  it("answers 404 for an image the release does not have", async () => {
    const dir = await mkdtemp(join(tmpdir(), "assets-"));
    expect((await get(app(dir), "Missing.png")).statusCode).toBe(404);
    expect((await get(app(), "Missing.png")).statusCode).toBe(404);
  });

  it("refuses names that leave the images directory or are not png", async () => {
    const dir = await mkdtemp(join(tmpdir(), "assets-"));
    const a = app(dir);
    for (const file of ["..%2F..%2Fsecret.png", "%2e%2e", "a.txt", "sub%2Fa.png"]) {
      // refused by the name check (400) or never routed (404); in no case served
      expect([400, 404], file).toContain((await get(a, file)).statusCode);
    }
  });
});
