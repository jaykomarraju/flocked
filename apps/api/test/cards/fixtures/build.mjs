// Rebuilds the pixel-comparison fixtures from the frozen card exports:
//
//   node apps/api/test/cards/fixtures/build.mjs
//
// Each fixture is one `docs/design/exports/cards/<state>__<variant>.png` (a 2x export) box-filtered
// to a fifth of the card's own size — 240×126, 240×160, 216×216 — and written back as a PNG. The
// test (pixel.test.ts) downscales its own render with the same box filter and compares the two, so
// the only differences left are layout and colour, not the two rasterisers' hinting or anti-aliasing.
// Fixtures rather than the exports themselves because the exports are ~300 KB each and every byte a
// Workers test reads has to be bundled into it.
//
// Regenerate whenever a card artboard is re-exported (docs/design/README.md "Exporting").
import { deflateSync, inflateSync } from 'node:zlib';
import { readFile, writeFile } from 'node:fs/promises';

const EXPORTS = new URL('../../../../../docs/design/exports/cards/', import.meta.url);

/** The fixtures the pixel test compares against: enough states to cover every layout the cards have. */
export const FIXTURES = [
  'result__free-win__og',
  'result__free-win__embed',
  'result__free-win__square',
  'result__free-win-streak__og',
  'result__free-loss__og',
  'result__stakes-win-amount__og',
  'result__free-refund-headcount-tie__og',
  'result__free-refund-voided__og',
  'teaser__sealed__og',
  'round__free__og',
];

/** The fixture size per variant: a fifth of the card, a tenth of the 2x export. */
export const FIXTURE_SIZE = {
  og: [240, 126],
  embed: [240, 160],
  square: [216, 216],
};

function decode(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let off = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const idat = [];
  while (off + 8 <= bytes.length) {
    const len = dv.getUint32(off);
    const type = String.fromCharCode(...bytes.subarray(off + 4, off + 8));
    if (type === 'IHDR') {
      width = dv.getUint32(off + 8);
      height = dv.getUint32(off + 12);
      colorType = bytes[off + 17];
      if (bytes[off + 16] !== 8 || bytes[off + 20] !== 0) throw new Error('unsupported PNG');
    } else if (type === 'IDAT') idat.push(bytes.subarray(off + 8, off + 8 + len));
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  const channels = { 0: 1, 2: 3, 6: 4 }[colorType];
  if (!channels) throw new Error(`colour type ${colorType}`);
  const raw = new Uint8Array(inflateSync(Buffer.concat(idat.map((c) => Buffer.from(c)))));
  const stride = width * channels;
  const out = new Uint8Array(width * height * 3);
  const prev = new Uint8Array(stride);
  const line = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const start = y * (stride + 1);
    const filter = raw[start];
    line.set(raw.subarray(start + 1, start + 1 + stride));
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? line[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      if (filter === 1) line[i] = (line[i] + a) & 255;
      else if (filter === 2) line[i] = (line[i] + b) & 255;
      else if (filter === 3) line[i] = (line[i] + ((a + b) >> 1)) & 255;
      else if (filter === 4) {
        const pa = Math.abs(b - c);
        const pb = Math.abs(a - c);
        const pc = Math.abs(a + b - 2 * c);
        line[i] = (line[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      }
    }
    for (let x = 0; x < width; x++) {
      const s = x * channels;
      const d = (y * width + x) * 3;
      out[d] = line[s];
      out[d + 1] = channels === 1 ? line[s] : line[s + 1];
      out[d + 2] = channels === 1 ? line[s] : line[s + 2];
    }
    prev.set(line);
  }
  return { width, height, data: out };
}

/** The same box filter as test/cards/png.ts `downscale`, on RGB. */
function downscale(img, width, height) {
  const fx = img.width / width;
  const fy = img.height / height;
  const out = new Uint8Array(width * height * 3);
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
          const s = (sy * img.width + sx) * 3;
          r += img.data[s];
          g += img.data[s + 1];
          b += img.data[s + 2];
          n++;
        }
      }
      const d = (y * width + x) * 3;
      out[d] = Math.round(r / n);
      out[d + 1] = Math.round(g / n);
      out[d + 2] = Math.round(b / n);
    }
  }
  return { width, height, data: out };
}

const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return (buf) => {
    let c = -1;
    for (const b of buf) c = t[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
})();

function chunk(type, body) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(CRC(Buffer.concat([Buffer.from(type, 'ascii'), body])), 0);
  return Buffer.concat([head, body, crc]);
}

function encode(img) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(img.width, 0);
  ihdr.writeUInt32BE(img.height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2; // RGB
  const stride = img.width * 3;
  const raw = Buffer.alloc((stride + 1) * img.height);
  for (let y = 0; y < img.height; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(img.data.subarray(y * stride, (y + 1) * stride)).copy(raw, y * (stride + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const name of FIXTURES) {
  const variant = name.slice(name.lastIndexOf('__') + 2);
  const [w, h] = FIXTURE_SIZE[variant];
  const img = await decode(new Uint8Array(await readFile(new URL(`${name}.png`, EXPORTS))));
  const small = downscale(img, w, h);
  const out = new URL(`${name}.px.png`, import.meta.url);
  await writeFile(out, encode(small));
  console.log(`${name}: ${img.width}×${img.height} -> ${w}×${h}`);
}
