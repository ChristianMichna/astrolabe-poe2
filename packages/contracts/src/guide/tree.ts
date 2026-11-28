import { z } from "zod";
import { PassiveGroup, PassiveNode } from "../catalog/entities.js";
import { PassiveNodeId } from "../common/ids.js";
import { DataReleaseId } from "../common/version.js";

/**
 * The passive tree of the data release the server runs with (server: GET /api/tree): every
 * node and group with its geometry, so the window can draw a guide's allocation. An entry the
 * server cannot read as a node or group is not left out silently; it is listed in `skipped`.
 */
export const PassiveTreeData = z.object({
  dataReleaseId: DataReleaseId,
  passiveNodes: z.array(PassiveNode),
  passiveGroups: z.array(PassiveGroup),
  /** `<kind>:<id>` of catalog entries that did not match their schema and are not in the lists. */
  skipped: z.array(z.string().min(1)),
});
export type PassiveTreeData = z.infer<typeof PassiveTreeData>;

/**
 * Index of the node icon atlas (server: GET /api/tree/icons.json; the picture is
 * GET /api/tree/icons.png). The atlas is a grid of square cells, row by row; a cell holds the
 * round-masked icon of one or more passive nodes. The picture is built from the passive tree
 * data of the engine at run time and is not part of the data release.
 */
export const TreeIconAtlas = z
  .object({
    /** Edge length of one cell in pixels. */
    cell: z.number().int().positive(),
    /** Cells per row. */
    columns: z.number().int().positive(),
    /** Width of the picture in pixels; `cell * columns`. */
    width: z.number().int().positive(),
    /** Height of the picture in pixels; a whole number of rows. */
    height: z.number().int().positive(),
    /** Catalog node id to cell index (row-major, from 0). */
    icons: z.record(PassiveNodeId, z.number().int().nonnegative()),
    /** Catalog node ids without a picture; they stay without one, never get a stand-in. */
    missing: z.array(PassiveNodeId),
  })
  .superRefine((atlas, ctx) => {
    if (atlas.width !== atlas.cell * atlas.columns) {
      ctx.addIssue({ code: "custom", path: ["width"], message: "width must be cell * columns" });
    }
    if (atlas.height % atlas.cell !== 0) {
      ctx.addIssue({
        code: "custom",
        path: ["height"],
        message: "height must be a whole number of rows",
      });
      return;
    }
    const cells = atlas.columns * (atlas.height / atlas.cell);
    for (const [id, index] of Object.entries(atlas.icons)) {
      if (index >= cells) {
        ctx.addIssue({
          code: "custom",
          path: ["icons", id],
          message: `cell ${index} is outside the picture (${cells} cells)`,
        });
      }
    }
    const seen = new Set<string>();
    atlas.missing.forEach((id, at) => {
      if (seen.has(id) || id in atlas.icons) {
        ctx.addIssue({
          code: "custom",
          path: ["missing", at],
          message: `node ${id} is listed twice or also has a picture`,
        });
      }
      seen.add(id);
    });
  });
