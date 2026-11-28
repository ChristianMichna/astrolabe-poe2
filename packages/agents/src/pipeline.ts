import type { z } from "zod";
import type { BuildRequest, Finding, RichText, TaskType } from "@astrolabe/contracts/build";
import type { EntityRef, JsonValue } from "@astrolabe/contracts/common";
import type { UserIntervention } from "@astrolabe/contracts/forge";
import type {
  CalcPort,
  CatalogPort,
  CraftSimPort,
  PricePort,
  ProgressionPort,
  SkeletonPort,
  TargetPort,
} from "./ports.js";

/** The part of a stored run that pipelines may read. */
export interface RunView {
  readonly runId: string;
  readonly request: BuildRequest;
  readonly interventions: readonly { readonly intervention: UserIntervention }[];
}

/** What a pipeline sees when planning or checking: the run plus engine services. */
export interface PipelineContext {
  readonly run: RunView;
  readonly catalog: CatalogPort;
  /** Calc access; every calculation is reported as a live event. */
  readonly calc: CalcPort;
  /** Skeleton builds for S3; absent unless the real PoB engine runs. */
  readonly skeleton?: SkeletonPort;
  /** Endgame tree optimisation for S5; absent unless the real PoB engine runs. */
  readonly target?: TargetPort;
  /** Stage ordering of the target tree for S6; same condition as the skeleton. */
  readonly progression?: ProgressionPort;
  /** Market prices for S7; absent without an economy service (prices are then uncalibrated). */
  readonly economy?: PricePort;
  /** Crafting simulation for S8. */
  readonly craft?: CraftSimPort;
  /** Latest intervention of a kind, e.g. the current variant choice. */
  latest<K extends UserIntervention["kind"]>(
    kind: K,
  ): Extract<UserIntervention, { kind: K }> | undefined;
  /** Texts of the player's comments on a guide section (oldest first); empty without any. */
  commentsOn?(section: string): readonly string[];
  /** Accepted result of a task or server step, undefined if not done yet. */
  result(key: string): JsonValue | undefined;
}

/**
 * One small task for Claude with exactly one response schema (ADR-0003).
 * The engine checks every submission in this order: schema → catalog ids
 * (G1) → numbers in text (calc references only) → the task's own check.
 */
export interface TaskSpec<T> {
  /** Unique key inside the run, e.g. "S2.candidate-1"; results are stored under it. */
  key: string;
  type: TaskType;
  instructions: string;
  promptVersion: string;
  context: JsonValue;
  schema: z.ZodType<T>;
  allowedTools: string[];
  /** Catalog references in the payload, with JSON pointers for findings. */
  entities?(payload: T): { path: string; ref: EntityRef }[];
  /** LLM-written text in the payload, checked for free numbers and calc refs. */
  richText?(payload: T): { path: string; text: RichText }[];
  /** Task-specific checks (engine calculations, gates). Only error findings reject. */
  check?(payload: T, ctx: PipelineContext): Promise<Finding[]>;
}

/** Type-erased task spec as the engine handles it. */
export type AnyTaskSpec = TaskSpec<unknown>;

/** Erases the payload type; the engine only passes payloads parsed by `schema`. */
export function defineTask<T>(spec: TaskSpec<T>): AnyTaskSpec {
  return spec as unknown as AnyTaskSpec;
}

export type PlanStep =
  | { kind: "task"; spec: AnyTaskSpec }
  /** Deterministic work without Claude (e.g. S1 base profile, S3 skeleton calculations). */
  | {
      kind: "server";
      key: string;
      type: TaskType;
      run(ctx: PipelineContext): Promise<JsonValue>;
    }
  /**
   * Deterministic work that may take minutes (PoB optimisation). The engine runs
   * it in the background and tells Claude to wait; the result is stored under
   * `key` when done and a failure fails the run. `run` must be restartable: it
   * starts again after a server restart.
   */
  | {
      kind: "job";
      key: string;
      type: TaskType;
      /** Shown to Claude and the app while the job runs, e.g. "Calculating the skeleton builds". */
      label: string;
      run(ctx: PipelineContext): Promise<JsonValue>;
    }
  | { kind: "wait_user"; reason: RichText }
  /**
   * Sends a stage back: drops its results and everything after, and shows the findings to the
   * task that redoes it. After `maxReturns` returns of the same stage the run fails visibly.
   */
  | {
      kind: "return";
      stage: TaskType;
      findings: Finding[];
      maxReturns: number;
      /** What still fails, for the error when the returns are used up. */
      summary: string;
    }
  /** The pipeline cannot go on (missing stage, wrong engine). Fails the run visibly. */
  | { kind: "blocked"; error: { code: string; message: string } }
  | { kind: "done" };

export interface Pipeline {
  readonly id: string;
  /** Next step for the current run state. Must be deterministic for a given state. */
  plan(ctx: PipelineContext): PlanStep;
  /** Number of Claude tasks once known (for progress display). */
  plannedTasks?(ctx: PipelineContext): number | undefined;
  /** Rejects an intervention that makes no sense for this run (returns the reason). */
  validateIntervention?(intervention: UserIntervention, ctx: PipelineContext): string | undefined;
}
