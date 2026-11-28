import { ItemSpec } from "@astrolabe/contracts/build";
import { describe, expect, it } from "vitest";
import { itemCard } from "../src/guides/guide-view.js";
import type { CatalogPort } from "../src/ports/catalog.js";

/* Fantasy entities; only the shape matters. */
const entities: Record<string, unknown> = {
  "baseItem:FixBase": {
    id: "FixBase",
    name: "Fixture Base",
    itemClass: "fixture_class",
    tags: [],
    requirements: {},
    implicitModIds: [],
    properties: {},
    icon: "assets/items/Fixture_Base.png",
  },
  "uniqueItem:FixUniqueArt": {
    id: "FixUniqueArt",
    name: "Fixture Unique With Art",
    baseItemId: "FixBase",
    mods: [],
    icon: "assets/items/Fixture_Unique.png",
  },
  "uniqueItem:FixUniquePlain": {
    id: "FixUniquePlain",
    name: "Fixture Unique Without Art",
    baseItemId: "FixBase",
    mods: [],
  },
};
const catalog = {
  get: ({ kind, id }: { kind: string; id: string }) => {
    const entity = entities[`${kind}:${id}`];
    return entity === undefined ? undefined : { entity };
  },
  release: undefined,
} as unknown as CatalogPort;

describe("item card icon", () => {
  it("gives a unique its own image and never the image of its base", () => {
    expect(
      itemCard(ItemSpec.parse({ kind: "unique", uniqueId: "FixUniqueArt" }), catalog, new Set())
        ?.icon,
    ).toBe("assets/items/Fixture_Unique.png");
    expect(
      itemCard(ItemSpec.parse({ kind: "unique", uniqueId: "FixUniquePlain" }), catalog, new Set())
        ?.icon,
    ).toBeUndefined();
  });

  it("gives a crafted item the image of its base", () => {
    const card = itemCard(
      {
        kind: "crafted",
        baseItemId: "FixBase",
        rarity: "fixture_rarity",
        mods: [],
        socketables: [],
      },
      catalog,
      new Set(),
    );
    expect(card?.icon).toBe("assets/items/Fixture_Base.png");
  });
});
