import type { RichText } from "@astrolabe/contracts/build";
import type { CalcRef, EntityRef } from "@astrolabe/contracts/common";
import type { PublishedGuide } from "@astrolabe/contracts/guide";

/** What the exporter cannot know itself: catalog names and numbers of stored calculations. */
export interface MarkdownResolvers {
  /** Display name of a catalog entity; undefined if the catalog does not know it. */
  entityName(ref: EntityRef): string | undefined;
  /** Value of a stored calculation's stat; undefined if the calculation or stat is unknown. */
  statValue(ref: CalcRef): number | undefined;
}

type Measured<T> =
  | { status: "ok"; value: T }
  | { status: "uncalibrated"; reason: string }
  | { status: "failed"; error: { code: string; message: string } };

/**
 * The guide as Markdown. Nothing is made up: a reference the resolvers cannot answer makes the
 * export fail with all of them listed, instead of printing a gap or a guess.
 */
export function guideToMarkdown(guide: PublishedGuide, resolve: MarkdownResolvers): string {
  const missing: string[] = [];
  const name = (ref: EntityRef): string => {
    const n = resolve.entityName(ref);
    if (n === undefined) missing.push(`${ref.kind}:${ref.id}`);
    return n ?? ref.id;
  };
  const text = (t: RichText): string =>
    t
      .map((seg) => {
        if (seg.type === "text") return seg.text;
        if (seg.type === "entity") return name(seg.ref);
        if (seg.type === "source") {
          const at = guide.research.findIndex((f) => f.id === seg.id);
          if (at < 0) missing.push(`source:${seg.id}`);
          return at < 0 ? `[${seg.id}]` : `[${at + 1}]`;
        }
        const v = resolve.statValue(seg.ref);
        if (v === undefined) missing.push(`calc:${seg.ref.calcId}/${seg.ref.stat}`);
        return v === undefined ? seg.ref.stat : formatNumber(v);
      })
      .join("");
  const measured = <T>(m: Measured<T>, show: (v: T) => string): string =>
    m.status === "ok"
      ? show(m.value)
      : m.status === "uncalibrated"
        ? `uncalibrated (${m.reason})`
        : `failed (${m.error.message})`;
  const price = (m: Measured<{ amount: number; currencyItemId: string }>): string =>
    measured(
      m,
      (v) => `${formatNumber(v.amount)} ${name({ kind: "baseItem", id: v.currencyItemId })}`,
    );
  const out: string[] = [];
  const h = (level: number, title: string): void => void out.push(`${"#".repeat(level)} ${title}`);
  const para = (t: RichText): void => void out.push(text(t));
  const bullets = (items: readonly RichText[]): void =>
    void out.push(items.map((i) => `- ${text(i)}`).join("\n"));

  const s = guide.summary;
  h(1, `${name({ kind: "gem", id: s.mainSkillId })} guide`);
  out.push(
    `Class ${name({ kind: "characterClass", id: s.classId })}, ${name({ kind: "ascendancy", id: s.ascendancyId })}. ` +
      `Revision ${String(guide.metadata.revision)}, data release ${guide.metadata.dataReleaseId}, PoB ${guide.metadata.pobVersion}.`,
  );
  h(2, "Summary");
  para(s.playstyle);
  para(s.scalingAxes);
  h(3, "Strengths");
  bullets(s.strengths);
  h(3, "Weaknesses");
  bullets(s.weaknesses);

  h(2, "How it works");
  para(guide.mechanics.explanation);
  for (const d of guide.mechanics.decisions) {
    out.push(`- ${d.subject === undefined ? "" : `**${name(d.subject)}**: `}${text(d.reason)}`);
  }

  h(2, "Progression");
  for (const st of guide.progression.stages) {
    h(3, `${st.label} (levels ${String(st.levelRange[0])}–${String(st.levelRange[1])})`);
    bullets(st.tasks);
    if (st.dangers.length > 0) {
      out.push("**Dangers**");
      bullets(st.dangers);
    }
  }

  h(2, "Gear");
  for (const tier of guide.gear.tiers) {
    h(3, tier.budgetTier);
    for (const sl of tier.slots) {
      const target =
        sl.target.kind === "unique"
          ? name({ kind: "uniqueItem", id: sl.target.uniqueId })
          : `rare ${name({ kind: "baseItem", id: sl.target.baseItemId })}`;
      out.push(
        `- **${sl.slot}** (${sl.priority}, ${sl.acquisition}): ${target}, cost ${price(sl.cost)}`,
      );
    }
  }

  if (guide.crafting.length > 0) {
    h(2, "Crafting");
    for (const plan of guide.crafting) {
      h(3, plan.slot);
      for (const step of plan.steps) {
        out.push(
          `${String(step.order + 1)}. ${text(step.goal)} (success ${measured(step.successChance, (v) => formatNumber(v))})`,
        );
      }
      out.push(`Expected total: ${price(plan.expectedTotal)}`);
      if (plan.fallback !== undefined) para(plan.fallback);
    }
  }

  h(2, "Playstyle");
  para(guide.playstyle.rotation);
  para(guide.playstyle.mapping);
  para(guide.playstyle.bossing);
  para(guide.playstyle.positioning);

  h(2, "Atlas");
  para(guide.atlas.strategy);

  if (guide.variants.length > 0) {
    h(2, "Variants");
    for (const v of guide.variants) out.push(`- **${v.kind}**: ${text(v.explanation)}`);
  }
  if (guide.faq.length > 0) {
    h(2, "Troubleshooting");
    for (const f of guide.faq) {
      out.push(`**${text(f.question)}**`);
      para(f.answer);
      if (f.checklist.length > 0) bullets(f.checklist);
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `The guide cannot be exported: ${String(missing.length)} reference(s) could not be resolved: ${[...new Set(missing)].join(", ")}`,
    );
  }
  return `${out.join("\n\n")}\n`;
}

function formatNumber(n: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(n);
}
