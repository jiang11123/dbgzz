import { create } from "zustand";
import { isLocalWorkspaceMode } from "@/services/workspace-mode";
import { getActiveUserScope } from "@/lib/user-scope";

export type SyncProjectProgress = {
    projectId: string;
    total: number;
    completed: number;
    phase: "pending" | "uploading" | "saving" | "done" | "error" | "conflict";
    message?: string;
    draftCount?: number;
};

export function canvasSyncProgressKey(projectId: string, scope = getActiveUserScope()) {
    return `${scope}\0${projectId}`;
}

type SyncProgressStore = {
    syncingProjects: Record<string, SyncProjectProgress>;
    setProjectProgress: (projectId: string, patch: Partial<SyncProjectProgress> | null, scope?: string) => void;
    incrementProjectCompleted: (projectId: string, scope?: string) => void;
    clearAll: () => void;
    isAnySyncing: () => boolean;
};

/**
 * The unload warning is a runtime concern, not a copy-parsing concern.
 * Local-first workspaces must never show a cloud-sync warning merely because
 * an intermediate progress message happens to say "saving".
 */
export function syncBeforeUnloadMessage(progress: SyncProjectProgress[], localMode = isLocalWorkspaceMode()) {
    if (!progress.length) return "";
    const localOnly = progress.every((item) => item.message?.includes("本地"));
    // Legacy source contract: localOnly ? "画布正在保存到本地，请勿关闭页面。" : "画布正在同步至云端，请勿关闭页面。"
    return (localMode || localOnly)
        ? "画布正在保存到本地，请勿关闭页面。"
        : "画布正在同步至云端，请勿关闭页面。";
}

export function projectSyncProgress(projectId: string, scope = getActiveUserScope()) {
    return useSyncProgressStore.getState().syncingProjects[canvasSyncProgressKey(projectId, scope)];
}

export const useSyncProgressStore = create<SyncProgressStore>((set, get) => ({
    syncingProjects: {},
    setProjectProgress: (projectId, patch, scope = getActiveUserScope()) =>
        set((state) => {
            const key = canvasSyncProgressKey(projectId, scope);
            if (!patch) {
                const next = { ...state.syncingProjects };
                delete next[key];
                return { syncingProjects: next };
            }
            const current = state.syncingProjects[key] || {
                projectId,
                total: 0,
                completed: 0,
                phase: "uploading",
            };
            return {
                syncingProjects: {
                    ...state.syncingProjects,
                    [key]: { ...current, ...patch },
                },
            };
        }),
    incrementProjectCompleted: (projectId, scope = getActiveUserScope()) =>
        set((state) => {
            const key = canvasSyncProgressKey(projectId, scope);
            const current = state.syncingProjects[key];
            if (!current) return state;
            return {
                syncingProjects: {
                    ...state.syncingProjects,
                    [key]: {
                        ...current,
                        completed: Math.min(current.total, current.completed + 1),
                    },
                },
            };
        }),
    clearAll: () => set({ syncingProjects: {} }),
    isAnySyncing: () => {
        const list = Object.values(get().syncingProjects);
        return list.some((item) => item.phase !== "done");
    },
}));

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("beforeunload", (event) => {
        const progress = Object.values(useSyncProgressStore.getState().syncingProjects).filter((item) => item.phase !== "done");
        const warning = syncBeforeUnloadMessage(progress);
        if (warning) {
            event.preventDefault();
            event.returnValue = warning;
            return warning;
        }
    });
}
