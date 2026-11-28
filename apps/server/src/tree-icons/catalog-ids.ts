import { PassiveNode } from "@astrolabe/contracts/catalog";
import type { TreeIconAtlas } from "@astrolabe/contracts/guide";
import type { PobIconIndex } from "./atlas.js";
import type { CatalogPort } from "../ports/catalog.js";

/**
 * The atlas is built from Path of Building's tree data, which names nodes by their PoB id. The
 * window and the contract name them by catalog id; this re-keys the index through `pobNodeId`.
 * A catalog node without a PoB id, or whose PoB node has no picture, is listed in `missing`.
 */
export function withCatalogIds(index: PobIconIndex, catalog: CatalogPort): TreeIconAtlas {
  const icons: Record<string, number> = {};
  const missing: TreeIconAtlas["missing"] = [];
  for (const entry of catalog.list("passiveNode")) {
    const node = PassiveNode.safeParse(entry.entity);
    if (!node.success) continue; // already listed in `skipped` of GET /api/tree
    const cell =
      node.data.pobNodeId === undefined ? undefined : index.icons[String(node.data.pobNodeId)];
    if (cell === undefined) missing.push(node.data.id);
    else icons[node.data.id] = cell;
  }
  const { cell, columns, width, height } = index;
  return { cell, columns, width, height, icons, missing };
}
