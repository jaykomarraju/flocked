// A PNG reader and a box filter, for the pixel and legibility tests. Both run inside workerd, where
// there is no image decoder: `DecompressionStream('deflate')` is the one piece of zlib the runtime
// has, and PNG scanline filters are a few lines on top of it. 8-bit greyscale, RGB and RGBA,
// non-interlaced — which is what Paper exports and what resvg writes.

export interface Bitmap {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel, row major. */
  data: Uint8Array;
}

export async function decodePng(bytes: Uint8Array): Promise<Bitmap> {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let off = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const idat: Uint8Array[] = [];
  while (off + 8 <= bytes.length) {
    const len = dv.getUint32(off);
    const type = String.fromCharCode(
      bytes[off + 4]!,
      bytes[off + 5]!,
      bytes[off + 6]!,
      bytes[off + 7]!,
    );
    if (type === 'IHDR') {
      width = dv.getUint32(off + 8);
      height = dv.getUint32(off + 12);
      if (bytes[off + 16] !== 8)
        throw new Error(`unsupported bit depth ${String(bytes[off + 16])}`);
      colorType = bytes[off + 17]!;
      if (bytes[off + 20] !== 0) throw new Error('interlaced PNG');
    } else if (type === 'IDAT') {
      idat.push(bytes.subarray(off + 8, off + 8 + len));
    } else if (type === 'IEND') break;
    off += 12 + len;
  }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : 0;
  if (!channels) throw new Error(`unsupported colour type ${String(colorType)}`);
  let total = 0;
  for (const c of idat) total += c.length;
  const deflated = new Uint8Array(total);
  let p = 0;
  for (const c of idat) {
    deflated.set(c, p);
    p += c.length;
  }
  const inflated = new Uint8Array(
    await new Response(
      new Blob([deflated]).stream().pipeThrough(new DecompressionStream('deflate')),
    ).arrayBuffer(),
  );
  const stride = width * channels;
  const out = new Uint8Array(width * height * 4);
  const prev = new Uint8Array(stride);
  const line = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const start = y * (stride + 1);
    const filter = inflated[start]!;
    line.set(inflated.subarray(start + 1, start + 1 + stride));
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? line[i - channels]! : 0;
      const b = prev[i]!;
      const c = i >= channels ? prev[i - channels]! : 0;
      switch (filter) {
        case 1:
          line[i] = (line[i]! + a) & 255;
          break;
        case 2:
          line[i] = (line[i]! + b) & 255;
          break;
        case 3:
          line[i] = (line[i]! + ((a + b) >> 1)) & 255;
          break;
        case 4: {
          const pa = Math.abs(b - c);
          const pb = Math.abs(a - c);
          const pc = Math.abs(a + b - 2 * c);
          line[i] = (line[i]! + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
          break;
        }
        default:
          break;
      }
    }
    for (let x = 0; x < width; x++) {
      const s = x * channels;
      const d = (y * width + x) * 4;
      if (channels === 1) {
        out[d] = out[d + 1] = out[d + 2] = line[s]!;
        out[d + 3] = 255;
      } else {
        out[d] = line[s]!;
        out[d + 1] = line[s + 1]!;
        out[d + 2] = line[s + 2]!;
        out[d + 3] = channels === 4 ? line[s + 3]! : 255;
      }
    }
    prev.set(line);
  }
  return { width, height, data: out };
}

/** Box-filtered downscale to `width` × `height` (any ratio; the tests always divide exactly). */
export function downscale(img: Bitmap, width: number, height: number): Bitmap {
  const fx = img.width / width;
  const fy = img.height / height;
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor(y * fy);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * fy));
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor(x * fx);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * fx));
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const s = (sy * img.width + sx) * 4;
          r += img.data[s]!;
          g += img.data[s + 1]!;
          b += img.data[s + 2]!;
          n++;
        }
      }
      const d = (y * width + x) * 4;
      out[d] = Math.round(r / n);
      out[d + 1] = Math.round(g / n);
      out[d + 2] = Math.round(b / n);
      out[d + 3] = 255;
    }
  }
  return { width, height, data: out };
}

/** Relative luminance (WCAG 2.1) of a pixel. */
export function luminance(img: Bitmap, i: number): number {
  const f = (v: number) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(img.data[i]!) + 0.7152 * f(img.data[i + 1]!) + 0.0722 * f(img.data[i + 2]!);
}

/** The WCAG contrast ratio between two luminances. */
export function contrastRatio(a: number, b: number): number {
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

export interface Diff {
  /** Mean absolute error over every RGB channel, 0–255. */
  mae: number;
  /** The share of pixels whose largest channel difference is over 32. */
  over: number;
}

/** Compares two bitmaps of the same size. */
export function diff(a: Bitmap, b: Bitmap): Diff {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(`size ${a.width}×${a.height} vs ${b.width}×${b.height}`);
  }
  let sum = 0;
  let over = 0;
  const n = a.width * a.height;
  for (let i = 0; i < n; i++) {
    const p = i * 4;
    const dr = Math.abs(a.data[p]! - b.data[p]!);
    const dg = Math.abs(a.data[p + 1]! - b.data[p + 1]!);
    const db = Math.abs(a.data[p + 2]! - b.data[p + 2]!);
    sum += dr + dg + db;
    if (Math.max(dr, dg, db) > 32) over++;
  }
  return { mae: sum / (n * 3), over: over / n };
}

/** Bands of rows that hold ink, as `measure`-style [y0, y1] pairs. */
export function inkBands(img: Bitmap, bg: readonly [number, number, number]): [number, number][] {
  const bands: [number, number][] = [];
  let open = false;
  for (let y = 0; y < img.height; y++) {
    let ink = false;
    for (let x = 0; x < img.width && !ink; x++) {
      const i = (y * img.width + x) * 4;
      ink =
        Math.abs(img.data[i]! - bg[0]) +
          Math.abs(img.data[i + 1]! - bg[1]) +
          Math.abs(img.data[i + 2]! - bg[2]) >
        24;
    }
    if (!ink) {
      open = false;
      continue;
    }
    if (open) bands[bands.length - 1]![1] = y;
    else {
      bands.push([y, y]);
      open = true;
    }
  }
  return bands;
}

/** Decodes a `?inline` data URI (the exports and fixtures come in as one). */
export function dataUriBytes(uri: string): Uint8Array {
  const base64 = uri.slice(uri.indexOf(',') + 1);
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
