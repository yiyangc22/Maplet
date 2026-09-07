// "Display" panel: how the points are drawn (opacity, ghosting) plus the scene
// overlays — axes, grid, labels, traces and orthographic projection — as simple
// checkboxes. Base size / size-by live in "Size by"; the selection outline is
// always on; image overlays get their own "Images" section.

import { useStore } from '../model/store';
import { Slider, Swatch, Toggle } from '../ui/widgets';

export default function DisplayControls() {
  const s = useStore((st) => st.settings);
  const st = useStore();
  const dataset = useStore((x) => x.dataset);
  const hasFrames = (dataset?.frameCount ?? 1) > 1;

  return (
    <div className="space-y-3">
      <Row label="base point opacity" value={s.pointOpacity.toFixed(2)} tip="Opacity of visible point dots.">
        <Slider min={0.05} max={1} step={0.05} value={s.pointOpacity} onChange={st.setPointOpacity} />
      </Row>
      <div>
        <Toggle
          label="ghost filtered-out points"
          checked={s.ghostMode}
          onChange={st.setGhost}
          tip="Show filtered-out points as faint ghosts (off = hide them)."
        />
        {s.ghostMode && (
          <div className="mt-1 pl-6">
            <Row label="ghost opacity" value={s.ghostOpacity.toFixed(3)} tip="How faint the ghosts are.">
              <Slider min={0} max={0.4} step={0.005} value={s.ghostOpacity} onChange={st.setGhostOpacity} />
            </Row>
          </div>
        )}
      </div>
      {/* Scene overlays (moved here from the right-click menu). */}
      <div className="space-y-[2px] border-t pt-2" style={{ borderColor: 'var(--border)' }}>
        <Toggle label="axes" checked={s.showAxes} onChange={st.setAxes} tip="Show the axes (lines + numbered ticks)." />
        <Toggle label="grid" checked={s.showGrid} onChange={st.setGrid} tip="Show the reference grid." />
        <Toggle
          label="labels for shown points"
          checked={s.labelAll}
          onChange={(v) => (v ? st.showAllLabels() : st.hideAllLabels())}
          tip="Draw a name label above every visible point."
        />
        {hasFrames && (
          <Toggle
            label="traces for shown points"
            checked={s.showTraces}
            onChange={(v) => (v ? st.showAllTraces() : st.hideAllTraces())}
            tip="Draw each visible point's path across frames."
          />
        )}
        {hasFrames && (
          <Toggle
            label="blip on update"
            checked={s.showBlips}
            onChange={st.setBlips}
            tip="Flash a point once (radar ping) when its position updates — helps when points update at staggered times."
          />
        )}
        <Toggle
          label="orthographic projection"
          checked={s.orthographic}
          onChange={st.setOrthographic}
          tip="Parallel projection (no perspective) for the main view."
        />
      </div>
    </div>
  );
}

// Microscopy overlay layers. Rendered in its own "Images" section (only when the
// dataset actually carries images).
export function ImageControls() {
  const dataset = useStore((st) => st.dataset);
  const s = useStore((st) => st.settings);
  const selected = useStore((st) => st.selectedImages);
  const st = useStore();
  const images = dataset?.images ?? [];
  if (images.length === 0) return null;

  const hidden = new Set(s.hiddenImages);
  const selArr = [...selected];

  // group tiles that share a `group` into one row; ungrouped layers stay individual
  type Entry = { kind: 'group'; name: string; indices: number[] } | { kind: 'single'; index: number };
  const entries: Entry[] = [];
  const groupMap = new Map<string, Extract<Entry, { kind: 'group' }>>();
  images.forEach((layer, i) => {
    if (layer.group) {
      let g = groupMap.get(layer.group);
      if (!g) {
        g = { kind: 'group', name: layer.group, indices: [] };
        groupMap.set(layer.group, g);
        entries.push(g);
      }
      g.indices.push(i);
    } else {
      entries.push({ kind: 'single', index: i });
    }
  });

  return (
    <div>
      <Toggle label={`image overlays (${images.length})`} checked={s.showImages} onChange={st.setImages} tip="Master switch for all overlay layers." />
      {s.showImages && (
        <>
          <div className="mt-1 pl-6">
            <Row label="overlay opacity" value={s.imageOpacity.toFixed(2)} tip="Opacity of all overlay layers.">
              <Slider min={0} max={1} step={0.05} value={s.imageOpacity} onChange={st.setImageOpacity} />
            </Row>
          </div>
          <div className="mt-2">
            <div
              className="section-head mb-1"
              data-tip="Show/hide image groups. Select individual images by ctrl-clicking them in the view, then use the buttons below."
            >
              layers
            </div>
            <div className="max-h-40 overflow-y-auto pr-1">
              {entries.map((e) => {
                if (e.kind === 'group') {
                  const nVis = e.indices.filter((i) => !hidden.has(i)).length;
                  const nSel = e.indices.filter((i) => selected.has(i)).length;
                  return (
                    <div key={`g:${e.name}`} className="flex items-center gap-2 py-[2px] leading-tight">
                      <input
                        type="checkbox"
                        checked={nVis > 0}
                        onChange={() => (nVis > 0 ? st.hideImages(e.indices) : st.showImages(e.indices))}
                        data-tip="Show or hide this whole image group."
                      />
                      <span className="min-w-0 flex-1 truncate" style={{ color: 'var(--muted)' }}>
                        {e.name}
                      </span>
                      <span className="mono-num shrink-0 text-[10px]" style={{ color: 'var(--faint)' }}>
                        {nSel ? `${nSel} sel · ` : ''}
                        {e.indices.length}
                      </span>
                    </div>
                  );
                }
                const i = e.index;
                const layer = images[i];
                const isSel = selected.has(i);
                return (
                  <div
                    key={layer.id ?? i}
                    className="flex items-center gap-2 py-[2px] leading-tight"
                    style={isSel ? { background: 'rgba(0,224,255,0.12)' } : undefined}
                  >
                    <input type="checkbox" checked={!hidden.has(i)} onChange={() => st.toggleImage(i)} data-tip="Show or hide this overlay layer." />
                    <button
                      className="min-w-0 flex-1 truncate text-left hover:text-white"
                      style={{ color: isSel ? 'var(--text)' : 'var(--muted)' }}
                      onClick={(ev) => st.toggleImageSelect(i, ev.ctrlKey || ev.metaKey || ev.shiftKey)}
                      data-tip="Select this layer (click again to de-select; ctrl/shift-click to add more)."
                    >
                      {layer.label ?? layer.id ?? `layer ${i}`}
                    </button>
                    <span className="flex shrink-0 gap-[2px]">
                      {(layer.channels ?? []).map((c, ci) => (
                        <Swatch key={ci} color={c.color ?? '#ffffff'} />
                      ))}
                    </span>
                  </div>
                );
              })}
            </div>
            <div className="mt-1 flex flex-wrap gap-1">
              <button className="btn py-[1px] text-[10px]" disabled={!selArr.length} onClick={() => st.hideImages(selArr)} data-tip="Hide the selected layers.">
                hide sel
              </button>
              <button className="btn py-[1px] text-[10px]" disabled={!selArr.length} onClick={() => st.showImages(selArr)} data-tip="Show the selected layers.">
                show sel
              </button>
              <button className="btn py-[1px] text-[10px]" disabled={!selArr.length} onClick={() => st.imagesOnly(selArr)} data-tip="Show only the selected layers.">
                isolate
              </button>
              <button className="btn py-[1px] text-[10px]" onClick={() => st.showImages(images.map((_, i) => i))} data-tip="Show every layer.">
                show all
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function Row({ label, value, tip, children }: { label: string; value: string; tip?: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="section-head mb-1 flex justify-between" data-tip={tip}>
        <span>{label}</span>
        <span className="mono-num" style={{ color: 'var(--muted)' }}>
          {value}
        </span>
      </div>
      {children}
    </div>
  );
}
