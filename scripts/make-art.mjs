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
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import ffmpeg from 'ffmpeg-static';
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
  // The grapple anchor: 34x34 on screen, in both of its states. Neither is
  // trimmed, so the lit ring lands on exactly the same centre as the dim one —
  // trimming each to its own content would shift the glow off the socket.
  { src: 'grapple_base.png', out: 'anchor.png', w: 128, h: 128, tile: true },
  { src: 'grapple_glow.png', out: 'anchor-lit.png', w: 128, h: 128, tile: true },
  // The clock pickup: 30x30, but it is the thing players look at, so it keeps
  // a little more resolution than it strictly needs.
  { src: 'clock.png', out: 'clock.png', w: 128, h: 128, trim: true },
  // Anything that REPEATS is square and untrimmed. Trimming crops each source
  // by however much transparent margin it happens to carry — that is what made
  // the platform come out 251x256 — and a tile whose aspect is not exactly 1:1
  // cannot be laid in a grid without the last column being sliced.
  { src: 'spike.png', out: 'hazard.png', w: 128, h: 128, tile: true },
  /*
   * Three interchangeable stone tiles.
   *
   * 256 is close to 1:1 where it matters: a tile occupies 60 world units, the
   * camera zooms to 2.2, and a phone reports up to a 2x ratio — so the largest
   * a tile is ever asked to be on a real screen is about 264 device pixels.
   * Exporting larger would be resolution nobody can resolve.
   */
  { src: 'tile1.png', out: 'platform-1.png', w: 256, h: 256, tile: true },
  { src: 'tile2.png', out: 'platform-2.png', w: 256, h: 256, tile: true },
  { src: 'tile3.png', out: 'platform-3.png', w: 256, h: 256, tile: true },
  /**
   * The patrolling enemy, as a sprite sheet.
   *
   * 48 frames of 512px arrive as a 4096x3072 sheet — 13.4MB for a creature
   * drawn at about fifty world units. Scaled to a quarter, every frame lands on
   * 128px and the grid stays exactly aligned, because 512 and 4096 both divide
   * by four cleanly. Nothing is trimmed: a sheet whose frames moved
   * independently would no longer be a sheet.
   */
  { src: 'saw_monster_sheet.png', out: 'enemy-sheet.png', w: 1024, h: 768, tile: true },
];

/**
 * The animated backdrop, and why it is re-encoded rather than shipped as sent.
 *
 * The loop arrived as three 1080p files totalling 12.4MB — a VP9 webm, an H.264
 * mp4 at three and a half times the webm's bitrate for identical pictures, and
 * an 800x450 GIF that alone was 7.35MB. In a Reddit post that is not a
 * background, it is a download.
 *
 * It plays behind the interface at phone size, so 1080p is resolution nobody
 * can see. Halving it to 720p and letting each codec pick its own quality
 * target lands the pair at well under a megabyte.
 *
 * The GIF is dropped outright: it is the largest file of the three and the
 * worst picture of the three, which is what GIF is.
 */
const VIDEO = {
  src: 'backdrop-loop.webm',
  width: 1280,
  /** A still of the first frame: shown instantly, and while the loop loads. */
  poster: { out: 'backdrop.jpg', quality: 68 },
  encodes: [
    {
      out: 'backdrop.webm',
      args: ['-c:v', 'libvpx-vp9', '-crf', '40', '-b:v', '0', '-row-mt', '1', '-cpu-used', '4'],
    },
    {
      // The fallback every Safari can play. `faststart` moves the index to the
      // front so playback can begin before the file has finished arriving.
      out: 'backdrop.mp4',
      args: [
        '-c:v', 'libx264', '-crf', '30', '-preset', 'slow',
        '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
      ],
    },
  ],
};

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

/* --- the backdrop loop ------------------------------------------------- */

const videoSrc = join(SRC, VIDEO.src);
let videoBefore = 0;
let videoAfter = 0;

try {
  videoBefore = statSync(videoSrc).size;
} catch {
  console.log(`\nno ${VIDEO.src} — skipping the backdrop loop`);
}

if (videoBefore > 0) {
  // Every frame of the loop is the same picture at 720p, so the poster is
  // pulled from the source rather than from an encode: it should be the best
  // still available, not a still of a compressed video.
  const posterPath = join(OUT, VIDEO.poster.out);
  execFileSync(ffmpeg, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', videoSrc, '-frames:v', '1',
    '-vf', `scale=${VIDEO.width}:-2`,
    '-q:v', '4', posterPath,
  ]);
  videoAfter += statSync(posterPath).size;
  console.log(
    `\n${VIDEO.src.padEnd(22)} -> ${VIDEO.poster.out.padEnd(14)} ` +
      `${(statSync(posterPath).size / 1024).toFixed(0).padStart(6)}KB`,
  );

  for (const enc of VIDEO.encodes) {
    const to = join(OUT, enc.out);
    execFileSync(ffmpeg, [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-i', videoSrc,
      // No audio track at all: this is wallpaper, and a muted stream is bytes
      // spent on something no player can ever hear.
      '-an',
      '-vf', `scale=${VIDEO.width}:-2`,
      ...enc.args,
      to,
    ]);
    const size = statSync(to).size;
    videoAfter += size;
    console.log(
      `${''.padEnd(22)} -> ${enc.out.padEnd(14)} ${(size / 1024).toFixed(0).padStart(6)}KB`,
    );
  }

  console.log(
    `backdrop loop ${(videoBefore / 1024 / 1024).toFixed(2)}MB -> ` +
      `${(videoAfter / 1024).toFixed(0)}KB`,
  );
}

const stray = readdirSync(SRC).filter(
  (f) => !JOBS.some((j) => j.src === f) && f !== VIDEO.src,
);
if (stray.length) console.log(`\nnot used: ${stray.join(', ')}`);
