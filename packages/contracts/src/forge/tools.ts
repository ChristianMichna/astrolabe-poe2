import { z } from "zod";
import { EntityRef } from "../common/ids.js";
import { JsonValue } from "../common/json.js";
import { Finding, TaskType } from "../build/findings.js";
import { RichText } from "../build/text.js";
import { GuideSectionKey, GUIDE_COMMENT_MAX_LENGTH } from "../guide/comments.js";

/*
 * MCP tools of the forge loop (ADR-0003): Claude in the user's own client
 * pulls small tasks with forge.next and hands in results with forge.submit;
 * the local server validates each submission (schema, PoB, gates) at once.
 * Same task format for the BYOK gateway (ADR-0002).
 */

export const RunId = z.uuid().brand<"RunId">();
export type RunId = z.infer<typeof RunId>;

export const TaskId = z.string().min(1).max(64).brand<"TaskId">();
export type TaskId = z.infer<typeof TaskId>;

/** Short session code shown in the frontend, e.g. "7F3K-QX"; no ambiguous characters. */
export const SessionCode = z
  .string()
  .regex(/^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{2}$/, "expected session code like 7F3K-QX");
export type SessionCode = z.infer<typeof SessionCode>;

/** Something the user did in the frontend since the last task. */
export const UserIntervention = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("chooseVariant"), candidateKey: z.string().min(1) }),
  z.object({ kind: z.literal("lock"), entity: EntityRef }),
  z.object({ kind: z.literal("reject"), entity: EntityRef }),
  z.object({ kind: z.literal("adjust"), request: z.string().min(1).max(2000) }),
  z.object({ kind: z.literal("redoStage"), stage: TaskType }),
  /**
   * The player commented on one section of the finished guide: redo that section with this
   * request. Only the task of `section` sees it. `previous` is the section as it stood; the
   * server sets it, a value sent by the client is replaced.
   */
  z.object({
    kind: z.literal("comment"),
    commentId: z.string().min(1).max(64),
    section: GuideSectionKey,
    text: z.string().min(1).max(GUIDE_COMMENT_MAX_LENGTH),
    previous: JsonValue.optional(),
  }),
  z.object({ kind: z.literal("pause") }),
  z.object({ kind: z.literal("resume") }),
  z.object({ kind: z.literal("answer"), askId: z.string().min(1), answer: z.string().max(2000) }),
]);
export type UserIntervention = z.infer<typeof UserIntervention>;

/** One small task with its own response schema. */
export const ForgeTask = z.object({
  taskId: TaskId,
  type: TaskType,
  /** Correction round, starting at 1. */
  attempt: z.int().positive(),
  maxAttempts: z.int().positive(),
  /** Short instructions from packages/agents/prompts (versioned there). */
  instructions: z.string().min(1),
  promptVersion: z.string().min(1),
  /** Only what this task needs: ids, calc references, earlier decisions. */
  context: JsonValue,
  feedback: z.array(UserIntervention),
  /** Findings of the previous submission of this task. */
  findings: z.array(Finding),
  /** JSON Schema the submission payload must satisfy. */
  responseSchema: z.record(z.string(), JsonValue),
  /** Read/calc tools Claude may use inside this task. */
  allowedTools: z.array(z.string().min(1)),
});
export type ForgeTask = z.infer<typeof ForgeTask>;

export const RunPhase = z.enum(["planning", "waiting_user", "paused", "done", "failed"]);
export type RunPhase = z.infer<typeof RunPhase>;

export const RunStatus = z.object({
  runId: RunId,
  phase: RunPhase,
  currentTask: TaskType.optional(),
  completedTasks: z.int().nonnegative(),
  /** Planned tasks; known only once the pipeline has expanded. */
  plannedTasks: z.int().nonnegative().optional(),
});
export type RunStatus = z.infer<typeof RunStatus>;

/** What forge.next / forge.attach / an accepted submit hand back. */
export const ForgeStep = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("task"), task: ForgeTask }),
  /** User must act in the frontend; call forge.next again after `retryAfterSeconds`. */
  z.object({
    kind: z.literal("wait_user"),
    reason: RichText,
    retryAfterSeconds: z.int().positive(),
  }),
  z.object({ kind: z.literal("done"), guideId: z.uuid() }),
  z.object({
    kind: z.literal("failed"),
    error: z.object({ code: z.string().min(1), message: z.string().min(1) }),
  }),
]);
export type ForgeStep = z.infer<typeof ForgeStep>;

export const ForgeTools = {
  "forge.attach": {
    description: "Attach to an Astrolabe run with the session code shown in the app.",
    input: z.object({ code: SessionCode }),
    output: z.object({ runId: RunId, status: RunStatus, next: ForgeStep }),
  },
  "forge.next": {
    description: "Get the next task of the run (or wait/done). Repeat until done.",
    input: z.object({ runId: RunId }),
    output: ForgeStep,
  },
  "forge.submit": {
    description:
      "Hand in the result of a task. Payload must match the task's responseSchema; numbers only as calc references.",
    input: z.object({
      runId: RunId,
      taskId: TaskId,
      attempt: z.int().positive(),
      payload: JsonValue,
    }),
    output: z.discriminatedUnion("result", [
      z.object({ result: z.literal("accepted"), next: ForgeStep }),
      /** Same task again with findings, if attempts remain; otherwise next is failed/escalation. */
      z.object({
        result: z.literal("rejected"),
        findings: z.array(Finding).min(1),
        next: ForgeStep,
      }),
    ]),
  },
  "forge.ask_user": {
    description: "Ask the user a question; it appears as a card in the Astrolabe app.",
    input: z.object({
      runId: RunId,
      taskId: TaskId,
      question: z.string().min(1).max(1000),
      options: z.array(z.string().min(1).max(200)).max(6).default([]),
    }),
    output: z.object({ askId: z.string().min(1), next: ForgeStep }),
  },
  "forge.status": {
    description: "Current state of the run.",
    input: z.object({ runId: RunId }),
    output: RunStatus,
  },
} as const;

export type ForgeToolName = keyof typeof ForgeTools;
