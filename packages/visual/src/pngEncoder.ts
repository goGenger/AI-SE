/**
 * Minimal PNG encode/decode for the 5.6-4 heat map (stdlib only: zlib +
 * CRC32). Supports 8-bit, non-interlaced, color type 6 (RGBA) and 2 (RGB).
 * ponytail: one file, ~120 lines; anything exotic (16-bit, interlace,
 * other color types) throws and the caller falls back to text hotspots.
 */
import { inflateSync, deflateSync } from "node:zlib";

export interface DecodedPng {
  width: number;
  height: number;
  /** RGBA bytes, length = width * height * 4. */
  rgba: Uint8Array;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (let index = 0; index < buffer.length; index += 1) {
    crc ^= buffer[index];
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

/** Encodes an RGBA raster as a minimal valid PNG (color type 6, filter 0 rows). */
export function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter type None
    for (let x = 0; x < stride; x += 1) {
      raw[y * (stride + 1) + 1 + x] = rgba[y * stride + x];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8); // bit depth
  ihdr.writeUInt8(6, 9); // color type RGBA
  ihdr.writeUInt8(0, 10); // compression: deflate
  ihdr.writeUInt8(0, 11); // filter: adaptive
  ihdr.writeUInt8(0, 12); // interlace: none
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

/** Decodes a minimal PNG (8-bit RGBA/RGB, non-interlaced, filters 0-4). */
export function decodeMinimalPng(buffer: Buffer): DecodedPng {
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error("not a PNG");
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = 6;
  const idat: Buffer[] = [];
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const bitDepth = data.readUInt8(8);
      colorType = data.readUInt8(9);
      const interlace = data.readUInt8(12);
      if (bitDepth !== 8 || (colorType !== 6 && colorType !== 2) || interlace !== 0) {
        throw new Error(`unsupported PNG: depth=${bitDepth} color=${colorType} interlace=${interlace}`);
      }
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }
  const bpp = colorType === 6 ? 4 : 3;
  const stride = width * bpp;
  const inflated = inflateSync(Buffer.concat(idat));
  const rgba = new Uint8Array(width * height * 4);
  const previousRow = new Uint8Array(stride);
  let cursor = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = inflated[cursor];
    cursor += 1;
    const row = inflated.subarray(cursor, cursor + stride);
    cursor += stride;
    const decoded = new Uint8Array(stride);
    for (let x = 0; x < stride; x += 1) {
      const left = x >= bpp ? decoded[x - bpp] : 0;
      const up = previousRow[x];
      const upLeft = x >= bpp ? previousRow[x - bpp] : 0;
      let value: number;
      if (filter === 0) value = row[x];
      else if (filter === 1) value = (row[x] + left) & 0xff;
      else if (filter === 2) value = (row[x] + up) & 0xff;
      else if (filter === 3) value = (row[x] + ((left + up) >> 1)) & 0xff;
      else if (filter === 4) {
        value = (row[x] + paeth(left, up, upLeft)) & 0xff;
      } else {
        throw new Error(`unsupported filter ${filter}`);
      }
      decoded[x] = value;
    }
    for (let x = 0; x < width; x += 1) {
      const target = (y * width + x) * 4;
      rgba[target] = decoded[x * bpp];
      rgba[target + 1] = decoded[x * bpp + 1];
      rgba[target + 2] = decoded[x * bpp + 2];
      rgba[target + 3] = colorType === 6 ? decoded[x * bpp + 3] : 255;
    }
    previousRow.set(decoded);
  }
  return { width, height, rgba };
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}
