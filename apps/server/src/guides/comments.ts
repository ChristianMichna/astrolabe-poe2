import {
  GuideCommentsView,
  type GuideComment,
  type GuideCommentStatus,
  type GuideSectionInfo,
} from "@astrolabe/contracts/guide";
import { commentEffect } from "@astrolabe/agents";
import type { RunRecord } from "../engine/run-record.js";

/** Names of the prose sections Claude writes (stage S9); other keys are named from their slug. */
const SECTION_LABELS: Readonly<Record<string, string>> = {
  "S9.summary": "Summary",
  "S9.mechanics": "How it works",
  "S9.playstyle": "Playstyle",
  "S9.atlas": "Endgame",
  "S9.variants": "Variants",
  "S9.faq": "Troubleshooting",
  "S5.gems": "Skill setup",
  "S6.notes": "Stage notes",
};

/** Prefixes of the detail tasks of S9 (one per stage, gear tier, gear slot and crafting plan). */
const DETAIL_PREFIXES: readonly (readonly [string, string])[] = [
  ["S9.stage-", "Stage"],
  ["S9.tier-", "Gear tier"],
  ["S9.slot-", "Gear slot"],
  ["S9.craft-", "Crafting plan"],
  // A crafting strategy: Claude plans it again and the simulator measures it again.
  ["S8.craft-", "Crafting strategy"],
  // The gear choice of a budget tier: everything built on it is calculated again.
  ["S7.gear-", "Gear choice"],
];

/** Readable name of a section key; the slug words stay as the pipeline wrote them. */
export function sectionLabel(key: string): string {
  const known = SECTION_LABELS[key];
  if (known !== undefined) return known;
  for (const [prefix, name] of DETAIL_PREFIXES) {
    if (key.startsWith(prefix)) return `${name}: ${key.slice(prefix.length).replaceAll("-", " ")}`;
  }
  return key;
}

function statusOf(run: RunRecord, section: string, at: string): GuideCommentStatus {
  const stored = run.results[section];
  // Applied only when the run is done again: validation can still send the section back.
  if (stored !== undefined && Date.parse(stored.at) > Date.parse(at)) {
    return run.phase === "done" ? "applied" : "working";
  }
  if (run.phase === "failed") return "failed";
  // A finished run never hands the comment over: the section is gone (a redone choice dropped it).
  if (run.phase === "done") return "failed";
  return run.current?.key === section ? "working" : "queued";
}

/**
 * The commentable sections of a guide and its comments, read from the run that made it. Guides
 * without a run (imported files) cannot be redone and say so.
 */
export function buildCommentsView(guideId: string, run: RunRecord | undefined): GuideCommentsView {
  if (run === undefined) {
    return GuideCommentsView.parse({
      guideId,
      reason:
        "This guide came from a file, so there is no run to change it. Make the guide yourself to comment on it.",
      sections: [],
      comments: [],
    });
  }
  const comments: GuideComment[] = run.interventions.flatMap(({ intervention, at }) =>
    intervention.kind === "comment"
      ? [
          {
            commentId: intervention.commentId,
            section: intervention.section,
            text: intervention.text,
            createdAt: at,
            status: statusOf(run, intervention.section, at),
          },
        ]
      : [],
  );
  // A section being redone has no stored result for a while; its comments keep it listed.
  const keys = new Set([
    ...Object.keys(run.results).filter((k) => commentEffect(k) !== undefined),
    ...comments.filter((c) => c.status !== "failed").map((c) => c.section),
  ]);
  const sections: GuideSectionInfo[] = [...keys].sort().map((key) => ({
    key,
    label: sectionLabel(key),
    effect: commentEffect(key)?.effect ?? "rewrite",
  }));
  return GuideCommentsView.parse({
    guideId,
    runId: run.runId,
    sections,
    comments,
    revisions: run.revisions.length,
  });
}
