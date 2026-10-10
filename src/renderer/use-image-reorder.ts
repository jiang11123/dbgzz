import { useEffect, useRef, useState } from 'react';
import type { ImageAsset } from '../shared/types';

export function useImageReorder(items: ImageAsset[], selected: string[], busy: boolean,
  commit: (ids: string[]) => void) {
  const latest = useRef({items, selected, busy, commit});
  latest.current = {items, selected, busy, commit};
  const [moving, setMoving] = useState<string[]>([]);
  const [target, setTarget] = useState<{id: string; before: boolean} | null>(null);
  useEffect(() => {
    let drag: {pointer: number; root: HTMLElement; strip: HTMLElement; ids: string[]; x: number; y: number;
      clientX: number; active: boolean; destination: {id: string; before: boolean} | null} | null = null;
    let frame = 0;
    const clear = () => {
      const old = drag; drag = null; cancelAnimationFrame(frame);
      if (old?.root.hasPointerCapture(old.pointer)) old.root.releasePointerCapture(old.pointer);
      setMoving([]); setTarget(null);
    };
    const locate = () => {
      if (!drag) return;
      const candidates = [...drag.strip.querySelectorAll<HTMLElement>('[data-asset-id]')].filter(n => !drag!.ids.includes(n.dataset.assetId!));
      const before = candidates.find(n => { const r = n.getBoundingClientRect(); return drag!.clientX < r.left + r.width / 2; });
      const item = before || candidates.at(-1);
      drag.destination = item ? {id: item.dataset.assetId!, before: Boolean(before)} : null;
      setTarget(drag.destination);
    };
    const scroll = () => {
      if (!drag) return;
      if (drag.active) {
        const r = drag.strip.getBoundingClientRect();
        const speed = drag.clientX < r.left + 20 ? -10 : drag.clientX > r.right - 20 ? 10 : 0;
        if (speed) { drag.strip.scrollLeft += speed; locate(); }
      }
      frame = requestAnimationFrame(scroll);
    };
    const down = (event: PointerEvent) => {
      if (latest.current.busy || event.button !== 0 || !(event.target instanceof Element) || event.target.closest('input')) return;
      const card = event.target.closest<HTMLElement>('.asset-bar-thumb');
      const strip = card?.closest<HTMLElement>('.asset-bar-thumbnails');
      const root = card?.closest<HTMLElement>('.image-assets-bar');
      if (!card || !strip || !root) return;
      const id = card.dataset.assetId!;
      const ids = latest.current.items.filter(item => latest.current.selected.includes(id) ? latest.current.selected.includes(item.id) : item.id === id).map(item => item.id);
      event.preventDefault();
      drag = {pointer: event.pointerId, root, strip, ids, x: event.clientX, y: event.clientY, clientX: event.clientX, active: false, destination: null};
      root.setPointerCapture(event.pointerId); frame = requestAnimationFrame(scroll);
    };
    const move = (event: PointerEvent) => {
      if (!drag || drag.pointer !== event.pointerId) return;
      drag.clientX = event.clientX;
      if (!drag.active && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 5) return;
      drag.active = true;
      // Keep file dragging into the native account BrowserView. Sorting only
      // happens while the pointer remains in the image bar.
      const r = drag.root.getBoundingClientRect();
      if (event.clientY > r.bottom || event.clientY < r.top || event.clientX < r.left || event.clientX > r.right) {
        const ids = drag.ids; clear(); window.workspace.dragImageAssets(ids); return;
      }
      setMoving(drag.ids); locate();
    };
    const up = () => {
      const old = drag; clear();
      if (!old?.active || !old.destination || latest.current.busy) return;
      const current = latest.current.items.map(item => item.id);
      const rest = current.filter(id => !old.ids.includes(id));
      const index = rest.indexOf(old.destination.id);
      if (index < 0 || old.ids.some(id => !current.includes(id))) return;
      rest.splice(index + (old.destination.before ? 0 : 1), 0, ...old.ids);
      if (rest.some((id, i) => id !== current[i])) latest.current.commit(rest);
    };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') clear(); };
    window.addEventListener('pointerdown', down); window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up); window.addEventListener('pointercancel', clear);
    window.addEventListener('blur', clear); window.addEventListener('keydown', key);
    return () => {
      clear(); window.removeEventListener('pointerdown', down); window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', clear);
      window.removeEventListener('blur', clear); window.removeEventListener('keydown', key);
    };
  }, []);
  return {moving, target};
}
