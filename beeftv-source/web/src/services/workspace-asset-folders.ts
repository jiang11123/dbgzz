import { assertUserScope, captureUserScope, type CapturedUserScope } from "@/lib/user-scope-guard";
import { localForageStorageForScope } from "@/lib/localforage-storage";
import {
    createAssetFolder,
    deleteAssetFolder,
    listAssetFolders,
    moveAssetsToFolder,
    updateAssetFolder,
    type AssetFolder,
} from "@/services/api/workspace-data";
import { usesBrowserLocalResourceStore } from "@/services/workspace-resource-storage";
import { flushAssetStorePersistence, runAssetStoreProjection, useAssetStore } from "@/stores/use-asset-store";

export const WORKSPACE_ASSET_FOLDERS_KEY = "infinite-canvas:asset-folders";

/** Folder name/hierarchy is a SQLite AssetFolder. Browser-local has no Go library, so IDB remains the product path. */
export function usesWorkspaceAssetFolderApi() {
    return !usesBrowserLocalResourceStore();
}

function parseLocalFolders(raw: string | null): AssetFolder[] {
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw) as unknown;
        if (!Array.isArray(parsed)) return [];
        return parsed.filter((folder): folder is AssetFolder => Boolean(folder && typeof folder === "object" && typeof (folder as AssetFolder).id === "string" && typeof (folder as AssetFolder).name === "string"));
    } catch {
        return [];
    }
}

async function readLocalFolders(userScope: string) {
    return parseLocalFolders(await localForageStorageForScope(userScope).getItem(WORKSPACE_ASSET_FOLDERS_KEY));
}

async function writeLocalFolders(userScope: string, folders: AssetFolder[]) {
    await localForageStorageForScope(userScope).setItem(WORKSPACE_ASSET_FOLDERS_KEY, JSON.stringify(folders));
    return folders;
}

function newLocalFolderId() {
    return `asset-folder-${typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
}

export async function listWorkspaceAssetFolders(expectedScope?: CapturedUserScope) {
    const expected = expectedScope ?? captureUserScope();
    assertUserScope(expected);
    const folders = !usesWorkspaceAssetFolderApi()
        ? await readLocalFolders(expected.userScope)
        : (await listAssetFolders({ expectedScope: expected })).folders;
    assertUserScope(expected);
    return folders;
}

export async function createWorkspaceAssetFolder(name: string, expectedScope?: CapturedUserScope) {
    const expected = expectedScope ?? captureUserScope();
    assertUserScope(expected);
    const trimmed = name.trim();
    if (!trimmed) throw new Error("请输入分类名称");
    if (!usesWorkspaceAssetFolderApi()) {
        const folders = await readLocalFolders(expected.userScope);
        assertUserScope(expected);
        const now = new Date().toISOString();
        const folder: AssetFolder = { id: newLocalFolderId(), name: trimmed, position: folders.length, createdAt: now, updatedAt: now };
        await writeLocalFolders(expected.userScope, [...folders, folder]);
        return folder;
    }
    return (await createAssetFolder(trimmed, { expectedScope: expected })).folder;
}

export async function renameWorkspaceAssetFolder(id: string, name: string, expectedScope?: CapturedUserScope) {
    const expected = expectedScope ?? captureUserScope();
    assertUserScope(expected);
    const folderId = id.trim();
    const trimmed = name.trim();
    if (!folderId) throw new Error("素材分类 ID 不能为空");
    if (!trimmed) throw new Error("请输入分类名称");
    if (!usesWorkspaceAssetFolderApi()) {
        const folders = await readLocalFolders(expected.userScope);
        assertUserScope(expected);
        const now = new Date().toISOString();
        const next = folders.map((folder) => (folder.id === folderId ? { ...folder, name: trimmed, updatedAt: now } : folder));
        await writeLocalFolders(expected.userScope, next);
        return next.find((folder) => folder.id === folderId);
    }
    return (await updateAssetFolder(folderId, trimmed, { expectedScope: expected })).folder;
}

export async function deleteWorkspaceAssetFolder(id: string, expectedScope?: CapturedUserScope) {
    const expected = expectedScope ?? captureUserScope();
    assertUserScope(expected);
    const folderId = id.trim();
    if (!folderId) throw new Error("素材分类 ID 不能为空");
    if (!usesWorkspaceAssetFolderApi()) {
        const folders = await readLocalFolders(expected.userScope);
        assertUserScope(expected);
        await writeLocalFolders(expected.userScope, folders.filter((folder) => folder.id !== folderId));
    } else {
        await deleteAssetFolder(folderId, { expectedScope: expected });
    }
    assertUserScope(expected);
    runAssetStoreProjection(() => {
        const store = useAssetStore.getState();
        for (const asset of store.assets) {
            if (asset.folderId === folderId) store.updateAsset(asset.id, { folderId: undefined });
        }
    });
}

export async function assignWorkspaceAssetsFolder(assetIds: string[], folderId = "", expectedScope?: CapturedUserScope) {
    const expected = expectedScope ?? captureUserScope();
    assertUserScope(expected);
    const ids = assetIds.map((id) => id.trim()).filter(Boolean);
    if (!ids.length) return;
    const nextFolderId = folderId.trim();
    if (usesWorkspaceAssetFolderApi()) {
        await moveAssetsToFolder(ids, nextFolderId, { expectedScope: expected });
        assertUserScope(expected);
        runAssetStoreProjection(() => {
            const store = useAssetStore.getState();
            for (const id of ids) store.updateAsset(id, { folderId: nextFolderId || undefined });
        });
        return;
    }
    const store = useAssetStore.getState();
    for (const id of ids) store.updateAsset(id, { folderId: nextFolderId || undefined });
    await flushAssetStorePersistence(expected);
}
