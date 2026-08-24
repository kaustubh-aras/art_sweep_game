# Clockshot — Reddit asset brief & generation prompts

Everything here is derived from the game's actual palette
([`src/clockshot/theme.ts`](src/clockshot/theme.ts)) and its actual sprite
vocabulary ([`src/clockshot/textures.ts`](src/clockshot/textures.ts)), so
generated art will sit next to the game rather than beside it.

---

## 1 · The palette, verbatim

Paste this block into any prompt. These are the only colours the game draws.

```
Background   #070b16   near-black navy — the arena void
Grid lines   #121c33   faint square grid over the background
Panel        #0d1426   with #1d2a44 borders
Platforms    #27395c   with a lit top edge #3a557f
GOLD         #ffc63d   time itself — clocks, the run dial   (deep: #6d4d00)
CYAN         #3df0ff   the rope, the anchors, the player    (deep: #0d5a66)
GREEN        #3dffa0   the goal and checkpoints             (deep: #0b4a2c)
RED-ORANGE   #ff5a3d   spikes, enemies, danger
Text         #e6edf8   bright   /  #8497b5 dim  /  #475777 faintest
```

**The colour grammar matters more than the hues.** In this game gold *always*
means time, cyan *always* means the rope, green *always* means the goal. Never
let a generator use them decoratively — a gold rope or a cyan goal reads as a
different game.

## 2 · The shapes, verbatim

| Thing | How the game draws it |
|---|---|
| Player | cyan rounded capsule, ~26×38, dark visor slit across the upper third |
| Anchor | small cyan ring with a filled centre dot and a soft glow |
| Rope | 3px cyan line from player to anchor, slight downward sag |
| Clock pickup | small gold clock face, two hands, dark `#3d2a00` hands |
| Golden clock | larger gold clock with a 12-spoke crown of rays |
| Goal | green ring, chequered inner band, like a finish line |
| Enemy | red-orange gear-clock, 8 teeth around the rim |
| Spikes | row of sharp red-orange triangles on a platform top |
| Type | uppercase monospace, wide letter-spacing (~0.3em) |

Style throughout: **flat vector, hard edges, high contrast, additive glow on the
bright colours only, no gradients on solids, no bevels, no drop shadows.**

---

## 3 · Devvit app icon — **1024 × 1024**

Required by `devvit publish`. Replaces [`assets/icon.png`](assets/icon.png),
declared as `marketingAssets.icon` in `devvit.json`. Renders small in listings,
so it must survive being 64px wide.

> Flat vector game icon, 1024×1024, square. Background: near-black navy
> `#070b16` with a very faint `#121c33` square grid. Centred composition: a
> small cyan capsule character (`#3df0ff`) with a dark horizontal visor slit,
> hanging from a taut cyan rope that runs up to a glowing cyan ring anchor near
> the top-right. The character swings on a visible arc. One gold clock face
> (`#ffc63d`, two dark hands) floats to the left along the arc path. A soft
> additive glow on the cyan and gold only. Bold, high-contrast, minimal — no
> more than three focal elements. Flat colour, hard edges, no gradients on
> solids, no bevels, no drop shadow, no text, no logo, no watermark. Readable at
> 64 pixels wide.

**Negatives:** `text, letters, numbers, UI chrome, realistic rendering, 3D,
bevel, gloss, gradient mesh, drop shadow, busy background, more than 3 elements`

## 4 · Community icon (subreddit avatar) — **256 × 256**

Renders as a **circle** at small sizes, so keep the subject centred with at
least 10% padding on every side and nothing important near the corners. PNG with
transparency if you want a clean edge.

> Flat vector app icon, 256×256, designed to be cropped to a circle. Centred
> subject with generous padding. A single gold clock face (`#ffc63d`) with two
> dark `#3d2a00` hands, and a taut cyan rope (`#3df0ff`) hooked over its top
> edge trailing off to the upper right, ending in a small glowing cyan ring.
> Background: solid near-black navy `#070b16`, no grid, no texture. Extremely
> simple — two elements only, thick strokes, maximum contrast. Flat colour, hard
> edges, no text, no gradients, no shadows. Must read clearly at 32 pixels.

**Why simpler than the app icon:** at 32px a swinging figure becomes a smudge. A
clock with a rope on it still reads.

**Negatives:** `text, thin lines, fine detail, background pattern, grid,
gradient, shadow, more than two elements, anything in the corners`

## 5 · Community banner — **1920 × 384** (5:1)

Built for desktop. **The mobile app crops both sides hard**, so every logo,
tagline and key element must sit inside the **middle 50%** — roughly x = 480 to
1440. Treat the outer 480px each side as decorative bleed only.

> Wide flat vector game banner, 1920×384, 5:1 letterbox. Background: near-black
> navy `#070b16` with a faint `#121c33` square grid and a very subtle darker
> vignette at the far left and right edges. Composition reads left to right as a
> single grapple run: on the left, a dark `#27395c` platform with a lit `#3a557f`
> top edge; a cyan capsule character (`#3df0ff`) with a dark visor launches from
> it on a taut cyan rope hooked to a glowing cyan ring anchor above the centre;
> a trail of small gold clock faces (`#ffc63d`) arcs through the middle
> following the swing; on the right, a glowing green ring goal (`#3dffa0`) with a
> chequered inner band. One row of red-orange spikes (`#ff5a3d`) on a low
> platform below the arc. All key elements inside the central 50% of the width.
> Generous empty space, nothing crowded. Flat colour, hard edges, additive glow
> on cyan/gold/green only, no gradients on solids, no text, no logo.

**Negatives:** `text, wordmark, logo, watermark, busy composition, elements near
the left or right edge, realistic art, 3D, gradient mesh, drop shadow, clutter`

### Banner with the wordmark baked in

If you want the name on the banner, generate the art above **without** text and
composite the wordmark from §6 on top, centred around x = 960. Generators are
unreliable at spelling and at monospace letter-spacing; compositing is the only
way to get it clean.

## 6 · Wordmark / logo — **1200 × 300**, transparent PNG

For the banner, the README, and anywhere the game is named.

> Flat vector wordmark on a fully transparent background, 1200×300. The single
> word "CLOCKSHOT" in uppercase monospace, wide letter-spacing (0.3em), heavy
> weight, in gold `#ffc63d`. The letter O in "CLOCK" is replaced by a clock face
> with two dark hands. A thin cyan rope (`#3df0ff`) hooks over the top of the
> final T and trails off to the upper right, ending in a small glowing cyan
> ring. Nothing else. Crisp edges, no outline, no gradient, no shadow, no
> background.

**Check the spelling by eye** — generators routinely produce "CLOCKSHOOT" or
"CLOKSHOT" at this letter-spacing. If it fights you, generate the clock-O and
the rope hook as separate transparent elements and set the type yourself in the
game's own font stack (`ui-monospace, SFMono-Regular, Menlo, Consolas`).

---

## 7 · Size reference

| Asset | Size | Where it goes |
|---|---|---|
| Devvit app icon | **1024 × 1024** | `assets/icon.png` → `marketingAssets.icon` |
| Community icon | **256 × 256** | subreddit → Appearance → Community icon |
| Community banner | **1920 × 384** | subreddit → Appearance → Banner |
| Wordmark | **1200 × 300** transparent | banner composite, README |

Two constraints that catch people out:

- The **community icon is masked to a circle.** Anything in the corners is lost.
- The **banner is cropped from both sides on mobile.** Keep everything that
  matters between x = 480 and x = 1440.

## 8 · A note on the current icon

[`assets/icon.png`](assets/icon.png) is 1024×1024 and correctly sized, but it is
**off-theme**: it is generated by
[`scripts/make-icon.mjs`](scripts/make-icon.mjs) and draws a green sweep dial
using `#3dffa0` and `#123528` — the identity of *SWEEP*, an abandoned earlier
game in this repo. Green now means "the goal" and nothing else, and the game's
own colours are gold and cyan. It should be replaced.

If you would rather keep generating it in code than prompt for it, the script is
the place — it draws from the palette with no image dependency, which is why the
game ships zero asset files.
