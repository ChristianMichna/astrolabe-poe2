import { z } from "zod";
import { EntityRef } from "../common/ids.js";
import { CalcRef } from "../common/sourced.js";

/** Id of a research finding (ADR-0006); defined here because text cites it and research uses text. */
export const ResearchFindingId = z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/);
export type ResearchFindingId = z.infer<typeof ResearchFindingId>;

/*
 * Rich text for everything an LLM writes (rationale, guide prose). Numbers
 * are never typed into text: they are `calc` segments that reference a PoB
 * result, and entities are `entity` segments with a catalog id. The number
 * linter (gate, packages/agents) rejects digits that stand for game values in
 * `text` segments; the schema only fixes the shape.
 */
export const TextSegment = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string().min(1).max(4000) }),
  z.object({ type: z.literal("calc"), ref: CalcRef }),
  z.object({ type: z.literal("entity"), ref: EntityRef }),
  /** A citation: the id of a research finding of the same guide (`GuideDocument.research`). */
  z.object({ type: z.literal("source"), id: ResearchFindingId }),
]);
export type TextSegment = z.infer<typeof TextSegment>;

export const RichText = z.array(TextSegment).min(1).max(200);
export type RichText = z.infer<typeof RichText>;

/** A decision with its reason; the guide shows these under "Warum so?". */
export const Rationale = z.object({
  subject: EntityRef.optional(),
  reason: RichText,
});
export type Rationale = z.infer<typeof Rationale>;
