import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineTask, type Pipeline } from "@astrolabe/agents";
import type { ForgeStep } from "@astrolabe/contracts/forge";
import { CalcFake } from "../src/calc/calc-fake.js";
import { PersistedCalc } from "../src/calc/persisted-calc.js";
import { ForgeEngine } from "../src/engine/forge-engine.js";
import { buildCommentsView } from "../src/guides/comments.js";
import { RunStore } from "../src/store/run-store.js";
import { CONFIG, REQUEST, RELEASE, fixtureCatalog } from "./fixtures.js";

/** Two sections (S9.summary, S9.faq), a validation step (S10) and a publishing step (S11). */
const pipeline: Pipeline = {
  id: "comment-test",
  plan: (ctx) => {
    for (const key of ["S9.summary", "S9.faq"]) {
      if (ctx.result(key) === undefined) {
        return {
          kind: "task",
          spec: defineTask<{ text: string }>({
            key,
            type: key,
            instructions: `Write ${key}.`,
            promptVersion: "t",
            context: {},
            schema: z.object({ text: z.string() }),
            allowedTools: [],
          }),
        };
      }
    }
    if (ctx.result("S10.report") === undefined) {
      return { kind: "server", key: "S10.report", type: "S10", run: async () => ({ ok: true }) };
    }
    if (ctx.result("S11.guide") === undefined) {
      return {
        kind: "server",
        key: "S11.guide",
        type: "S11",
        run: async () => ({
          metadata: { guideId: ctx.run.runId, revision: 0 },
          summary: ctx.result("S9.summary") ?? null,
        }),
      };
    }
    return { kind: "done" };
  },
};

function setup() {
  const store = new RunStore(":memory:");
  const engine = new ForgeEngine({
    store,
    catalog: fixtureCatalog(),
    calc: new PersistedCalc(new CalcFake({ dataReleaseId: RELEASE }), store),
    config: CONFIG,
    pipelines: [pipeline],
    calcProfiles: CONFIG.pipelines.poc.calcProfiles,
  });
  return { engine, store };
}

function task(step: ForgeStep) {
  if (step.kind !== "task") throw new Error(`expected task, got ${JSON.stringify(step)}`);
  return step.task;
}

async function finishedRun() {
  const { engine, store } = setup();
  const { runId, sessionCode } = await engine.createRun(REQUEST, "comment-test");
  let t = task((await engine.attach(sessionCode)).next);
  let out = await engine.submit({
    runId,
    taskId: t.taskId,
    attempt: 1,
    payload: { text: "first summary" },
  });
  if (out.result !== "accepted") throw new Error("rejected");
  t = task(out.next);
  out = await engine.submit({ runId, taskId: t.taskId, attempt: 1, payload: { text: "faq" } });
  if (out.next.kind !== "done") throw new Error("expected done");
  return { engine, store, runId };
}

describe("section comments", () => {
  it("redoes only the commented section and publishes the guide as a new revision", async () => {
    const { engine, store, runId } = await finishedRun();
    await engine.intervene(runId, {
      kind: "comment",
      commentId: "c1",
      section: "S9.summary",
      text: "Shorter and less generic.",
    });
    // Until Claude is done, the guide stays readable as its last revision.
    expect(store.findGuide(runId)).toMatchObject({ metadata: { revision: 0 } });

    const t = task(await engine.next(runId));
    expect(t.type).toBe("S9.summary");
    expect(t.instructions).toContain("commented on this section");
    expect(t.feedback).toEqual([
      expect.objectContaining({
        kind: "comment",
        commentId: "c1",
        previous: { text: "first summary" },
      }),
    ]);
    const view = buildCommentsView(runId, store.findRunByGuideId(runId));
    expect(view.comments).toEqual([
      expect.objectContaining({ commentId: "c1", status: "working" }),
    ]);

    const out = await engine.submit({
      runId,
      taskId: t.taskId,
      attempt: 1,
      payload: { text: "second summary" },
    });
    expect(out).toMatchObject({ result: "accepted", next: { kind: "done" } });
    // The faq was not asked again.
    expect(store.findGuide(runId)).toMatchObject({
      metadata: { revision: 1 },
      summary: { text: "second summary" },
    });
    const after = store.findRunByGuideId(runId);
    expect(after?.revisions).toHaveLength(1);
    expect(buildCommentsView(runId, after).comments[0]?.status).toBe("applied");
  });

  it("gives a comment only to the task of its section", async () => {
    const { engine, runId } = await finishedRun();
    await engine.intervene(runId, {
      kind: "comment",
      commentId: "c2",
      section: "S9.faq",
      text: "More questions.",
    });
    await engine.intervene(runId, {
      kind: "comment",
      commentId: "c3",
      section: "S9.summary",
      text: "Mention the budget.",
    });
    // Summary is the first open section; it must not see the faq comment.
    const summary = task(await engine.next(runId));
    expect(summary.type).toBe("S9.summary");
    expect(summary.feedback.map((f) => (f.kind === "comment" ? f.commentId : f.kind))).toEqual([
      "c3",
    ]);
    const out = await engine.submit({
      runId,
      taskId: summary.taskId,
      attempt: 1,
      payload: { text: "s" },
    });
    if (out.result !== "accepted") throw new Error("rejected");
    const faq = task(out.next);
    expect(faq.type).toBe("S9.faq");
    expect(faq.feedback.map((f) => (f.kind === "comment" ? f.commentId : f.kind))).toEqual(["c2"]);
  });

  it("refuses unknown sections and comments before the guide is finished", async () => {
    const { engine, runId } = await finishedRun();
    await expect(
      engine.intervene(runId, {
        kind: "comment",
        commentId: "x",
        section: "S9.nothing",
        text: "Hi",
      }),
    ).rejects.toMatchObject({ code: "invalid_intervention" });

    const fresh = setup();
    const created = await fresh.engine.createRun(REQUEST, "comment-test");
    await expect(
      fresh.engine.intervene(created.runId, {
        kind: "comment",
        commentId: "y",
        section: "S9.summary",
        text: "Hi",
      }),
    ).rejects.toMatchObject({ code: "invalid_intervention" });
  });

  it("says why a guide without a run cannot be commented on", () => {
    const view = buildCommentsView("g1", undefined);
    expect(view.sections).toEqual([]);
    expect(view.reason).toMatch(/file/);
  });
});

describe("several comments on one section", () => {
  it("keeps every comment and starts from the newest text", async () => {
    const { engine, store, runId } = await finishedRun();
    const comment = (id: string) =>
      engine.intervene(runId, { kind: "comment", commentId: id, section: "S9.summary", text: id });
    await comment("a");
    let t = task(await engine.next(runId));
    let out = await engine.submit({ runId, taskId: t.taskId, attempt: 1, payload: { text: "r1" } });
    expect(out.next.kind).toBe("done");
    await comment("b");
    t = task(await engine.next(runId));
    expect(t.feedback).toEqual([
      expect.objectContaining({ commentId: "b", previous: { text: "r1" } }),
    ]);
    // A second comment while the task is open joins it; the first stays.
    await comment("c");
    t = task(await engine.next(runId));
    expect(t.feedback.map((f) => (f.kind === "comment" ? f.commentId : f.kind))).toEqual([
      "b",
      "c",
    ]);
    expect(t.feedback[1]).toMatchObject({ previous: { text: "r1" } });
    out = await engine.submit({ runId, taskId: t.taskId, attempt: 1, payload: { text: "r2" } });
    expect(out.next.kind).toBe("done");
    expect(store.findGuide(runId)).toMatchObject({ metadata: { revision: 2 } });
  });
});

/** A crafting strategy (S8), its priced plan (S8.plan) and the text about it (S9.craft-…). */
const craftPipeline: Pipeline = {
  id: "craft-comment-test",
  plan: (ctx) => {
    const task = (key: string) =>
      ({
        kind: "task",
        spec: defineTask<{ text: string }>({
          key,
          type: key,
          instructions: `Write ${key}.`,
          promptVersion: "t",
          context: {},
          schema: z.object({ text: z.string() }),
          allowedTools: [],
        }),
      }) as const;
    const craft = "S8.craft-a-ring";
    if (ctx.result(craft) === undefined) return task(craft);
    if (ctx.result("S8.plan") === undefined) {
      return {
        kind: "server",
        key: "S8.plan",
        type: "S8.plan",
        run: async () => ({ priced: ctx.result(craft) ?? null }),
      };
    }
    if (ctx.result("S9.summary") === undefined) return task("S9.summary");
    if (ctx.result("S9.craft-s8-craft-a-ring") === undefined)
      return task("S9.craft-s8-craft-a-ring");
    if (ctx.result("S10.report") === undefined) {
      return { kind: "server", key: "S10.report", type: "S10", run: async () => ({ ok: true }) };
    }
    if (ctx.result("S11.guide") === undefined) {
      return {
        kind: "server",
        key: "S11.guide",
        type: "S11",
        run: async () => ({
          metadata: { guideId: ctx.run.runId, revision: 0 },
          plan: ctx.result("S8.plan") ?? null,
        }),
      };
    }
    return { kind: "done" };
  },
};

describe("comments on a crafting strategy", () => {
  it("plans the strategy again and measures the plan and its text again, not the other sections", async () => {
    const store = new RunStore(":memory:");
    const engine = new ForgeEngine({
      store,
      catalog: fixtureCatalog(),
      calc: new PersistedCalc(new CalcFake({ dataReleaseId: RELEASE }), store),
      config: CONFIG,
      pipelines: [craftPipeline],
      calcProfiles: CONFIG.pipelines.poc.calcProfiles,
    });
    const { runId, sessionCode } = await engine.createRun(REQUEST, "craft-comment-test");
    let step: ForgeStep = (await engine.attach(sessionCode)).next;
    for (const text of ["strategy 1", "summary", "craft text"]) {
      const t = task(step);
      const out = await engine.submit({ runId, taskId: t.taskId, attempt: 1, payload: { text } });
      if (out.result !== "accepted") throw new Error("rejected");
      step = out.next;
    }
    expect(step.kind).toBe("done");

    await engine.intervene(runId, {
      kind: "comment",
      commentId: "k1",
      section: "S8.craft-a-ring",
      text: "Cheaper, no exalts.",
    });
    const view = buildCommentsView(runId, store.findRunByGuideId(runId));
    expect(view.sections.find((s) => s.key === "S8.craft-a-ring")).toMatchObject({
      effect: "remeasure",
    });
    const first = task(await engine.next(runId));
    expect(first.type).toBe("S8.craft-a-ring");
    expect(first.feedback).toEqual([
      expect.objectContaining({ commentId: "k1", previous: { text: "strategy 1" } }),
    ]);
    let out = await engine.submit({
      runId,
      taskId: first.taskId,
      attempt: 1,
      payload: { text: "strategy 2" },
    });
    if (out.result !== "accepted") throw new Error("rejected");
    // The plan is measured again on the server, the summary is kept, the craft text is asked again.
    const next = task(out.next);
    expect(next.type).toBe("S9.craft-s8-craft-a-ring");
    out = await engine.submit({ runId, taskId: next.taskId, attempt: 1, payload: { text: "t2" } });
    expect(out.next.kind).toBe("done");
    expect(store.findGuide(runId)).toMatchObject({
      metadata: { revision: 1 },
      plan: { priced: { text: "strategy 2" } },
    });
  });

  it("refuses a strategy the guide does not have", async () => {
    const { engine, runId } = await finishedRun();
    await expect(
      engine.intervene(runId, {
        kind: "comment",
        commentId: "z",
        section: "S8.craft-nothing",
        text: "ok",
      }),
    ).rejects.toMatchObject({ code: "invalid_intervention" });
  });
});

/** Gem setup (S5), stage notes (S6) and the gear of a tier (S7) come before the written guide. */
const buildPipeline: Pipeline = {
  id: "build-comment-test",
  plan: (ctx) => {
    const task = (key: string) =>
      ({
        kind: "task",
        spec: defineTask<{ text: string }>({
          key,
          type: key,
          instructions: `Write ${key}.`,
          promptVersion: "t",
          context: { gems: ctx.result("S5.gems") ?? null },
          schema: z.object({ text: z.string() }),
          allowedTools: [],
        }),
      }) as const;
    for (const key of ["S5.gems", "S6.notes", "S7.gear-start", "S9.summary"]) {
      if (ctx.result(key) === undefined) return task(key);
    }
    if (ctx.result("S10.report") === undefined) {
      return { kind: "server", key: "S10.report", type: "S10", run: async () => ({ ok: true }) };
    }
    if (ctx.result("S11.guide") === undefined) {
      return {
        kind: "server",
        key: "S11.guide",
        type: "S11",
        run: async () => ({ metadata: { guideId: ctx.run.runId, revision: 0 } }),
      };
    }
    return { kind: "done" };
  },
};

describe("comments on a build choice", () => {
  async function finishedBuild() {
    const store = new RunStore(":memory:");
    const engine = new ForgeEngine({
      store,
      catalog: fixtureCatalog(),
      calc: new PersistedCalc(new CalcFake({ dataReleaseId: RELEASE }), store),
      config: CONFIG,
      pipelines: [buildPipeline],
      calcProfiles: CONFIG.pipelines.poc.calcProfiles,
    });
    const { runId, sessionCode } = await engine.createRun(REQUEST, "build-comment-test");
    let step: ForgeStep = (await engine.attach(sessionCode)).next;
    for (const text of ["gems 1", "notes 1", "gear 1", "summary 1"]) {
      const t = task(step);
      const out = await engine.submit({ runId, taskId: t.taskId, attempt: 1, payload: { text } });
      if (out.result !== "accepted") throw new Error("rejected");
      step = out.next;
    }
    expect(step.kind).toBe("done");
    return { engine, store, runId };
  }

  it("asks the gear of a tier again, and every later stage after it, but not earlier ones", async () => {
    const { engine, store, runId } = await finishedBuild();
    await engine.intervene(runId, {
      kind: "comment",
      commentId: "g1",
      section: "S7.gear-start",
      text: "Use a different weapon.",
    });
    const view = buildCommentsView(runId, store.findRunByGuideId(runId));
    expect(view.sections.find((s) => s.key === "S7.gear-start")).toMatchObject({
      effect: "rebuild",
    });
    const gear = task(await engine.next(runId));
    expect(gear.type).toBe("S7.gear-start");
    expect(gear.feedback).toEqual([
      expect.objectContaining({ commentId: "g1", previous: { text: "gear 1" } }),
    ]);
    let out = await engine.submit({
      runId,
      taskId: gear.taskId,
      attempt: 1,
      payload: { text: "gear 2" },
    });
    if (out.result !== "accepted") throw new Error("rejected");
    // The guide text built on the gear is written again, and gets no comment.
    const summary = task(out.next);
    expect(summary.type).toBe("S9.summary");
    expect(summary.feedback).toEqual([]);
    out = await engine.submit({
      runId,
      taskId: summary.taskId,
      attempt: 1,
      payload: { text: "summary 2" },
    });
    expect(out.next.kind).toBe("done");
    // Gems and notes before the gear were kept; the guide is a new revision.
    expect(store.findRunByGuideId(runId)?.results["S5.gems"]?.value).toEqual({ text: "gems 1" });
    expect(store.findGuide(runId)).toMatchObject({ metadata: { revision: 1 } });
    expect(buildCommentsView(runId, store.findRunByGuideId(runId))).toMatchObject({ revisions: 1 });
  });

  it("asks everything after the gem setup again", async () => {
    const { engine, runId } = await finishedBuild();
    await engine.intervene(runId, {
      kind: "comment",
      commentId: "g2",
      section: "S5.gems",
      text: "Try another main skill.",
    });
    expect(task(await engine.next(runId)).type).toBe("S5.gems");
  });

  it("redoes the stage notes and what is built on them", async () => {
    const { engine, runId } = await finishedBuild();
    await engine.intervene(runId, {
      kind: "comment",
      commentId: "n1",
      section: "S6.notes",
      text: "More on dangers.",
    });
    const t = task(await engine.next(runId));
    expect(t.type).toBe("S6.notes");
    const out = await engine.submit({
      runId,
      taskId: t.taskId,
      attempt: 1,
      payload: { text: "n2" },
    });
    // What is built on the notes is made again, so the run is not finished yet.
    expect(out.next.kind).toBe("task");
  });

  it("hands an earlier comment over again when a rebuild replaces its task", async () => {
    const { engine, runId } = await finishedBuild();
    await engine.intervene(runId, {
      kind: "comment",
      commentId: "c1",
      section: "S5.gems",
      text: "First.",
    });
    expect(task(await engine.next(runId)).type).toBe("S5.gems");
    await engine.intervene(runId, {
      kind: "comment",
      commentId: "c2",
      section: "S5.gems",
      text: "Second.",
    });
    const t = task(await engine.next(runId));
    const texts = (t.feedback ?? []).flatMap((f) => (f.kind === "comment" ? [f.text] : []));
    expect(texts).toContain("First.");
    expect(texts).toContain("Second.");
  });
});
