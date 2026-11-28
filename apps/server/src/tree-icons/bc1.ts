/** Decoding of the BC1 (DXT1) textures that Path of Building ships its node icons in. */

const BLOCK_BYTES = 8;

function expand565(value: number): [number, number, number] {
  const r = (value >> 11) & 31;
  const g = (value >> 5) & 63;
  const b = value & 31;
  return [(r << 3) | (r >> 2), (g << 2) | (g >> 4), (b << 3) | (b >> 2)];
}

/** Decodes the top mip level of one BC1 slice (`width` x `height`, both multiples of 4) to RGBA8. */
export function decodeBc1(
  data: Uint8Array,
  offset: number,
  width: number,
  height: number,
): Uint8Array {
  if (width % 4 !== 0 || height % 4 !== 0) {
    throw new Error(`BC1 size ${width}x${height} is not a multiple of 4`);
  }
  const blocksX = width / 4;
  const blocksY = height / 4;
  if (offset + blocksX * blocksY * BLOCK_BYTES > data.length) {
    throw new Error("BC1 slice reaches past the end of the texture");
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const out = new Uint8Array(width * height * 4);
  const palette = new Uint8Array(16);
  for (let by = 0; by < blocksY; by++) {
    for (let bx = 0; bx < blocksX; bx++) {
      const at = offset + (by * blocksX + bx) * BLOCK_BYTES;
      const c0 = view.getUint16(at, true);
      const c1 = view.getUint16(at + 2, true);
      const [r0, g0, b0] = expand565(c0);
      const [r1, g1, b1] = expand565(c1);
      palette.set([r0, g0, b0, 255, r1, g1, b1, 255], 0);
      if (c0 > c1) {
        palette.set(
          [
            Math.floor((2 * r0 + r1) / 3),
            Math.floor((2 * g0 + g1) / 3),
            Math.floor((2 * b0 + b1) / 3),
            255,
            Math.floor((r0 + 2 * r1) / 3),
            Math.floor((g0 + 2 * g1) / 3),
            Math.floor((b0 + 2 * b1) / 3),
            255,
          ],
          8,
        );
      } else {
        palette.set([(r0 + r1) >> 1, (g0 + g1) >> 1, (b0 + b1) >> 1, 255, 0, 0, 0, 0], 8);
      }
      const bits = view.getUint32(at + 4, true);
      for (let i = 0; i < 16; i++) {
        const code = (bits >>> (2 * i)) & 3;
        const x = bx * 4 + (i & 3);
        const y = by * 4 + (i >> 2);
        out.set(palette.subarray(code * 4, code * 4 + 4), (y * width + x) * 4);
      }
    }
  }
  return out;
}
