// A tiny drawing surface so the axis renderer can output to EITHER a 2D canvas
// (the live overlay + PNG export) OR SVG markup (vector export) from one code path.

export type TextAlign = 'left' | 'center' | 'right';
export type TextBaseline = 'top' | 'middle' | 'bottom';

export interface Pen {
  color(c: string): void; // sets both stroke and fill
  font(px: number, bold?: boolean): void;
  line(x1: number, y1: number, x2: number, y2: number): void;
  text(s: string, x: number, y: number, align: TextAlign, baseline: TextBaseline): void;
  textRotated(s: string, x: number, y: number, angleRad: number, align: TextAlign, baseline: TextBaseline): void;
}

const FONT_STACK = "'JetBrains Mono', ui-monospace, monospace";

export class CanvasPen implements Pen {
  constructor(private ctx: CanvasRenderingContext2D) {
    ctx.lineWidth = 1;
  }
  color(c: string): void {
    this.ctx.strokeStyle = c;
    this.ctx.fillStyle = c;
  }
  font(px: number, bold = false): void {
    this.ctx.font = `${bold ? 'bold ' : ''}${px}px ${FONT_STACK}`;
  }
  line(x1: number, y1: number, x2: number, y2: number): void {
    this.ctx.beginPath();
    this.ctx.moveTo(x1, y1);
    this.ctx.lineTo(x2, y2);
    this.ctx.stroke();
  }
  text(s: string, x: number, y: number, align: TextAlign, baseline: TextBaseline): void {
    this.ctx.textAlign = align;
    this.ctx.textBaseline = baseline;
    this.ctx.fillText(s, x, y);
  }
  textRotated(s: string, x: number, y: number, angleRad: number, align: TextAlign, baseline: TextBaseline): void {
    this.ctx.save();
    this.ctx.translate(x, y);
    this.ctx.rotate(angleRad);
    this.ctx.textAlign = align;
    this.ctx.textBaseline = baseline;
    this.ctx.fillText(s, 0, 0);
    this.ctx.restore();
  }
}

export class SvgPen implements Pen {
  parts: string[] = [];
  private col = '#8a8a8a';
  private fpx = 10;
  private bold = false;
  color(c: string): void {
    this.col = c;
  }
  font(px: number, bold = false): void {
    this.fpx = px;
    this.bold = bold;
  }
  line(x1: number, y1: number, x2: number, y2: number): void {
    this.parts.push(`<line x1="${n(x1)}" y1="${n(y1)}" x2="${n(x2)}" y2="${n(y2)}" stroke="${this.col}" stroke-width="1"/>`);
  }
  text(s: string, x: number, y: number, align: TextAlign, baseline: TextBaseline): void {
    const anchor = align === 'center' ? 'middle' : align === 'right' ? 'end' : 'start';
    // approximate canvas textBaseline via a dy shift
    const dy = baseline === 'top' ? '0.8em' : baseline === 'middle' ? '0.32em' : '0';
    this.parts.push(
      `<text x="${n(x)}" y="${n(y)}" fill="${this.col}" font-family="${FONT_STACK}" font-size="${this.fpx}"${this.bold ? ' font-weight="bold"' : ''} text-anchor="${anchor}" dy="${dy}">${esc(s)}</text>`,
    );
  }
  textRotated(s: string, x: number, y: number, angleRad: number, align: TextAlign, baseline: TextBaseline): void {
    const anchor = align === 'center' ? 'middle' : align === 'right' ? 'end' : 'start';
    const dy = baseline === 'top' ? '0.8em' : baseline === 'middle' ? '0.32em' : '0';
    const deg = ((angleRad * 180) / Math.PI).toFixed(2);
    this.parts.push(
      `<text transform="translate(${n(x)},${n(y)}) rotate(${deg})" fill="${this.col}" font-family="${FONT_STACK}" font-size="${this.fpx}"${this.bold ? ' font-weight="bold"' : ''} text-anchor="${anchor}" dy="${dy}">${esc(s)}</text>`,
    );
  }
  markup(): string {
    return this.parts.join('');
  }
}

function n(v: number): string {
  return Number.isFinite(v) ? v.toFixed(1) : '0';
}
function esc(s: string): string {
  return s.replace(/[<>&]/g, (c) => (c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&amp;'));
}
