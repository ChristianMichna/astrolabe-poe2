import { CalcResult } from "@astrolabe/contracts/calc";
import { CalcId, type EntityKind } from "@astrolabe/contracts/common";
import { BaseItem, Mod, UniqueItem } from "@astrolabe/contracts/catalog";
import type { ItemSpec } from "@astrolabe/contracts/build";
import type {
  GuideGearEntry,
  GuideItemCard,
  GuideItemLine,
  GuideView,
  PublishedGuide,
} from "@astrolabe/contracts/guide";
import { collectCalcIds } from "@astrolabe/contracts/guide";
import { collectGuideRefs } from "@astrolabe/revalidate";
import type { CalcPort } from "../ports/calc.js";
import type { CatalogPort } from "../ports/catalog.js";

/** The item as the catalog describes it, or null where the catalog lacks it (listed in `unresolved`). */
function itemCard(
  spec: ItemSpec,
  catalog: CatalogPort,
  unresolved: Set<string>,
): GuideItemCard | null {
  const lookup = <T>(
    kind: "baseItem" | "uniqueItem" | "mod",
    id: string,
    schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } },
  ): T | undefined => {
    const parsed = schema.safeParse(catalog.get({ kind, id })?.entity);
    if (parsed.success) return parsed.data;
    unresolved.add(`${kind}:${id}`);
    return undefined;
  };
  const line = (modId: string, extra: Partial<GuideItemLine> = {}): GuideItemLine => {
    const mod = lookup("mod", modId, Mod);
    return {
      modId,
      ...(mod?.text === undefined ? {} : { text: mod.text }),
      ...(mod === undefined ? {} : { generationType: mod.generationType }),
      ...(mod?.tier === undefined ? {} : { tier: mod.tier }),
      ...extra,
    };
  };
  if (spec.kind === "unique") {
    const unique = lookup("uniqueItem", spec.uniqueId, UniqueItem);
    const base = unique && lookup("baseItem", unique.baseItemId, BaseItem);
    if (unique === undefined || base === undefined) return null;
    const lines = unique.mods.filter(
      (m) =>
        spec.variantId === undefined ||
        m.variantIds === undefined ||
        m.variantIds.includes(spec.variantId),
    );
    return {
      kind: "unique",
      name: unique.name,
      baseName: base.name,
      ...(unique.icon === undefined ? {} : { icon: unique.icon }),
      itemClass: base.itemClass,
      implicits: base.implicitModIds.map((id) => line(id)),
      explicits: lines.map((m) => ({
        ...(m.modId === undefined ? {} : { modId: m.modId }),
        ...(m.text === undefined ? {} : { text: m.text }),
      })),
    };
  }
  const base = lookup("baseItem", spec.baseItemId, BaseItem);
  if (base === undefined) return null;
  const rarity = catalog.release?.rarities?.rarities.find((r) => r.id === spec.rarity);
  if (rarity === undefined) unresolved.add(`rarity:${spec.rarity}`);
  return {
    kind: "crafted",
    rarityId: spec.rarity,
    ...(rarity === undefined ? {} : { rarityName: rarity.name }),
    baseName: base.name,
    ...(base.icon === undefined ? {} : { icon: base.icon }),
    itemClass: base.itemClass,
    implicits: base.implicitModIds.map((id) => line(id)),
    explicits: spec.mods.map((m) => line(m.modId)),
  };
}

function gearEntries(
  guide: PublishedGuide,
  catalog: CatalogPort,
  current: boolean,
  unresolved: Set<string>,
): GuideGearEntry[] {
  const card = (spec: ItemSpec): GuideItemCard | null =>
    current ? itemCard(spec, catalog, unresolved) : null;
  return guide.gear.tiers.flatMap((tier) =>
    tier.slots.map((slot) => {
      const minimum = slot.minimum === undefined ? undefined : card(slot.minimum);
      return {
        budgetTier: tier.budgetTier,
        slot: slot.slot,
        target: card(slot.target),
        ...(minimum === undefined ? {} : { minimum }),
        alternatives: slot.alternatives.map(card),
      };
    }),
  );
}

/**
 * The display name of a referenced entity. A mod has no name in the catalog; its rendered text
 * (lines joined with "; ") stands in for it, so a mod id in a guide reads like the game shows it.
 */
export function refName(catalog: CatalogPort, kind: EntityKind, id: string): string | undefined {
  const entry = catalog.get({ kind, id });
  if (entry === undefined) return undefined;
  if (entry.name !== undefined) return entry.name;
  if (kind !== "mod") return undefined;
  const mod = Mod.safeParse(entry.entity);
  if (!mod.success || mod.data.text === undefined) return undefined;
  const lines = mod.data.text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
  return lines.length === 0 ? undefined : lines.join("; ");
}

/**
 * The guide with the names of the entities it refers to and the stored results behind its
 * numbers. A name or result that is not available stays absent and is listed in `unresolved`.
 * A guide of another data release gets no names at all (an id can mean something else there);
 * a stored result that is not a valid result any more is listed, never passed on.
 */
export async function buildGuideView(
  guide: PublishedGuide,
  catalog: CatalogPort,
  calc: CalcPort,
): Promise<GuideView> {
  const current = guide.metadata.dataReleaseId === catalog.dataReleaseId;
  const unresolved = new Set<string>();
  const names: Record<string, string> = {};
  for (const ref of collectGuideRefs(guide)) {
    const key = `${ref.kind}:${ref.id}`;
    if (key in names || unresolved.has(key)) continue;
    const name = current ? refName(catalog, ref.kind, ref.id) : undefined;
    if (name === undefined) unresolved.add(key);
    else names[key] = name;
  }
  const loaded = await Promise.all(
    collectCalcIds(guide).map(async (raw) => {
      const calcId = CalcId.safeParse(raw);
      if (!calcId.success) return { raw, result: undefined };
      return { raw, result: await calc.getResult(calcId.data) };
    }),
  );
  const results: Record<string, CalcResult> = {};
  for (const { raw, result } of loaded) {
    const valid = CalcResult.safeParse(result);
    if (valid.success && valid.data.calcId === raw) results[raw] = valid.data;
    else unresolved.add(`calc:${raw}`);
  }
  const gear = gearEntries(guide, catalog, current, unresolved);
  return {
    guide,
    catalogReleaseId: catalog.dataReleaseId,
    current,
    gear,
    names,
    results,
    unresolved: [...unresolved],
  };
}
