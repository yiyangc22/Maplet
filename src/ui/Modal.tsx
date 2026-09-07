// A small centered modal with a dim backdrop. Click-outside or Esc closes it
// (Esc is captured so it doesn't also clear the selection underneath). Used for
// the "columns had no type" review and the "change variable type?" confirmation.

import { useEffect, type ReactNode } from 'react';

export function Modal({
  title,
  children,
  actions,
  onClose,
  width = 440,
}: {
  title?: string;
  children: ReactNode;
  actions?: ReactNode;
  onClose: () => void;
  width?: number;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.55)' }}
      onMouseDown={onClose}
    >
      <div
        className="panel p-4"
        style={{ background: 'var(--panel-2)', width, maxWidth: '92vw' }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {title && (
          <div className="mb-2 font-[600]" style={{ color: 'var(--text)' }}>
            {title}
          </div>
        )}
        <div className="text-[12px] leading-relaxed" style={{ color: 'var(--muted)' }}>
          {children}
        </div>
        {actions && <div className="mt-4 flex justify-end gap-2">{actions}</div>}
      </div>
    </div>
  );
}
