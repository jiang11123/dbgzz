import { create } from "zustand";
import { useLayoutEffect } from "react";
import { canvasAppearanceBaseTheme, type CanvasAppearance } from "@/lib/canvas/canvas-appearance";
import { normalizeTheme, useThemeStore, type ThemeName } from "@/stores/use-theme-store";

type CanvasThemeStore = {
    theme: ThemeName;
    active: boolean;
    followGlobal: boolean;
    setTheme: (theme?: string) => void;
    setAppearance: (appearance: CanvasAppearance) => void;
};

// 外观选择由画布持久化；这里只保存当前编辑器解析后的主题，不另存历史快照。
export const useCanvasThemeStore = create<CanvasThemeStore>()((set) => ({
    theme: useThemeStore.getState().theme,
    active: false,
    followGlobal: true,
    setTheme: (theme) => set({ theme: normalizeTheme(theme), followGlobal: false }),
    setAppearance: (appearance) => set({
        followGlobal: appearance.mode === "follow",
        theme: canvasAppearanceBaseTheme(appearance, useThemeStore.getState().theme),
    }),
}));

// 工具栏和 body 上的 AntD 浮层都使用同一次主题更新。
useThemeStore.subscribe((state, previous) => {
    if (state.theme !== previous.theme && useCanvasThemeStore.getState().followGlobal) {
        useCanvasThemeStore.setState({ theme: state.theme });
    }
});

export function useCanvasThemeScope() {
    useLayoutEffect(() => {
        useCanvasThemeStore.setState({ active: true });
        return () => { useCanvasThemeStore.setState({ active: false }); };
    }, []);
}

export function useActiveTheme() {
    const workspaceTheme = useThemeStore((state) => state.theme);
    const canvasTheme = useCanvasThemeStore((state) => state.theme);
    const active = useCanvasThemeStore((state) => state.active);
    return active ? canvasTheme : workspaceTheme;
}
