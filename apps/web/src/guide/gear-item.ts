import type { ItemModView, ItemView } from "@astrolabe/ui";
import type { GuideItemCard, GuideItemLine } from "@astrolabe/contracts/guide";

const RARITY_BY_NAME = { normal: "normal", magic: "magic", rare: "rare" } as const;

/** The look of the card; null when the release gives no (known) name for the rarity. */
export function rarityOf(card: GuideItemCard): ItemView["rarity"] | null {
  if (card.kind === "unique") return "unique";
  const key = card.rarityName?.toLowerCase() ?? "";
  return key in RARITY_BY_NAME ? RARITY_BY_NAME[key as keyof typeof RARITY_BY_NAME] : null;
}

function modView(line: GuideItemLine, index: number, implicit: boolean): ItemModView {
  return {
    id: line.modId ?? `line-${index}`,
    text: line.text ?? `Unknown modifier${line.modId === undefined ? "" : ` (${line.modId})`}`,
    // Tiers are not shown on guide cards, so the prefix/suffix split stays invisible here.
    kind: implicit ? "implicit" : line.generationType === "suffix" ? "suffix" : "prefix",
    ...(line.tier === undefined ? {} : { tier: line.tier }),
  };
}

export function toItemView(
  card: GuideItemCard,
  id: string,
  dataRelease: string,
  acquisition?: string,
): ItemView {
  return {
    id,
    // An unknown rarity gets the plain look and a visible note next to the card.
    rarity: rarityOf(card) ?? "normal",
    ...(card.name === undefined ? {} : { name: card.name }),
    baseType: card.baseName,
    itemClass: card.itemClass,
    properties: [],
    requirements: [],
    implicits: card.implicits.map((l, i) => modView(l, i, true)),
    explicits: card.explicits.map((l, i) => modView(l, i, false)),
    ...(acquisition === undefined ? {} : { acquisition }),
    provenance: { kind: "gamedata", dataRelease },
  };
}
