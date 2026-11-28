import type { CalcOutcome, ProgressionStage } from "@astrolabe/contracts/build";
import type { GuideGearEntry, GuideItemCard, GuideView } from "@astrolabe/contracts/guide";
import { GUIDE_STATS } from "./guide-stats";
import { nameOf } from "./RichTextView";

/*
 * What a comment changed: two revisions of one guide side by side. Numbers are the stored Path of
 * Building results of each revision, read the same way as the stage numbers (first profile of the
 * stage that has an outcome); a stat one side does not have is shown as missing, never as 0.
 */

export interface StatChange {
  readonly stage: string;
  readonly stat: string;
  readonly label: string;
  /** Undefined where that revision has no value for the stat. */
  readonly before: number | undefined;
  readonly after: number | undefined;
}

export interface SkillChange {
  readonly stage: string;
  readonly added: readonly string[];
  readonly removed: readonly string[];
}

export interface GearChange {
  readonly tier: string;
  readonly slot: string;
  readonly before: string | undefined;
  readonly after: string | undefined;
}

export interface RevisionDiff {
  readonly stats: readonly StatChange[];
  readonly skills: readonly SkillChange[];
  readonly gear: readonly GearChange[];
  readonly craftingAdded: readonly string[];
  readonly craftingRemoved: readonly string[];
  /** Stages only one revision has, by label. */
  readonly stagesAdded: readonly string[];
  readonly stagesRemoved: readonly string[];
  readonly empty: boolean;
}

function statOf(stage: ProgressionStage, stat: string, view: GuideView): number | undefined {
  for (const profile of GUIDE_STATS.calcProfiles) {
    const outcome: CalcOutcome | undefined = stage.calcs[profile];
    if (outcome === undefined) continue;
    if (outcome.status === "failed") return undefined;
    return view.results[outcome.calcId]?.stats[stat];
  }
  return undefined;
}

function gemNames(stage: ProgressionStage, view: GuideView): string[] {
  return stage.state.skills.flatMap((s) =>
    [s.gem.gemId, ...s.supports.map((x) => x.gemId)].map(
      (id) => nameOf(view, { kind: "gem", id }) ?? id,
    ),
  );
}

const cardName = (card: GuideItemCard | null | undefined): string | undefined =>
  card === null || card === undefined ? undefined : (card.name ?? card.baseName);

/** Items count as the same when their card is the same (name, base and every line). */
const sameCard = (a: GuideItemCard | null, b: GuideItemCard | null): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

export function diffRevisions(before: GuideView, after: GuideView): RevisionDiff {
  const oldStages = new Map(before.guide.progression.stages.map((s) => [s.key, s]));
  const newStages = new Map(after.guide.progression.stages.map((s) => [s.key, s]));
  const stats: StatChange[] = [];
  const skills: SkillChange[] = [];
  for (const [key, stage] of newStages) {
    const old = oldStages.get(key);
    if (old === undefined) continue;
    for (const s of GUIDE_STATS.stats) {
      const was = statOf(old, s.stat, before);
      const now = statOf(stage, s.stat, after);
      if (was !== now) {
        stats.push({ stage: stage.label, stat: s.stat, label: s.label, before: was, after: now });
      }
    }
    const was = gemNames(old, before);
    const now = gemNames(stage, after);
    const added = now.filter((n) => !was.includes(n));
    const removed = was.filter((n) => !now.includes(n));
    if (added.length > 0 || removed.length > 0) skills.push({ stage: stage.label, added, removed });
  }
  const entryKey = (e: GuideGearEntry): string => `${e.budgetTier}\u0000${e.slot}`;
  const oldGear = new Map(before.gear.map((e) => [entryKey(e), e]));
  const gear: GearChange[] = [];
  for (const e of after.gear) {
    const old = oldGear.get(entryKey(e));
    if (old === undefined) {
      gear.push({ tier: e.budgetTier, slot: e.slot, before: undefined, after: cardName(e.target) });
    } else if (!sameCard(old.target, e.target)) {
      gear.push({
        tier: e.budgetTier,
        slot: e.slot,
        before: cardName(old.target),
        after: cardName(e.target),
      });
    }
    oldGear.delete(entryKey(e));
  }
  for (const old of oldGear.values()) {
    gear.push({
      tier: old.budgetTier,
      slot: old.slot,
      before: cardName(old.target),
      after: undefined,
    });
  }
  const oldPlans = new Set(before.guide.crafting.map((p) => p.key));
  const newPlans = new Set(after.guide.crafting.map((p) => p.key));
  const craftingAdded = after.guide.crafting.filter((p) => !oldPlans.has(p.key)).map((p) => p.slot);
  const craftingRemoved = before.guide.crafting
    .filter((p) => !newPlans.has(p.key))
    .map((p) => p.slot);
  const stagesAdded = [...newStages].filter(([k]) => !oldStages.has(k)).map(([, s]) => s.label);
  const stagesRemoved = [...oldStages].filter(([k]) => !newStages.has(k)).map(([, s]) => s.label);
  return {
    stats,
    skills,
    gear,
    craftingAdded,
    craftingRemoved,
    stagesAdded,
    stagesRemoved,
    empty:
      stats.length +
        skills.length +
        gear.length +
        craftingAdded.length +
        craftingRemoved.length +
        stagesAdded.length +
        stagesRemoved.length ===
      0,
  };
}
