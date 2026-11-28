import { z } from "zod";
import { IsoDateTime } from "../common/version.js";

/**
 * Section comments: the player marks a part of a finished guide and says what should change;
 * Claude then redoes exactly that part through the forge loop (`UserIntervention` kind
 * "comment"), every submission is checked again (G1, numbers only from the engine, rubric) and
 * the guide becomes a new revision.
 */

/**
 * Key of one task result the guide is made of: a written section ("S9.mechanics", "S9.stage-act-1")
 * or a crafting strategy ("S8.craft-<tier>-<slot>"), which the simulator measures again. Keys are
 * the pipeline's own; the list of keys a guide can be commented on comes from the server
 * (`GuideCommentsView.sections`), the app never builds them itself.
 */
export const GuideSectionKey = z
  .string()
  .min(3)
  .max(120)
  .regex(
    /^(?:S9|S8\.craft)[.-][a-z0-9][a-z0-9.-]*$/,
    "expected a guide section key like S9.mechanics or S8.craft-tier-slot",
  );
export type GuideSectionKey = z.infer<typeof GuideSectionKey>;

/** Longest comment text; the text goes to Claude as an instruction for one section. */
export const GUIDE_COMMENT_MAX_LENGTH = 2000;

/** Request body of POST /api/guides/:guideId/comments. */
export const GuideCommentRequest = z.object({
  section: GuideSectionKey,
  text: z.string().trim().min(1).max(GUIDE_COMMENT_MAX_LENGTH),
});
export type GuideCommentRequest = z.infer<typeof GuideCommentRequest>;

/**
 * Where a comment stands, derived from the run (not stored twice):
 * `queued` waits for Claude to pick it up, `working` is the open task of the section,
 * `applied` means the section was rewritten and checked after the comment, `failed` means the run
 * stopped (see the run) before the section was done.
 */
export const GuideCommentStatus = z.enum(["queued", "working", "applied", "failed"]);
export type GuideCommentStatus = z.infer<typeof GuideCommentStatus>;

export const GuideComment = z.object({
  commentId: z.string().min(1).max(64),
  section: GuideSectionKey,
  text: z.string().min(1).max(GUIDE_COMMENT_MAX_LENGTH),
  createdAt: IsoDateTime,
  status: GuideCommentStatus,
});
export type GuideComment = z.infer<typeof GuideComment>;

/** A part of the guide that can be commented on. */
export const GuideSectionInfo = z.object({
  key: GuideSectionKey,
  /** Name for the comment button and list, in the app's language. */
  label: z.string().min(1),
  /**
   * The comment makes Claude plan the part again and the engine measures it again (crafting
   * strategies: simulator and prices), not only rewrite text.
   */
  recalculates: z.boolean().default(false),
});
export type GuideSectionInfo = z.infer<typeof GuideSectionInfo>;

/** Server: GET /api/guides/:guideId/comments and the answer of the POST. */
export const GuideCommentsView = z.object({
  guideId: z.string().min(1),
  /**
   * The run that made the guide; comments are worked off in it. Absent for an imported guide,
   * which cannot be commented on (`sections` is then empty and `reason` says why).
   */
  runId: z.uuid().optional(),
  reason: z.string().min(1).optional(),
  sections: z.array(GuideSectionInfo),
  comments: z.array(GuideComment),
});
export type GuideCommentsView = z.infer<typeof GuideCommentsView>;

/**
 * Lower case, digits and dashes: how the pipeline turns an id (stage, tier, slot, plan) into a
 * part of a result key. A test in apps/server holds this equal to the pipeline's own keys.
 */
export function sectionSlug(id: string): string {
  return id
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/** Key of the text written for a progression stage. */
export const stageSectionKey = (stageKey: string): string => `S9.stage-${sectionSlug(stageKey)}`;

/** Key of the text written for a gear slot of a budget tier. */
export const slotSectionKey = (tier: string, slot: string): string =>
  `S9.slot-${sectionSlug(tier)}-${sectionSlug(slot)}`;

/** Key of the text written for a crafting plan (`CraftingPlan.key`). */
export const craftTextSectionKey = (planKey: string): string => `S9.craft-${sectionSlug(planKey)}`;
