import { useCallback, useState } from "react";

const FOCUS_MODE_KEY = "canvas-focus-mode-v2";

// 默认策略：小屏首次进入时自动沉浸；用户显式退出后必须保持退出，
// 否则小屏条件会立刻把顶栏和“新建画布”入口重新隐藏。
function readInitialPreference(): boolean {
    const stored = window.localStorage.getItem(FOCUS_MODE_KEY);
    if (stored !== null) return stored === "true";
    return window.innerWidth < 1024;
}

export function useFocusMode() {
    const [userPreference, setUserPreference] = useState<boolean>(readInitialPreference);
    const focusMode = userPreference;

    const persist = useCallback((next: boolean) => {
        setUserPreference(next);
        try {
            window.localStorage.setItem(FOCUS_MODE_KEY, String(next));
        } catch {
            // 忽略 localStorage 不可用场景，专注模式仍可在本次会话生效。
        }
    }, []);

    const enterFocusMode = useCallback(() => persist(true), [persist]);
    const exitFocusMode = useCallback(() => persist(false), [persist]);
    const toggleFocusMode = useCallback(() => persist(!userPreference), [persist, userPreference]);

    return {
        focusMode,
        enterFocusMode,
        exitFocusMode,
        toggleFocusMode,
    };
}
