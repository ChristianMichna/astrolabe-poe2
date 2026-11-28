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

describe("TreeIconAtlas", () => {
  it("accepts an index with missing icons listed", () => {
    expect(TreeIconAtlas.parse(atlas).missing).toEqual(["789"]);
  });
  it("rejects a negative cell index and an empty node id", () => {
    expect(TreeIconAtlas.safeParse({ ...atlas, icons: { "123": -1 } }).success).toBe(false);
    expect(TreeIconAtlas.safeParse({ ...atlas, icons: { "": 0 } }).success).toBe(false);
  });
});
