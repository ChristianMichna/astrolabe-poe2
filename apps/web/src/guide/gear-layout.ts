import { z } from "zod";
import raw from "../../../../config/web/gear-layout.json";

/** Where each slot sits on the paper doll (config/web/gear-layout.json), checked at start-up. */
const Area = z.object({
  col: z.number().int().min(1),
  row: z.number().int().min(1),
  colSpan: z.number().int().min(1),
  rowSpan: z.number().int().min(1),
});

const GearLayoutConfig = z
  .object({
    columns: z.number().int().min(1),
    slots: z.record(z.string().min(1), Area),
    /** Icon id per slot name (see SlotIcon); slots without an entry get a neutral icon. */
    icons: z.record(z.string().min(1), z.string().min(1)),
    /** Slots that take the same place because a character wears only one of them (e.g. two-hand vs off-hand). */
    alternatives: z.array(z.array(z.string().min(1)).min(2)).default([]),
  })
  .superRefine((cfg, ctx) => {
    const seen = new Map<string, string>();
    const same = (a: string, b: string) =>
      cfg.alternatives.some((g) => g.includes(a) && g.includes(b));
    for (const [slot, a] of Object.entries(cfg.slots)) {
      if (a.col + a.colSpan - 1 > cfg.columns) {
        ctx.addIssue({ code: "custom", message: `${slot} leaves the ${cfg.columns} columns` });
      }
      for (let r = a.row; r < a.row + a.rowSpan; r++) {
        for (let c = a.col; c < a.col + a.colSpan; c++) {
          const key = `${c},${r}`;
          const other = seen.get(key);
          if (other !== undefined && !same(slot, other)) {
            ctx.addIssue({ code: "custom", message: `${slot} overlaps ${other}` });
          }
          seen.set(key, slot);
        }
      }
    }
  });

export const GEAR_LAYOUT = GearLayoutConfig.parse(raw);
