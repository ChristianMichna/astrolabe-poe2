import { describe, expect, it } from "vitest";
import type { DataRelease } from "@astrolabe/contracts/catalog";
import type { ArchetypeCandidate } from "@astrolabe/contracts/build";
import type { StageConfig } from "../src/config.js";
import type { PipelineContext } from "../src/pipeline.js";
import { steerTask, targetSize, type GemSetupSubmission } from "../src/stages/s5-target.js";

const release = (over: object = {}) =>
  ({
    id: "poe2-fix+r1",
    maxCharacterLevel: { value: 20, origin: "pob-code" },
    passivePoints: {
      mainTree: { perLevel: 1, fromLevel: 2, origin: "pob-code" },
      weaponSetByAct: {
        acts: [
          { act: 1, areaLevel: 5, points: 1 },
          { act: 2, areaLevel: 10, points: 1 },
        ],
        origin: "pob-code",
      },
    },
    ...over,
  }) as unknown as DataRelease;

describe("targetSize", () => {
  it("adds the level points from fromLevel to the maximum and every weapon set point", () => {
    expect(targetSize(release())).toEqual({ level: 20, passivePoints: 19 + 2 });
  });

  it("names what is missing instead of guessing", () => {
    expect(targetSize(undefined)).toMatch(/release record/);
    expect(targetSize(release({ maxCharacterLevel: undefined }))).toMatch(/maxCharacterLevel/);
    expect(targetSize(release({ passivePoints: undefined }))).toMatch(/passivePoints/);
  });

  it("rejects inconsistent facts", () => {
    expect(
      targetSize(
        release({
          passivePoints: {
            mainTree: { perLevel: 1, fromLevel: 30, origin: "pob-code" },
            weaponSetByAct: { acts: [{ act: 1, areaLevel: 5, points: 1 }], origin: "pob-code" },
          },
        }),
      ),
    ).toMatch(/inconsistent/);
  });
});

describe("steerTask", () => {
  const nodes: Record<string, object> = {
    "n-main": { classStartFor: [] },
    "n-asc": { classStartFor: [], ascendancyId: "a1" },
  };
  const ctx = {
    run: { interventions: [], request: { exclusions: [] } },
    catalog: {
      get: (ref: { id: string }) =>
        nodes[ref.id] === undefined ? undefined : { entity: nodes[ref.id] },
    },
    result: () => undefined,
    latest: () => undefined,
  } as unknown as PipelineContext;
  const spec = steerTask(
    ctx,
    { promptVersion: "t" } as unknown as StageConfig,
    {} as unknown as ArchetypeCandidate,
    { skills: [], rationale: [] } as unknown as GemSetupSubmission,
    ["More life"],
  );
  const body = (over: object) => ({
    requiredNodeIds: [],
    forbiddenNodeIds: [],
    priorityNodeIds: [],
    rationale: [{ reason: [{ type: "text", text: "Because." }] }],
    ...over,
  });

  it("keeps the comments in the task context", () => {
    expect(spec.context).toMatchObject({ playerComments: ["More life"] });
  });

  it("refuses a node that is required and forbidden, and nodes outside the main tree", async () => {
    const conflict = await spec.check?.(
      body({ requiredNodeIds: ["n-main"], forbiddenNodeIds: ["n-main"] }),
      ctx,
    );
    expect(conflict?.map((f) => f.code)).toContain("steer_conflict");
    const ascendancy = await spec.check?.(body({ priorityNodeIds: ["n-asc"] }), ctx);
    expect(ascendancy?.map((f) => f.code)).toEqual(["steer_not_main_tree"]);
    expect(await spec.check?.(body({ requiredNodeIds: ["n-main"] }), ctx)).toEqual([]);
  });
});
