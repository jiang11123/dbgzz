import { create } from "zustand";
import { scopedLocalStorage, subscribeUserScope } from "@/lib/user-scope";

const key = "dbgzz:doubao-node-preferences:v1";

function readPreferences(): { showDoubaoNodes: boolean; autoConfirmVideo: boolean } {
    try {
        const parsed = JSON.parse(scopedLocalStorage.getItem(key) || "null");
        return {
            showDoubaoNodes: parsed?.showDoubaoNodes === true,
            autoConfirmVideo: parsed?.autoConfirmVideo !== false, // 默认开启
        };
    } catch {
        return {
            showDoubaoNodes: false,
            autoConfirmVideo: true,
        };
    }
}

export const useDoubaoPreferencesStore = create<{
    showDoubaoNodes: boolean;
    setShowDoubaoNodes: (show: boolean) => void;
    autoConfirmVideo: boolean;
    setAutoConfirmVideo: (auto: boolean) => void;
}>((set, get) => ({
    ...readPreferences(),
    setShowDoubaoNodes: (showDoubaoNodes) => {
        const next = { ...readPreferences(), showDoubaoNodes, autoConfirmVideo: get().autoConfirmVideo };
        scopedLocalStorage.setItem(key, JSON.stringify(next));
        set({ showDoubaoNodes });
    },
    setAutoConfirmVideo: (autoConfirmVideo) => {
        const next = { ...readPreferences(), showDoubaoNodes: get().showDoubaoNodes, autoConfirmVideo };
        scopedLocalStorage.setItem(key, JSON.stringify(next));
        set({ autoConfirmVideo });
    },
}));

subscribeUserScope(() => useDoubaoPreferencesStore.setState(readPreferences()));

