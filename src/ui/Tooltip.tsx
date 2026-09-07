// A single delegated tooltip. Any element with a `data-tip` attribute (set
// directly or via the `tip` prop on our widgets) shows a short description after
// a short hover delay. Mounted once at the app root.

import { useEffect, useState } from 'react';

const DELAY = 550;

export default function TooltipLayer() {
  const [tip, setTip] = useState<{ text: string; x: number; y: number } | null>(null);

  useEffect(() => {
    let timer: number | undefined;
    let current: HTMLElement | null = null;

    const findTip = (t: EventTarget | null): HTMLElement | null => {
      let node = t as HTMLElement | null;
      while (node && node !== document.body) {
        if (node.dataset && node.dataset.tip) return node;
        node = node.parentElement;
      }
      return null;
    };
    const hide = () => {
      window.clearTimeout(timer);
      current = null;
      setTip(null);
    };
    const onOver = (e: PointerEvent) => {
      const el = findTip(e.target);
      if (el === current) return;
      current = el;
      window.clearTimeout(timer);
      if (!el) {
        setTip(null);
        return;
      }
      timer = window.setTimeout(() => {
        const r = el.getBoundingClientRect();
        setTip({ text: el.dataset.tip ?? '', x: r.left, y: r.bottom + 6 });
      }, DELAY);
    };

    document.addEventListener('pointerover', onOver);
    document.addEventListener('pointerdown', hide, true);
    window.addEventListener('scroll', hide, true);
    window.addEventListener('keydown', hide, true);
    window.addEventListener('blur', hide);
    return () => {
      document.removeEventListener('pointerover', onOver);
      document.removeEventListener('pointerdown', hide, true);
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('keydown', hide, true);
      window.removeEventListener('blur', hide);
      window.clearTimeout(timer);
    };
  }, []);

  if (!tip || !tip.text) return null;
  const x = Math.max(4, Math.min(tip.x, window.innerWidth - 248));
  const y = Math.min(tip.y, window.innerHeight - 40);
  return (
    <div
      className="panel pointer-events-none fixed z-[100] max-w-[240px] px-2 py-1 text-[11px] leading-snug"
      style={{ left: x, top: y, background: 'var(--panel-2)', color: 'var(--muted)' }}
    >
      {tip.text}
    </div>
  );
}
