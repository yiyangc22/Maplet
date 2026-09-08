// Top menu bar — brutalist, native-menu-removed style. Everything is grouped into
// File / Edit / Selection / View menus; the right side shows only the loaded
// file's name and its data-point count.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useStore } from '../model/store';
import { isElectron, recent } from '../platform/loader';
import { doBrowse, doLoadBundle, doLoadPath, doLoadPerspective, doOpen, doOpenFolder, doOpenImages, doSample, doSave } from '../app/load';

export default function MenuBar({
  onToggleHistory,
  onOpenExport,
  onOpenSave,
  onOpenSearch,
}: {
  onToggleHistory: () => void;
  onOpenExport: () => void;
  onOpenSave: () => void;
  onOpenSearch: () => void;
}) {
  const dataset = useStore((s) => s.dataset);
  const status = useStore((s) => s.status);
  const log = useStore((s) => s.log);
  const cur = useStore((s) => s.currentEntryId);
  const lassoMode = useStore((s) => s.lassoMode);
  const selCount = useStore((s) => s.selection.size);
  const currentFile = useStore((s) => s.currentFile);
  const st = useStore();

  const idx = log.findIndex((e) => e.id === cur);
  const hasUndo = idx > 0 && log.slice(0, idx).some((e) => e.snapshot);
  const hasRedo = idx >= 0 && log.slice(idx + 1).some((e) => e.snapshot);

  // Smart Save: write back to the bound file; if there's none (raw data), open Save-as.
  const onSaveClick = async () => {
    if (!(await doSave())) onOpenSave();
  };

  return (
    <div className="flex h-9 shrink-0 items-stretch border-b" style={{ borderColor: 'var(--border)', background: 'var(--panel)' }}>
      <span className="flex select-none items-center border-r px-3 font-[700] tracking-wide" style={{ color: 'var(--text)', borderColor: 'var(--border)' }}>
        MAPLET
      </span>
      <Dropdown label="File" tip="Load, save, and export." width={190}>
        <SubMenu label="Load…">
          <MenuItem
            label="Browse…"
            tip="Pick any supported file — a raw table, a saved view (.yml), or a full visualization (.json). Routed by kind."
            onClick={() => void doBrowse(false)}
          />
          <MenuItem
            label="Raw table (.csv/.tsv)"
            tip="One row per point (or per point per frame). You map its columns to coordinates and variables when it loads."
            onClick={doOpen}
          />
          <MenuItem
            label="View (.yml/.yaml)"
            tip="Apply a saved view — filters, panels and camera — onto the current dataset (contains no data of its own)."
            onClick={() => void doLoadPerspective()}
            disabled={!dataset}
          />
          <MenuItem
            label="Full visualization (.json)"
            tip="Open a standalone bundle: the whole dataset AND its view, even if the original data file is gone."
            onClick={() => void doLoadBundle()}
          />
          <MenuItem
            label="Sample dataset"
            tip="Load the bundled MERFISH mouse-hypothalamus demo dataset."
            onClick={doSample}
          />
          <MenuSep />
          <MenuItem label="Add images…" tip="Load overlay images from a separate spreadsheet (coordinates + file path). Load data first." onClick={doOpenImages} disabled={!dataset} />
          {isElectron() && (
            <MenuItem label="Open folder…" tip="Open a save bundle or experiment folder (points + images together)." onClick={doOpenFolder} />
          )}
          {isElectron() && <MenuSep />}
          {isElectron() && <RecentItems />}
        </SubMenu>
        <MenuItem
          label={currentFile ? `Save (${currentFile.kind === 'bundle' ? '.json' : '.yml'})` : 'Save…'}
          tip="Save back to the file this came from; raw data prompts for a format."
          onClick={() => void onSaveClick()}
          disabled={!dataset}
        />
        <MenuItem label="Save as…" tip="Save the current setup as a view (.yml) or a standalone bundle (.json)." onClick={onOpenSave} disabled={!dataset} />
        <MenuItem
          label="Export as…"
          tip="Export every open panel (with grid/axes, no UI) as a PNG or vector SVG."
          onClick={onOpenExport}
          disabled={!dataset}
        />
      </Dropdown>

      <Dropdown label="Edit" tip="Undo / redo, edit history, search, revert." width={230}>
        <MenuItem label="Undo" tip="Undo the last adjustment (Ctrl+Z)." onClick={st.undo} disabled={!hasUndo} />
        <MenuItem label="Redo" tip="Redo (Ctrl+Shift+Z / Ctrl+Y)." onClick={st.redo} disabled={!hasRedo} />
        <MenuItem
          label="View edit history"
          tip="Every change to the plot, click a row to revert (Enter)."
          onClick={onToggleHistory}
          disabled={!dataset}
        />
        <MenuSep />
        <MenuItem label="Global search…" tip="Search every point and column; pick a result to select and frame it." onClick={onOpenSearch} disabled={!dataset} />
        <MenuItem label="Reset to last save" tip="Discard every edit since the last save or load." onClick={st.resetToLastSave} disabled={!dataset} />
      </Dropdown>

      <Dropdown label="Selection" tip="Select and frame data points." width={230} disabled={!dataset}>
        <MenuItem
          label="Lasso select"
          active={lassoMode}
          tip="Drag a boundary in any panel to select points inside. Shift-drag adds; Esc cancels; navigation pauses."
          onClick={st.toggleLassoMode}
        />
        <MenuItem label="Select all" tip="Select every shown point (hidden/filtered-out points can't be selected)." onClick={st.selectAll} />
        <MenuItem label="Frame selection" tip="Zoom the main viewer to the selected points (or visible if none)." onClick={st.frameSelection} />
        <MenuItem label="Clear selection" tip="Clear the selection (Esc)." onClick={st.clearSelection} disabled={selCount === 0} />
      </Dropdown>

      <div className="ml-auto flex items-center gap-3 pr-3">
        {status === 'loading' && <span style={{ color: 'var(--warn)' }}>loading…</span>}
        {dataset && (
          <span
            className="truncate text-[12px]"
            style={{ color: 'var(--text)', maxWidth: 380 }}
            title={`${dataset.sourceName}${dataset.meta.name && dataset.meta.name !== dataset.sourceName ? ` — ${dataset.meta.name}` : ''}\n${dataset.source}`}
          >
            {dataset.sourceName}
            <span className="mono-num ml-2" style={{ color: 'var(--faint)' }}>
              {dataset.n.toLocaleString()} points
            </span>
          </span>
        )}
      </div>
    </div>
  );
}

// A left-anchored dropdown menu that closes on an outside click or on any click
// inside (every item is an action).
function Dropdown({
  label,
  tip,
  disabled,
  width = 210,
  children,
}: {
  label: string;
  tip?: string;
  disabled?: boolean;
  width?: number;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  return (
    <div className="relative flex" ref={ref}>
      <button className={`menu-btn ${open ? 'active' : ''}`} disabled={disabled} onClick={() => setOpen((o) => !o)} data-tip={tip}>
        {label} ▾
      </button>
      {open && (
        <div
          className="panel absolute left-0 top-full z-50 mt-1"
          style={{ minWidth: width, width: 'max-content', background: 'var(--panel-2)' }}
          onClick={() => setOpen(false)}
        >
          {children}
        </div>
      )}
    </div>
  );
}

function MenuItem({
  label,
  tip,
  onClick,
  disabled,
  active,
}: {
  label: string;
  tip?: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
}) {
  return (
    <button
      className="flex w-full items-center gap-2 whitespace-nowrap px-3 py-[6px] text-left text-[12px] hover:bg-white hover:text-black disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-inherit"
      data-tip={tip}
      disabled={disabled}
      onClick={onClick}
    >
      {/* Toggle items (active is a boolean) show a ballot box; plain actions show nothing. */}
      <span className="w-4 shrink-0 text-center" style={{ color: active ? 'var(--accent)' : 'var(--muted)' }}>
        {active === undefined ? '' : active ? '☑' : '☐'}
      </span>
      <span className="flex-1">{label}</span>
    </button>
  );
}

// A flyout submenu inside a Dropdown (e.g. File ▸ Load). Opens to the right on
// hover; a leaf click bubbles to the Dropdown panel, which closes the whole menu.
// The parent row swallows its own click so it doesn't close the menu.
function SubMenu({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button
        className="flex w-full items-center gap-2 whitespace-nowrap px-3 py-[6px] text-left text-[12px] hover:bg-white hover:text-black"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Leading spacer matches MenuItem's checkbox column so "Load…" lines up
            with the plain items (Save…, Save as…, Export as…) below it. */}
        <span className="w-4 shrink-0" />
        <span className="flex-1">{label}</span>
        <span style={{ color: 'var(--muted)' }}>▸</span>
      </button>
      {open && (
        <div className="panel absolute top-[-5px] py-1" style={{ left: '100%', minWidth: 210, width: 'max-content', background: 'var(--panel-2)' }}>
          {children}
        </div>
      )}
    </div>
  );
}

function MenuSep() {
  return <div className="my-1 border-t" style={{ borderColor: 'var(--border)' }} />;
}

// Recent files, loaded when the File menu opens (this only mounts while open).
function RecentItems() {
  const [items, setItems] = useState<string[]>([]);
  useEffect(() => {
    recent().then(setItems);
  }, []);
  if (items.length === 0) {
    return (
      <div className="px-3 py-2 text-[12px]" style={{ color: 'var(--faint)' }}>
        no recent files
      </div>
    );
  }
  return (
    <>
      <div className="px-3 pt-1 text-[10px] uppercase tracking-wide" style={{ color: 'var(--faint)' }}>
        recent
      </div>
      {items.map((p) => (
        <button
          key={p}
          className="block w-full truncate px-3 py-[6px] text-left text-[12px] hover:bg-white hover:text-black"
          title={p}
          onClick={() => doLoadPath(p)}
        >
          {p}
        </button>
      ))}
    </>
  );
}
