import { describe, expect, it } from "vitest";
import type { PublishedGuide } from "@astrolabe/contracts/guide";
import { BuildFile, guideToBuildFile } from "../src/build-file.js";

const skill = (gem: string, supports: string[]) => ({
  key: "main",
  role: "main",
  gem: { gemId: gem, level: 1, quality: 0 },
  supports: supports.map((gemId) => ({ gemId, level: 1, quality: 0 })),
});
const stage = (
  key: string,
  order: number,
  levelRange: [number, number],
  nodes: [string, number][],
  skills: object[],
  items: object[] = [],
) => ({
  key,
  order,
  levelRange,
  allocationOrder: nodes.map(([n]) => n),
  state: {
    tree: {
      allocated: nodes.map(([nodeId, weaponSet]) => ({ nodeId, weaponSet })),
      ascendancy: [],
    },
    skills,
    items,
  },
});
const guide = {
  summary: { ascendancyId: "Asc1" },
  progression: {
    stages: [
      stage(
        "a",
        0,
        [1, 10],
        [
          ["n1", 0],
          ["n2", 0],
        ],
        [skill("G", ["S1"])],
      ),
      stage(
        "b",
        1,
        [11, 20],
        [
          ["n1", 0],
          ["n2", 0],
          ["n3", 1],
          ["n9", 0],
        ],
        [skill("G", ["S1", "S2"])],
        [
          { slot: "Ring 1", item: { kind: "unique", uniqueId: "U" } },
          {
            slot: "Weapon 1",
            item: {
              kind: "crafted",
              baseItemId: "Wand",
              rarity: "Rare",
              mods: [{ modId: "M", required: true }],
            },
          },
          { slot: "Weapon 1 Swap", item: { kind: "unique", uniqueId: "U" } },
        ],
      ),
      stage(
        "c",
        2,
        [21, 30],
        [
          ["n1", 0],
          ["n3", 1],
        ],
        [skill("G2", [])],
      ),
    ],
  },
} as never as PublishedGuide;
const resolve = {
  passiveGameId: (id: string) => (id === "n9" ? undefined : `game_${id}`),
  slotGameId: (id: string) => (id === "Weapon 1 Swap" ? undefined : id.replace(" ", "")),
  uniqueName: (id: string) => `Unique ${id}`,
  ascendancyName: (id: string) => id,
  rarityName: (id: string) => id,
  entityName: (r: { id: string }) => `Name ${r.id}`,
};

describe("guideToBuildFile", () => {
  const { file, omitted } = guideToBuildFile(guide, resolve, "Test build");

  it("spans each passive over the stages it stays allocated in", () => {
    expect(file.passives).toEqual([
      { id: "game_n1", level_interval: [1, 30] },
      { id: "game_n2", level_interval: [1, 20] },
      { id: "game_n3", level_interval: [11, 30], weapon_set: 1 },
    ]);
  });

  it("splits a skill where the active gem changes and spans supports separately", () => {
    expect(file.skills).toEqual([
      {
        id: "G",
        level_interval: [1, 20],
        support_skills: [
          { id: "S1", level_interval: [1, 20] },
          { id: "S2", level_interval: [11, 20] },
        ],
      },
      { id: "G2", level_interval: [21, 30], support_skills: [] },
    ]);
  });

  it("names uniques and describes rares", () => {
    expect(file.inventory_slots).toEqual([
      { inventory_id: "Ring1", level_interval: [11, 20], unique_name: "Unique U" },
      {
        inventory_id: "Weapon1",
        level_interval: [11, 20],
        additional_text: "Rare Name Wand: Name M",
      },
    ]);
  });

  it("leaves out the placeholder weapon of the calculation and says so", () => {
    const placeholder = {
      slot: "Weapon 1",
      item: { kind: "crafted", baseItemId: "Wand", rarity: "normal", mods: [] },
    };
    const plain = {
      ...guide,
      progression: {
        stages: [stage("a", 0, [1, 10], [["n1", 0]], [skill("G", [])], [placeholder])],
      },
    } as never as PublishedGuide;
    const out = guideToBuildFile(plain, resolve, "Test build");
    expect(out.file.inventory_slots).toEqual([]);
    expect(out.omitted).toEqual([
      "slot Weapon 1: an item without modifiers is a measuring placeholder, left out of the file",
    ]);
  });

  it("lists what has no game id instead of guessing", () => {
    expect(omitted).toEqual([
      "passive n9: the release has no game id",
      "slot Weapon 1 Swap: the release has no inventory id",
    ]);
  });

  it("produces a file that satisfies the format schema", () => {
    expect(BuildFile.safeParse(file).success).toBe(true);
    expect(file.ascendancy).toBe("Asc1");
  });
});

describe("guideToBuildFile edge cases", () => {
  const withStages = (stages: object[]) =>
    ({ summary: { ascendancyId: "Asc1" }, progression: { stages } }) as never as PublishedGuide;

  it("attributes supports to the skill run of their own stages when level ranges touch", () => {
    const g = withStages([
      stage("a", 0, [1, 20], [["n1", 0]], [skill("G", ["S1"])]),
      stage("b", 1, [20, 30], [["n1", 0]], [skill("G2", ["S2"])]),
    ]);
    expect(guideToBuildFile(g, resolve, "x").file.skills).toEqual([
      { id: "G", level_interval: [1, 20], support_skills: [{ id: "S1", level_interval: [1, 20] }] },
      {
        id: "G2",
        level_interval: [20, 30],
        support_skills: [{ id: "S2", level_interval: [20, 30] }],
      },
    ]);
  });

  it("writes a re-allocated passive as two entries and rejects weapon sets above 2", () => {
    const g = withStages([
      stage(
        "a",
        0,
        [1, 10],
        [
          ["n1", 0],
          ["n2", 3],
        ],
        [],
      ),
      stage("b", 1, [11, 20], [["n2", 3]], []),
      stage(
        "c",
        2,
        [21, 30],
        [
          ["n1", 0],
          ["n2", 3],
        ],
        [],
      ),
    ]);
    const { file, omitted } = guideToBuildFile(g, resolve, "x");
    expect(file.passives).toEqual([
      { id: "game_n1", level_interval: [1, 10] },
      { id: "game_n1", level_interval: [21, 30] },
    ]);
    expect(omitted.some((o) => o.includes("weapon set 3"))).toBe(true);
  });

  it("lists every missing name instead of dropping it", () => {
    const g = withStages([
      stage(
        "a",
        0,
        [1, 10],
        [],
        [],
        [
          {
            slot: "Weapon 1",
            item: {
              kind: "crafted",
              baseItemId: "Wand",
              rarity: "Rare",
              mods: [{ modId: "M", required: true }],
            },
          },
          { slot: "Ring 1", item: { kind: "unique", uniqueId: "U" } },
        ],
      ),
    ]);
    const { omitted, file } = guideToBuildFile(
      g,
      {
        ...resolve,
        entityName: (r) => (r.kind === "mod" ? undefined : "Wand"),
        uniqueName: () => undefined,
        ascendancyName: () => undefined,
      },
      "x",
    );
    expect(omitted).toEqual(
      expect.arrayContaining([
        expect.stringContaining("mod M"),
        expect.stringContaining("unique U"),
        expect.stringContaining("ascendancy Asc1"),
      ]),
    );
    expect(file.ascendancy).toBeUndefined();
  });

  it("refuses stages that go back in level and guides without stages", () => {
    const back = withStages([stage("a", 0, [11, 20], [], []), stage("b", 1, [1, 10], [], [])]);
    expect(() => guideToBuildFile(back, resolve, "x")).toThrow(/level order/);
    expect(() => guideToBuildFile(withStages([]), resolve, "x")).toThrow(/no progression stage/);
  });
});
