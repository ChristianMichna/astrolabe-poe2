import { z } from "zod";
import type { PublishedGuide } from "@astrolabe/contracts/guide";

/*
 * The `.build` file of the game's Build Planner (format "Version 1 (Experimental)"): JSON with
 * passives, skills (with supports) and inventory hints, each with a level interval. Item values
 * and meta gems are not part of the format.
 */

const LevelInterval = z
  .tuple([z.int().nonnegative(), z.int().nonnegative()])
  .refine(([from, to]) => from <= to, {
    message: "a level interval must not end before it starts",
  });

export const BuildFile = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  ascendancy: z.string().min(1).optional(),
  passives: z.array(
    z.object({
      id: z.string().min(1),
      level_interval: LevelInterval,
      weapon_set: z.int().min(0).max(2).optional(),
    }),
  ),
  skills: z.array(
    z.object({
      id: z.string().min(1),
      level_interval: LevelInterval,
      support_skills: z.array(z.object({ id: z.string().min(1), level_interval: LevelInterval })),
    }),
  ),
  inventory_slots: z.array(
    z.object({
      inventory_id: z.string().min(1),
      level_interval: LevelInterval,
      unique_name: z.string().min(1).optional(),
      additional_text: z.string().optional(),
    }),
  ),
});
export type BuildFile = z.infer<typeof BuildFile>;

/** What the exporter cannot know itself: the game's own ids and names for catalog entities. */
export interface BuildFileResolvers {
  /** The game's string id of a passive node (`PassiveSkills.Id`); undefined if the release has none. */
  passiveGameId(nodeId: string): string | undefined;
  /** The game's inventory id of a slot (`Inventories.Id`); undefined for slots without one. */
  slotGameId(slotId: string): string | undefined;
  /** The unique's name as the game lists it; undefined if the catalog does not know it. */
  uniqueName(uniqueId: string): string | undefined;
  /** The ascendancy as the game names it (the example of the format is "Warrior1"). */
  ascendancyName(ascendancyId: string): string | undefined;
  /** Display name of a rarity classification of the release. */
  rarityName(rarityId: string): string | undefined;
  /** Display name of a catalog entity (base item or mod). */
  entityName(ref: { kind: "baseItem" | "mod"; id: string }): string | undefined;
}

export interface BuildFileResult {
  file: BuildFile;
  /** Everything left out because the game id or name is missing; never filled with a guess. */
  omitted: string[];
}

type Stage = PublishedGuide["progression"]["stages"][number];
type Interval = [number, number];

interface Run {
  subject: string;
  value: string;
  interval: Interval;
  firstStage: number;
  lastStage: number;
}

/**
 * Runs of consecutive stages in which `keyOf` returns the same value for a subject: one run is
 * one entry of the file, spanning from the first level of its first stage to the last level of its
 * last stage.
 */
function runs(
  stages: readonly Stage[],
  subjects: (stage: Stage) => ReadonlyMap<string, string>,
): Run[] {
  const out: Run[] = [];
  const open = new Map<string, Run>();
  stages.forEach((stage, index) => {
    const now = subjects(stage);
    for (const [subject, run] of [...open]) {
      if (now.get(subject) !== run.value) open.delete(subject);
    }
    for (const [subject, value] of now) {
      const run = open.get(subject);
      if (run === undefined) {
        const fresh = {
          subject,
          value,
          interval: [stage.levelRange[0], stage.levelRange[1]] as Interval,
          firstStage: index,
          lastStage: index,
        };
        out.push(fresh);
        open.set(subject, fresh);
      } else {
        run.interval = [run.interval[0], stage.levelRange[1]];
        run.lastStage = index;
      }
    }
  });
  return out;
}

/** The guide as `.build` content. Missing game ids are listed in `omitted`, never invented. */
export function guideToBuildFile(
  guide: PublishedGuide,
  resolve: BuildFileResolvers,
  name: string,
): BuildFileResult {
  const omitted: string[] = [];
  const stages = [...guide.progression.stages].sort((a, b) => a.order - b.order);
  if (stages.length === 0) throw new Error("The guide has no progression stage to export");
  stages.forEach((s, i) => {
    const before = stages[i - 1];
    if (
      before !== undefined &&
      (s.levelRange[0] < before.levelRange[0] || s.levelRange[1] < before.levelRange[1])
    ) {
      throw new Error(`Stage ${s.key} does not follow ${before.key} in level order`);
    }
  });

  const passiveRuns = runs(stages, (s) => {
    const nodes = new Map<string, string>();
    for (const n of s.state.tree.allocated) nodes.set(n.nodeId, String(n.weaponSet));
    for (const n of s.state.tree.ascendancy) nodes.set(n, "0");
    return nodes;
  });
  const orderOf = new Map<string, number>();
  stages.forEach((s) => s.allocationOrder.forEach((n, i) => orderOf.set(`${s.key}/${n}`, i)));
  const passives = passiveRuns
    .sort(
      (a, b) =>
        a.firstStage - b.firstStage ||
        (orderOf.get(`${stages[a.firstStage]?.key ?? ""}/${a.subject}`) ?? Infinity) -
          (orderOf.get(`${stages[b.firstStage]?.key ?? ""}/${b.subject}`) ?? Infinity),
    )
    .flatMap((r) => {
      const id = resolve.passiveGameId(r.subject);
      if (id === undefined) {
        omitted.push(`passive ${r.subject}: the release has no game id`);
        return [];
      }
      const set = Number(r.value);
      if (set > 2) {
        omitted.push(
          `passive ${r.subject}: weapon set ${String(set)} is not in the format (0 to 2)`,
        );
        return [];
      }
      // Set 0 (no weapon set) is left out; whether the game wants it written is untested.
      return [{ id, level_interval: r.interval, ...(set > 0 ? { weapon_set: set } : {}) }];
    });

  // A skill entry spans the stages in which the active gem stays the same; supports likewise.
  const skillRuns = runs(stages, (s) => new Map(s.state.skills.map((k) => [k.key, k.gem.gemId])));
  const skills = skillRuns.map((r) => {
    const supportRuns = runs(stages.slice(r.firstStage, r.lastStage + 1), (s) => {
      const skill = s.state.skills.find((k) => k.key === r.subject);
      return new Map((skill?.supports ?? []).map((g) => [g.gemId, g.gemId]));
    });
    return {
      id: r.value,
      level_interval: r.interval,
      support_skills: supportRuns.map((sr) => ({ id: sr.value, level_interval: sr.interval })),
    };
  });

  const itemText = (item: Stage["state"]["items"][number]["item"]): string | undefined => {
    if (item.kind === "unique") return undefined;
    const base = resolve.entityName({ kind: "baseItem", id: item.baseItemId });
    if (base === undefined) {
      omitted.push(`base item ${item.baseItemId}: no name`);
      return undefined;
    }
    const rarity = resolve.rarityName(item.rarity);
    if (rarity === undefined) {
      omitted.push(`rarity ${item.rarity}: no name`);
      return undefined;
    }
    const mods: string[] = [];
    for (const m of item.mods.filter((x) => x.required)) {
      const modName = resolve.entityName({ kind: "mod", id: m.modId });
      if (modName === undefined) omitted.push(`mod ${m.modId}: no name, left out of the item text`);
      else mods.push(modName);
    }
    return `${rarity} ${base}${mods.length > 0 ? `: ${mods.join(", ")}` : ""}`;
  };
  const itemKey = (item: Stage["state"]["items"][number]["item"]): string =>
    item.kind === "unique"
      ? `unique:${item.uniqueId}`
      : `crafted:${item.baseItemId}:${item.rarity}:${item.mods
          .map((m) => `${m.modId}${m.required ? "!" : "?"}`)
          .sort()
          .join(",")}`;
  const itemOf = new Map<string, Stage["state"]["items"][number]["item"]>();
  // A crafted item without modifiers is the weapon the calculation wears so that attack skills
  // deal damage (S3), not a recommendation: it is left out and named once per slot.
  const placeholders = new Set<string>();
  const itemRuns = runs(stages, (s) => {
    const slots = new Map<string, string>();
    for (const e of s.state.items) {
      if (e.item.kind === "crafted" && e.item.mods.length === 0) {
        placeholders.add(e.slot);
        continue;
      }
      const key = itemKey(e.item);
      slots.set(e.slot, key);
      itemOf.set(key, e.item);
    }
    return slots;
  });
  for (const slot of placeholders) {
    omitted.push(
      `slot ${slot}: an item without modifiers is a measuring placeholder, left out of the file`,
    );
  }
  const inventory_slots = itemRuns.flatMap((r): BuildFile["inventory_slots"] => {
    const inventoryId = resolve.slotGameId(r.subject);
    if (inventoryId === undefined) {
      omitted.push(`slot ${r.subject}: the release has no inventory id`);
      return [];
    }
    const item = itemOf.get(r.value);
    if (item === undefined) return [];
    if (item.kind === "unique") {
      const unique = resolve.uniqueName(item.uniqueId);
      if (unique === undefined) {
        omitted.push(`unique ${item.uniqueId}: the catalog has no name`);
        return [];
      }
      return [{ inventory_id: inventoryId, level_interval: r.interval, unique_name: unique }];
    }
    const text = itemText(item);
    return text === undefined
      ? []
      : [{ inventory_id: inventoryId, level_interval: r.interval, additional_text: text }];
  });

  const ascendancy = resolve.ascendancyName(guide.summary.ascendancyId);
  if (ascendancy === undefined)
    omitted.push(`ascendancy ${guide.summary.ascendancyId}: no game name`);
  const file = BuildFile.parse({
    name,
    ...(ascendancy === undefined ? {} : { ascendancy }),
    passives,
    skills,
    inventory_slots,
  });
  return { file, omitted };
}
