import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { measureRubric, matchPath, QualityRubric, wordsOf } from "../src/quality/rubric.js";
import {
  DETAIL_KEYS,
  judgedFindings,
  judgedSections,
  qualityTask,
} from "../src/stages/s10-quality.js";
import type { StageConfig } from "../src/config.js";
import type { PipelineContext } from "../src/pipeline.js";
import type { GuideDraft } from "../src/stages/s10-validate.js";
import type { RubricSection } from "../src/quality/rubric.js";

const rubric = QualityRubric.parse(
  JSON.parse(
    readFileSync(new URL("../../../config/agents/guide-rubric.json", import.meta.url), "utf8"),
  ),
);
const text = (n: number) => [
  { type: "text", text: Array.from({ length: n }, () => "word").join(" ") },
];

describe("guide rubric file", () => {
  it("is valid and has a question for the sections that need a human-like judge", () => {
    expect(rubric.rules.length).toBeGreaterThan(20);
    expect(judgedSections(rubric)).toEqual([
      "summary",
      "mechanics",
      "progression",
      "gear",
      "crafting",
      "playstyle",
      "atlas",
      "variants",
      "faq",
    ]);
  });
});

describe("measured rules", () => {
  it("counts words of text segments and entries of lists at a pointer with wildcards", () => {
    expect(wordsOf([...text(3), { type: "entity", ref: { kind: "gem", id: "x" } }])).toBe(3);
    const draft = { a: [{ b: [1, 2] }, { b: [] }] };
    expect(
      matchPath(draft, "/a/*/b").map((m) => [m.pointer, (m.value as unknown[]).length]),
    ).toEqual([
      ["/a/0/b", 2],
      ["/a/1/b", 0],
    ]);
  });

  const guide = (words: number, hasGuide = true) =>
    ({
      progression: {
        stages: [
          {
            key: "act-1",
            levelRange: [1, 10],
            ...(hasGuide
              ? {
                  guide: {
                    intro: text(words),
                    treeNotes: [1, 2],
                    checklist: [1, 2],
                    gearNotes: [1],
                  },
                }
              : {}),
          },
        ],
      },
    }) as unknown as GuideDraft;
  const only = (r: { path: string }) => r.path.startsWith("/progression/stages/*/guide");

  it("accepts a stage with enough prose", () => {
    expect(measureRubric(guide(60), rubric, DETAIL_KEYS, only)).toEqual([]);
  });

  it("sends a thin stage text back to the detail task of that stage", () => {
    const found = measureRubric(guide(5), rubric, DETAIL_KEYS, only);
    expect(found.map((f) => [f.code, f.returnTo, f.path])).toEqual([
      ["rubric-stage-intro", "S9.stage-act-1", "/progression/stages/0/guide/intro"],
    ]);
  });

  it("treats a stage without any detail text as missing, not as fine", () => {
    const codes = measureRubric(guide(0, false), rubric, DETAIL_KEYS, only).map((f) => f.code);
    expect(codes).toContain("rubric-stage-intro");
    expect(codes).toContain("rubric-stage-checklist");
  });
});

describe("judged questions", () => {
  const verdictFor = (met: boolean, part?: string) => ({
    verdicts: rubric.questions
      .filter((q) => q.section === "progression")
      .map((q) => ({
        id: q.id,
        met,
        evidence: "words only",
        ...(part === undefined ? {} : { part }),
      })),
  });
  const run = (verdict: ReturnType<typeof verdictFor> | undefined, cause?: string) =>
    judgedFindings(
      { ...rubric, questions: rubric.questions.filter((q) => q.section === "progression") },
      () => verdict,
      () => cause,
      (s: RubricSection) => `S6-${s}`,
    );

  it("fails a section nobody judged yet", () => {
    expect(run(undefined).map((f) => f.code)).toEqual(["quality_not_judged"]);
  });
  it("passes met answers and returns an unmet one to the detail task of its part", () => {
    expect(run(verdictFor(true))).toEqual([]);
    const found = run(verdictFor(false, "act-1"), "S9.stage-act-1");
    expect(found.map((f) => [f.code, f.returnTo])).toEqual([
      ["quality-stage-concrete", "S9.stage-act-1"],
    ]);
  });

  it("makes the judge name the part of a section made of parts, and every question once", async () => {
    const ctx = {
      run: { request: {}, interventions: [] },
      catalog: {},
      result: () => undefined,
    } as never as PipelineContext;
    const spec = qualityTask(ctx, { promptVersion: "t" } as StageConfig, rubric, "progression", {
      progression: { stages: [] },
    } as never as GuideDraft) as never as { check: (p: unknown) => Promise<{ code: string }[]> };
    expect((await spec.check(verdictFor(true))).map((f) => f.code)).toEqual([]);
    expect((await spec.check(verdictFor(false))).map((f) => f.code)).toEqual(["part_missing"]);
    expect((await spec.check({ verdicts: [] })).map((f) => f.code)).toEqual(["missing_answer"]);
    expect((await spec.check(verdictFor(false, "no-such-stage"))).map((f) => f.code)).toEqual([
      "part_unknown",
    ]);
  });

  it("refuses a rule that sends a finding to a task that cannot fix it", () => {
    const rule = rubric.rules.find((r) => r.returnTo === "detail:stage");
    expect(rule).toBeDefined();
    const bad = { ...rubric, rules: [{ ...rule, path: "/progression/stages/*/tasks" }] };
    expect(QualityRubric.safeParse(bad).success).toBe(false);
    const typo = { ...rubric, rules: [{ ...rule, returnTo: "S9.sumary" }] };
    expect(QualityRubric.safeParse(typo).success).toBe(false);
  });

  it("fails loudly when a wildcard meets something that is not a list", () => {
    expect(() => matchPath({ a: { b: 1 } }, "/a/*/b")).toThrow(/not a list/);
    expect(matchPath({ a: [{ b: 1 }] }, "/a/*/b")).toHaveLength(1);
  });
});
