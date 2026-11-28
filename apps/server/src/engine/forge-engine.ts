import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { BuildRequest, CalcOutcome, Finding, RichText } from "@astrolabe/contracts/build";
import type { CalcProfileId, JsonValue } from "@astrolabe/contracts/common";
import type { RunEvent } from "@astrolabe/contracts/events";
import {
  RunId,
  type ForgeStep,
  type ForgeTask,
  type ForgeTools,
  type RunStatus,
  type SessionCode,
  TaskId,
  type UserIntervention,
} from "@astrolabe/contracts/forge";
import type { ForgeConfig } from "../config/forge-config.js";
import type {
  CraftSimPort,
  PricePort,
  ProgressionPort,
  SkeletonPort,
  TargetPort,
} from "@astrolabe/agents";
import type { CalcPort } from "../ports/calc.js";
import type { CatalogPort } from "../ports/catalog.js";
import type { RunStore } from "../store/run-store.js";
import { entityFindings, richTextFindings, schemaFindings } from "./checks.js";
import { ForgeError } from "./errors.js";
import type { Logger } from "../logger.js";
import type { AnyTaskSpec, Pipeline, PipelineContext, PlanStep } from "./pipeline.js";
import type { RunRecord } from "./run-record.js";
import { newSessionCode } from "./session-code.js";

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type EventInput = DistributiveOmit<RunEvent, "runId" | "seq" | "at">;
type SubmitOutput = z.infer<(typeof ForgeTools)["forge.submit"]["output"]>;
type AttachOutput = z.infer<(typeof ForgeTools)["forge.attach"]["output"]>;

const ATTACH_WINDOW_MS = 60_000;

/** Stage number of the validation (S10): results from it on are made again after a section changed. */
const VALIDATION_STAGE = 10;

/** Options answering an escalation after a task failed too often. */
export const ESCALATION_RETRY = "Retry the task";
export const ESCALATION_ABORT = "Abort the run";

/**
 * Added to the instructions of a task the player commented on (the comment is in `feedback`).
 * The rules of the task stay: ids from the catalog, numbers only as calculation references.
 */
const COMMENT_INSTRUCTIONS =
  "The player commented on this section of the finished guide: see the feedback entries of kind comment. `previous` is the section as it stood. Write the section again so that it follows the comment, keep what the comment does not criticise, and do not state numbers the comment asks for: if it needs a measurement, calculate it with the tools and reference the result.";

export interface ForgeEngineOptions {
  store: RunStore;
  catalog: CatalogPort;
  calc: CalcPort;
  /** Set in catalog-only mode: new runs are refused with this reason (`calc_unavailable`). */
  catalogOnlyReason?: string;
  config: ForgeConfig;
  pipelines: readonly Pipeline[];
  /** Calc profiles whose results may be referenced in text. */
  calcProfiles: readonly CalcProfileId[];
  now?: () => Date;
  /** Skeleton builds for S3; only with the real PoB engine. */
  skeleton?: SkeletonPort;
  /** Endgame tree optimisation for S5; same condition as the skeleton. */
  target?: TargetPort;
  /** Stage ordering for S6; same condition as the skeleton. */
  progression?: ProgressionPort;
  /** Market prices for S7. */
  economy?: PricePort;
  /** Crafting simulation for S8. */
  craft?: CraftSimPort;
  /** Reports background job failures that could not be stored in the run. */
  logger?: Logger;
}

/** Mutable view of one run inside a single locked operation. */
class Tx {
  readonly events: RunEvent[] = [];
  wake = false;

  constructor(
    readonly record: RunRecord,
    private readonly now: () => Date,
  ) {}

  emit(event: EventInput): void {
    const full = {
      ...event,
      runId: this.record.runId,
      seq: this.record.nextSeq,
      at: this.now().toISOString(),
    } as RunEvent;
    this.record.nextSeq += 1;
    this.events.push(full);
  }

  setPhase(phase: RunRecord["phase"]): void {
    if (this.record.phase === phase) return;
    this.record.phase = phase;
    this.emit({ type: "run.phase", phase });
  }
}

/**
 * The forge loop (ADR-0003): a server-side state machine hands Claude one
 * small task at a time, checks every submission at once (schema, catalog,
 * numbers, engine) and returns concrete findings until the task is green.
 * All state lives in the RunStore, so a run survives app restarts and a new
 * chat can continue it with a fresh session code.
 */
export class ForgeEngine {
  private readonly pipelines: ReadonlyMap<string, Pipeline>;
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly listeners = new Map<string, Set<(event: RunEvent) => void>>();
  private readonly wakers = new Map<string, Set<() => void>>();
  /** Running background job per run (at most one: the pipeline plans one step at a time). */
  private readonly jobs = new Map<string, { key: string; token: symbol }>();
  /** Job time limits that have not fired yet; cleared when the jobs stop. */
  private readonly jobTimers = new Set<NodeJS.Timeout>();
  private readonly now: () => Date;
  /** Times of failed attach calls inside the current window. */
  private attachFailures: number[] = [];

  constructor(private readonly options: ForgeEngineOptions) {
    this.pipelines = new Map(options.pipelines.map((p) => [p.id, p]));
    this.now = options.now ?? (() => new Date());
  }

  get calcEngine(): CalcPort["engine"] {
    return this.options.calc.engine;
  }

  // ---------------------------------------------------------------- frontend

  /** Starts a run for a normalised build request and issues its first session code. */
  async createRun(
    request: BuildRequest,
    pipelineId: string,
  ): Promise<{ runId: RunId; sessionCode: SessionCode; expiresAt: string }> {
    if (this.options.catalogOnlyReason !== undefined) {
      // Catalog-only mode: a run could not measure a single number.
      throw new ForgeError("calc_unavailable", this.options.catalogOnlyReason);
    }
    if (!this.pipelines.has(pipelineId)) {
      throw new ForgeError("invalid_request", `Unknown pipeline ${pipelineId}`);
    }
    if (request.dataReleaseId !== this.options.catalog.dataReleaseId) {
      throw new ForgeError(
        "invalid_request",
        `Request targets data release ${request.dataReleaseId}, the loaded catalog is ${this.options.catalog.dataReleaseId}`,
      );
    }
    const unknown = entityFindings(this.options.catalog, [
      ...(request.mainSkillId === undefined
        ? []
        : [{ path: "/mainSkillId", ref: { kind: "gem" as const, id: request.mainSkillId } }]),
      ...request.exclusions.map((ref, i) => ({ path: `/exclusions/${i}`, ref })),
    ]);
    if (unknown.length > 0) {
      throw new ForgeError(
        "invalid_request",
        unknown.map((f) => `${f.path ?? ""}: ${f.message}`).join("\n"),
      );
    }
    const runId = RunId.parse(randomUUID());
    const code = this.newCode();
    const record: RunRecord = {
      runId,
      pipelineId,
      createdAt: this.now().toISOString(),
      request,
      phase: "planning",
      sessionCode: code,
      results: {},
      current: null,
      interventions: [],
      asks: [],
      taskCounter: 0,
      nextSeq: 0,
      returns: {},
      returned: {},
      revisions: [],
    };
    const tx = new Tx(record, this.now);
    tx.emit({ type: "run.phase", phase: "planning" });
    this.commit(tx);
    return { runId, sessionCode: code.code, expiresAt: code.expiresAt };
  }

  /** New session code for an existing run (e.g. to continue in a new chat). */
  async issueSessionCode(runId: string): Promise<{ sessionCode: SessionCode; expiresAt: string }> {
    return this.mutate(runId, async (tx) => {
      const code = this.newCode();
      tx.record.sessionCode = code;
      return { sessionCode: code.code, expiresAt: code.expiresAt };
    });
  }

  /**
   * Called before the calc pool closes: running jobs become stale, so the failure the closing
   * pool causes is not stored in the run. The runs stay as they are and the next planning
   * restarts the job.
   */
  stopJobs(): void {
    this.jobs.clear();
    for (const timer of this.jobTimers) clearTimeout(timer);
    this.jobTimers.clear();
  }

  /** Something the user did in the app; goes into the feedback queue of the run. */
  async intervene(runId: string, requested: UserIntervention): Promise<RunStatus> {
    return this.mutate(runId, async (tx) => {
      const r = tx.record;
      this.reviveIfResumable(tx, requested);
      const intervention =
        requested.kind === "comment" ? this.openForComment(tx, requested) : requested;
      this.assertActive(r);
      const ctx = this.context(tx);
      const pipelineError = this.pipelineOf(r).validateIntervention?.(intervention, ctx);
      if (pipelineError !== undefined) throw new ForgeError("invalid_intervention", pipelineError);

      switch (intervention.kind) {
        case "answer": {
          const ask = r.asks.find((a) => a.askId === intervention.askId && a.answer === undefined);
          if (ask === undefined) {
            throw new ForgeError("unknown_ask", `No open question ${intervention.askId}`);
          }
          if (ask.options.length > 0 && !ask.options.includes(intervention.answer)) {
            throw new ForgeError("invalid_intervention", "Answer must be one of the options");
          }
          ask.answer = intervention.answer;
          if (ask.origin === "escalation") this.resolveEscalation(tx, intervention.answer);
          break;
        }
        case "pause":
          tx.setPhase("paused");
          break;
        case "resume":
          if (r.phase === "paused") tx.setPhase("planning");
          break;
        case "redoStage": {
          this.dropFrom(r, intervention.stage);
          break;
        }
        default:
          break;
      }
      r.interventions.push({ intervention, at: this.now().toISOString(), delivered: false });
      tx.emit({ type: "feedback.queued", intervention });
      tx.wake = true;
      return this.statusOf(r, ctx);
    });
  }

  /** Full run state for the frontend. */
  async view(runId: string): Promise<RunRecord> {
    return this.load(runId);
  }

  subscribe(runId: string, listener: (event: RunEvent) => void): () => void {
    const set = this.listeners.get(runId) ?? new Set();
    set.add(listener);
    this.listeners.set(runId, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(runId);
    };
  }

  eventsAfter(runId: string, afterSeq: number): RunEvent[] {
    return this.options.store.eventsAfter(runId, afterSeq);
  }

  // ------------------------------------------------------------ forge tools

  async attach(code: string): Promise<AttachOutput> {
    const nowMs = this.now().getTime();
    this.attachFailures = this.attachFailures.filter((t) => nowMs - t < ATTACH_WINDOW_MS);
    if (this.attachFailures.length >= this.options.config.attachFailuresPerMinute) {
      throw new ForgeError(
        "too_many_attempts",
        "Too many wrong session codes. Wait a minute and use the code shown in the Astrolabe app.",
      );
    }
    const record = this.options.store.findBySessionCode(code);
    if (record?.sessionCode == null) {
      this.attachFailures.push(nowMs);
      throw new ForgeError(
        "unknown_session_code",
        "Unknown session code. Copy the current code from the Astrolabe app.",
      );
    }
    if (Date.parse(record.sessionCode.expiresAt) < this.now().getTime()) {
      throw new ForgeError(
        "session_code_expired",
        "The session code has expired. Ask the user for a new code from the Astrolabe app.",
      );
    }
    return this.mutate(record.runId, async (tx) => {
      const next = await this.advance(tx);
      return { runId: tx.record.runId, status: this.statusOf(tx.record, this.context(tx)), next };
    });
  }

  /** Next step; blocks up to the configured long-poll time while the run waits for the user. */
  async next(runId: string, signal?: AbortSignal): Promise<ForgeStep> {
    const step = await this.mutate(runId, (tx) => this.advance(tx));
    if (step.kind !== "wait_user" || this.options.config.waitLongPollSeconds === 0) return step;
    await this.waitForWake(runId, this.options.config.waitLongPollSeconds * 1000, signal);
    return this.mutate(runId, (tx) => this.advance(tx));
  }

  async submit(input: {
    runId: string;
    taskId: string;
    attempt: number;
    payload: JsonValue;
  }): Promise<SubmitOutput> {
    return this.mutate(input.runId, async (tx) => {
      const r = tx.record;
      this.assertActive(r);
      const current = r.current;
      if (current === null) {
        throw new ForgeError("no_open_task", "There is no open task. Call forge_next.");
      }
      if (current.taskId !== input.taskId || current.attempt !== input.attempt) {
        throw new ForgeError(
          "stale_task",
          `Open task is ${current.taskId} attempt ${current.attempt}. Call forge_next for the current task.`,
        );
      }
      if (r.asks.some((a) => a.origin === "escalation" && a.answer === undefined)) {
        throw new ForgeError(
          "stale_task",
          "This task is waiting for the user's decision in the app. Call forge_next.",
        );
      }
      const ctx = this.context(tx);
      const spec = this.specFor(tx, ctx);

      tx.emit({ type: "task.submitted", taskId: current.taskId });
      const { findings, value } = await this.check(spec, input.payload, ctx);
      const errors = findings.filter((f) => f.severity === "error");
      const maxAttempts = this.options.config.maxAttemptsPerTask;

      if (errors.length > 0) {
        tx.emit({
          type: "task.rejected",
          taskId: current.taskId,
          findings: errors,
          attempt: current.attempt,
          maxAttempts,
        });
        current.findings = errors;
        if (current.attempt >= maxAttempts) {
          this.openAsk(tx, {
            origin: "escalation",
            taskId: current.taskId,
            question: `Task ${current.type} failed its checks ${maxAttempts} times. Retry it or abort the run?`,
            options: [ESCALATION_RETRY, ESCALATION_ABORT],
          });
        } else {
          current.attempt += 1;
          tx.emit({
            type: "task.started",
            taskId: current.taskId,
            task: current.type,
            attempt: current.attempt,
          });
        }
        return { result: "rejected", findings: errors, next: await this.advance(tx) };
      }

      r.results[spec.key] = {
        type: spec.type,
        by: "claude",
        value,
        at: this.now().toISOString(),
      };
      r.current = null;
      tx.emit({ type: "task.accepted", taskId: current.taskId });
      return { result: "accepted", next: await this.advance(tx) };
    });
  }

  async askUser(input: {
    runId: string;
    taskId: string;
    question: string;
    options: string[];
  }): Promise<{ askId: string; next: ForgeStep }> {
    return this.mutate(input.runId, async (tx) => {
      this.assertActive(tx.record);
      const current = tx.record.current;
      if (current?.taskId !== input.taskId) {
        throw new ForgeError(
          "stale_task",
          "Questions belong to the open task. Call forge_next for the current task.",
        );
      }
      const askId = this.openAsk(tx, {
        origin: "claude",
        taskId: current.taskId,
        question: input.question,
        options: input.options,
      });
      return { askId, next: await this.advance(tx) };
    });
  }

  async status(runId: string): Promise<RunStatus> {
    return this.mutate(runId, async (tx) => this.statusOf(tx.record, this.context(tx)));
  }

  // --------------------------------------------------------------- internals

  /** Runs the pipeline until Claude or the user has something to do. */
  private async advance(tx: Tx): Promise<ForgeStep> {
    const r = tx.record;
    const pipeline = this.pipelineOf(r);
    // Server steps finish in a bounded number of rounds; the guard catches a pipeline loop.
    for (let round = 0; round < 1000; round += 1) {
      if (r.phase === "done") {
        if (r.guideId === undefined) throw new Error(`Run ${r.runId} is done without guideId`);
        return { kind: "done", guideId: r.guideId };
      }
      if (r.phase === "failed") {
        return {
          kind: "failed",
          error: r.error ?? { code: "run_failed", message: "The run failed." },
        };
      }
      if (r.phase === "paused") {
        return this.wait("The user paused the run in the Astrolabe app. Call forge_next again.");
      }
      const open = r.asks.find((a) => a.answer === undefined);
      if (open !== undefined) {
        tx.setPhase("waiting_user");
        return this.wait(
          `Waiting for the user to answer in the Astrolabe app: ${open.question} Call forge_next again.`,
        );
      }

      const ctx = this.context(tx);
      const step = pipeline.plan(ctx);
      switch (step.kind) {
        case "server": {
          const value = await step.run(ctx);
          r.results[step.key] = {
            type: step.type,
            by: "server",
            value,
            at: this.now().toISOString(),
          };
          continue;
        }
        case "job": {
          tx.setPhase("planning");
          if (this.jobs.get(r.runId)?.key !== step.key) this.startJob(r, step);
          return this.wait(`Astrolabe is working: ${step.label}. Call forge_next again.`);
        }
        case "wait_user":
          tx.setPhase("waiting_user");
          return { kind: "wait_user", reason: step.reason, retryAfterSeconds: this.retryAfter() };
        case "blocked":
          r.error = step.error;
          r.current = null;
          tx.setPhase("failed");
          return { kind: "failed", error: step.error };
        case "return": {
          const used = r.returns[step.stage] ?? 0;
          if (used >= step.maxReturns) {
            r.error = {
              code: "returns_exhausted",
              message: `Stage ${step.stage} was returned ${String(used)} times and the gates still fail. ${step.summary}`,
            };
            r.current = null;
            tx.setPhase("failed");
            return { kind: "failed", error: r.error };
          }
          r.returns[step.stage] = used + 1;
          const before = Object.keys(r.results).length;
          this.dropFrom(r, step.stage);
          if (Object.keys(r.results).length === before) {
            // Nothing was dropped, so planning would return again at once and burn the returns.
            r.error = {
              code: "return_dropped_nothing",
              message: `Returning stage ${step.stage} dropped no result; the finding names a stage that has not run.`,
            };
            r.current = null;
            tx.setPhase("failed");
            return { kind: "failed", error: r.error };
          }
          r.returned[step.stage] = step.findings;
          r.current = null;
          tx.setPhase("planning");
          continue;
        }
        case "done":
          // The publishing step names the guide; pipelines without one get a fresh id.
          r.guideId = guideIdOf(r.results["S11.guide"]?.value) ?? randomUUID();
          this.stampRevision(r);
          r.current = null;
          tx.setPhase("done");
          tx.emit({ type: "guide.ready", guideId: r.guideId });
          continue;
        case "task": {
          tx.setPhase("planning");
          const spec = step.spec;
          if (r.current?.key !== spec.key) {
            r.taskCounter += 1;
            r.current = {
              taskId: TaskId.parse(`${spec.key}#${r.taskCounter}`),
              key: spec.key,
              type: spec.type,
              attempt: 1,
              findings: this.takeReturned(r, spec.type),
              feedback: [],
              startedAt: this.now().toISOString(),
            };
            tx.emit({
              type: "task.started",
              taskId: r.current.taskId,
              task: spec.type,
              attempt: 1,
            });
          }
          for (const entry of r.interventions) {
            if (entry.delivered) continue;
            // A section comment belongs to the task of its section only.
            const { intervention } = entry;
            if (intervention.kind === "comment" && intervention.section !== spec.key) continue;
            r.current.feedback.push(entry.intervention);
            entry.delivered = true;
          }
          return { kind: "task", task: this.taskOf(r, spec) };
        }
      }
    }
    throw new Error(`Pipeline ${pipeline.id} did not reach a task, wait or done`);
  }

  /**
   * Drops the results of a stage and everything computed from them, so the stage runs again.
   * Later stages are computed from earlier ones; parts of one stage build on each other in order.
   */
  private dropFrom(r: RunRecord, stage: string): void {
    // Later stages are computed from earlier ones, so redoing a stage drops them too.
    const from = stageNumber(stage);
    const matches = (type: string) =>
      type === stage ||
      type.startsWith(`${stage}.`) ||
      (from !== undefined && (stageNumber(type) ?? -1) > from);
    // Parts of a stage build on each other in order (e.g. S6.stages → S6.notes → S6.plan):
    // redoing one part drops the parts stored after it.
    let partDropped = false;
    r.results = Object.fromEntries(
      Object.entries(r.results).filter(([, result]) => {
        if (matches(result.type)) {
          partDropped = partDropped || stageNumber(result.type) === from;
          return false;
        }
        if (partDropped && stage.includes(".") && stageNumber(result.type) === from) {
          return false;
        }
        return true;
      }),
    );
    // A variant choice belongs to the candidates it was made on; the player picks again.
    if (from !== undefined && from <= VARIANT_CHOICE_STAGE) {
      r.interventions = r.interventions.filter((e) => e.intervention.kind !== "chooseVariant");
    }
    // Findings returned to this stage or a later one belong to results that are gone now.
    r.returned = Object.fromEntries(Object.entries(r.returned).filter(([key]) => !matches(key)));
    // A running job computed from the old results; its answer must not come back.
    this.jobs.delete(r.runId);
    if (r.current !== null && matches(r.current.type)) {
      // Questions of the dropped task are moot; close them so the loop does not block.
      for (const ask of r.asks) {
        if (ask.answer === undefined && ask.taskId === r.current.taskId) {
          ask.answer = "(withdrawn: stage redone)";
        }
      }
      r.current = null;
    }
  }

  /** Gate findings returned to a stage are shown to the task that redoes it. */
  private takeReturned(r: RunRecord, type: string): Finding[] {
    const key = Object.keys(r.returned).find((k) => type === k || type.startsWith(`${k}.`));
    if (key === undefined) return [];
    const { [key]: findings = [], ...rest } = r.returned;
    r.returned = rest;
    return findings;
  }

  private taskOf(r: RunRecord, spec: AnyTaskSpec): ForgeTask {
    if (r.current === null) throw new Error("taskOf without current task");
    return {
      taskId: r.current.taskId,
      type: spec.type,
      attempt: r.current.attempt,
      maxAttempts: this.options.config.maxAttemptsPerTask,
      instructions: r.current.feedback.some((f) => f.kind === "comment")
        ? `${spec.instructions} ${COMMENT_INSTRUCTIONS}`
        : spec.instructions,
      promptVersion: spec.promptVersion,
      context: spec.context,
      feedback: r.current.feedback,
      findings: r.current.findings,
      responseSchema: toJsonRecord(z.toJSONSchema(spec.schema, { io: "input" })),
      allowedTools: spec.allowedTools,
    };
  }

  /** The spec of the open task; drops the task if the pipeline moved on (e.g. after redo). */
  private specFor(tx: Tx, ctx: PipelineContext): AnyTaskSpec {
    const step = this.pipelineOf(tx.record).plan(ctx);
    if (step.kind !== "task" || step.spec.key !== tx.record.current?.key) {
      throw new ForgeError("stale_task", "The open task is no longer current. Call forge_next.");
    }
    return step.spec;
  }

  private async check(
    spec: AnyTaskSpec,
    payload: JsonValue,
    ctx: PipelineContext,
  ): Promise<{ findings: Finding[]; value: JsonValue }> {
    const parsed = spec.schema.safeParse(payload);
    if (!parsed.success) return { findings: schemaFindings(parsed.error), value: null };
    const data = parsed.data;
    const g1 = entityFindings(ctx.catalog, spec.entities?.(data) ?? []);
    if (g1.length > 0) return { findings: g1, value: null };
    const numbers = await richTextFindings(ctx.calc, spec.richText?.(data) ?? [], {
      dataReleaseId: ctx.catalog.dataReleaseId,
      calcProfiles: this.options.calcProfiles,
      overrides: ctx.run.request.calcOverrides,
    });
    if (numbers.length > 0) return { findings: numbers, value: null };
    const own = (await spec.check?.(data, ctx)) ?? [];
    return { findings: own, value: toJson(data) };
  }

  /** Read-only context for background jobs: no events, no transaction. */
  private snapshotContext(r: RunRecord): PipelineContext {
    return this.buildContext(r, this.options.calc);
  }

  private context(tx: Tx): PipelineContext {
    const calc = this.options.calc;
    const reportingCalc: CalcPort = {
      engine: calc.engine,
      getResult: (id) => calc.getResult(id),
      calculate: async (input) => {
        const outcomes: Record<CalcProfileId, CalcOutcome> = await calc.calculate(input);
        for (const outcome of Object.values(outcomes)) {
          if (outcome.status === "ok") tx.emit({ type: "calc.completed", calcId: outcome.calcId });
          else tx.emit({ type: "calc.failed", error: outcome.error });
        }
        return outcomes;
      },
    };
    return this.buildContext(tx.record, reportingCalc);
  }

  private buildContext(r: RunRecord, calc: CalcPort): PipelineContext {
    // Every number of a run is calculated with the player's overrides of the calc profile.
    const overrides = r.request.calcOverrides;
    const runCalc: CalcPort =
      Object.keys(overrides).length === 0
        ? calc
        : {
            engine: calc.engine,
            getResult: (id) => calc.getResult(id),
            calculate: (input) =>
              calc.calculate({ ...input, overrides: { ...overrides, ...input.overrides } }),
          };
    return {
      run: r,
      catalog: this.options.catalog,
      calc: runCalc,
      ...(this.options.skeleton === undefined ? {} : { skeleton: this.options.skeleton }),
      ...(this.options.target === undefined ? {} : { target: this.options.target }),
      ...(this.options.progression === undefined ? {} : { progression: this.options.progression }),
      ...(this.options.economy === undefined ? {} : { economy: this.options.economy }),
      ...(this.options.craft === undefined ? {} : { craft: this.options.craft }),
      latest: <K extends UserIntervention["kind"]>(kind: K) => {
        for (let i = r.interventions.length - 1; i >= 0; i -= 1) {
          const entry = r.interventions[i]?.intervention;
          if (entry?.kind === kind) return entry as Extract<UserIntervention, { kind: K }>;
        }
        return undefined;
      },
      result: (key) => r.results[key]?.value,
    };
  }

  private statusOf(r: RunRecord, ctx: PipelineContext): RunStatus {
    const planned = this.pipelineOf(r).plannedTasks?.(ctx);
    return {
      runId: r.runId,
      phase: r.phase,
      ...(r.current === null ? {} : { currentTask: r.current.type }),
      completedTasks: Object.values(r.results).filter((x) => x.by === "claude").length,
      ...(planned === undefined ? {} : { plannedTasks: planned }),
    };
  }

  private openAsk(
    tx: Tx,
    ask: { origin: "claude" | "escalation"; taskId: TaskId; question: string; options: string[] },
  ): string {
    const askId = randomUUID();
    tx.record.asks.push({ askId, ...ask });
    tx.emit({ type: "ask_user", askId, question: ask.question, options: ask.options });
    tx.setPhase("waiting_user");
    return askId;
  }

  private resolveEscalation(tx: Tx, answer: string): void {
    if (answer === ESCALATION_RETRY) {
      if (tx.record.current !== null) {
        tx.record.current.attempt = 1;
        tx.emit({
          type: "task.started",
          taskId: tx.record.current.taskId,
          task: tx.record.current.type,
          attempt: 1,
        });
      }
      tx.setPhase("planning");
      return;
    }
    tx.record.error = {
      code: "aborted_by_user",
      message: "The user aborted the run after repeated failed checks.",
    };
    tx.record.current = null;
    tx.setPhase("failed");
  }

  /**
   * A comment on a section of the guide: reopens a finished run and drops only the section, the
   * validation and the published guide, so Claude redoes that one task. The finished guide is kept
   * as an earlier revision. Returns the comment with `previous` set by the server.
   */
  private openForComment(
    tx: Tx,
    comment: Extract<UserIntervention, { kind: "comment" }>,
  ): Extract<UserIntervention, { kind: "comment" }> {
    const r = tx.record;
    if (r.phase === "failed") {
      throw new ForgeError("run_finished", `Run ${r.runId} failed; redo the failed stage first.`);
    }
    if (r.phase !== "done" && r.revisions.length === 0) {
      throw new ForgeError(
        "invalid_intervention",
        "Sections can be commented on once the guide is finished.",
      );
    }
    const stored = r.results[comment.section];
    // The newest comment on the section carries the text it started from (an older round is stale).
    const earlier = r.interventions.findLast(
      (e) => e.intervention.kind === "comment" && e.intervention.section === comment.section,
    )?.intervention;
    if (stored === undefined && earlier === undefined) {
      throw new ForgeError("invalid_intervention", `The guide has no section ${comment.section}.`);
    }
    const previous = stored?.value ?? (earlier?.kind === "comment" ? earlier.previous : undefined);
    if (r.phase === "done") {
      const guide = r.results["S11.guide"]?.value;
      if (guide !== undefined) r.revisions.push(guide);
      tx.setPhase("planning");
    }
    // The comment's section is redone; validation and publishing run again on the new text.
    r.results = Object.fromEntries(
      Object.entries(r.results).filter(
        ([key, result]) =>
          key !== comment.section && (stageNumber(result.type) ?? -1) < VALIDATION_STAGE,
      ),
    );
    r.returns = {};
    // Findings returned to this section belong to the text that is gone; those of others stay.
    r.returned = Object.fromEntries(
      Object.entries(r.returned).filter(
        ([key]) => key !== comment.section && !comment.section.startsWith(`${key}.`),
      ),
    );
    // An open task of the section stays: it receives this comment next to the earlier ones.
    const withPrevious = { ...comment };
    delete withPrevious.previous;
    return previous === undefined ? withPrevious : { ...withPrevious, previous };
  }

  /** The published guide of a reopened run is the next revision of the same guide. */
  private stampRevision(r: RunRecord): void {
    const stored = r.results["S11.guide"];
    if (stored === undefined || r.revisions.length === 0) return;
    const guide = stored.value;
    if (typeof guide !== "object" || guide === null || Array.isArray(guide)) return;
    const metadata = guide["metadata"];
    if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) return;
    stored.value = { ...guide, metadata: { ...metadata, revision: r.revisions.length } };
  }

  /**
   * A run that stopped on a problem the player can retry continues when they ask for it:
   * `resume` after a failed job runs the job again, `redoStage` after failed jobs, used-up
   * returns or a failed validation redoes the stage with fresh returns. Everything stored stays.
   */
  private reviveIfResumable(tx: Tx, intervention: UserIntervention): void {
    const r = tx.record;
    if (r.phase !== "failed") return;
    const code = r.error?.code;
    const retryable =
      (intervention.kind === "resume" && code === "job_failed") ||
      (intervention.kind === "redoStage" &&
        (code === "job_failed" || code === "returns_exhausted" || code === "validation_failed"));
    if (!retryable) return;
    delete r.error;
    r.current = null;
    if (intervention.kind === "redoStage") r.returns = {};
    tx.setPhase("planning");
  }

  private assertActive(r: RunRecord): void {
    if (r.phase === "done" || r.phase === "failed") {
      throw new ForgeError("run_finished", `Run ${r.runId} is already ${r.phase}.`);
    }
  }

  /** Runs a pipeline job outside the run lock and stores its result (or failure) when it ends. */
  private startJob(record: RunRecord, step: Extract<PlanStep, { kind: "job" }>): void {
    const runId = record.runId;
    // The job sees a snapshot; its result comes back through a normal locked mutation.
    const ctx = this.snapshotContext(structuredClone(record));
    const token = Symbol(step.key);
    this.jobs.set(runId, { key: step.key, token });
    // Stale = the run was redone, finished or failed since the job started; the answer is dropped.
    const finish = (apply: (tx: Tx) => void) =>
      this.mutate(runId, async (tx) => {
        const current = this.jobs.get(runId)?.token === token;
        const phase = tx.record.phase;
        if (!current || phase === "done" || phase === "failed") return;
        apply(tx);
        tx.wake = true;
      });
    // The timer fails the run when the job hangs (a stuck calc worker); the job itself cannot be
    // aborted, so its late answer is dropped by the stale check in `finish`.
    const limitMinutes = this.options.config.jobTimeoutMinutes;
    let timer: NodeJS.Timeout | undefined;
    const limit = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(
              `it did not finish within ${String(limitMinutes)} minutes; the calculation may still be running, and resuming starts it again`,
            ),
          ),
        limitMinutes * 60_000,
      );
      timer.unref();
      this.jobTimers.add(timer);
    });
    // `async` so that a synchronous throw of the job is a rejection, not an escape from planning
    void Promise.race([(async () => step.run(ctx))(), limit])
      .then(
        (value) =>
          finish((tx) => {
            tx.record.results[step.key] = {
              type: step.type,
              by: "server",
              value,
              at: this.now().toISOString(),
            };
          }),
        (error: unknown) => {
          this.options.logger?.error("background job failed", { runId, job: step.key, error });
          return finish((tx) => {
            tx.record.error = {
              code: "job_failed",
              message: `${step.label} failed: ${error instanceof Error ? error.message : String(error)}`,
            };
            tx.record.current = null;
            tx.setPhase("failed");
          });
        },
      )
      .catch((error: unknown) => {
        this.options.logger?.error("could not store a background job result", { runId, error });
      })
      .finally(() => {
        if (timer !== undefined) {
          clearTimeout(timer);
          this.jobTimers.delete(timer);
        }
        if (this.jobs.get(runId)?.token === token) this.jobs.delete(runId);
      });
  }

  private wait(text: string): ForgeStep {
    const reason: RichText = [{ type: "text", text }];
    return { kind: "wait_user", reason, retryAfterSeconds: this.retryAfter() };
  }

  private retryAfter(): number {
    return this.options.config.waitRetryAfterSeconds;
  }

  private newCode(): { code: SessionCode; expiresAt: string } {
    const ttlMs = this.options.config.sessionCodeTtlMinutes * 60_000;
    return {
      code: newSessionCode(),
      expiresAt: new Date(this.now().getTime() + ttlMs).toISOString(),
    };
  }

  private pipelineOf(r: RunRecord): Pipeline {
    const pipeline = this.pipelines.get(r.pipelineId);
    if (pipeline === undefined) {
      throw new Error(`Run ${r.runId} uses pipeline ${r.pipelineId}, which is not installed`);
    }
    return pipeline;
  }

  private load(runId: string): RunRecord {
    const parsed = RunId.safeParse(runId);
    const record = parsed.success ? this.options.store.load(parsed.data) : undefined;
    if (record === undefined) throw new ForgeError("unknown_run", `Unknown run ${runId}`);
    return record;
  }

  /** Runs `fn` on a fresh copy of the run under a per-run lock, then saves and publishes. */
  private async mutate<T>(runId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    const previous = this.locks.get(runId) ?? Promise.resolve();
    const task = previous.then(async () => {
      const tx = new Tx(this.load(runId), this.now);
      const out = await fn(tx);
      this.commit(tx);
      return out;
    });
    const settled = task.then(
      () => undefined,
      () => undefined,
    );
    this.locks.set(runId, settled);
    void settled.then(() => {
      if (this.locks.get(runId) === settled) this.locks.delete(runId);
    });
    return task;
  }

  private commit(tx: Tx): void {
    this.options.store.save(tx.record, tx.events);
    const listeners = this.listeners.get(tx.record.runId);
    for (const event of tx.events) {
      for (const listener of listeners ?? []) listener(event);
    }
    if (tx.wake) {
      for (const wake of this.wakers.get(tx.record.runId) ?? []) wake();
    }
  }

  private waitForWake(runId: string, ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal?.aborted === true) {
        resolve();
        return;
      }
      const set = this.wakers.get(runId) ?? new Set<() => void>();
      this.wakers.set(runId, set);
      const done = () => {
        clearTimeout(timer);
        set.delete(done);
        if (set.size === 0) this.wakers.delete(runId);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      set.add(done);
      signal?.addEventListener("abort", done, { once: true });
    });
  }
}

function toJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function toJsonRecord(value: unknown): Record<string, JsonValue> {
  const json = toJson(value);
  if (json === null || typeof json !== "object" || Array.isArray(json)) {
    throw new Error("JSON Schema of a task is not an object");
  }
  return json;
}

/** The stage that holds the player's variant choice (S4). */
const VARIANT_CHOICE_STAGE = 4;

/** "S3.evaluate" and "S3" are stage 3; anything else has no stage number. */
function stageNumber(type: string): number | undefined {
  const match = /^S(\d+)(?:\.|$)/.exec(type);
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

function guideIdOf(value: unknown): string | undefined {
  const id = (value as { metadata?: { guideId?: unknown } } | null | undefined)?.metadata?.guideId;
  return typeof id === "string" ? id : undefined;
}
