import { z } from "zod";
import { IsoDateTime } from "../common/version.js";

/**
 * Section comments: the player marks a part of a finished guide and says what should change;
 * Claude then redoes exactly that part through the forge loop (`UserIntervention` kind
 * "comment"), every submission is checked again (G1, numbers only from the engine, rubric) and
 * the guide becomes a new revision.
 */

/**
 * Key of one task result the guide is made of, e.g. "S9.mechanics" or "S9.stage-act-1". Keys are
 * the pipeline's own; the list of keys a guide can be commented on comes from the server
 * (`GuideCommentsView.sections`), the app never builds them itself.
 */
export const GuideSectionKey = z
  .string()
  .min(3)
  .max(120)
  .regex(/^S9\.[a-z0-9][a-z0-9.-]*$/, "expected a guide section key like S9.mechanics");
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
