// Shown when a dropped/opened file can't be recognized as a points table (empty, not
// delimited, or too few columns to form a coordinate map). A friendly nudge to check
// the file, in the same style as the row-cap prompt.

import { useStore } from '../model/store';
import { Modal } from '../ui/Modal';

export default function StructureNoticeModal() {
  const notice = useStore((s) => s.structureNotice);
  const dismiss = useStore((s) => s.dismissStructureNotice);
  if (!notice) return null;

  return (
    <Modal
      title="Couldn't read that file"
      width={440}
      onClose={dismiss}
      actions={
        <button className="btn btn-active" onClick={dismiss}>
          OK
        </button>
      }
    >
      <p className="mb-2" style={{ color: 'var(--text)' }}>
        Hmm — couldn&rsquo;t make sense of <b>{notice.name || 'that file'}</b>&rsquo;s structure.
      </p>
      <p className="text-[12px] leading-snug" style={{ color: 'var(--muted)' }}>
        Check that it&rsquo;s a <b>CSV or TSV</b> with a header row and one row per cell (columns separated by
        commas or tabs), then try loading it again.
      </p>
    </Modal>
  );
}
