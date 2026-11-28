import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { zstdDecompress } from "node:zlib";
import { promisify } from "node:util";
import { z } from "zod";
import { decodeBc1 } from "./bc1.js";
import { encodePng } from "./png.js";

const zstd = promisify(zstdDecompress);

/** Edge of one atlas cell; the sources are 64 to 176 pixels, so notables stay sharp when zoomed in. */
const CELL = 96;
/** DDS magic and header (128 bytes), then the DX10 header (20 bytes) of texture arrays. */
const DDS_DATA_OFFSET = 148;
const DXGI_BC1_UNORM = 71;
/** Texture sheets with the allocatable node icons; the `-disabled` variants are greyed copies. */
const ICON_SHEET = /^skills_\d+_\d+_BC1\.dds\.zst$/;
const TREE_VERSION_DIR = /^(\d+)_(\d+)$/;

const TreeFile = z.object({
  nodes: z.record(z.string(), z.object({ icon: z.string().optional() }).passthrough()),
  ddsCoords: z.record(z.string(), z.record(z.string(), z.number().int().positive())),
});

/** The picture's grid and which cell holds the icon of which PoB node (keyed by PoB's node id). */
export interface PobIconIndex {
  cell: number;
  columns: number;
  width: number;
  height: number;
  icons: Record<string, number>;
}

export interface BuiltIconAtlas {
  png: Buffer;
  index: PobIconIndex;
}

/** The newest `<major>_<minor>` folder under `<pobRoot>/src/TreeData`. */
export async function findTreeDataDir(pobRoot: string): Promise<string> {
  const base = join(pobRoot, "src", "TreeData");
  const versions = (await readdir(base))
    .map((name) => ({ name, match: TREE_VERSION_DIR.exec(name) }))
    .filter((entry): entry is { name: string; match: RegExpExecArray } => entry.match !== null)
    .map(({ name, match }) => ({ name, major: Number(match[1]), minor: Number(match[2]) }))
    .sort((a, b) => b.major - a.major || b.minor - a.minor);
  const newest = versions[0];
  if (newest === undefined) throw new Error(`No passive tree data folder in ${base}`);
  return join(base, newest.name);
}

interface DecodedSheet {
  width: number;
  height: number;
  slices: number;
  sliceBytes: number;
  data: Uint8Array;
}

function parseSheet(data: Uint8Array, sheetName: string): DecodedSheet {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (data.length < DDS_DATA_OFFSET || view.getUint32(0, true) !== 0x20534444) {
    throw new Error(`${sheetName} is not a DDS texture`);
  }
  const height = view.getUint32(12, true);
  const width = view.getUint32(16, true);
  const mips = view.getUint32(28, true);
  const fourCc = String.fromCharCode(...data.subarray(84, 88));
  if (fourCc !== "DX10" || view.getUint32(128, true) !== DXGI_BC1_UNORM) {
    throw new Error(`${sheetName} is not a BC1 texture array`);
  }
  const slices = view.getUint32(140, true);
  let sliceBytes = 0;
  for (let level = 0; level < mips; level++) {
    sliceBytes += Math.max(1, (width >> level) >> 2) * Math.max(1, (height >> level) >> 2) * 8;
  }
  if (DDS_DATA_OFFSET + slices * sliceBytes > data.length) {
    throw new Error(`${sheetName} is shorter than its header says`);
  }
  return { width, height, slices, sliceBytes, data };
}

/** Scales RGBA pixels to a CELL x CELL cell (bilinear, 2x2 supersampled) and cuts a round, feathered edge. */
function toRoundCell(src: Uint8Array, width: number, height: number): Uint8Array {
  const out = new Uint8Array(CELL * CELL * 4);
  const sample = (u: number, v: number, channel: number): number => {
    const x = Math.min(width - 1, Math.max(0, u * width - 0.5));
    const y = Math.min(height - 1, Math.max(0, v * height - 0.5));
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const x1 = Math.min(width - 1, x0 + 1);
    const y1 = Math.min(height - 1, y0 + 1);
    const fx = x - x0;
    const fy = y - y0;
    const at = (px: number, py: number) => src[(py * width + px) * 4 + channel] ?? 0;
    return (
      at(x0, y0) * (1 - fx) * (1 - fy) +
      at(x1, y0) * fx * (1 - fy) +
      at(x0, y1) * (1 - fx) * fy +
      at(x1, y1) * fx * fy
    );
  };
  const radius = CELL / 2 - 0.5;
  for (let y = 0; y < CELL; y++) {
    for (let x = 0; x < CELL; x++) {
      const distance = Math.hypot(x + 0.5 - CELL / 2, y + 0.5 - CELL / 2);
      const alpha = Math.min(1, Math.max(0, radius - distance));
      if (alpha === 0) continue;
      const at = (y * CELL + x) * 4;
      for (let channel = 0; channel < 3; channel++) {
        let sum = 0;
        for (const dy of [0.25, 0.75]) {
          for (const dx of [0.25, 0.75]) {
            sum += sample((x + dx) / CELL, (y + dy) / CELL, channel);
          }
        }
        out[at + channel] = Math.round(sum / 4);
      }
      out[at + 3] = Math.round(alpha * 255);
    }
  }
  return out;
}

/**
 * Builds the node icon atlas from the passive tree data of Path of Building (`tree.json` and the
 * `skills_*` texture sheets of one `TreeData/<version>` folder). Every node with an icon in the
 * sheets gets a cell; nodes without one are absent from `icons`.
 */
export async function buildIconAtlas(treeDir: string): Promise<BuiltIconAtlas> {
  const tree = TreeFile.parse(JSON.parse(await readFile(join(treeDir, "tree.json"), "utf8")));
  const sheetNames = Object.keys(tree.ddsCoords).filter((name) => ICON_SHEET.test(name));
  if (sheetNames.length === 0) throw new Error(`No icon sheet in ${treeDir}`);

  // Icon path -> its pixels, one cell per distinct icon.
  const cells: Uint8Array[] = [];
  const cellOfIcon = new Map<string, number>();
  for (const sheetName of sheetNames) {
    const compressed = await readFile(join(treeDir, sheetName));
    const sheet = parseSheet(await zstd(compressed), sheetName);
    for (const [icon, slice] of Object.entries(tree.ddsCoords[sheetName] ?? {})) {
      if (cellOfIcon.has(icon)) continue;
      if (slice > sheet.slices) throw new Error(`${sheetName} has no slice ${slice} for ${icon}`);
      const offset = DDS_DATA_OFFSET + (slice - 1) * sheet.sliceBytes;
      const rgba = decodeBc1(sheet.data, offset, sheet.width, sheet.height);
      cellOfIcon.set(icon, cells.length);
      cells.push(toRoundCell(rgba, sheet.width, sheet.height));
    }
  }

  const columns = Math.ceil(Math.sqrt(cells.length));
  const rows = Math.ceil(cells.length / columns);
  const width = columns * CELL;
  const height = rows * CELL;
  const pixels = new Uint8Array(width * height * 4);
  cells.forEach((cell, index) => {
    const left = (index % columns) * CELL;
    const top = Math.floor(index / columns) * CELL;
    for (let y = 0; y < CELL; y++) {
      pixels.set(cell.subarray(y * CELL * 4, (y + 1) * CELL * 4), ((top + y) * width + left) * 4);
    }
  });

  const icons: Record<string, number> = {};
  for (const [nodeId, node] of Object.entries(tree.nodes)) {
    const cell = node.icon === undefined ? undefined : cellOfIcon.get(node.icon);
    if (cell !== undefined) icons[nodeId] = cell;
  }
  return {
    png: encodePng(pixels, width, height),
    index: { cell: CELL, columns, width, height, icons },
  };
}
