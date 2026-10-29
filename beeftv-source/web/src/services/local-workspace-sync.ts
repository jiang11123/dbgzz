import { assertUserScope, captureUserScope, type CapturedUserScope } from "@/lib/user-scope-guard";
import { rebindInconsistentCanvasAssets, type CanvasAssetRebindResult } from "@/services/canvas-asset-repair";
import { createLocalCanvasProject, deleteLocalCanvasProjects, openLocalCanvasProject, openLocalCanvasProjectFromBackend, persistCanvasDocument, restoreLocalCanvasProjectFromHistory } from "@/services/local-workspace-repository";
import { flushAssetStorePersistence, useAssetStore, type Asset } from "@/stores/use-asset-store";
import {
    loadWorkspaceAssetLibraryPage,
    loadWorkspaceAssetsForUse,
    type WorkspaceAssetLibraryPageOptions,
} from "@/services/workspace-asset-read";
import { flushCanvasStorePersistence, useCanvasStore, type CanvasProject } from "@/stores/canvas/use-canvas-store";

export { isLocalWorkspaceMode } from "@/services/workspace-mode";

let operationTail: Promise<void> = Promise.resolve();
const canvasRefreshListeners = new Set<(project: CanvasProject, previous: CanvasProject | undefined) => void>();

/**
 * Backward-compatible local persistence facade.
 *
 * Call sites keep their historical function names while the implementation
 * contains no account, cloud snapshot, upload queue, conflict baseline or
 * retry machinery. New code should use the workspace repositories directly.
 */
export function hasRemoteUserDataSyncSession() {
    return false;
}

export function withRemoteUserDataSyncExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const next = operationTail.then(operation, operation);
    operationTail = next.then(() => undefined, () => undefined);
    return next;
}

export async function loadCanvasProjectForEditing(
    id: string,
    options: { latest?: boolean; historyRestore?: { snapshotId: string; revision: number }; onLoad?: (project: CanvasProject) => void } = {},
) {
    const expected = captureUserScope();
    assertUserScope(expected);
    if (options.historyRestore) {
        const restored = await restoreLocalCanvasProjectFromHistory(id, options.historyRestore, expected);
        assertUserScope(expected);
        options.onLoad?.(restored);
        return restored;
    }
    const project = await openLocalCanvasProjectFromBackend(id, expected);
    if (project) options.onLoad?.(project);
    return project || undefined;
}

// 画布内容被其他写入者（远端刷新、任务回写）替换后通知本地编辑器合并。
export function subscribeCanvasRefresh(listener: (project: CanvasProject, previous: CanvasProject | undefined) => void) {
    canvasRefreshListeners.add(listener);
    return () => { canvasRefreshListeners.delete(listener); };
}

/** 外部写入已投影到本地存储后，把这次替换交给正在编辑的页面。 */
export function notifyCanvasRefresh(project: CanvasProject, previous: CanvasProject | undefined) {
    for (const listener of [...canvasRefreshListeners]) listener(project, previous);
}

/**
 * Persist an editor snapshot to the co-packaged Go repository. Callers that
 * mutate the canvas outside the autosave flow (for example node deletion) must
 * use this bridge so the next remote refresh cannot resurrect a stale snapshot.
 */
export async function syncLocalCanvasSnapshot(id: string, patch: Partial<Pick<CanvasProject, "nodes" | "connections" | "chatSessions" | "activeChatId" | "appearance" | "backgroundMode" | "showImageInfo" | "viewport">>, expectedScope?: CapturedUserScope) {
    const expected = expectedScope ?? captureUserScope();
    assertUserScope(expected);
    const current = openLocalCanvasProject(id);
    if (!current) throw new Error("本地画布不存在");
    const { viewport, ...documentPatch } = patch;
    if (viewport) useCanvasStore.getState().updateProject(id, { viewport });
    if (Object.keys(documentPatch).length > 0) await persistCanvasDocument(id, documentPatch, expected);
    assertUserScope(expected);
    const saved = openLocalCanvasProject(id);
    if (!saved) throw new Error("本地画布不存在");
    return saved;
}

export type LocalAssetPageOptions = WorkspaceAssetLibraryPageOptions;

export function loadAssetLibraryPage(options: LocalAssetPageOptions) {
    return loadWorkspaceAssetLibraryPage(options);
}

export function loadAssetsForUse(ids: Iterable<string>, expectedScope?: WorkspaceAssetLibraryPageOptions["expectedScope"]) {
    return loadWorkspaceAssetsForUse(ids, expectedScope);
}

export function localSavedRemotePendingMessage(localAction: string, error: unknown) {
    const detail = error instanceof Error && error.message.trim() ? error.message.trim() : "未知错误";
    return `${localAction}失败：${detail}`;
}

export async function createCanvasProjectWithRemoteSync(
    title: string,
    projectId?: string,
    initialContent?: Partial<Pick<CanvasProject, "nodes" | "connections" | "chatSessions" | "activeChatId">>,
): Promise<{ id: string; syncError?: unknown }> {
    return { ...await createLocalCanvasProject(title, projectId, initialContent), syncError: undefined };
}

export async function deleteAssetWithRemoteSync(id: string) {
    const assetId = id.trim();
    if (!assetId) throw new Error("素材 ID 不能为空");
    await useAssetStore.getState().removeAsset(assetId);
    await flushAssetStorePersistence();
}

export function deleteCanvasProjectsWithRemoteSync(ids: string[]) {
    return deleteLocalCanvasProjects(ids);
}

/** Legacy save name retained while callers migrate to workspace repositories. */
export async function saveRemoteUserDataNow(_input?: string | readonly string[] | { force?: boolean }) {
    await Promise.all([flushCanvasStorePersistence(), flushAssetStorePersistence()]);
}

export function scheduleRemoteUserDataSync() {
    void saveRemoteUserDataNow().catch((error) => console.error("本地工作区保存失败", error));
}

export async function forceOverwriteRemoteCanvasSync(): Promise<CanvasAssetRebindResult> {
    const result = rebindInconsistentCanvasAssets(useAssetStore.getState().assets);
    await Promise.all([flushCanvasStorePersistence(), flushAssetStorePersistence()]);
    return result;
}
