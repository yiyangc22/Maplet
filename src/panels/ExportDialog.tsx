// "Export as": render the whole viewer area — every open panel with its grid,
// axes and grey border, but no UI — as a raster PNG or a vector SVG. The height is
// derived from the on-screen layout so panel aspect ratios are preserved.

import { useState } from 'react';
import { useStore } from '../model/store';
import type { ExportOptions } from '../viewer/controls';
import { exportCompositePng, exportCompositeSvg } from '../viewer/composite';
import { saveExport } from '../platform/persist';

export default function ExportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const dataset = useStore((s) => s.dataset);
  const logMsg = useStore((s) => s.logMsg);
  const [format, setFormat] = useState<'png' | 'svg'>('png');
  const [width, setWidth] = useState(2000);
  const [background, setBackground] = useState<ExportOptions['background']>('dark');
  const [busy, setBusy] = useState(false);
  if (!open) return null;

  const doExport = async () => {
    setBusy(true);
    try {
      const w = Math.max(64, width | 0);
      const base = (dataset?.sourceName ?? 'maplet').replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9._-]+/g, '_') || 'maplet';
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      if (format === 'png') {
        const { dataUrl, outW, outH } = await exportCompositePng(w, background);
        await saveExport({ format: 'png', pngDataUrl: dataUrl, suggestedName: `${base}_${stamp}.png`, presetJson: '' });
        logMsg('ok', `Exported PNG ${outW}×${outH} (${background}).`);
      } else {
        const { svg, outW, outH } = exportCompositeSvg(w, background);
        await saveExport({ format: 'svg', svgText: svg, suggestedName: `${base}_${stamp}.svg`, presetJson: '' });
        logMsg('ok', `Exported SVG ${outW}×${outH} (${background}).`);
      }
    } catch (e) {
      logMsg('error', `Export failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
      onClose();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.5)' }} onClick={onClose}>
      <div className="panel w-[400px] p-4" style={{ background: 'var(--panel)' }} onClick={(e) => e.stopPropagation()}>
        <div className="section-head mb-3">Export as</div>

        <div className="mb-3">
          <div className="section-head mb-1">format</div>
          <div className="flex gap-1">
            <button className={`btn flex-1 ${format === 'png' ? 'btn-active' : ''}`} onClick={() => setFormat('png')} data-tip="Raster PNG at the pixel width below. Best for slides and quick figures.">
              PNG (raster)
            </button>
            <button className={`btn flex-1 ${format === 'svg' ? 'btn-active' : ''}`} onClick={() => setFormat('svg')} data-tip="Vector SVG: points as circles, axes as lines/text. Scales cleanly for publication.">
              SVG (vector)
            </button>
          </div>
        </div>

        <div className="mb-3">
          <label className="block">
            <div className="section-head mb-1">width px (height follows the layout)</div>
            <input className="field w-full mono-num" type="number" min={64} value={width} onChange={(e) => setWidth(+e.target.value)} />
          </label>
        </div>

        <div className="mb-4">
          <div className="section-head mb-1">background</div>
          <div className="flex gap-1">
            {(['dark', 'white', 'transparent'] as const).map((b) => (
              <button key={b} className={`btn flex-1 ${background === b ? 'btn-active' : ''}`} onClick={() => setBackground(b)} data-tip={b === 'transparent' ? 'Transparent background (PNG alpha; SVG no backdrop).' : `${b} background`}>
                {b}
              </button>
            ))}
          </div>
        </div>

        <p className="mb-3 text-[11px] leading-snug" style={{ color: 'var(--faint)' }}>
          Exports every open panel — its grid and axes (if shown) and its grey border — combined in the on-screen layout. UI
          controls are excluded. Only shown (unfiltered) points are drawn.
        </p>

        <div className="flex justify-end gap-2">
          <button className="btn" onClick={onClose} disabled={busy}>
            cancel
          </button>
          <button className="btn btn-active" onClick={() => void doExport()} disabled={busy || !dataset} data-tip="Render and download the image.">
            {busy ? 'exporting…' : 'export'}
          </button>
        </div>
      </div>
    </div>
  );
}
