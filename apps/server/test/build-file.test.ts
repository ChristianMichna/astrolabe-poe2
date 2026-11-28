import { describe, expect, it } from "vitest";
import type { DataRelease } from "@astrolabe/contracts/catalog";
import { CalcFake } from "../src/calc/calc-fake.js";
import { ForgeEngine } from "../src/engine/forge-engine.js";
import type { RunRecord } from "../src/engine/run-record.js";
import { buildFileResolvers } from "../src/export/build-file-resolvers.js";
import { createApp } from "../src/http/app.js";
import { createMemoryLogger } from "../src/logger.js";
import { createPocPipeline } from "../src/pipelines/poc-pipeline.js";
import type { CalcPort } from "../src/ports/calc.js";
import type { CatalogPort } from "../src/ports/catalog.js";
import { RunStore } from "../src/store/run-store.js";
import { guide } from "./guide-fixture.js";
import { CONFIG, RELEASE, fixtureCatalog } from "./fixtures.js";

const TOKEN = "c".repeat(64);
const headers = { host: "127.0.0.1:1", authorization: `Bearer ${TOKEN}` };
const GUIDE_ID = guide.metadata.guideId;
const validation = { gates: [], completenessScore: 100, scoringConfigVersion: "1", passed: true };
const validated = { ...guide, validation };
const validResult = {
  calcId: "calc-1",
  pobVersion: "v0.23.1",
  dataReleaseId: RELEASE,
  calcProfile: "default",
  inputHash: "a".repeat(64),
  computedAt: "2026-11-26T12:00:00Z",
  stats: { FixtureStatA: 1 },
  warnings: [],
  unsupportedMods: [],
};
const stored = { ...validated, metadata: { ...guide.metadata, dataReleaseId: RELEASE } };

function app(
  findGuide: ((id: string) => unknown) | undefined,
  catalogOverride?: CatalogPort,
  listGuideIds?: () => string[],
  calcOverride?: CalcPort,
  findRunByGuide?: (id: string) => { revisions: unknown[] } | undefined,
) {
  const store = new RunStore(":memory:");
  const catalog = catalogOverride ?? fixtureCatalog();
  const calc = calcOverride ?? new CalcFake({ dataReleaseId: RELEASE });
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
    ...(findGuide === undefined ? {} : { findGuide }),
    ...(findRunByGuide === undefined
      ? {}
      : { findRunByGuide: findRunByGuide as unknown as (id: string) => RunRecord | undefined }),
    ...(listGuideIds === undefined ? {} : { listGuideIds, guideOrigin: () => "imported" as const }),
  });
}

describe("GET /api/guides/:guideId/build-file", () => {
  it("needs the access token", async () => {
    const res = await app(() => stored).inject({
      method: "GET",
      url: `/api/guides/${GUIDE_ID}/build-file`,
      headers: { host: headers.host },
    });
    expect(res.statusCode).toBe(401);
  });

  it("exports the stored guide and lists what the release has no id for", async () => {
    const res = await app(() => stored).inject({
      method: "GET",
      url: `/api/guides/${GUIDE_ID}/build-file`,
      headers,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ file: { name: string; passives: unknown[] }; omitted: string[] }>();
    expect(body.file.passives).toEqual([]);
    expect(body.omitted).toContain("passive fixture_node_1: the release has no game id");
    expect(body.file.name.length).toBeGreaterThan(0);
  });

  it("writes the game ids the release carries", async () => {
    const base = fixtureCatalog();
    const catalog: CatalogPort = {
      dataReleaseId: base.dataReleaseId,
      release: base.release,
      get: (ref) =>
        ref.kind === "passiveNode" && ref.id === "fixture_node_1"
          ? { kind: "passiveNode", id: ref.id, entity: { gameId: "game_node_1" } }
          : base.get(ref),
      search: (q) => base.search(q),
      list: (k) => base.list(k),
      hasStat: (id) => base.hasStat(id),
    };
    const res = await app(() => stored, catalog).inject({
      method: "GET",
      url: `/api/guides/${GUIDE_ID}/build-file`,
      headers,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ file: { passives: { id: string }[] }; omitted: string[] }>();
    expect(body.file.passives.map((p) => p.id)).toEqual(["game_node_1"]);
    expect(body.omitted).not.toContain("passive fixture_node_1: the release has no game id");
  });

  it("explains a guide whose stages are out of level order instead of answering 500", async () => {
    const first = stored.progression.stages[0];
    const empty = {
      ...stored,
      progression: {
        stages: [
          { ...first, levelRange: [20, 30] },
          { ...first, key: "stage-2", order: 1, levelRange: [1, 10] },
        ],
      },
    };
    const res = await app(() => empty).inject({
      method: "GET",
      url: `/api/guides/${GUIDE_ID}/build-file`,
      headers,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { message: string } }>().error.message).toMatch(/cannot be exported/);
  });

  it("answers 404 for an unknown guide", async () => {
    const res = await app(() => undefined).inject({
      method: "GET",
      url: `/api/guides/${GUIDE_ID}/build-file`,
      headers,
    });
    expect(res.statusCode).toBe(404);
  });

  it("refuses a guide built with another release", async () => {
    const res = await app(() => validated).inject({
      method: "GET",
      url: `/api/guides/${GUIDE_ID}/build-file`,
      headers,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { message: string } }>().error.message).toMatch(/revalidate/);
  });

  it("refuses a stored value that is not a guide", async () => {
    const res = await app(() => ({ nope: true })).inject({
      method: "GET",
      url: `/api/guides/${GUIDE_ID}/build-file`,
      headers,
    });
    expect(res.statusCode).toBe(400);
  });

  it("is a bad request without a run store", async () => {
    const res = await app(undefined).inject({
      method: "GET",
      url: `/api/guides/${GUIDE_ID}/build-file`,
      headers,
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("buildFileResolvers", () => {
  const entries: Record<string, { name?: string; entity: unknown }> = {
    "passiveNode:n1": { entity: { gameId: "game_n1" } },
    "passiveNode:n2": { entity: {} },
    "uniqueItem:u1": { name: "Unique One", entity: {} },
    "ascendancy:Asc1": { name: "Fixture Asc", entity: {} },
    "mod:m1": { name: "Mod One", entity: {} },
  };
  const catalog = {
    dataReleaseId: RELEASE,
    release: {
      itemSlots: {
        slots: [{ id: "Helmet", gameId: "Helm1" }, { id: "Flask 1" }],
      },
      rarities: { rarities: [{ id: "rare", name: "Rare" }] },
    } as unknown as DataRelease,
    get: (ref: { kind: string; id: string }) => {
      const e = entries[`${ref.kind}:${ref.id}`];
      return e === undefined ? undefined : { kind: ref.kind, id: ref.id, ...e };
    },
  } as unknown as CatalogPort;
  const r = buildFileResolvers(catalog);

  it("reads game ids and names from the release and leaves the rest undefined", () => {
    expect(r.passiveGameId("n1")).toBe("game_n1");
    expect(r.passiveGameId("n2")).toBeUndefined();
    expect(r.passiveGameId("nope")).toBeUndefined();
    expect(r.slotGameId("Helmet")).toBe("Helm1");
    expect(r.slotGameId("Flask 1")).toBeUndefined();
    expect(r.slotGameId("Nope")).toBeUndefined();
    expect(r.uniqueName("u1")).toBe("Unique One");
    expect(r.ascendancyName("Asc1")).toBe("Asc1");
    expect(r.ascendancyName("Asc2")).toBeUndefined();
    expect(r.rarityName("rare")).toBe("Rare");
    expect(r.rarityName("magic")).toBeUndefined();
    expect(r.entityName({ kind: "mod", id: "m1" })).toBe("Mod One");
  });

  it("works for a release without slot or rarity facts", () => {
    const bare = buildFileResolvers({ ...catalog, release: undefined } as CatalogPort);
    expect(bare.slotGameId("Helmet")).toBeUndefined();
    expect(bare.rarityName("rare")).toBeUndefined();
  });
});

describe("guide routes", () => {
  const get = (url: string, a: ReturnType<typeof app>) => a.inject({ method: "GET", url, headers });

  it("serves a stored guide and refuses an unknown or damaged one", async () => {
    const a = app((id) => (id === GUIDE_ID ? stored : id === "bad" ? { nope: 1 } : undefined));
    const ok = await get(`/api/guides/${GUIDE_ID}`, a);
    expect(ok.statusCode).toBe(200);
    expect(ok.json<{ metadata: { guideId: string } }>().metadata.guideId).toBe(GUIDE_ID);
    expect((await get("/api/guides/unknown", a)).statusCode).toBe(404);
    expect((await get("/api/guides/bad", a)).statusCode).toBe(400);
  });

  it("lists guides with names and says which ones it cannot read", async () => {
    const a = app(
      (id) => (id === GUIDE_ID ? stored : { nope: 1 }),
      undefined,
      () => [GUIDE_ID, "bad"],
    );
    const res = await get("/api/guides", a);
    expect(res.statusCode).toBe(200);
    const body = res.json<{ guides: Record<string, unknown>[] }>();
    expect(body.guides[0]).toMatchObject({
      guideId: GUIDE_ID,
      dataReleaseId: RELEASE,
      ascendancyId: "fixture_asc",
      current: true,
      origin: "imported",
    });
    expect(body.guides[1]).toEqual({ guideId: "bad", error: "The stored guide cannot be read." });
  });

  it("keeps listing when reading one stored guide throws, and omits unknown names", async () => {
    const a = app(
      (id) => {
        if (id === "broken") throw new Error("damaged run record");
        return stored;
      },
      undefined,
      () => ["broken", GUIDE_ID],
    );
    const body = (await get("/api/guides", a)).json<{ guides: Record<string, unknown>[] }>();
    expect(body.guides[0]).toEqual({
      guideId: "broken",
      error: "The stored guide cannot be read.",
    });
    expect(body.guides[1]).toMatchObject({ guideId: GUIDE_ID });
    // The fixture catalog knows neither the guide's main skill nor its ascendancy by name.
    expect(Object.keys(body.guides[1] ?? {})).not.toContain("mainSkillName");
    expect(Object.keys(body.guides[1] ?? {})).not.toContain("ascendancyName");
  });

  it("needs the access token and the run store", async () => {
    const a = app(
      () => stored,
      undefined,
      () => [],
    );
    expect(
      (await a.inject({ method: "GET", url: "/api/guides", headers: { host: headers.host } }))
        .statusCode,
    ).toBe(401);
    expect((await get("/api/guides", app(undefined))).statusCode).toBe(400);
  });
});

describe("GET /api/guides/:guideId/view?revision", () => {
  it("returns an earlier revision of the run's guide and says when there is none", async () => {
    const older = {
      ...(stored as object),
      metadata: { ...(stored as { metadata: object }).metadata, revision: 0 },
    };
    const a = app(
      () => stored,
      undefined,
      undefined,
      undefined,
      () => ({ revisions: [older] }),
    );
    const ok = await a.inject({
      method: "GET",
      url: `/api/guides/${GUIDE_ID}/view?revision=0`,
      headers,
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json<{ guide: { metadata: { revision: number } } }>().guide.metadata.revision).toBe(
      0,
    );
    const missing = await a.inject({
      method: "GET",
      url: `/api/guides/${GUIDE_ID}/view?revision=3`,
      headers,
    });
    expect(missing.statusCode).toBe(404);
  });
});

describe("GET /api/guides/:guideId/view", () => {
  it("returns the guide with names and the stored results it can find, and lists the rest", async () => {
    const a = app(() => stored);
    const res = await a.inject({
      method: "GET",
      url: `/api/guides/${GUIDE_ID}/view`,
      headers,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      guide: { metadata: { guideId: string } };
      names: Record<string, string>;
      results: Record<string, unknown>;
      unresolved: string[];
    }>();
    expect(body.guide.metadata.guideId).toBe(GUIDE_ID);
    // The fixture catalog knows none of the fixture guide's entities, and the fake calc none of its calc ids.
    expect(body.unresolved).toContain("gem:Fixture/Gems/Main");
    expect(body.unresolved).toContain("calc:calc-1");
    expect(body.names).toEqual({});
    expect(body.results).toEqual({});
    expect(body).toMatchObject({ catalogReleaseId: RELEASE, current: true });
  });

  it("passes a valid stored result through the contract and lists a damaged one", async () => {
    const calc = {
      getResult: (id: string) =>
        Promise.resolve(
          id === "calc-1" ? validResult : id === "calc-2" ? { calcId: id, stats: {} } : undefined,
        ),
    } as unknown as CalcPort;
    const res = await app(() => stored, undefined, undefined, calc).inject({
      method: "GET",
      url: `/api/guides/${GUIDE_ID}/view`,
      headers,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ results: Record<string, unknown>; unresolved: string[] }>();
    expect(body.results["calc-1"]).toEqual(validResult);
    expect(body.unresolved).not.toContain("calc:calc-1");
    if (JSON.stringify(stored).includes("calc-2")) expect(body.unresolved).toContain("calc:calc-2");
  });

  it("marks a guide of another release and resolves no names for it", async () => {
    const older = {
      ...stored,
      metadata: { ...stored.metadata, dataReleaseId: "poe2-0.0.1+r1" },
    };
    const catalog = fixtureCatalog();
    const known = {
      ...catalog,
      get: () => ({ kind: "gem", id: "x", name: "Would be wrong", entity: {} }),
    } as unknown as CatalogPort;
    const res = await app(() => older, known).inject({
      method: "GET",
      url: `/api/guides/${GUIDE_ID}/view`,
      headers,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      current: boolean;
      catalogReleaseId: string;
      names: Record<string, string>;
      unresolved: string[];
    }>();
    expect(body.current).toBe(false);
    expect(body.catalogReleaseId).toBe(RELEASE);
    expect(body.names).toEqual({});
    expect(body.unresolved).toContain("gem:Fixture/Gems/Main");
  });

  it("needs the access token", async () => {
    const res = await app(() => stored).inject({
      method: "GET",
      url: `/api/guides/${GUIDE_ID}/view`,
      headers: { host: headers.host },
    });
    expect(res.statusCode).toBe(401);
  });

  it("answers 404 for an unknown guide and 400 for a damaged one", async () => {
    const missing = await app(() => undefined).inject({
      method: "GET",
      url: `/api/guides/${GUIDE_ID}/view`,
      headers,
    });
    expect(missing.statusCode).toBe(404);
    const damaged = await app(() => ({ nope: 1 })).inject({
      method: "GET",
      url: `/api/guides/${GUIDE_ID}/view`,
      headers,
    });
    expect(damaged.statusCode).toBe(400);
  });
});

describe("buildGuideView", () => {
  it("resolves names and stored results and lists the rest", async () => {
    const { buildGuideView } = await import("../src/guides/guide-view.js");
    const { PublishedGuide } = await import("@astrolabe/contracts/guide");
    const guideDoc = PublishedGuide.parse(stored);
    const catalog = {
      dataReleaseId: RELEASE,
      get: (ref: { kind: string; id: string }) =>
        ref.kind === "gem" && ref.id === "Fixture/Gems/Main"
          ? { kind: "gem", id: ref.id, name: "Main Skill", entity: {} }
          : undefined,
    } as unknown as CatalogPort;
    const result = validResult;
    const calc = {
      getResult: (id: string) => Promise.resolve(id === "calc-1" ? result : undefined),
    } as never;
    const view = await buildGuideView(guideDoc, catalog, calc);
    expect(view.names["gem:Fixture/Gems/Main"]).toBe("Main Skill");
    expect(view.results["calc-1"]).toEqual(result);
    const wrongKey = await buildGuideView(guideDoc, catalog, {
      getResult: () => Promise.resolve({ ...result, calcId: "other" }),
    } as never);
    expect(wrongKey.results["calc-1"]).toBeUndefined();
    expect(wrongKey.unresolved).toContain("calc:calc-1");
    expect(view.unresolved).not.toContain("gem:Fixture/Gems/Main");
    expect(view.unresolved).not.toContain("calc:calc-1");
    expect(view.unresolved.length).toBeGreaterThan(0);
  });
});

describe("refName", () => {
  const modEntity = {
    id: "Fixture/Mod",
    groups: [],
    generationType: "prefix",
    domains: ["item"],
    requiredLevel: 1,
    stats: [],
    spawnWeights: [],
    text: "+10 to Strength\n+5 to Dexterity",
  };
  const catalog = {
    dataReleaseId: RELEASE,
    get: (ref: { kind: string; id: string }) =>
      ref.id === "Fixture/Mod"
        ? { ...ref, entity: modEntity }
        : ref.id === "Fixture/Gem"
          ? { ...ref, name: "Gem Name", entity: {} }
          : undefined,
  } as unknown as CatalogPort;

  it("uses the rendered text of a mod as its name", async () => {
    const { refName } = await import("../src/guides/guide-view.js");
    expect(refName(catalog, "mod", "Fixture/Mod")).toBe("+10 to Strength; +5 to Dexterity");
  });

  it("leaves a mod without usable text undefined", async () => {
    const { refName } = await import("../src/guides/guide-view.js");
    const of = (entity: unknown): CatalogPort =>
      ({
        dataReleaseId: RELEASE,
        get: (ref: object) => ({ ...ref, entity }),
      }) as unknown as CatalogPort;
    expect(refName(of({ ...modEntity, text: undefined }), "mod", "x")).toBeUndefined();
    expect(refName(of({ ...modEntity, text: "" }), "mod", "x")).toBeUndefined();
    expect(refName(of({ ...modEntity, text: " \n " }), "mod", "x")).toBeUndefined();
    expect(refName(of({ nonsense: true }), "mod", "x")).toBeUndefined();
    expect(refName(of({}), "gem", "x")).toBeUndefined();
  });

  it("prefers a real name and leaves unknown or nameless non-mods undefined", async () => {
    const { refName } = await import("../src/guides/guide-view.js");
    expect(refName(catalog, "gem", "Fixture/Gem")).toBe("Gem Name");
    expect(refName(catalog, "mod", "Fixture/Nope")).toBeUndefined();
  });
});

describe("buildGuideView gear cards", () => {
  const entities: Record<string, unknown> = {
    "uniqueItem:Fixture Unique": {
      id: "Fixture Unique",
      name: "Fixture Unique Name",
      baseItemId: "Fixture/Base",
      mods: [{ text: "Unique line", stats: [], unresolved: [] }],
      variants: [],
      dropSources: [],
    },
    "baseItem:Fixture/Base": {
      id: "Fixture/Base",
      name: "Fixture Base",
      itemClass: "fixture_class",
      tags: [],
      requirements: {},
      implicitModIds: ["Fixture/Implicit"],
      properties: {},
    },
    "mod:Fixture/Implicit": {
      id: "Fixture/Implicit",
      groups: [],
      generationType: "implicit",
      domains: ["item"],
      requiredLevel: 1,
      stats: [],
      spawnWeights: [],
      text: "Implicit text",
    },
  };
  const catalog = {
    dataReleaseId: RELEASE,
    get: (ref: { kind: string; id: string }) => {
      const entity = entities[`${ref.kind}:${ref.id}`];
      return entity === undefined ? undefined : { ...ref, name: "n", entity };
    },
  } as unknown as CatalogPort;
  const calc = { getResult: () => Promise.resolve(undefined) } as never;

  it("describes the unique of the gear plan from the catalog", async () => {
    const { buildGuideView } = await import("../src/guides/guide-view.js");
    const { PublishedGuide, GuideView } = await import("@astrolabe/contracts/guide");
    const view = await buildGuideView(PublishedGuide.parse(stored), catalog, calc);
    expect(() => GuideView.parse(view)).not.toThrow();
    const card = view.gear[0]?.target;
    expect(card).toMatchObject({
      kind: "unique",
      name: "Fixture Unique Name",
      baseName: "Fixture Base",
    });
    expect(card?.implicits[0]?.text).toBe("Implicit text");
    expect(card?.explicits[0]?.text).toBe("Unique line");
  });

  it("gives no card and lists the entry when the catalog does not know the item", async () => {
    const { buildGuideView } = await import("../src/guides/guide-view.js");
    const { PublishedGuide } = await import("@astrolabe/contracts/guide");
    const empty = { dataReleaseId: RELEASE, get: () => undefined } as unknown as CatalogPort;
    const view = await buildGuideView(PublishedGuide.parse(stored), empty, calc);
    expect(view.gear[0]?.target).toBeNull();
    expect(view.unresolved).toContain("uniqueItem:Fixture Unique");
  });

  async function viewWith(
    patch: (slot: { target: unknown; minimum?: unknown }) => void,
    cat: CatalogPort = catalog,
  ) {
    const { buildGuideView } = await import("../src/guides/guide-view.js");
    const { PublishedGuide } = await import("@astrolabe/contracts/guide");
    const doc = PublishedGuide.parse(structuredClone(stored));
    const slot = doc.gear.tiers[0]?.slots[0];
    if (slot === undefined) throw new Error("fixture has no gear slot");
    patch(slot as never);
    return buildGuideView(doc, cat, calc);
  }

  const withRarities = {
    dataReleaseId: RELEASE,
    release: { rarities: { rarities: [{ id: "rare_id", name: "Rare" }] } },
    get: catalog.get,
  } as unknown as CatalogPort;

  it("describes a crafted item with the rarity name of the release and its mod tiers", async () => {
    entities["mod:Fixture/Prefix"] = {
      id: "Fixture/Prefix",
      groups: [],
      generationType: "prefix",
      domains: ["item"],
      tier: 2,
      requiredLevel: 1,
      stats: [],
      spawnWeights: [],
      text: "Prefix text",
    };
    const view = await viewWith((slot) => {
      slot.target = {
        kind: "crafted",
        baseItemId: "Fixture/Base",
        rarity: "rare_id",
        mods: [
          { modId: "Fixture/Prefix", rollFraction: 0.5, required: true },
          { modId: "Fixture/Missing", rollFraction: 0.5, required: true },
        ],
        socketables: [],
      };
      slot.minimum = { kind: "unique", uniqueId: "Fixture Unique" };
    }, withRarities);
    const card = view.gear[0]?.target;
    expect(card).toMatchObject({ kind: "crafted", rarityId: "rare_id", rarityName: "Rare" });
    expect(card?.explicits[0]).toMatchObject({
      text: "Prefix text",
      generationType: "prefix",
      tier: 2,
    });
    expect(card?.explicits[1]).toEqual({ modId: "Fixture/Missing" });
    expect(view.unresolved).toContain("mod:Fixture/Missing");
    expect(view.gear[0]?.minimum).toMatchObject({ kind: "unique", name: "Fixture Unique Name" });
  });

  it("leaves the rarity name out and lists the rarity when the release does not know it", async () => {
    const view = await viewWith((slot) => {
      slot.target = {
        kind: "crafted",
        baseItemId: "Fixture/Base",
        rarity: "unknown_rarity",
        mods: [],
        socketables: [],
      };
    }, withRarities);
    expect(view.gear[0]?.target?.rarityName).toBeUndefined();
    expect(view.gear[0]?.target?.rarityId).toBe("unknown_rarity");
    expect(view.unresolved).toContain("rarity:unknown_rarity");
  });

  it("gives no cards and reads no entity for a guide of another release", async () => {
    let reads = 0;
    const counting = {
      dataReleaseId: "poe2-0.0.1+r1",
      get: (ref: { kind: string; id: string }) => {
        reads += 1;
        return catalog.get(ref as never);
      },
    } as unknown as CatalogPort;
    const view = await viewWith(() => {}, counting);
    expect(view.current).toBe(false);
    expect(view.gear[0]?.target).toBeNull();
    expect(reads).toBe(0);
  });

  it("shows only the lines of the chosen unique variant", async () => {
    entities["uniqueItem:Fixture Unique"] = {
      ...(entities["uniqueItem:Fixture Unique"] as object),
      mods: [
        { text: "All variants", stats: [], unresolved: [] },
        { text: "Variant A only", stats: [], unresolved: [], variantIds: ["a"] },
        { text: "Variant B only", stats: [], unresolved: [], variantIds: ["b"] },
      ],
    };
    const view = await viewWith((slot) => {
      slot.target = { kind: "unique", uniqueId: "Fixture Unique", variantId: "a" };
    });
    expect(view.gear[0]?.target?.explicits.map((l) => l.text)).toEqual([
      "All variants",
      "Variant A only",
    ]);
  });

  it("treats a catalog entity that breaks its schema as unknown", async () => {
    entities["baseItem:Fixture/Base"] = { id: "Fixture/Base" };
    const view = await viewWith(() => {});
    expect(view.gear[0]?.target).toBeNull();
    expect(view.unresolved).toContain("baseItem:Fixture/Base");
  });
});

describe("GET /api/tree", () => {
  const node = {
    id: "Fixture/Node",
    name: "Fixture Node",
    kind: "small",
    stats: [],
    position: { groupId: "g1", orbit: 0, orbitIndex: 0 },
    connections: [],
  };
  const catalog = {
    dataReleaseId: RELEASE,
    list: (kind: string) =>
      kind === "passiveNode"
        ? [
            { kind, id: node.id, entity: node },
            { kind, id: "Broken", entity: { id: "Broken" } },
          ]
        : [],
    get: () => undefined,
  } as unknown as CatalogPort;

  it("lists the nodes of the release and names the entries it cannot read", async () => {
    const res = await app(undefined, catalog).inject({
      method: "GET",
      url: "/api/tree",
      headers,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      dataReleaseId: string;
      passiveNodes: { id: string }[];
      skipped: string[];
    }>();
    expect(body.dataReleaseId).toBe(RELEASE);
    expect(body.passiveNodes.map((n) => n.id)).toEqual(["Fixture/Node"]);
    expect(body.skipped).toEqual(["passiveNode:Broken"]);
  });

  it("needs the access token", async () => {
    const res = await app(undefined, catalog).inject({
      method: "GET",
      url: "/api/tree",
      headers: { host: headers.host },
    });
    expect(res.statusCode).toBe(401);
  });
});
