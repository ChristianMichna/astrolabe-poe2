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
