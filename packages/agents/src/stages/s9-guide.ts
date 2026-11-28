import { z } from "zod";
import type {
  ArchetypeCandidate,
  Finding,
  RichText,
  TargetBuild,
} from "@astrolabe/contracts/build";
import {
  GuideAtlas,
  GuideFaqEntry,
  GuideMechanics,
  GuidePlaystyle,
  GuideSummary,
  GuideVariant,
} from "@astrolabe/contracts/guide";
import type { EntityRef, JsonValue } from "@astrolabe/contracts/common";
import type { StageConfig } from "../config.js";
import { defineTask, type AnyTaskSpec, type PipelineContext } from "../pipeline.js";
import { S9_SECTION, S9_SECTION_FOCUS } from "../prompts.js";
import { partFindings } from "../quality/rubric.js";
import { requestContext } from "./context.js";
import { researchContext } from "./s9-research.js";

/** The sections Claude writes, in the order of the guide; the rest of the document is assembled by the app. */
export const S9_SECTIONS = [
  "summary",
  "mechanics",
  "playstyle",
  "atlas",
  "variants",
  "faq",
] as const;
export type S9Section = (typeof S9_SECTIONS)[number];

export const sectionKey = (s: S9Section): string => `S9.${s}`;

/** Summary part Claude writes; class, ascendancy, skill and budget range come from the plans. */
export const SummaryDraft = GuideSummary.omit({
  classId: true,
  ascendancyId: true,
  mainSkillId: true,
  budgetRange: true,
});
export type SummaryDraft = z.infer<typeof SummaryDraft>;

const VariantsDraft = z.object({ variants: z.array(GuideVariant) });
const FaqDraft = z.object({ faq: z.array(GuideFaqEntry).min(1) });

export const sectionSchemas = {
  summary: SummaryDraft,
  mechanics: GuideMechanics,
  playstyle: GuidePlaystyle,
  atlas: GuideAtlas,
  variants: VariantsDraft,
  faq: FaqDraft,
} as const satisfies Record<S9Section, z.ZodType>;

const SEGMENT_TYPES = new Set(["text", "calc", "entity", "source"]);

function isRichText(v: unknown): v is RichText {
  return (
    Array.isArray(v) &&
    v.length > 0 &&
    v.every(
      (s) =>
        typeof s === "object" &&
        s !== null &&
        SEGMENT_TYPES.has((s as { type?: unknown }).type as string),
    )
  );
}

const isRef = (v: unknown): v is EntityRef =>
  typeof v === "object" &&
  v !== null &&
  typeof (v as { kind?: unknown }).kind === "string" &&
  typeof (v as { id?: unknown }).id === "string";

/** All rich text and catalog references of a section payload, with JSON pointers. */
export function walkSection(payload: unknown): {
  texts: { path: string; text: RichText }[];
  entities: { path: string; ref: EntityRef }[];
} {
  const texts: { path: string; text: RichText }[] = [];
  const entities: { path: string; ref: EntityRef }[] = [];
  const walk = (v: unknown, path: string): void => {
    if (isRichText(v)) {
      texts.push({ path, text: v });
      v.forEach((seg, i) => {
        if (seg.type === "entity") entities.push({ path: `${path}/${i}/ref`, ref: seg.ref });
      });
      return;
    }
    if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, `${path}/${i}`));
      return;
    }
    if (typeof v !== "object" || v === null) return;
    for (const [k, x] of Object.entries(v)) {
      if ((k === "subject" || k === "replaces" || k === "gem") && isRef(x)) {
        entities.push({ path: `${path}/${k}`, ref: x });
      } else if (k === "with" && Array.isArray(x)) {
        x.forEach((r, i) => {
          if (isRef(r)) entities.push({ path: `${path}/with/${i}`, ref: r });
        });
      } else if (k === "modId" && typeof x === "string") {
        entities.push({ path: `${path}/modId`, ref: { kind: "mod", id: x } as EntityRef });
      } else walk(x, `${path}/${k}`);
    }
  };
  walk(payload, "");
  return { texts, entities };
}

/** The measurements a section may cite: calc ids of the target build per profile. */
export function citableCalcs(target: TargetBuild): JsonValue {
  return Object.entries(target.calcs).flatMap(([profile, outcome]) =>
    outcome.status === "ok" ? [{ profile, calcId: outcome.calcId }] : [],
  ) as JsonValue;
}

export interface S9Inputs {
  chosen: ArchetypeCandidate;
  target: TargetBuild;
  /** Stored plans of S6 to S8, as JSON for the prompt. */
  plans: { progression: JsonValue; gear: JsonValue; crafting: JsonValue };
}

/** The suitability must cover the mode the player asked for. */
async function summaryCheck(payload: unknown, ctx: PipelineContext): Promise<Finding[]> {
  const summary = payload as SummaryDraft;
  const { suitability } = summary;
  const mode = ctx.run.request.mode;
  const wrong = [
    ...(mode.ssf && !suitability.ssf ? ["solo self-found"] : []),
    ...(mode.hardcore && !suitability.hardcore ? ["hardcore"] : []),
    ...(!mode.hardcore && !suitability.softcore ? ["softcore"] : []),
  ];
  const classes = ctx.catalog.release?.classifications;
  const unknown =
    classes === undefined
      ? []
      : [
          ...summary.damageTypes
            .filter((id) => !classes.damageTypes.includes(id))
            .map((id, i) => ({ id, path: `/damageTypes/${i}`, what: "damage type" })),
          ...summary.defenceLayers
            .filter((id) => !classes.defenceLayers.includes(id))
            .map((id, i) => ({ id, path: `/defenceLayers/${i}`, what: "defence layer" })),
        ];
  const classFindings: Finding[] = [
    ...unknown.map((u) => ({
      gate: "G1" as const,
      severity: "error" as const,
      code: "unknown_classification",
      message: `${u.id} is not a ${u.what} of data release ${ctx.catalog.dataReleaseId}.`,
      path: u.path,
    })),
    ...(classes === undefined
      ? [
          {
            gate: "G1" as const,
            severity: "warning" as const,
            code: "classifications_unchecked",
            message:
              "The data release does not list its damage types and defence layers, so these ids could not be checked.",
            path: "/damageTypes",
          },
        ]
      : []),
  ];
  return [
    ...classFindings,
    ...wrong.map((m) => ({
      gate: "G7" as const,
      severity: "error" as const,
      code: "suitability_contradicts_request",
      message: `The player asked for ${m} play, so the guide must be suitable for it.`,
      path: "/suitability",
    })),
  ];
}

/** Defence layers named by the mechanics must exist in the release, like those of the summary. */
function layerCheck(payload: unknown, ctx: PipelineContext): Finding[] {
  const layers = ctx.catalog.release?.classifications?.defenceLayers;
  if (layers === undefined) return [];
  const defences = (payload as { defences?: { layer: string }[] }).defences ?? [];
  return defences.flatMap((d, i) =>
    layers.includes(d.layer)
      ? []
      : [
          {
            gate: "G1" as const,
            severity: "error" as const,
            code: "unknown_classification",
            message: `${d.layer} is not a defence layer of data release ${ctx.catalog.dataReleaseId}.`,
            path: `/defences/${String(i)}/layer`,
          },
        ],
  );
}

/** A section's answer in the shape the guide draft holds it (the lists of variants and faq are bare). */
function sectionDraftOf(section: S9Section, payload: unknown): unknown {
  const p = payload as Record<string, unknown>;
  return section === "variants" ? p.variants : section === "faq" ? p.faq : payload;
}

type Depth = NonNullable<StageConfig["s9"]>["depth"];

/** Least amount of prose per section, from config; a shortfall goes back to the same task. */
export function depthCheck(section: S9Section, depth: Depth) {
  return (payload: unknown): Finding[] => {
    const p = payload as Record<string, unknown>;
    const counts: [string, number, number][] = [];
    const count = (field: string, min: number, from: Record<string, unknown> = p): void => {
      const v = from[field];
      counts.push([field, Array.isArray(v) ? v.length : 0, min]);
    };
    if (section === "summary") count("introduction", depth.introductionParagraphs);
    if (section === "mechanics") {
      count("interactions", depth.interactions);
      count("defences", depth.defences);
      count("gemSetups", depth.gemSetups);
    }
    if (section === "playstyle") {
      count("rotationSteps", depth.rotationSteps);
      count("tips", depth.tips);
      count("commonMistakes", depth.commonMistakes);
    }
    if (section === "atlas") {
      count("phases", depth.atlasPhases);
      count("waystoneTips", depth.waystoneTips);
    }
    if (section === "variants") count("variants", depth.variants);
    if (section === "faq") count("faq", depth.faq);
    return counts
      .filter(([, n, min]) => n < min)
      .map(([field, n, min]) => ({
        gate: "G7" as const,
        severity: "error" as const,
        code: "section_too_thin",
        message: `${field} has ${String(n)} entries; write at least ${String(min)}.`,
        path: `/${field}`,
      }));
  };
}

/** A citation must name a finding that was handed to this section; nothing else may be cited. */
export function citationCheck(payload: unknown, research: JsonValue | undefined): Finding[] {
  const known = new Set(
    research !== null &&
      typeof research === "object" &&
      !Array.isArray(research) &&
      Array.isArray(research.findings)
      ? research.findings.flatMap((f) =>
          f !== null && typeof f === "object" && !Array.isArray(f) && typeof f.id === "string"
            ? [f.id]
            : [],
        )
      : [],
  );
  return walkSection(payload).texts.flatMap(({ path, text }) =>
    text.flatMap((seg, i) =>
      seg.type === "source" && !known.has(seg.id)
        ? [
            {
              gate: "G7" as const,
              severity: "error" as const,
              code: "citation_unknown",
              message: `The citation ${seg.id} is not one of the findings you were given${known.size === 0 ? " (there are none for this section)" : `: ${[...known].join(", ")}`}.`,
              path: `${path}/${String(i)}`,
            },
          ]
        : [],
    ),
  );
}

/** One section of the guide (Claude); earlier sections are context for the later ones. */
export function sectionTask(
  ctx: PipelineContext,
  config: StageConfig,
  section: S9Section,
  inputs: S9Inputs,
): AnyTaskSpec {
  const written = S9_SECTIONS.slice(0, S9_SECTIONS.indexOf(section)).map((s) => {
    const content = ctx.result(sectionKey(s));
    if (content === undefined) throw new Error(`Section ${s} is missing before ${section}`);
    return { section: s, content };
  });
  const research = researchContext(ctx, section);
  return defineTask<unknown>({
    key: sectionKey(section),
    type: sectionKey(section),
    promptVersion: config.promptVersion,
    instructions: `${S9_SECTION} Section to write: ${section}. ${S9_SECTION_FOCUS[section]}`,
    context: {
      request: requestContext(ctx),
      chosen: JSON.parse(JSON.stringify(inputs.chosen)) as JsonValue,
      calcs: citableCalcs(inputs.target),
      ...inputs.plans,
      ...(research === undefined ? {} : { research }),
      written,
    },
    schema: sectionSchemas[section],
    check: async (payload: unknown, pctx: PipelineContext): Promise<Finding[]> => [
      ...(section === "summary" ? await summaryCheck(payload, pctx) : []),
      ...(section === "mechanics" ? layerCheck(payload, pctx) : []),
      ...(config.s9 === undefined ? [] : depthCheck(section, config.s9.depth)(payload)),
      ...citationCheck(payload, research),
      ...partFindings(
        config.s9?.rubric,
        { [section]: sectionDraftOf(section, payload) },
        `/${section}`,
      ),
    ],
    allowedTools: ["catalog_search", "catalog_get", "calc_evaluate"],
    entities: (p) => walkSection(p).entities,
    richText: (p) => walkSection(p).texts,
  });
}
