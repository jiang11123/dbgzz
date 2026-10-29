import { create } from "zustand";
import { scopedLocalStorage, subscribeUserScope } from "@/lib/user-scope";

const key = "dbgzz:doubao-node-preferences:v1";

function readShowDoubaoNodes(): boolean {
    try {
        return JSON.parse(scopedLocalStorage.getItem(key) || "null")?.showDoubaoNodes === true;
    } catch {
        return false;
    }
}

export const useDoubaoPreferencesStore = create<{
    showDoubaoNodes: boolean;
    setShowDoubaoNodes: (show: boolean) => void;
}>((set) => ({
    showDoubaoNodes: readShowDoubaoNodes(),
    setShowDoubaoNodes: (showDoubaoNodes) => {
        scopedLocalStorage.setItem(key, JSON.stringify({ showDoubaoNodes }));
        set({ showDoubaoNodes });
    },
}));

subscribeUserScope(() => useDoubaoPreferencesStore.setState({ showDoubaoNodes: readShowDoubaoNodes() }));
