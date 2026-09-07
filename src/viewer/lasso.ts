// A freehand lasso overlay shared by the 3D and UMAP viewers. While the store's
// lasso mode is on, dragging draws a boundary; on release the polygon (in screen
// coords relative to the render surface) is handed back so the viewer can select
// every point whose projected position falls inside it.

export function pointInPolygon(px: number, py: number, poly: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0];
    const yi = poly[i][1];
    const xj = poly[j][0];
    const yj = poly[j][1];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export interface LassoOptions {
  container: HTMLElement; // where the overlay canvas is appended (viewer container)
  dom: HTMLElement; // element receiving pointer events (the WebGL canvas)
  isActive: () => boolean; // lasso mode on?
  onSelect: (polygon: [number, number][], additive: boolean) => void;
}

export function createLasso(opts: LassoOptions): () => void {
  const canvas = document.createElement('canvas');
  Object.assign(canvas.style, {
    position: 'absolute',
    left: '0',
    top: '0',
    pointerEvents: 'none',
    zIndex: '6',
  } as CSSStyleDeclaration);
  opts.container.appendChild(canvas);
  const ctx = canvas.getContext('2d')!;

  let drawing = false;
  let pts: [number, number][] = [];
  let additive = false;

  const dpr = () => Math.min(window.devicePixelRatio || 1, 2);
  function sync() {
    const r = opts.dom.getBoundingClientRect();
    // Align the overlay exactly over the render canvas, wherever the canvas sits
    // inside its container (e.g. below a panel title bar). Offsets are resolved
    // against the overlay's own offset parent, so the drawn boundary lands under
    // the cursor rather than a title-bar's height too high.
    const parent = (canvas.offsetParent as HTMLElement | null) ?? opts.container;
    const pr = parent.getBoundingClientRect();
    const d = dpr();
    canvas.width = Math.max(1, Math.round(r.width * d));
    canvas.height = Math.max(1, Math.round(r.height * d));
    canvas.style.left = `${r.left - pr.left}px`;
    canvas.style.top = `${r.top - pr.top}px`;
    canvas.style.width = `${r.width}px`;
    canvas.style.height = `${r.height}px`;
  }
  function pt(e: PointerEvent): [number, number] {
    const r = opts.dom.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }
  function clear() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
  function draw() {
    const d = dpr();
    ctx.setTransform(d, 0, 0, d, 0, 0);
    ctx.clearRect(0, 0, canvas.width / d, canvas.height / d);
    if (pts.length < 1) return;
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.closePath();
    ctx.fillStyle = 'rgba(255,176,0,0.12)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,176,0,0.9)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 4]);
    ctx.stroke();
  }

  const down = (e: PointerEvent) => {
    if (!opts.isActive() || e.button !== 0) return;
    drawing = true;
    // Ctrl (or Cmd) adds this region to the current selection. Shift does too —
    // Shift is the lasso-engage key, so while it's held every successive lasso
    // accumulates into one selection instead of replacing the previous one.
    additive = e.ctrlKey || e.metaKey || e.shiftKey;
    sync();
    pts = [pt(e)];
    draw();
  };
  const move = (e: PointerEvent) => {
    if (!drawing) return;
    const p = pt(e);
    const last = pts[pts.length - 1];
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > 3) {
      pts.push(p);
      draw();
    }
  };
  const up = () => {
    if (!drawing) return;
    drawing = false;
    const poly = pts;
    pts = [];
    clear();
    if (poly.length >= 3) opts.onSelect(poly, additive);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && drawing) {
      drawing = false;
      pts = [];
      clear();
    }
  };

  opts.dom.addEventListener('pointerdown', down);
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('keydown', onKey);

  return () => {
    opts.dom.removeEventListener('pointerdown', down);
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('keydown', onKey);
    canvas.remove();
  };
}
