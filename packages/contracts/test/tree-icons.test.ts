import { describe, expect, it } from "vitest";
import { TreeIconAtlas } from "../src/guide/tree.js";

const atlas = {
  cell: 96,
  columns: 4,
  width: 384,
  height: 192,
  icons: { "123": 0, "456": 5 },
  missing: ["789"],
};
const bad = (patch: Record<string, unknown>) => TreeIconAtlas.safeParse({ ...atlas, ...patch });

describe("TreeIconAtlas", () => {
  it("accepts an index with missing icons listed, and an empty one", () => {
    expect(TreeIconAtlas.parse(atlas).missing).toEqual(["789"]);
    expect(bad({ icons: {}, missing: [] }).success).toBe(true);
  });
  it("rejects a negative cell index and an empty node id", () => {
    expect(bad({ icons: { "123": -1 } }).success).toBe(false);
    expect(bad({ icons: { "": 0 } }).success).toBe(false);
    expect(bad({ missing: [""] }).success).toBe(false);
  });
  it("rejects zero, fractional and missing sizes", () => {
    for (const field of ["cell", "columns", "width", "height"]) {
      expect(bad({ [field]: 0 }).success).toBe(false);
      expect(bad({ [field]: 1.5 }).success).toBe(false);
      expect(bad({ [field]: undefined }).success).toBe(false);
    }
  });
  it("rejects sizes that contradict each other", () => {
    expect(bad({ width: 380 }).success).toBe(false);
    expect(bad({ height: 100 }).success).toBe(false);
  });
  it("rejects a cell outside the picture", () => {
    expect(bad({ icons: { "123": 8 } }).success).toBe(false);
    expect(bad({ icons: { "123": 7 } }).success).toBe(true);
  });
  it("rejects a node that is missing twice or missing and pictured", () => {
    expect(bad({ missing: ["789", "789"] }).success).toBe(false);
    expect(bad({ missing: ["123"] }).success).toBe(false);
  });
});
