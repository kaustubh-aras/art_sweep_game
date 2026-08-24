/**
 * Turns the delivered artwork into game-ready textures.
 *
 * The source files are 500-1700px illustrations totalling about 5MB. Nothing in
 * Clockshot is drawn larger than a few dozen game units, and the whole client
 * bundle is currently 380KB gzipped — shipping the originals would multiply the
 * weight of a Reddit post by more than ten for pixels no player can ever see.
 *
 * So each one is trimmed of its transparent margin, resized to the largest size
 * it is ever actually drawn at (its game size, times the maximum camera zoom,
 * times a 2x device pixel ratio, rounded up to something tidy), and quantised.
 *
 * Run with `npm run art` after dropping new files into `art/source`.
 */
import { mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';

const SRC = process.argv[2] ?? 'art/source';
const OUT = 'src/assets';

/**
 * What each delivered file becomes.
 *
 * `fit: 'inside'` everywhere, so nothing is ever stretched — the target is a
 * bounding box, not a shape to squash the art into.
 */
const JOBS = [
  // The player is drawn at 26x38 and the camera zooms to 2.2 on a 2x screen.
  { src: 'player.png', out: 'player.png', w: 128, h: 192, trim: true },
  // The grapple anchor: 34x34 on screen.
  { src: 'asset-2.png', out: 'anchor.png', w: 128, h: 128, trim: true },
  // The clock pickup: 30x30, but it is the thing players look at, so it keeps
  // a little more resolution than it strictly needs.
  { src: 'asset-3.png', out: 'clock.png', w: 128, h: 128, trim: true },
  // Anything that REPEATS is square and untrimmed. Trimming crops each source
  // by however much transparent margin it happens to carry — that is what made
  // the platform come out 251x256 — and a tile whose aspect is not exactly 1:1
  // cannot be laid in a grid without the last column being sliced.
  { src: 'spike.png', out: 'hazard.png', w: 128, h: 128, tile: true },
  { src: 'tile1.png', out: 'platform.png', w: 256, h: 256, tile: true },
  // The patrolling enemy. A wheel, and the play scene spins it.
  { src: 'saw.png', out: 'enemy.png', w: 128, h: 128, trim: true },
  // The arena backdrop. No alpha, so it goes out as JPEG — a PNG of a
  // photographic gradient is several times the size for no visible gain.
  { src: 'background-1.png', out: 'backdrop.jpg', w: 1280, h: 720, jpeg: 74 },
];

mkdirSync(OUT, { recursive: true });

let before = 0;
let after = 0;

for (const job of JOBS) {
  const from = join(SRC, job.src);
  const to = join(OUT, job.out);

  let img = sharp(from);
  // Trim only fully transparent edges: the glow around the player fades to
  // nothing and is part of the art, so a colour-based trim would eat it.
  if (job.trim) img = img.trim({ threshold: 0 });

  // A tile is resized to an EXACT square with `fill`, so the output is
  // guaranteed 1:1 whatever the source was. `inside` fits within the box and
  // would quietly hand back an off-square result again.
  img = job.tile
    ? img.resize(job.w, job.h, { fit: 'fill' })
    : img.resize(job.w, job.h, { fit: 'inside', withoutEnlargement: true });

  img = job.jpeg
    ? img.jpeg({ quality: job.jpeg, mozjpeg: true, chromaSubsampling: '4:4:4' })
    : img.png({ compressionLevel: 9, palette: true, quality: 88, effort: 10 });

  const info = await img.toFile(to);
  const src = statSync(from).size;
  before += src;
  after += info.size;

  const kb = (n) => `${(n / 1024).toFixed(0)}KB`;
  console.log(
    `${job.src.padEnd(18)} -> ${job.out.padEnd(14)} ` +
      `${String(info.width).padStart(4)}x${String(info.height).padEnd(4)} ` +
      `${kb(src).padStart(7)} -> ${kb(info.size).padStart(6)}`,
  );
}

console.log(
  `\ntotal ${(before / 1024 / 1024).toFixed(2)}MB -> ${(after / 1024).toFixed(0)}KB ` +
    `(${(100 - (after / before) * 100).toFixed(1)}% smaller)`,
);

const stray = readdirSync(SRC).filter((f) => !JOBS.some((j) => j.src === f));
if (stray.length) console.log(`\nnot used: ${stray.join(', ')}`);
