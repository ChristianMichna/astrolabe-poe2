import { z } from "zod";
import { BuildRequest, Finding, TaskType } from "@astrolabe/contracts/build";
import { IsoDateTime, JsonValue } from "@astrolabe/contracts/common";
import { RunId, RunPhase, SessionCode, TaskId, UserIntervention } from "@astrolabe/contracts/forge";

/*
 * Persisted state of one run. Internal storage format of apps/server (not a
 * contract): parsed on every load so a damaged row fails loudly.
 */

export const CurrentTask = z.object({
  taskId: TaskId,
  /** Pipeline key of the task, e.g. "S2.candidate-2". */
  key: z.string().min(1),
  type: TaskType,
  attempt: z.int().positive(),
  findings: z.array(Finding),
  feedback: z.array(UserIntervention),
  startedAt: IsoDateTime,
});
export type CurrentTask = z.infer<typeof CurrentTask>;

export const StoredResult = z.object({
  type: TaskType,
  /** "claude" for accepted submissions, "server" for deterministic steps. */
  by: z.enum(["claude", "server"]),
  value: JsonValue,
  at: IsoDateTime,
});
export type StoredResult = z.infer<typeof StoredResult>;

export const OpenAsk = z.object({
  askId: z.string().min(1),
  /** "claude": forge.ask_user; "escalation": task failed too often, user decides. */
  origin: z.enum(["claude", "escalation"]),
  taskId: TaskId.optional(),
  question: z.string().min(1),
  options: z.array(z.string()),
  answer: z.string().optional(),
});
export type OpenAsk = z.infer<typeof OpenAsk>;

export const RunRecord = z.object({
  runId: RunId,
  pipelineId: z.string().min(1),
  createdAt: IsoDateTime,
  request: BuildRequest,
  phase: RunPhase,
  sessionCode: z.object({ code: SessionCode, expiresAt: IsoDateTime }).nullable(),
  results: z.record(z.string(), StoredResult),
  current: CurrentTask.nullable(),
  interventions: z.array(
    z.object({ intervention: UserIntervention, at: IsoDateTime, delivered: z.boolean() }),
  ),
  asks: z.array(OpenAsk),
  taskCounter: z.int().nonnegative(),
  /** Seq the next event of this run gets. */
  nextSeq: z.int().nonnegative(),
  /** How often gate findings sent a stage back (S10), per stage; bounded by the pipeline. */
  returns: z.record(z.string(), z.int().nonnegative()).default({}),
  /** Findings returned to a stage, shown to the task that redoes it. */
  returned: z.record(z.string(), z.array(Finding)).default({}),
  guideId: z.uuid().optional(),
  /** Earlier published versions of the guide (S11 results), oldest first; filled by section comments. */
  revisions: z.array(JsonValue).default([]),
  error: z.object({ code: z.string().min(1), message: z.string().min(1) }).optional(),
});
export type RunRecord = z.infer<typeof RunRecord>;
