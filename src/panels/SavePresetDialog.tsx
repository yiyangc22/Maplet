// "Save as" — choose the file format: a human-readable PERSPECTIVE (.yml, the view
// + filters + layout + camera, no data) or a standalone BUNDLE (.json, everything
// with the dataset embedded, reopens even if the original CSV/TSV is gone).

import { useEffect, useState } from 'react';
import { useStore } from '../model/store';
import { Modal } from '../ui/Modal';
import { savePerspectiveAs, saveBundleAs } from '../app/load';

export default function SavePresetDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const dataset = useStore((s) => s.dataset);
  const [mode, setMode] = useState<'perspective' | 'bundle'>('perspective');
  // The dialog stays mounted (App always renders it), so reset to the default
  // each time it opens rather than remembering the last pick.
  useEffect(() => {
    if (open) setMode('perspective');
  }, [open]);
  if (!open) return null;

  const onSave = () => {
    if (mode === 'bundle') void saveBundleAs();
    else void savePerspectiveAs();
    onClose();
  };

  return (
    <Modal
      title="Save As"
      onClose={onClose}
      actions={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-active" onClick={onSave} disabled={!dataset}>
            Save
          </button>
        </>
      }
    >
      <p className="mb-3">Choose a format:</p>
      <div className="space-y-2">
        <Option
          checked={mode === 'perspective'}
          onSelect={() => setMode('perspective')}
          title="View — .yml"
          desc="Human-readable: the camera, colors, filters, selection and panel layout — every change you made on top of the raw data, but NOT the data itself. Load it onto the same dataset to reproduce the view."
        />
        <Option
          checked={mode === 'bundle'}
          onSelect={() => setMode('bundle')}
          title="Full visualization — .json"
          desc="Standalone: the same view PLUS the entire dataset embedded, so it reopens anywhere — even if the original CSV/TSV is moved or deleted."
        />
      </div>
    </Modal>
  );
}

function Option({
  checked,
  onSelect,
  title,
  desc,
}: {
  checked: boolean;
  onSelect: () => void;
  title: string;
  desc: string;
}) {
  return (
    <label
      className="flex cursor-pointer gap-2 border p-2"
      style={{ borderColor: checked ? 'var(--accent)' : 'var(--border)' }}
    >
      <input type="radio" name="save-mode" checked={checked} onChange={onSelect} className="mt-[3px]" />
      <span className="min-w-0">
        <span style={{ color: 'var(--text)' }}>{title}</span>
        <span className="mt-[2px] block text-[11px]" style={{ color: 'var(--muted)' }}>
          {desc}
        </span>
      </span>
    </label>
  );
}
