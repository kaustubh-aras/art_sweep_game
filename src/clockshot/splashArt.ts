import type { Arena } from './arena';

/**
 * The splash card's artwork: one drawn scene of what Clockshot is.
 *
 * The first version of this plotted the arena itself from its layout data. It
 * was honest and it did not work: a banner is two and a half times wider than
 * it is tall, no arena is, and fitting a whole course into that shape turned
 * every platform into a sliver. Framing in close fixed the scale and lost the
 * picture — these arenas are sparse by design, and a tight crop of one is
 * three dots and a lot of sky.
 *
 * So the card is illustrated rather than plotted: a rope, a swing over a pit,
 * seconds strung out along the arc, and the goal lit on the far ledge. It is
 * still the arena's own picture — the skyline and the teeth in the pit are
 * seeded from the arena's id and grow with its difficulty, so every course
 * gets a scene of its own and the same course always gets the same one — but
 * the composition is chosen, because a picture that has to sell a post at 168
 * pixels tall has to be composed.
 *
 * Everything is drawn in a fixed 400×170 space and scaled by the browser, so
 * the numbers below read as layout rather than as world coordinates.
 */

const W = 400;
const H = 170;

/** Rounds to one decimal, so the emitted path data stays small and readable. */
function n(v: number): string {
  return `${Math.round(v * 10) / 10}`;
}

/** A seeded PRNG, so an arena's scene never changes between two viewers. */
function rng(seed: number): () => number {
  let a = seed >>> 0 || 1;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedOf(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  }
  return h >>> 0;
}

/** The clock the whole game runs on, hung in the sky like a moon. */
function clockMoon(cx: number, cy: number, r: number): string {
  const marks = Array.from({ length: 12 }, (_, i) => {
    const a = (i / 12) * Math.PI * 2;
    return `<line x1="${n(cx + Math.cos(a) * (r - 3.5))}" y1="${n(
      cy + Math.sin(a) * (r - 3.5),
    )}" x2="${n(cx + Math.cos(a) * (r - 1.5))}" y2="${n(cy + Math.sin(a) * (r - 1.5))}"/>`;
  }).join('');

  return `
    <circle cx="${n(cx)}" cy="${n(cy)}" r="${n(r * 3.4)}" fill="url(#moonGlow)"/>
    <circle cx="${n(cx)}" cy="${n(cy)}" r="${n(
    r,
  )}" fill="#141d33" stroke="#ffc63d" stroke-width="1.1" opacity="0.95"/>
    <g stroke="#ffc63d" stroke-width="0.9" opacity="0.5">${marks}</g>
    <line x1="${n(cx)}" y1="${n(cy)}" x2="${n(cx)}" y2="${n(
    cy - r * 0.62,
  )}" stroke="#ffc63d" stroke-width="1.4" stroke-linecap="round"/>
    <line x1="${n(cx)}" y1="${n(cy)}" x2="${n(cx + r * 0.5)}" y2="${n(
    cy + r * 0.22,
  )}" stroke="#ffd97a" stroke-width="1.4" stroke-linecap="round"/>`;
}

/** A ridge of towers. Two of these, one behind the other, make the distance. */
function skyline(
  rand: () => number,
  count: number,
  baseY: number,
  minH: number,
  maxH: number,
  fill: string,
  cap: string | null,
  opacity: number,
): string {
  const slot = W / count;
  let out = '';
  for (let i = 0; i < count; i++) {
    const w = slot * (0.5 + rand() * 0.42);
    const x = i * slot + (slot - w) * rand();
    const h = minH + rand() * (maxH - minH);
    const y = baseY - h;
    out += `<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(
      h + 40,
    )}" rx="3" fill="${fill}"/>`;
    if (cap) {
      out += `<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="2" rx="1" fill="${cap}"/>`;
    }
  }
  return `<g opacity="${opacity}">${out}</g>`;
}

/** The teeth at the bottom of the pit — the reason the rope exists. */
function pitSpikes(x0: number, x1: number, y: number, teeth: number): string {
  const w = (x1 - x0) / teeth;
  let d = '';
  for (let i = 0; i < teeth; i++) {
    const x = x0 + i * w;
    d += `M${n(x)} ${n(y)} L${n(x + w / 2)} ${n(y - 9)} L${n(x + w)} ${n(y)} `;
  }
  return `<path d="${d}Z" fill="#ff5a3d" opacity="0.78"/>`;
}

/**
 * The scene.
 *
 * Read left to right it is the game in one line: you push off the near ledge,
 * you are mid-swing over the teeth, and the goal is lit on the far side with
 * the seconds you need strung out along the way.
 */
export function arenaArt(arena: Arena): string {
  const rand = rng(seedOf(arena.id));

  const anchor = { x: 232, y: 38 };
  const rider = { x: 198, y: 94 };

  const clocks = [
    { x: 148, y: 110 },
    { x: 218, y: 88 },
    { x: 276, y: 90 },
  ]
    .map(
      (c) =>
        `<circle cx="${n(c.x)}" cy="${n(c.y)}" r="4.4" fill="#ffc63d" opacity="0.95"/>` +
        `<circle cx="${n(c.x)}" cy="${n(
          c.y,
        )}" r="8.5" fill="none" stroke="#ffc63d" stroke-width="0.8" opacity="0.32"/>`,
    )
    .join('');

  const stars = Array.from({ length: 26 }, () => {
    const x = rand() * W;
    const y = rand() * 100;
    const r = 0.5 + rand() * 0.9;
    return `<circle cx="${n(x)}" cy="${n(y)}" r="${n(r)}" fill="#8ba4cd" opacity="${n(
      0.15 + rand() * 0.4,
    )}"/>`;
  }).join('');

  // Harder arenas get a taller, busier skyline and more teeth in the pit.
  const far = skyline(
    rand,
    9,
    142,
    24 + arena.difficulty * 5,
    54 + arena.difficulty * 8,
    '#101b33',
    null,
    0.9,
  );
  const mid = skyline(rand, 6, 150, 14, 38 + arena.difficulty * 4, 'url(#tower)', '#4d6ea8', 1);

  return `<svg class="art-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
    <defs>
      <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#0a1122"/>
        <stop offset="0.6" stop-color="#132444"/>
        <stop offset="1" stop-color="#0b162b"/>
      </linearGradient>
      <linearGradient id="tower" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#2b4272"/>
        <stop offset="1" stop-color="#16233f"/>
      </linearGradient>
      <linearGradient id="ledge" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#3c5b90"/>
        <stop offset="1" stop-color="#182744"/>
      </linearGradient>
      <radialGradient id="moonGlow">
        <stop offset="0" stop-color="#ffc63d" stop-opacity="0.2"/>
        <stop offset="1" stop-color="#ffc63d" stop-opacity="0"/>
      </radialGradient>
      <radialGradient id="goalGlow">
        <stop offset="0" stop-color="#3dffa0" stop-opacity="0.45"/>
        <stop offset="1" stop-color="#3dffa0" stop-opacity="0"/>
      </radialGradient>
    </defs>

    <rect width="${W}" height="${H}" fill="url(#sky)"/>
    ${stars}
    ${clockMoon(64, 44, 17)}
    ${far}
    ${mid}

    <rect x="-4" y="122" width="122" height="52" rx="4" fill="url(#ledge)"/>
    <rect x="-4" y="122" width="122" height="2.5" rx="1.2" fill="#7ea6dd"/>
    <rect x="298" y="108" width="110" height="66" rx="4" fill="url(#ledge)"/>
    <rect x="298" y="108" width="110" height="2.5" rx="1.2" fill="#7ea6dd"/>
    ${pitSpikes(124, 294, 158, 4 + arena.difficulty * 2)}

    <path d="M110 126 Q${n(anchor.x)} ${n(
    anchor.y + 104,
  )} 318 92" fill="none" stroke="#3df0ff" stroke-width="1.1" stroke-dasharray="5 6" opacity="0.38"/>
    <line x1="${n(anchor.x)}" y1="${n(anchor.y)}" x2="${n(rider.x)}" y2="${n(
    rider.y,
  )}" stroke="#3df0ff" stroke-width="1.6" opacity="0.9"/>
    <circle cx="${n(anchor.x)}" cy="${n(
    anchor.y,
  )}" r="9" fill="none" stroke="#3df0ff" stroke-width="1.6" opacity="0.75"/>
    <circle cx="${n(anchor.x)}" cy="${n(anchor.y)}" r="3.2" fill="#3df0ff"/>

    <circle cx="${n(rider.x)}" cy="${n(rider.y)}" r="4.4" fill="#e6edf8"/>
    <path d="M${n(rider.x)} ${n(
    rider.y + 4,
  )} q-6 7 -14 8 q7 2 10 6" stroke="#e6edf8" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
    ${clocks}

    <circle cx="352" cy="102" r="30" fill="url(#goalGlow)"/>
    <rect x="350" y="80" width="2" height="32" fill="#3dffa0" opacity="0.85"/>
    <path d="M352 82 L370 88 L352 94 Z" fill="#3dffa0"/>
    <circle cx="351" cy="112" r="4" fill="#3dffa0"/>
  </svg>`;
}
