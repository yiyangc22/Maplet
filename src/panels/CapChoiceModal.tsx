// Shown when a loaded table has more rows than the viewer stays fully smooth with. The
// user can load only the first N rows (a cheap prefix — always works, even for a file
// too large to hold in memory), load the whole thing anyway (may be less snappy), or
// cancel. Closing / Esc / Cancel aborts the load.

import { useStore } from '../model/store';
import { Modal } from '../ui/Modal';

export default function CapChoiceModal() {
  const prompt = useStore((s) => s.capPrompt);
  const resolve = useStore((s) => s.resolveCapPrompt);
  if (!prompt) return null;
  const { rows, cap, oversize } = prompt;

  return (
    <Modal
      width={460}
      onClose={() => resolve(null)}
      actions={
        <>
          <button className="btn" onClick={() => resolve(null)}>
            Cancel
          </button>
          {/* The full dataset only lives in memory for a file we read whole; an oversized
              file was read as a prefix, so "Load anyway" isn't offered there. */}
          {!oversize && (
            <button className="btn" onClick={() => resolve('all')}>
              Load anyway
            </button>
          )}
          <button className="btn btn-active" onClick={() => resolve('head')}>
            Load first {cap.toLocaleString()} rows
          </button>
        </>
      }
    >
      <p className="mb-2" style={{ color: 'var(--text)' }}>
        Wowza, that&rsquo;s <b>{rows.toLocaleString()}</b> rows. Try something fewer than{' '}
        <b>{cap.toLocaleString()}</b>, or:
      </p>
      <p className="text-[12px] leading-snug" style={{ color: 'var(--muted)' }}>
        load the <b>first {cap.toLocaleString()} rows</b> in file order (enough to explore, stays snappy)
        {oversize ? '.' : ', or '}
        {!oversize && (
          <>
            <b>load anyway</b> to draw the whole dataset — it still renders, but hover, filtering and colouring
            may lag.
          </>
        )}
      </p>
    </Modal>
  );
}
