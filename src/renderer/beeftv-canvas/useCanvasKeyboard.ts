import { useEffect } from 'react';

interface KeyboardOptions {
  selectedNodeId: string | null;
  onRemoveNode: (id: string) => void;
  onResetView: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  setIsSpacePressed: (pressed: boolean) => void;
}

export function useCanvasKeyboard({
  selectedNodeId,
  onRemoveNode,
  onResetView,
  onZoomIn,
  onZoomOut,
  setIsSpacePressed,
}: KeyboardOptions) {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // 避免在输入框打字时误触画布全局快捷键
      const target = e.target as HTMLElement;
      const isInput = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);

      // 空格键平移抓手
      if (e.code === 'Space' && !isInput) {
        e.preventDefault();
        setIsSpacePressed(true);
        return;
      }

      if (isInput) return;

      // Delete / Backspace: 删除选中的节点
      if ((e.code === 'Delete' || e.code === 'Backspace') && selectedNodeId) {
        e.preventDefault();
        onRemoveNode(selectedNodeId);
      }

      // Ctrl + 0: 视口复位
      if ((e.ctrlKey || e.metaKey) && e.key === '0') {
        e.preventDefault();
        onResetView();
      }

      // Ctrl + =: 放大
      if ((e.ctrlKey || e.metaKey) && (e.key === '=' || e.key === '+')) {
        e.preventDefault();
        onZoomIn();
      }

      // Ctrl + -: 缩小
      if ((e.ctrlKey || e.metaKey) && e.key === '-') {
        e.preventDefault();
        onZoomOut();
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        setIsSpacePressed(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [selectedNodeId, onRemoveNode, onResetView, onZoomIn, onZoomOut, setIsSpacePressed]);
}
