// Perceptual colormaps for continuous variables + a categorical palette, both
// chosen to be COLOR-VISION-DEFICIENCY (colour-blind) SAFE: every sequential map
// is perceptually uniform (viridis family / cividis), the one diverging map is
// blue↔red (avoids the red↔green confusion), and the categorical palette is the
// Okabe–Ito + Paul Tol qualitative sets. No rainbow / jet / turbo maps. Colormaps
// are equally-spaced RGB stops (0..255), linearly interpolated. sampleColormap
// returns normalized 0..1 RGB (for the shader); hex helpers are for CSS legends.

export type RGB = [number, number, number];

const STOPS: Record<string, RGB[]> = {
  viridis: [
    [68, 1, 84], [72, 40, 120], [62, 74, 137], [49, 104, 142], [38, 130, 142],
    [31, 158, 137], [53, 183, 121], [110, 206, 88], [181, 222, 43], [253, 231, 37],
  ],
  magma: [
    [0, 0, 4], [28, 16, 68], [79, 18, 123], [129, 37, 129], [181, 54, 122],
    [229, 80, 100], [251, 135, 97], [254, 194, 135], [252, 253, 191],
  ],
  inferno: [
    [0, 0, 4], [31, 12, 72], [85, 15, 109], [136, 34, 106], [186, 54, 85],
    [227, 89, 51], [249, 140, 10], [249, 201, 50], [252, 255, 164],
  ],
  plasma: [
    [13, 8, 135], [75, 3, 161], [125, 3, 168], [168, 34, 150], [203, 70, 121],
    [229, 107, 93], [248, 148, 65], [253, 195, 40], [240, 249, 33],
  ],
  cividis: [
    [0, 32, 76], [0, 49, 110], [41, 68, 112], [80, 88, 113], [117, 108, 113],
    [154, 131, 105], [194, 155, 89], [236, 182, 60], [255, 233, 69],
  ],
  coolwarm: [
    [59, 76, 192], [120, 140, 225], [192, 205, 230], [221, 221, 221],
    [230, 180, 160], [225, 110, 90], [180, 4, 38],
  ],
  greys: [
    [30, 30, 30], [240, 240, 240],
  ],
};

export const COLORMAP_NAMES = Object.keys(STOPS);
export const DEFAULT_COLORMAP = 'viridis';

function stopsFor(name: string): RGB[] {
  return STOPS[name] ?? STOPS[DEFAULT_COLORMAP];
}

/** Sample a colormap at t in [0,1]; returns normalized 0..1 RGB. */
export function sampleColormap(name: string, t: number): RGB {
  const stops = stopsFor(name);
  const clamped = Number.isFinite(t) ? Math.min(1, Math.max(0, t)) : 0;
  const scaled = clamped * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(scaled));
  const f = scaled - i;
  const a = stops[i];
  const b = stops[i + 1];
  return [
    (a[0] + (b[0] - a[0]) * f) / 255,
    (a[1] + (b[1] - a[1]) * f) / 255,
    (a[2] + (b[2] - a[2]) * f) / 255,
  ];
}

export function colormapHex(name: string, t: number): string {
  return rgbToHex(sampleColormap(name, t));
}

/** A CSS linear-gradient string for a colorbar swatch. */
export function colormapGradient(name: string, steps = 12): string {
  const parts: string[] = [];
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    parts.push(`${colormapHex(name, t)} ${(t * 100).toFixed(0)}%`);
  }
  return `linear-gradient(90deg, ${parts.join(', ')})`;
}

// ---------------------------------------------------------------------------
// Categorical palette — COLOUR-BLIND-SAFE qualitative colours (the Okabe–Ito set,
// minus its black which vanishes on the near-black background, then Paul Tol's
// "muted" set), ordered brightest-first so the common <8-category case uses the
// most separable, legible-on-#050505 hues. Cycled with a lightness shift when a
// variable has more categories than colours. Verified against deuter-/protan-/
// tritanopia — no red↔green or otherwise ambiguous pairs among the leaders.
// ---------------------------------------------------------------------------

const CATEGORICAL: RGB[] = [
  [86, 180, 233], // sky blue
  [230, 159, 0], // orange
  [0, 158, 115], // bluish green
  [204, 121, 167], // reddish purple
  [240, 228, 66], // yellow
  [0, 114, 178], // blue
  [213, 94, 0], // vermillion
  [136, 204, 238], // pale cyan
  [68, 170, 153], // teal
  [170, 68, 153], // purple
  [221, 204, 119], // sand
  [153, 153, 51], // olive
  [17, 119, 51], // dark green
  [136, 34, 85], // wine
];

export const MISSING_COLOR: RGB = [0.42, 0.42, 0.42]; // grey for points with no value

export function categoricalColor(index: number): RGB {
  const base = CATEGORICAL[index % CATEGORICAL.length];
  const cycle = Math.floor(index / CATEGORICAL.length);
  if (cycle === 0) return [base[0] / 255, base[1] / 255, base[2] / 255];
  // shift lightness on each wrap so cycled colors are still separable
  const f = cycle % 2 === 1 ? 0.62 : 1.32;
  return [
    Math.min(1, (base[0] / 255) * f),
    Math.min(1, (base[1] / 255) * f),
    Math.min(1, (base[2] / 255) * f),
  ];
}

export function rgbToHex([r, g, b]: RGB): string {
  const c = (v: number) => Math.round(v * 255).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** Parse "#rrggbb" (or "#rgb") to normalized 0..1 RGB; null if unparseable. */
export function hexToRgb(hex: string): RGB | null {
  let h = hex.trim().replace(/^#/, '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (h.length !== 6 || /[^0-9a-fA-F]/.test(h)) return null;
  return [
    parseInt(h.slice(0, 2), 16) / 255,
    parseInt(h.slice(2, 4), 16) / 255,
    parseInt(h.slice(4, 6), 16) / 255,
  ];
}
