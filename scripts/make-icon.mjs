// Generates the 1024x1024 marketing icon required by `devvit publish`.
// The game ships no image files, so the icon is drawn here from the same
// palette the game uses — dial, wake, hand — with no image dependency.
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

const SIZE = 1024;
const SS = 3; // supersampling factor per axis, for antialiased edges

const BG = [0x04, 0x07, 0x0d];
const FIELD = [0x08, 0x10, 0x19];
const RING = [0x12, 0x35, 0x28];
const GREEN = [0x3d, 0xff, 0xa0];
const BRIGHT = [0xd8, 0xff, 0xe9];

const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * Math.max(0, Math.min(1, t)));

const CX = SIZE / 2;
const CY = SIZE / 2;
const R = SIZE * 0.375; // dial radius
const HAND = -Math.PI / 5; // where the hand currently points
const WAKE = Math.PI * 1.15; // how much of the dial the wake still covers

/** Colour of one sample in device space. Everything is analytic — no canvas. */
function sample(x, y) {
  const dx = x - CX;
  const dy = y - CY;
  const dist = Math.hypot(dx, dy);

  if (dist > R + 7) return BG;

  // Ring: a thin annulus at the dial edge.
  if (dist > R) return mix(BG, RING, (R + 7 - dist) / 7);

  let color = FIELD;

  // The wake: brightest right behind the hand, fading as the dial turns away.
  // Angles run backwards from the hand so the trail follows it.
  let behind = HAND - Math.atan2(dy, dx);
  while (behind < 0) behind += Math.PI * 2;
  while (behind >= Math.PI * 2) behind -= Math.PI * 2;

  if (behind < WAKE) {
    const falloff = (1 - behind / WAKE) ** 2.1;
    // The wake rides the rim rather than filling the disc, like a radar sweep.
    const radial = Math.max(0, 1 - Math.abs(dist / R - 0.72) / 0.62);
    color = mix(color, GREEN, falloff * radial * 0.85);
  }

  // The hand itself: a hard bright spoke from hub to rim.
  const hx = Math.cos(HAND);
  const hy = Math.sin(HAND);
  const along = dx * hx + dy * hy;
  if (along > 0 && along < R * 0.97) {
    const off = Math.abs(-dx * hy + dy * hx);
    const w = 4.5;
    if (off < w) color = mix(color, BRIGHT, (1 - off / w) * (1 - (along / R) * 0.35));
  }

  // Hub.
  if (dist < 17) color = mix(color, BRIGHT, 1 - dist / 17);

  return color;
}

// Render with supersampling into raw RGB scanlines (filter byte 0 per row).
const raw = Buffer.alloc(SIZE * (SIZE * 3 + 1));
let p = 0;
for (let y = 0; y < SIZE; y++) {
  raw[p++] = 0; // filter: none
  for (let x = 0; x < SIZE; x++) {
    let r = 0;
    let g = 0;
    let b = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const c = sample(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS);
        r += c[0];
        g += c[1];
        b += c[2];
      }
    }
    const n = SS * SS;
    raw[p++] = Math.round(r / n);
    raw[p++] = Math.round(g / n);
    raw[p++] = Math.round(b / n);
  }
}

// --- minimal PNG container ---
const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return (buf) => {
    let c = -1;
    for (const byte of buf) c = t[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
})();

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(CRC(body));
  return Buffer.concat([len, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 2; // colour type: truecolour RGB
// 10..12 = compression/filter/interlace, all 0

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

mkdirSync('assets', { recursive: true });
writeFileSync('assets/icon.png', png);
console.log(`assets/icon.png — ${SIZE}x${SIZE}, ${(png.length / 1024).toFixed(1)} KB`);
