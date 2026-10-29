import { assertUserScope, type CapturedUserScope } from "@/lib/user-scope-guard";
import { uploadMediaFile, type UploadedFile } from "@/services/file-storage";
import { uploadImage, type UploadedImage } from "@/services/image-storage";
import { persistWorkspaceAssetLink, WorkspaceAssetMediaPendingError } from "@/services/workspace-asset-repository";
import { isCanonicalWorkspaceMediaPersistSource } from "@/services/workspace-resource-storage";
import { peekAssetStoreDraft, useAssetStore, type NewAsset } from "@/stores/use-asset-store";

export type DirectorCanvasImageHandoff = {
    assetId?: string;
    persisted?: boolean;
};

export type DirectorLibraryPersistResult = {
    assetId: string;
    created: boolean;
    confirmed: boolean;
};

function throwIfAborted(signal?: AbortSignal) {
    if (signal?.aborted) throw new DOMException("导演台会话已结束", "AbortError");
}

function storageKeyOf(asset: NewAsset) {
    return "storageKey" in asset.data ? asset.data.storageKey : undefined;
}

/** Native/hosted confirm only resource-backed rows; browser-local IndexedDB is the product store. */
export function isDirectorCanonicalPersistSource(input: { storageKey?: string; pendingRemoteUpload?: boolean }) {
    return isCanonicalWorkspaceMediaPersistSource(input);
}

export function findWorkspaceAssetIdByStorageKey(storageKey?: string) {
    const key = storageKey?.trim();
    if (!key) return undefined;
    return useAssetStore.getState().assets.find((asset) => "storageKey" in asset.data && asset.data.storageKey === key)?.id;
}

/**
 * Create an explicit library draft, then commit through the typed workspace
 * asset boundary. Desktop/hosted PUT the owned asset; browser-local still
 * flushes IndexedDB. Blob/IDB-only desktop fallbacks keep the draft and do
 * not claim a save. Skip PUT only with a successful ensure receipt.
 */
export async function persistDirectorLibraryAsset(input: {
    asset: NewAsset;
    expectedScope: CapturedUserScope;
    signal?: AbortSignal;
    existingAssetId?: string;
    existingPersisted?: boolean;
    pendingRemoteUpload?: boolean;
}): Promise<DirectorLibraryPersistResult> {
    const { expectedScope, signal } = input;
    throwIfAborted(signal);
    assertUserScope(expectedScope);

    const canonical = isDirectorCanonicalPersistSource({
        storageKey: storageKeyOf(input.asset),
        pendingRemoteUpload: input.pendingRemoteUpload,
    });

    const existingId = input.existingAssetId?.trim();
    if (existingId) {
        const live = useAssetStore.getState().assets.find((item) => item.id === existingId);
        if (live) {
            if (canonical && input.existingPersisted && !peekAssetStoreDraft(expectedScope.userScope, live.id)) {
                return { assetId: live.id, created: false, confirmed: true };
            }
            let confirmed = canonical;
            try {
                await persistWorkspaceAssetLink({ asset: live, expectedScope, signal, source: "uploaded" });
            } catch (error) {
                if (!(error instanceof WorkspaceAssetMediaPendingError)) throw error;
                confirmed = false;
            }
            throwIfAborted(signal);
            assertUserScope(expectedScope);
            return { assetId: live.id, created: false, confirmed };
        }
    }

    const assetId = useAssetStore.getState().addAsset(input.asset);
    const asset = useAssetStore.getState().assets.find((item) => item.id === assetId);
    if (!asset) throw new Error("素材写入本地失败");
    let confirmed = canonical;
    try {
        await persistWorkspaceAssetLink({ asset, expectedScope, signal, source: "uploaded" });
    } catch (error) {
        if (!(error instanceof WorkspaceAssetMediaPendingError)) throw error;
        confirmed = false;
    }
    throwIfAborted(signal);
    assertUserScope(expectedScope);
    return { assetId, created: true, confirmed };
}

/** Upload with the captured identity, then persist. Do not recapture after the original upload. */
export async function persistDirectorImageUpload(input: {
    source: string | Blob;
    expectedScope: CapturedUserScope;
    signal?: AbortSignal;
    toAsset: (uploaded: UploadedImage) => NewAsset;
    existingAssetId?: string;
    existingPersisted?: boolean;
    onProgress?: (uploadedBytes: number, totalBytes: number) => void;
}): Promise<{ uploaded: UploadedImage; persist: DirectorLibraryPersistResult }> {
    throwIfAborted(input.signal);
    assertUserScope(input.expectedScope);
    const uploaded = await uploadImage(input.source, input.onProgress, input.expectedScope);
    throwIfAborted(input.signal);
    assertUserScope(input.expectedScope);
    const persist = await persistDirectorLibraryAsset({
        asset: input.toAsset(uploaded),
        expectedScope: input.expectedScope,
        signal: input.signal,
        existingAssetId: input.existingAssetId,
        existingPersisted: input.existingPersisted,
        pendingRemoteUpload: uploaded.pendingRemoteUpload,
    });
    return { uploaded, persist };
}

export async function persistDirectorMediaUpload(input: {
    source: Blob;
    prefix: string;
    expectedScope: CapturedUserScope;
    signal?: AbortSignal;
    toAsset: (uploaded: UploadedFile) => NewAsset;
    existingAssetId?: string;
    existingPersisted?: boolean;
    onProgress?: (uploadedBytes: number, totalBytes: number) => void;
}): Promise<{ uploaded: UploadedFile; persist: DirectorLibraryPersistResult }> {
    throwIfAborted(input.signal);
    assertUserScope(input.expectedScope);
    const uploaded = await uploadMediaFile(input.source, input.prefix, input.onProgress, input.expectedScope);
    throwIfAborted(input.signal);
    assertUserScope(input.expectedScope);
    const persist = await persistDirectorLibraryAsset({
        asset: input.toAsset(uploaded),
        expectedScope: input.expectedScope,
        signal: input.signal,
        existingAssetId: input.existingAssetId,
        existingPersisted: input.existingPersisted,
        pendingRemoteUpload: uploaded.pendingRemoteUpload,
    });
    return { uploaded, persist };
}
