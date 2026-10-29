import { linkProjectAsset, moveProjectAsset, updateProjectAssetCategory } from "@/services/api/projects";
import { ApiError } from "@/services/api/request";
import { deleteWorkspaceAssetRecord, putWorkspaceAsset } from "@/services/api/workspace-data";
import { normalizeAssetCategory } from "@/lib/asset-category";
import { assertUserScope, captureUserScope, userScopeMatches, UserScopeAbandonedError, type CapturedUserScope } from "@/lib/user-scope-guard";
import { usesBrowserLocalResourceStore, workspaceAssetHasCanonicalMediaPersist } from "@/services/workspace-resource-storage";
import {
    ackAssetStoreDraft,
    flushAssetStorePersistence,
    hydrateAssetStoreDrafts,
    peekAssetStoreDraft,
    readAssetStoreDrafts,
    recordAssetStoreDraft,
    runAssetStoreProjection,
    useAssetStore,
    type Asset,
    type AssetCategory,
    type AssetStatus,
} from "@/stores/use-asset-store";

export type WorkspaceAssetLinkOptions = {
    asset: Asset;
    domainProjectId?: string;
    category?: AssetCategory;
    folderId?: string;
    source?: "uploaded" | "canvas";
    signal?: AbortSignal;
    expectedScope?: CapturedUserScope;
};

const assetCommitChains = new Map<string, Promise<unknown>>();

export class WorkspaceAssetMediaPendingError extends Error {
    constructor() {
        super("素材文件尚未保存到工作区，修改已保留在本机");
        this.name = "WorkspaceAssetMediaPendingError";
    }
}

function assertAssetWriteReceipt(receipt: AssetWriteReceipt | undefined, id: string): asserts receipt is AssetWriteReceipt {
    if (!receipt || receipt.id !== id) throw new Error("素材保存回执无效，修改已保留在本机");
}

function throwIfAborted(signal?: AbortSignal) {
    if (signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
}

function isNotFoundAssetError(error: unknown) {
    return error instanceof ApiError && (error.status === 404 || error.code === 404);
}

function assetCommitKey(userScope: string, assetId: string) {
    return `${userScope}\0${assetId}`;
}

function enqueueAssetCommit<T>(userScope: string, assetId: string, epoch: number, job: () => Promise<T>): Promise<T> {
    const key = assetCommitKey(userScope, assetId);
    const previous = assetCommitChains.get(key) ?? Promise.resolve();
    const run = previous.then(undefined, () => undefined).then(async () => {
        const live = captureUserScope();
        if (live.userScope !== userScope || live.epoch !== epoch) throw new UserScopeAbandonedError();
        return job();
    });
    assetCommitChains.set(key, run.then(() => undefined, () => undefined));
    return run;
}

export function resetWorkspaceAssetCommitStateForTests() {
    assetCommitChains.clear();
}

function linkedProjectIds(asset: Asset, domainProjectId?: string) {
    const projectIds = Array.isArray(asset.metadata?.projectIds) ? asset.metadata.projectIds.filter((id): id is string => typeof id === "string") : [];
    return domainProjectId ? [...new Set([...projectIds, domainProjectId])] : projectIds;
}

/** Keep later local edits. Only copy receipt fields the user has not changed since submit. */
type AssetWriteReceipt = {
    id?: string;
    title?: string;
    category?: string;
    status?: string;
    folderId?: string;
    primaryVersionId?: string;
    createdAt?: string;
    updatedAt?: string;
};

export function mergeWorkspaceAssetReceipt(submitted: Asset, live: Asset, receipt: AssetWriteReceipt) {
    const patch: Partial<Asset> = {};
    if (live.title === submitted.title && receipt.title && receipt.title !== live.title) patch.title = receipt.title;
    if ((live.category || "other") === (submitted.category || "other") && receipt.category) {
        const category = normalizeAssetCategory(receipt.category);
        if (category !== live.category) patch.category = category;
    }
    if ((live.status || "confirmed") === (submitted.status || "confirmed") && receipt.status && receipt.status !== live.status) {
        patch.status = receipt.status as AssetStatus;
    }
    if ((live.folderId || "") === (submitted.folderId || "") && receipt.folderId !== undefined && (receipt.folderId || "") !== (live.folderId || "")) {
        patch.folderId = receipt.folderId || undefined;
    }
    if ((live.primaryVersionId || "") === (submitted.primaryVersionId || "") && receipt.primaryVersionId && receipt.primaryVersionId !== live.primaryVersionId) {
        patch.primaryVersionId = receipt.primaryVersionId;
    }
    return patch;
}

function projectLinkedMetadata(live: Asset, domainProjectId: string | undefined) {
    if (!domainProjectId) return live.metadata;
    return { ...live.metadata, projectIds: linkedProjectIds(live, domainProjectId) };
}

function applyReceiptProjection(id: string, submitted: Asset, receipt: AssetWriteReceipt, domainProjectId?: string) {
    const live = useAssetStore.getState().assets.find((item) => item.id === id);
    if (!live) return false;
    const patch = mergeWorkspaceAssetReceipt(submitted, live, receipt);
    const metadata = projectLinkedMetadata(live, domainProjectId);
    const metadataChanged = JSON.stringify(metadata ?? null) !== JSON.stringify(live.metadata ?? null);
    if (!Object.keys(patch).length && !metadataChanged) return true;
    runAssetStoreProjection(() => {
        useAssetStore.getState().updateAsset(id, metadataChanged ? { ...patch, metadata } : patch);
    });
    return true;
}

async function commitTrackedAssetDraft(id: string, expected: CapturedUserScope, signal?: AbortSignal) {
    throwIfAborted(signal);
    assertUserScope(expected);
    const draft = peekAssetStoreDraft(expected.userScope, id);
    if (!draft) return;
    const submittedVersion = draft.version;
    if (draft.kind === "delete") {
        try {
            await deleteWorkspaceAssetRecord(id, { signal, expectedScope: expected });
        } catch (error) {
            if (!isNotFoundAssetError(error)) throw error;
        }
        throwIfAborted(signal);
        if (!userScopeMatches(expected)) throw new UserScopeAbandonedError();
        ackAssetStoreDraft(expected, id, submittedVersion);
        const later = peekAssetStoreDraft(expected.userScope, id);
        if (later?.kind === "upsert") return;
        if (useAssetStore.getState().assets.some((item) => item.id === id)) {
            await runAssetStoreProjection(() => useAssetStore.getState().removeAsset(id));
        }
        return;
    }

    const asset = useAssetStore.getState().assets.find((item) => item.id === id) ?? draft.asset;
    if (!asset) return;
    if (!workspaceAssetHasCanonicalMediaPersist(asset)) {
        await flushAssetStorePersistence(expected);
        throw new WorkspaceAssetMediaPendingError();
    }
    const submitted = asset;
    const saved = await putWorkspaceAsset(id, submitted, { signal, expectedScope: expected });
    throwIfAborted(signal);
    if (!userScopeMatches(expected)) throw new UserScopeAbandonedError();
    assertAssetWriteReceipt(saved?.asset, id);
    ackAssetStoreDraft(expected, id, submittedVersion);
    applyReceiptProjection(id, submitted, saved.asset);
}

/** Single boundary for local asset persistence and optional project linking. */
export async function persistWorkspaceAssetLink({ asset, domainProjectId, category, folderId, source, signal, expectedScope }: WorkspaceAssetLinkOptions) {
    const expected = expectedScope ?? captureUserScope();
    throwIfAborted(signal);
    assertUserScope(expected);
    await hydrateAssetStoreDrafts(expected.userScope);
    assertUserScope(expected);
    if (!workspaceAssetHasCanonicalMediaPersist(asset)) {
        await flushAssetStorePersistence(expected);
        throw new WorkspaceAssetMediaPendingError();
    }

    if (usesBrowserLocalResourceStore()) {
        if (domainProjectId) {
            const projectIds = linkedProjectIds(asset, domainProjectId);
            useAssetStore.getState().updateAsset(asset.id, { metadata: { ...asset.metadata, projectIds } });
        }
        const submittedVersion = peekAssetStoreDraft(expected.userScope, asset.id)?.version;
        await flushAssetStorePersistence(expected);
        assertUserScope(expected);
        if (submittedVersion) ackAssetStoreDraft(expected, asset.id, submittedVersion);
        return;
    }

    await enqueueAssetCommit(expected.userScope, asset.id, expected.epoch, async () => {
        throwIfAborted(signal);
        assertUserScope(expected);
        const live = useAssetStore.getState().assets.find((item) => item.id === asset.id) ?? peekAssetStoreDraft(expected.userScope, asset.id)?.asset ?? asset;
        const draft = peekAssetStoreDraft(expected.userScope, live.id);
        const submittedVersion = draft?.version;
        if (draft?.kind === "delete") {
            await commitTrackedAssetDraft(live.id, expected, signal);
            return;
        }
        const submitted = live;
        const saved = await putWorkspaceAsset(live.id, submitted, { signal, expectedScope: expected });
        throwIfAborted(signal);
        if (!userScopeMatches(expected)) throw new UserScopeAbandonedError();
        assertAssetWriteReceipt(saved?.asset, live.id);
        if (submittedVersion) ackAssetStoreDraft(expected, live.id, submittedVersion);
        const afterPut = peekAssetStoreDraft(expected.userScope, live.id);
        if (afterPut?.kind === "delete") {
            await commitTrackedAssetDraft(live.id, expected, signal);
            return;
        }
        if (!useAssetStore.getState().assets.some((item) => item.id === live.id)) return;

        let receipt: AssetWriteReceipt = saved.asset;
        if (domainProjectId) {
            const { asset: linkedAsset } = await linkProjectAsset(
                domainProjectId,
                { assetId: live.id, category: normalizeAssetCategory(category || live.category), folderId, source },
                signal,
                expected,
            );
            throwIfAborted(signal);
            assertUserScope(expected);
            let linked = category && linkedAsset.category !== category ? (await updateProjectAssetCategory(domainProjectId, live.id, category, signal, expected)).asset : linkedAsset;
            throwIfAborted(signal);
            assertUserScope(expected);
            if (folderId !== undefined && (linked.folderId || "") !== folderId) linked = (await moveProjectAsset(domainProjectId, live.id, folderId, signal, expected)).asset;
            throwIfAborted(signal);
            assertUserScope(expected);
            receipt = linked;
        }
        if (peekAssetStoreDraft(expected.userScope, live.id)?.kind === "delete") {
            await commitTrackedAssetDraft(live.id, expected, signal);
            return;
        }
        applyReceiptProjection(live.id, submitted, receipt, domainProjectId);
    });
}

export type DeleteWorkspaceAssetOptions = {
    expectedStatus?: "archived";
    onDraftRecorded?: (version: number) => void;
};

export async function deleteWorkspaceAsset(id: string, expectedScope?: CapturedUserScope, options?: DeleteWorkspaceAssetOptions) {
    const expected = expectedScope ?? captureUserScope();
    const assetId = id.trim();
    if (!assetId) throw new Error("素材 ID 不能为空");
    assertUserScope(expected);
    await hydrateAssetStoreDrafts(expected.userScope);
    assertUserScope(expected);

    if (usesBrowserLocalResourceStore()) {
        if (options?.expectedStatus) {
            const live = useAssetStore.getState().assets.find((item) => item.id === assetId);
            if (live && live.status !== options.expectedStatus) {
                throw new ApiError("素材已不在回收站，未删除", { status: 409, code: 409 });
            }
        }
        await useAssetStore.getState().removeAsset(assetId);
        await flushAssetStorePersistence(expected);
        const draft = peekAssetStoreDraft(expected.userScope, assetId);
        if (draft) ackAssetStoreDraft(expected, assetId, draft.version);
        return;
    }

    recordAssetStoreDraft(assetId, "delete", expected);
    const submittedVersion = peekAssetStoreDraft(expected.userScope, assetId)?.version ?? 0;
    options?.onDraftRecorded?.(submittedVersion);
    await enqueueAssetCommit(expected.userScope, assetId, expected.epoch, async () => {
        assertUserScope(expected);
        const current = peekAssetStoreDraft(expected.userScope, assetId);
        if (current && current.version !== submittedVersion && current.kind === "upsert") return;
        try {
            await deleteWorkspaceAssetRecord(assetId, {
                expectedScope: expected,
                ...(options?.expectedStatus ? { params: { expectedStatus: options.expectedStatus } } : {}),
            });
        } catch (error) {
            if (!isNotFoundAssetError(error)) throw error;
        }
        if (!userScopeMatches(expected)) throw new UserScopeAbandonedError();
        const later = peekAssetStoreDraft(expected.userScope, assetId);
        if (later && later.version !== submittedVersion && later.kind === "upsert") return;
        if (later && later.version === submittedVersion) ackAssetStoreDraft(expected, assetId, submittedVersion);
        if (useAssetStore.getState().assets.some((item) => item.id === assetId)) {
            await runAssetStoreProjection(() => useAssetStore.getState().removeAsset(assetId, { cleanupMedia: false }));
        }
    });
}

export async function persistWorkspaceAssetChanges(expectedScope?: CapturedUserScope) {
    const expected = expectedScope ?? captureUserScope();
    assertUserScope(expected);
    await hydrateAssetStoreDrafts(expected.userScope);
    assertUserScope(expected);
    if (usesBrowserLocalResourceStore()) {
        const snapshot = readAssetStoreDrafts(expected);
        await flushAssetStorePersistence(expected);
        assertUserScope(expected);
        for (const draft of [...snapshot.upserts, ...snapshot.deletes]) ackAssetStoreDraft(expected, draft.id, draft.version);
        return;
    }

    const drafts = readAssetStoreDrafts(expected);
    const ids = [...new Set([...drafts.upserts, ...drafts.deletes].map((draft) => draft.id))];
    await Promise.all(ids.map((id) => enqueueAssetCommit(expected.userScope, id, expected.epoch, () => commitTrackedAssetDraft(id, expected))));
}
