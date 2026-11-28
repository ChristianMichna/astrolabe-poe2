import { z } from "zod";
import { PassiveGroup, PassiveNode } from "../catalog/entities.js";
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
export const TreeIconAtlas = z.object({
  /** Edge length of one cell in pixels. */
  cell: z.number().int().positive(),
  /** Cells per row. */
  columns: z.number().int().positive(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  /** Passive node id (the catalog's pobNodeId as text) to cell index (row-major, from 0). */
  icons: z.record(z.string().min(1), z.number().int().nonnegative()),
  /** Passive node ids whose icon is not in the atlas; they stay without a picture, never get a stand-in. */
  missing: z.array(z.string().min(1)),
});
export type TreeIconAtlas = z.infer<typeof TreeIconAtlas>;
