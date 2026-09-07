// "Export as": render the whole centre section — the main viewer plus every open
// bottom panel, each with its grid, axes and grey border, but no UI — into one
// image. The panels' on-screen rectangles set the layout (so aspect ratios are
// preserved); each viewport renders its own scene + axes at the target resolution
// via the viewports registry, and we composite them into a PNG or a vector SVG.

import { useStore } from '../model/store';
import { viewports, type ExportBackground, type ViewportControls } from './controls';

const BORDER = '#3a3a3a';

interface Placed {
  vc: ViewportControls;
  x: number;
  y: number;
  w: number;
  h: number;
}
interface Layout {
  outW: number;
  outH: number;
  placed: Placed[];
}

// Map every live viewport (main + panels) to a rectangle in an output `width` px
// wide, scaled uniformly from the on-screen layout.
function layout(width: number): Layout {
  const panels = useStore.getState().panels;
  const ids = ['main', ...panels.map((_, i) => `panel-${i}`)];
  const entries = ids
    .map((id) => viewports.get(id))
    .filter((vc): vc is ViewportControls => !!vc && !!vc.container);
  if (entries.length === 0) throw new Error('Nothing to export — no viewer panels are open.');

  const rects = entries.map((vc) => vc.container.getBoundingClientRect());
  const minLeft = Math.min(...rects.map((r) => r.left));
  const minTop = Math.min(...rects.map((r) => r.top));
  const maxRight = Math.max(...rects.map((r) => r.right));
  const maxBottom = Math.max(...rects.map((r) => r.bottom));
  const boundW = Math.max(1, maxRight - minLeft);
  const boundH = Math.max(1, maxBottom - minTop);
  const scale = Math.max(0.01, width) / boundW;

  const placed = entries.map((vc, i) => {
    const r = rects[i];
    return {
      vc,
      x: Math.round((r.left - minLeft) * scale),
      y: Math.round((r.top - minTop) * scale),
      w: Math.max(1, Math.round(r.width * scale)),
      h: Math.max(1, Math.round(r.height * scale)),
    };
  });
  return { outW: Math.round(boundW * scale), outH: Math.round(boundH * scale), placed };
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('panel render failed to decode'));
    img.src = url;
  });
}

// PNG: render each panel's scene to a data URL, draw it, paint its axes, outline it.
export async function exportCompositePng(width: number, bg: ExportBackground): Promise<{ dataUrl: string; outW: number; outH: number }> {
  const { outW, outH, placed } = layout(width);
  const canvas = document.createElement('canvas');
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not create the export canvas.');
  if (bg !== 'transparent') {
    ctx.fillStyle = bg === 'white' ? '#ffffff' : '#050505';
    ctx.fillRect(0, 0, outW, outH);
  }
  for (const p of placed) {
    const img = await loadImage(p.vc.stillPng(p.w, p.h, bg));
    ctx.drawImage(img, p.x, p.y, p.w, p.h);
    ctx.save();
    ctx.translate(p.x, p.y);
    p.vc.axesToCanvas(ctx, p.w, p.h);
    ctx.restore();
  }
  ctx.strokeStyle = BORDER;
  ctx.lineWidth = 1;
  for (const p of placed) ctx.strokeRect(p.x + 0.5, p.y + 0.5, p.w - 1, p.h - 1);
  return { dataUrl: canvas.toDataURL('image/png'), outW, outH };
}

// SVG: each panel is a nested <svg> (points as circles) with its axes as vector
// lines/text alongside, plus a border rect — all laid out in the output space.
export function exportCompositeSvg(width: number, bg: ExportBackground): { svg: string; outW: number; outH: number } {
  const { outW, outH, placed } = layout(width);
  const parts: string[] = [`<svg xmlns="http://www.w3.org/2000/svg" width="${outW}" height="${outH}" viewBox="0 0 ${outW} ${outH}">`];
  if (bg !== 'transparent') {
    parts.push(`<rect width="${outW}" height="${outH}" fill="${bg === 'white' ? '#ffffff' : '#050505'}"/>`);
  }
  for (const p of placed) {
    const scene = p.vc.sceneSvg(p.w, p.h, bg);
    const axes = p.vc.axesToSvg(p.w, p.h);
    parts.push(
      `<g transform="translate(${p.x},${p.y})"><svg width="${p.w}" height="${p.h}" viewBox="0 0 ${p.w} ${p.h}">${scene}</svg>${axes}</g>`,
    );
  }
  parts.push(`<g fill="none" stroke="${BORDER}" stroke-width="1">`);
  for (const p of placed) parts.push(`<rect x="${p.x + 0.5}" y="${p.y + 0.5}" width="${p.w - 1}" height="${p.h - 1}"/>`);
  parts.push('</g></svg>');
  return { svg: parts.join('\n'), outW, outH };
}
