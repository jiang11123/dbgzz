import { useEffect, useRef, useState } from 'react';

export function useImageMarquee(selected: string[], setSelected: (ids: string[]) => void, busy: boolean) {
  const region = useRef<HTMLElement>(null);
  const currentSelection = useRef(selected);
  currentSelection.current = selected;
  const [box, setBox] = useState<{left: number; top: number; width: number; height: number} | null>(null);
  useEffect(() => {
    const root = region.current;
    if (!root || busy) return;
    let drag: {id: number; x: number; y: number; startX: number; startY: number; clientX: number; clientY: number; base: string[]; additive: boolean; moved: boolean} | null = null;
    let frame = 0;
    const strip = () => root.querySelector<HTMLElement>('.asset-bar-thumbnails')!;
    const update = () => {
      if (!drag?.moved) return;
      const list = strip(), rect = list.getBoundingClientRect();
      const x = Math.max(rect.left, Math.min(rect.right, drag.clientX)) - rect.left + list.scrollLeft;
      const y = Math.max(rect.top, Math.min(rect.bottom, drag.clientY)) - rect.top;
      const left = Math.min(drag.x, x), right = Math.max(drag.x, x);
      const top = Math.min(drag.y, y), bottom = Math.max(drag.y, y);
      const ids = [...list.querySelectorAll<HTMLElement>('[data-asset-id]')].filter(node => {
        const r = node.getBoundingClientRect();
        const itemLeft = r.left - rect.left + list.scrollLeft, itemTop = r.top - rect.top;
        return itemLeft < right && itemLeft + r.width > left && itemTop < bottom && itemTop + r.height > top;
      }).map(node => node.dataset.assetId!);
      setSelected([...new Set([...(drag.additive ? drag.base : []), ...ids])]);
      const visibleLeft = Math.max(rect.left, rect.left + left - list.scrollLeft);
      const visibleRight = Math.min(rect.right, rect.left + right - list.scrollLeft);
      setBox({left: visibleLeft, top: rect.top + top, width: Math.max(0, visibleRight - visibleLeft), height: bottom - top});
    };
    const tick = () => {
      if (!drag) return;
      if (drag.moved) {
        const list = strip(), r = list.getBoundingClientRect();
        const amount = drag.clientX < r.left + 20 ? -10 : drag.clientX > r.right - 20 ? 10 : 0;
        if (amount) { list.scrollLeft += amount; update(); }
      }
      frame = requestAnimationFrame(tick);
    };
    const end = (cancel = false) => {
      if (!drag) return;
      const saved = drag; drag = null;
      if (cancel) setSelected(saved.base);
      else if (!saved.moved && !saved.additive) setSelected([]);
      if (root.hasPointerCapture(saved.id)) root.releasePointerCapture(saved.id);
      cancelAnimationFrame(frame); setBox(null);
    };
    const down = (event: PointerEvent) => {
      if (event.button !== 0 || !(event.target instanceof Element) || !root.contains(event.target)
        || event.target.closest('.asset-bar-thumb,.asset-bar-controls,.bar-resizer')) return;
      const list = strip(), r = list.getBoundingClientRect();
      if (event.clientY >= r.top + list.clientHeight && event.clientY < r.bottom) return; // Native scrollbar.
      event.preventDefault();
      drag = {id: event.pointerId, x: Math.max(0, Math.min(r.width, event.clientX - r.left)) + list.scrollLeft,
        y: Math.max(0, Math.min(r.height, event.clientY - r.top)), startX: event.clientX, startY: event.clientY, clientX: event.clientX, clientY: event.clientY,
        base: [...currentSelection.current], additive: event.ctrlKey || event.metaKey || event.shiftKey, moved: false};
      root.setPointerCapture(event.pointerId); frame = requestAnimationFrame(tick);
    };
    const move = (event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.id) return;
      if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > 3) drag.moved = true;
      drag.clientX = event.clientX; drag.clientY = event.clientY; update();
    };
    const up = () => end();
    const cancel = () => end(true);
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') cancel(); };
    window.addEventListener('pointerdown', down); window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up); window.addEventListener('pointercancel', cancel);
    window.addEventListener('blur', up); window.addEventListener('keydown', key);
    return () => {
      end(true);
      window.removeEventListener('pointerdown', down); window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('blur', up); window.removeEventListener('keydown', key);
    };
  }, [busy, setSelected]);
  return {region, box};
}
