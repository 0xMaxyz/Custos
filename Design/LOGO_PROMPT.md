# Custos — Logo Generation Prompt

Prompts for generating the **Custos** brand mark with an image model (Midjourney,
DALL·E 3, Ideogram, Firefly, SDXL). Custos is Latin for *guardian / keeper* and
echoes **custody** — an AI risk-guardian for tokenized-Treasury yield on Mantle.
The mark should read as **calm, trustworthy, institutional-grade protection** —
not loud, not "crypto-bro." Brand accent is violet `#7C3AED`; the app ships in
light and dark themes, so the mark must work on both.

---

## 1. Primary prompt (copy-paste)

> A minimal, geometric logo mark for a fintech brand called **Custos**, an
> AI-powered guardian that protects on-chain savings. A single abstract symbol
> that fuses a **shield** with a **watchful eye / aperture** at its center — the
> shield reads as protection, the central aperture as vigilant AI oversight.
> Clean vector geometry, balanced negative space, one continuous confident line
> weight, slight rounded corners. Deep violet (`#7C3AED`) as the primary color on
> a transparent background, with a subtle cool-to-warm violet gradient. Flat,
> modern, premium, institutional — like a cross between a bank seal and a privacy
> app. Centered, symmetrical, generous padding. No text, no letters, no mascot,
> no 3D, no drop shadows, no photorealism. Vector, SVG-style, crisp edges,
> scalable, works as a small favicon. --style raw --v 6

**Tagline for context (don't render as part of the mark):** *the guardian that
proves every move.*

---

## 2. Concept directions (generate several, pick one)

Run each as its own prompt by swapping the **symbol** clause in §1.

| # | Direction | Symbol clause to substitute |
|---|-----------|------------------------------|
| A | **Shield + aperture eye** (recommended) | "a shield whose negative space forms a watchful camera-aperture eye at the center" |
| B | **Custos monogram "C" as a shield** | "a single letter C drawn as a protective enclosing arc/shield around a small solid dot (the asset it guards)" |
| C | **Sentinel keyhole** (custody nod) | "a shield containing a minimal keyhole, signalling custody and safekeeping" |
| D | **Vault + heartbeat/peg line** | "a rounded shield enclosing a single horizontal line that ticks once like a steady pulse / a stable peg line" |
| E | **Concentric guard rings** | "three concentric rounded-square guard rings (idle · floor · core) with a solid protected center, like layered defenses" |

> Direction **A** best matches the product (verifiable *autonomous defense* +
> AI watchfulness). **B** is the safest as an app icon / favicon.

---

## 3. Style & constraints (apply to all)

**Do:**
- Single flat vector mark; one or two colors max; strong silhouette.
- Geometric, grid-constructed, mathematically balanced; golden-ratio or 8px-grid feel.
- Legible at 16×16 px (favicon) through large hero sizes — test tiny.
- Distinct, memorable silhouette that survives being filled a single solid color.
- Subtle violet gradient optional (`#7C3AED` → `#6D28D9`), but it must also work
  as a flat one-color mark.

**Don't:**
- No text/wordmark inside the icon (the wordmark is set separately, see §5).
- No literal padlocks, coins, dollar signs, bulls/bears, rockets, or robots.
- No 3D bevels, glossy reflections, drop shadows, gradients meshes, or photoreal.
- No clip-art shields with crossed swords / heraldry clutter.
- No stock "AI brain" or circuit-board motifs.

---

## 4. Color & theme variants to export

Generate / recolor the chosen mark in each:
1. **Primary** — violet `#7C3AED` on transparent.
2. **On-dark** — mark in white or light violet `#A78BFA` for the dark theme (`#0B0B12`-ish bg).
3. **On-light** — mark in `#6D28D9` for the light theme (white/`#F8FAFC` bg).
4. **Monochrome** — pure black and pure white versions (for stamps, etch, single-color print).
5. **Favicon** — simplified 32×32 / 16×16 with thicker strokes so it stays legible.

---

## 5. Wordmark (separate from the icon)

> The wordmark **"Custos"** set in a clean, modern, slightly geometric sans-serif
> (think Inter / Geist / General Sans), medium weight, tight-but-legible tracking,
> lowercase or title-case. Optional: the icon mark sits to the **left** of the
> wordmark (horizontal lockup) and **above** it (stacked lockup). The "o" in
> Custos may subtly echo the central aperture/eye of the icon. Violet `#7C3AED`
> or theme-appropriate neutral. No effects.

This matches the app's typography (Inter for UI). Deliver three lockups:
**icon-only**, **horizontal** (icon + wordmark), **stacked**.

---

## 6. Per-tool notes

- **Midjourney:** append `--style raw --v 6 --no text, letters, shadow, 3d`. Use
  `--ar 1:1` for the icon, `--ar 3:1` for the horizontal lockup. Upscale, then
  trace to vector (e.g. in Illustrator / `vtracer`) since MJ outputs raster.
- **DALL·E 3 / ChatGPT:** add "flat vector logo, solid background, centered,
  high contrast, no text" and ask for "a simple icon that vectorizes cleanly."
- **Ideogram / Firefly:** strongest if you *do* want the wordmark rendered;
  request "logo with the text 'Custos', clean geometric sans-serif."
- **SDXL:** add a negative prompt: `text, watermark, signature, 3d, bevel,
  gradient mesh, photo, realistic, cluttered, heraldry, padlock, coin`.

---

## 7. Acceptance checklist

- [ ] Recognizable in a single flat color and at 16×16 px.
- [ ] Reads as *protection + watchfulness*, not a generic shield or a padlock.
- [ ] Works on both light (`#F8FAFC`) and dark (`#0B0B12`) backgrounds.
- [ ] No embedded text in the icon; wordmark delivered separately.
- [ ] Final delivered as **SVG** (vectorize raster outputs) + PNG exports at
      512 / 192 / 32 / 16 px, plus a `favicon.svg` for `web/`.
- [ ] Pairs cleanly with the violet `#7C3AED` accent already used across the app.
