import { isDeepStrictEqual } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { CalcResult } from "@astrolabe/contracts/calc";
import { RunEvent } from "@astrolabe/contracts/events";
import { collectCalcIds, type GuideFile, type GuideListItem } from "@astrolabe/contracts/guide";
import { ForgeError } from "../engine/errors.js";
import { RunRecord } from "../engine/run-record.js";
import type { Logger } from "../logger.js";
import { GuidePatchCheck, PatchCheckOutcome } from "@astrolabe/contracts";

/**
 * SQLite store for runs and their event log (node:sqlite, no native
 * add-on to build for Windows). One JSON row per run; events append-only.
 */
export class RunStore {
  private readonly db: DatabaseSync;

  constructor(
    path: string,
    private readonly logger?: Logger,
  ) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        session_code TEXT,
        record TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS runs_session_code ON runs(session_code);
      CREATE TABLE IF NOT EXISTS calc_results (
        calc_id TEXT PRIMARY KEY,
        result TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS imported_guides (
        guide_id TEXT PRIMARY KEY,
        guide TEXT NOT NULL,
        imported_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS patch_checks (
        guide_id TEXT NOT NULL,
        to_release_id TEXT NOT NULL,
        outcome TEXT NOT NULL,
        checked_at TEXT NOT NULL,
        PRIMARY KEY (guide_id, to_release_id)
      );
      CREATE TABLE IF NOT EXISTS events (
        run_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        event TEXT NOT NULL,
        PRIMARY KEY (run_id, seq)
      );
    `);
  }

  load(runId: string): RunRecord | undefined {
    const row = this.db.prepare("SELECT record FROM runs WHERE run_id = ?").get(runId);
    return row === undefined ? undefined : parseRow(RunRecord, row["record"], `run ${runId}`);
  }

  findBySessionCode(code: string): RunRecord | undefined {
    const row = this.db.prepare("SELECT record FROM runs WHERE session_code = ?").get(code);
    return row === undefined ? undefined : parseRow(RunRecord, row["record"], `code ${code}`);
  }

  /**
   * The stored guide (result of stage S11) with this id; when several runs carry the id, the
   * most recently saved one. Undefined if no run has produced it.
   */
  findGuide(guideId: string): unknown {
    const rows = this.db
      .prepare(
        "SELECT record FROM runs WHERE json_extract(record, '$.guideId') = ? ORDER BY updated_at DESC, rowid DESC LIMIT 1",
      )
      .all(guideId);
    const row = rows[0];
    if (row === undefined) return this.findImportedGuide(guideId);
    const record = parseRow(RunRecord, row["record"], `guide ${guideId}`);
    // While a section comment is worked off, the guide stays readable as its last revision.
    return record.results["S11.guide"]?.value ?? record.revisions.at(-1);
  }

  /** The run that made the guide with this id (the most recently saved one); undefined for imported guides. */
  findRunByGuideId(guideId: string): RunRecord | undefined {
    const row = this.db
      .prepare(
        "SELECT record FROM runs WHERE json_extract(record, '$.guideId') = ? ORDER BY updated_at DESC, rowid DESC LIMIT 1",
      )
      .get(guideId);
    return row === undefined ? undefined : parseRow(RunRecord, row["record"], `guide ${guideId}`);
  }

  private findImportedGuide(guideId: string): unknown {
    const row = this.db
      .prepare("SELECT guide FROM imported_guides WHERE guide_id = ?")
      .get(guideId);
    if (row === undefined) return undefined;
    const text = row["guide"];
    if (typeof text !== "string") throw new Error(`Stored imported guide ${guideId} is not text`);
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new Error(`Stored imported guide ${guideId} is not valid JSON`, { cause: error });
    }
  }

  /**
   * Stores a guide file: the results its guide refers to (never replacing a different result
   * stored under the same calcId) and the guide itself. Importing the same guide again replaces the copy; a guide
   * that one of this installation's own runs produced is not overwritten. All or nothing.
   */
  importGuide(file: GuideFile, importedAt: string): void {
    const guideId = file.guide.metadata.guideId;
    // Only the results the guide refers to are stored; the file may carry more.
    const byId = new Map<string, CalcResult>(Object.entries(file.results));
    const results = collectCalcIds(file.guide).flatMap((calcId) => {
      const result = byId.get(calcId);
      return result === undefined ? [] : [result];
    });
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (this.runGuideIds().includes(guideId)) {
        throw new ForgeError(
          "invalid_request",
          `Guide ${guideId} was made by this installation; it is not replaced by an import.`,
        );
      }
      for (const result of results) {
        const existing = this.loadCalcResult(result.calcId);
        if (existing !== undefined && !isDeepStrictEqual(existing, result)) {
          throw new ForgeError(
            "invalid_request",
            `Result ${result.calcId} differs from the one already stored under that id; the file is not imported.`,
          );
        }
      }
      for (const result of results) this.saveCalcResult(result);
      this.db
        .prepare(
          "INSERT OR REPLACE INTO imported_guides (guide_id, guide, imported_at) VALUES (?, ?, ?)",
        )
        .run(guideId, JSON.stringify(file.guide), importedAt);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      if (error instanceof ForgeError) throw error;
      throw new Error(`Guide ${guideId} could not be stored`, { cause: error });
    }
  }

  /** Ids of all stored guides: guides of runs, newest first, then imported ones, newest first. */
  listGuideIds(): string[] {
    const ids = this.runGuideIds();
    const imported = this.db
      .prepare("SELECT guide_id FROM imported_guides ORDER BY imported_at DESC, rowid DESC")
      .all();
    for (const row of imported) {
      const id = row["guide_id"];
      if (typeof id === "string" && !ids.includes(id)) ids.push(id);
    }
    return ids;
  }

  /** `run` for a guide a run produced here, `imported` for a stored guide file (same precedence as `listGuideIds`); an unknown id is an error. */
  guideOrigin(guideId: string): GuideListItem["origin"] {
    if (this.runGuideIds().includes(guideId)) return "run";
    const imported = this.db
      .prepare("SELECT 1 AS found FROM imported_guides WHERE guide_id = ?")
      .get(guideId);
    if (imported === undefined) throw new Error(`No stored guide ${guideId}`);
    return "imported";
  }

  private runGuideIds(): string[] {
    const rows = this.db
      .prepare(
        `SELECT json_extract(record, '$.guideId') AS guide_id FROM runs
         WHERE json_extract(record, '$.guideId') IS NOT NULL
         ORDER BY updated_at DESC, rowid DESC`,
      )
      .all();
    const ids: string[] = [];
    for (const row of rows) {
      const id = row["guide_id"];
      if (typeof id === "string" && !ids.includes(id)) ids.push(id);
    }
    return ids;
  }

  /** Keeps the outcome of the newest revalidation of a guide against a release (replaces an older one). */
  savePatchCheck(
    guideId: string,
    toReleaseId: string,
    outcome: PatchCheckOutcome,
    checkedAt: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO patch_checks (guide_id, to_release_id, outcome, checked_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(guide_id, to_release_id) DO UPDATE SET outcome = excluded.outcome,
           checked_at = excluded.checked_at`,
      )
      .run(guideId, toReleaseId, JSON.stringify(outcome), checkedAt);
  }

  /**
   * Stored revalidation outcomes against one release. A row that does not match the contract
   * (damaged or written by another version) is logged and shown as an `internal` error for that
   * guide, so one bad row neither hides the others nor passes as a verdict. A row whose guide
   * id is not even a guide id cannot belong to any guide: it is logged and left out.
   */
  listPatchChecks(toReleaseId: string): GuidePatchCheck[] {
    const checks: GuidePatchCheck[] = [];
    const rows = this.db
      .prepare(
        "SELECT guide_id, outcome, checked_at FROM patch_checks WHERE to_release_id = ? ORDER BY guide_id",
      )
      .all(toReleaseId);
    for (const row of rows) {
      const guideId = GuidePatchCheck.shape.guideId.safeParse(row["guide_id"]);
      if (!guideId.success) {
        this.logger?.error("a stored guide check has no valid guide id and is left out", {
          error: guideId.error,
          toReleaseId,
        });
        continue;
      }
      let raw: unknown;
      let problem: unknown;
      try {
        raw = JSON.parse(String(row["outcome"]));
      } catch (error) {
        problem = error;
      }
      const outcome = PatchCheckOutcome.safeParse(raw);
      const checkedAt = GuidePatchCheck.shape.checkedAt.safeParse(row["checked_at"]);
      if (outcome.success && checkedAt.success) {
        checks.push({ guideId: guideId.data, outcome: outcome.data, checkedAt: checkedAt.data });
        continue;
      }
      this.logger?.error("a stored guide check does not match the contract", {
        error: problem ?? (outcome.success ? checkedAt.error : outcome.error),
        guideId: guideId.data,
        toReleaseId,
      });
      checks.push({
        guideId: guideId.data,
        // The time of the damaged row is unknown if it is the damaged part: the epoch says so.
        checkedAt: checkedAt.success ? checkedAt.data : new Date(0).toISOString(),
        outcome: {
          kind: "error",
          code: "internal",
          message: "The stored check result is damaged. The app log has details.",
        },
      });
    }
    return checks;
  }

  /** Saves the run and its new events in one transaction. */
  save(record: RunRecord, events: readonly RunEvent[]): void {
    const upsert = this.db.prepare(
      `INSERT INTO runs (run_id, session_code, record, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(run_id) DO UPDATE SET session_code = excluded.session_code,
         record = excluded.record, updated_at = excluded.updated_at`,
    );
    const insertEvent = this.db.prepare("INSERT INTO events (run_id, seq, event) VALUES (?, ?, ?)");
    this.db.exec("BEGIN");
    try {
      upsert.run(
        record.runId,
        record.sessionCode?.code ?? null,
        JSON.stringify(record),
        new Date().toISOString(),
      );
      for (const event of events) {
        insertEvent.run(event.runId, event.seq, JSON.stringify(event));
      }
      this.db.exec("COMMIT");
    } catch (error) {
      let rollbackNote = "";
      try {
        this.db.exec("ROLLBACK");
      } catch (rollbackError) {
        rollbackNote = `; rollback failed too: ${String(rollbackError)}`;
      }
      throw new Error(`Saving run ${record.runId} failed${rollbackNote}`, { cause: error });
    }
  }

  /** Events with seq greater than `afterSeq` (use -1 for all), in order. */
  eventsAfter(runId: string, afterSeq: number): RunEvent[] {
    return this.db
      .prepare("SELECT event FROM events WHERE run_id = ? AND seq > ? ORDER BY seq")
      .all(runId, afterSeq)
      .map((row) => parseRow(RunEvent, row["event"], `event of run ${runId}`));
  }

  saveCalcResult(result: CalcResult): void {
    this.db
      .prepare("INSERT OR REPLACE INTO calc_results (calc_id, result) VALUES (?, ?)")
      .run(result.calcId, JSON.stringify(result));
  }

  loadCalcResult(calcId: string): CalcResult | undefined {
    const row = this.db.prepare("SELECT result FROM calc_results WHERE calc_id = ?").get(calcId);
    return row === undefined ? undefined : parseRow(CalcResult, row["result"], `calc ${calcId}`);
  }

  close(): void {
    this.db.close();
  }
}

function parseRow<T extends z.ZodType>(schema: T, value: unknown, what: string): z.infer<T> {
  if (typeof value !== "string") throw new Error(`Stored ${what} is not text`);
  let raw: unknown;
  try {
    raw = JSON.parse(value);
  } catch (error) {
    throw new Error(`Stored ${what} is not valid JSON`, { cause: error });
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Stored ${what} is damaged: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}
