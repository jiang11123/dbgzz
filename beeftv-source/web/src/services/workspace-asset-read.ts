import { parseAssetRecord } from "@/lib/asset-record";
import { assertUserScope, captureUserScope, UserScopeAbandonedError, type CapturedUserScope } from "@/lib/user-scope-guard";
import { resourceFileUrl, resourceIdFromStorageKey } from "@/services/api/resources";
import {
    listWorkspaceAssetSummaries,
    listWorkspaceAssetsPage,
    lookupWorkspaceAssetsByIds,
    type WorkspaceAssetPageResponse,
} from "@/services/api/workspace-assets";
import { usesBrowserLocalResourceStore } from "@/services/workspace-resource-storage";
import {
    hydrateAssetStoreDrafts,
    readAssetStoreDrafts,
    runAssetStoreProjection,
    useAssetStore,
    type Asset,
    type AssetStoreDraftRecord,
} from "@/stores/use-asset-store";

type AssetStoreDraftWithSnapshot = AssetStoreDraftRecord & { asset?: Asset };

export const WORKSPACE_ASSET_BATCH_LIMIT = 100;
export const WORKSPACE_ASSET_RECENT_MS = 30 * 24 * 60 * 60 * 1000;
export const WORKSPACE_ASSET_LINKED_PROJECT = "已关联项目";
export const WORKSPACE_ASSET_UNLINKED_PROJECT = "未关联项目";

/**
 * SQLite Library hard-deletes rows and GET /assets plus POST /assets/batch only
 * return surviving owner records. There is no tombstone/import list, so a
 * cache-only id cannot be distinguished from a server deletion.
 */
export const WORKSPACE_ASSET_TOMBSTONE_SEAM =
    "asset.Library 没有墓碑/导入清单：GET /assets 与 POST /assets/batch 只返回仍存在的所属记录。浏览器缓存里多出的 ID 无法区分「从未写入 SQLite」和「服务端已删除」。";

const preservedDraftScopes = new Set<string>();

export type WorkspaceAssetLibraryPageOptions = {
    page: number;
    pageSize: number;
    kind?: string;
    category?: string;
    folderId?: string;
    uncategorized?: boolean;
    status?: string;
    query?: string;
    favorite?: boolean;
    recent?: boolean;
    project?: string;
    generated?: boolean;
    signal?: AbortSignal;
    expectedScope?: CapturedUserScope;
};

export type WorkspaceAssetLibraryPage = {
    assets: Asset[];
    kindCounts: Record<string, number>;
    categoryCounts: Record<string, number>;
    folderCounts: Record<string, number>;
    favoriteTotal: number;
    recentTotal: number;
    projectCounts: Record<string, number>;
    generatedTotal: number;
    generatedKindCounts: Record<string, number>;
    page: number;
    pageSize: number;
    total: number;
    canonicalTotal: number;
    hasMore: boolean;
    canonicalHasMore: boolean;
};

export function usesWorkspaceAssetLibraryApi() {
    return !usesBrowserLocalResourceStore();
}

export function resetWorkspaceAssetReadStateForTests() {
    preservedDraftScopes.clear();
}

export function isUnsavedWorkspaceAsset(asset: Asset) {
    return asset.status === "draft" || asset.metadata?.unsaved === true || asset.metadata?.recoverableLocalDraft === true;
}

export async function loadWorkspaceAssetLibraryPage(options: WorkspaceAssetLibraryPageOptions): Promise<WorkspaceAssetLibraryPage> {
    throwIfAborted(options.signal);
    if (!usesWorkspaceAssetLibraryApi()) return loadBrowserLocalAssetPage(options);

    const expected = options.expectedScope ?? captureUserScope();
    assertUserScope(expected);
    await hydrateAssetStoreDrafts(expected.userScope);
    assertUserScope(expected);
    throwIfAborted(options.signal);

    const remote = await listWorkspaceAssetsPage(
        {
            page: options.page,
            pageSize: options.pageSize,
            kind: options.kind,
            category: options.category,
            folderId: options.folderId,
            uncategorized: options.uncategorized,
            status: options.status,
            query: options.query,
            favorite: options.favorite,
            recent: options.recent,
            project: options.project,
            generated: options.generated,
        },
        { signal: options.signal, expectedScope: expected },
    );
    assertUserScope(expected);
    throwIfAborted(options.signal);

    const parsed = parseWorkspaceAssetPage(remote);
    const overlaid = await overlayAssetDrafts(parsed, options, expected);
    projectCommittedAssets(parsed.assets, expected);
    return overlaid;
}

export async function loadWorkspaceAssetsForUse(ids: Iterable<string>, expectedScope?: CapturedUserScope) {
    const unique = [...new Set([...ids].map((id) => id.trim()).filter(Boolean))];
    if (!unique.length) return;
    if (!usesWorkspaceAssetLibraryApi()) {
        const available = new Set(useAssetStore.getState().assets.map((asset) => asset.id));
        if (unique.some((id) => !available.has(id))) throw new Error("部分本地素材不存在，请重新选择素材");
        return;
    }

    const expected = expectedScope ?? captureUserScope();
    assertUserScope(expected);
    await hydrateAssetStoreDrafts(expected.userScope);
    assertUserScope(expected);
    const drafts = readAssetStoreDrafts(expected);
    const deleted = new Set(drafts.deletes.map((draft) => draft.id));
    const upsertById = new Map(drafts.upserts.map((draft) => [draft.id, draft]));
    const storeById = new Map(useAssetStore.getState().assets.map((asset) => [asset.id, asset]));
    if (unique.some((id) => deleted.has(id))) throw new Error("部分本地素材不存在，请重新选择素材");

    const lookupIds = unique.filter((id) => !upsertById.has(id));
    const found = new Set<string>();
    const snapshots: Asset[] = [];
    for (const id of unique) {
        const draft = upsertById.get(id);
        if (!draft) continue;
        const live = resolveDraftAsset(draft, storeById);
        if (!live) continue;
        found.add(id);
        if (!storeById.has(id)) snapshots.push(live);
    }
    const loaded: Asset[] = [];
    for (const chunk of chunkIds(lookupIds, WORKSPACE_ASSET_BATCH_LIMIT)) {
        const result = await lookupWorkspaceAssetsByIds(chunk, { expectedScope: expected });
        assertUserScope(expected);
        for (const asset of parseWorkspaceAssetPayloads(result.assets)) {
            found.add(asset.id);
            loaded.push(asset);
        }
    }
    projectCommittedAssets(loaded, expected);
    if (snapshots.length) projectDraftSnapshots(snapshots, expected);
    if (unique.some((id) => !found.has(id))) throw new Error("部分本地素材不存在，请重新选择素材");
}

export async function preserveLegacyCacheOnlyAssetDrafts(expectedScope?: CapturedUserScope) {
    const expected = expectedScope ?? captureUserScope();
    assertUserScope(expected);
    if (!usesWorkspaceAssetLibraryApi()) {
        return { preservedIds: [] as string[], tombstoneSeam: WORKSPACE_ASSET_TOMBSTONE_SEAM };
    }
    if (preservedDraftScopes.has(expected.userScope)) {
        return { preservedIds: [] as string[], tombstoneSeam: WORKSPACE_ASSET_TOMBSTONE_SEAM };
    }

    await hydrateAssetStoreDrafts(expected.userScope);
    assertUserScope(expected);
    const summaries = await listWorkspaceAssetSummaries({ expectedScope: expected });
    assertUserScope(expected);
    const committed = new Set((summaries.assets || []).map((item) => item.id).filter(Boolean));
    const drafts = readAssetStoreDrafts(expected);
    const drafted = new Set([...drafts.upserts, ...drafts.deletes].map((draft) => draft.id));
    const preservedIds: string[] = [];
    for (const asset of useAssetStore.getState().assets) {
        if (committed.has(asset.id) || drafted.has(asset.id)) continue;
        useAssetStore.getState().updateAsset(asset.id, {
            status: "draft",
            metadata: { ...(asset.metadata || {}), recoverableLocalDraft: true },
        });
        preservedIds.push(asset.id);
    }
    preservedDraftScopes.add(expected.userScope);
    return { preservedIds, tombstoneSeam: WORKSPACE_ASSET_TOMBSTONE_SEAM };
}

function loadBrowserLocalAssetPage(options: WorkspaceAssetLibraryPageOptions): WorkspaceAssetLibraryPage {
    const query = options.query?.trim().toLowerCase() || "";
    const catalog = useAssetStore.getState().assets;
    const filtered = catalog.filter((asset) => matchesLibraryFilters(asset, options, query));
    const start = Math.max(0, options.page - 1) * options.pageSize;
    const scoped = catalog.filter((asset) => isStatusScopedLibraryAsset(asset, options.status));
    const active = catalog.filter(isActiveLibraryAsset);
    const generated = active.filter(isWorkspaceGeneratedHistoryAsset);
    const total = filtered.length;
    const hasMore = start + options.pageSize < filtered.length;
    return {
        assets: filtered.slice(start, start + options.pageSize),
        kindCounts: countMap(scoped, (asset) => asset.kind),
        categoryCounts: countMap(scoped, (asset) => asset.category || "other"),
        folderCounts: countMap(scoped, (asset) => asset.folderId || ""),
        favoriteTotal: active.filter((asset) => asset.metadata?.favorite === true).length,
        recentTotal: active.filter(isRecentAsset).length,
        projectCounts: countMap(active, workspaceAssetProjectLabel),
        generatedTotal: generated.length,
        generatedKindCounts: countMap(generated, (asset) => asset.kind),
        page: options.page,
        pageSize: options.pageSize,
        total,
        canonicalTotal: total,
        hasMore,
        canonicalHasMore: hasMore,
    };
}

async function overlayAssetDrafts(page: WorkspaceAssetLibraryPage, options: WorkspaceAssetLibraryPageOptions, expected: CapturedUserScope): Promise<WorkspaceAssetLibraryPage> {
    assertUserScope(expected);
    const drafts = readAssetStoreDrafts(expected);
    if (!drafts.upserts.length && !drafts.deletes.length) return page;

    const deleted = new Set(drafts.deletes.map((draft) => draft.id));
    const upsertById = new Map(drafts.upserts.map((draft) => [draft.id, draft]));
    const storeById = new Map(useAssetStore.getState().assets.map((asset) => [asset.id, asset]));
    const query = options.query?.trim().toLowerCase() || "";
    const affectedIds = [...new Set([...drafts.deletes, ...drafts.upserts].map((draft) => draft.id))];
    const canonical = await lookupCanonicalAssets(affectedIds, options, expected);
    assertUserScope(expected);
    throwIfAborted(options.signal);

    const seen = new Set<string>();
    const assets: Asset[] = [];
    for (const asset of page.assets) {
        if (deleted.has(asset.id)) continue;
        const draft = upsertById.get(asset.id);
        if (draft) {
            const live = resolveDraftAsset(draft, storeById) ?? asset;
            if (!matchesLibraryFilters(live, options, query) || seen.has(live.id)) continue;
            seen.add(live.id);
            assets.push(markUnsavedCopy(live));
            continue;
        }
        if (seen.has(asset.id)) continue;
        seen.add(asset.id);
        assets.push(asset);
    }

    if (options.page <= 1) {
        for (const draft of drafts.upserts) {
            if (seen.has(draft.id) || deleted.has(draft.id)) continue;
            const live = resolveDraftAsset(draft, storeById);
            if (!live || !matchesLibraryFilters(live, options, query)) continue;
            const before = canonical.get(draft.id);
            if (before && matchesLibraryFilters(before, options, query)) continue;
            seen.add(draft.id);
            assets.unshift(markUnsavedCopy(live));
        }
    }

    let total = page.total;
    let favoriteTotal = page.favoriteTotal;
    let recentTotal = page.recentTotal;
    let generatedTotal = page.generatedTotal;
    const projectCounts = { ...page.projectCounts };
    const kindCounts = { ...page.kindCounts };
    const categoryCounts = { ...page.categoryCounts };
    const folderCounts = { ...page.folderCounts };
    const generatedKindCounts = { ...page.generatedKindCounts };
    for (const id of affectedIds) {
        const before = canonical.get(id);
        const after = draftAfterState(id, deleted, upsertById, storeById, before);
        total += matchDelta(after, before, (asset) => matchesLibraryFilters(asset, options, query));
        favoriteTotal += matchDelta(after, before, isActiveFavoriteAsset);
        recentTotal += matchDelta(after, before, isActiveRecentAsset);
        generatedTotal += matchDelta(after, before, isActiveGeneratedHistoryAsset);
        applyFacetDelta(kindCounts, facetKindKey(before, options.status), facetKindKey(after, options.status));
        applyFacetDelta(categoryCounts, facetCategoryKey(before, options.status), facetCategoryKey(after, options.status));
        applyFacetDelta(folderCounts, facetFolderKey(before, options.status), facetFolderKey(after, options.status));
        applyFacetDelta(generatedKindCounts, generatedKindKey(before), generatedKindKey(after));
        const beforeLabel = before && isActiveLibraryAsset(before) ? workspaceAssetProjectLabel(before) : undefined;
        const afterLabel = after && isActiveLibraryAsset(after) ? workspaceAssetProjectLabel(after) : undefined;
        if (beforeLabel === afterLabel) continue;
        if (beforeLabel) bumpCount(projectCounts, beforeLabel, -1);
        if (afterLabel) bumpCount(projectCounts, afterLabel, 1);
    }

    return {
        ...page,
        assets,
        kindCounts,
        categoryCounts,
        folderCounts,
        total: Math.max(0, total),
        hasMore: page.hasMore,
        favoriteTotal: Math.max(0, favoriteTotal),
        recentTotal: Math.max(0, recentTotal),
        projectCounts,
        generatedTotal: Math.max(0, generatedTotal),
        generatedKindCounts,
    };
}

function projectCommittedAssets(assets: Asset[], expected: CapturedUserScope) {
    if (!assets.length) return;
    assertUserScope(expected);
    const drafts = readAssetStoreDrafts(expected);
    const skip = new Set([...drafts.upserts, ...drafts.deletes].map((draft) => draft.id));
    runAssetStoreProjection(() => {
        useAssetStore.setState((state) => {
            const next = new Map(state.assets.map((asset) => [asset.id, asset]));
            for (const asset of assets) {
                if (skip.has(asset.id)) continue;
                next.set(asset.id, asset);
            }
            return { assets: [...next.values()] };
        });
    });
}

function projectDraftSnapshots(assets: Asset[], expected: CapturedUserScope) {
    if (!assets.length) return;
    assertUserScope(expected);
    runAssetStoreProjection(() => {
        useAssetStore.setState((state) => {
            const next = new Map(state.assets.map((asset) => [asset.id, asset]));
            for (const asset of assets) {
                if (next.has(asset.id)) continue;
                next.set(asset.id, asset);
            }
            return { assets: [...next.values()] };
        });
    });
}

function parseWorkspaceAssetPage(remote: WorkspaceAssetPageResponse): WorkspaceAssetLibraryPage {
    if (!remote || !Array.isArray(remote.assets)) throw new Error("素材列表无效");
    return {
        assets: parseWorkspaceAssetPayloads(remote.assets),
        kindCounts: numberMap(remote.kindCounts),
        categoryCounts: numberMap(remote.categoryCounts),
        folderCounts: numberMap(remote.folderCounts),
        favoriteTotal: Number(remote.favoriteTotal) || 0,
        recentTotal: Number(remote.recentTotal) || 0,
        projectCounts: numberMap(remote.projectCounts),
        generatedTotal: Number(remote.generatedTotal) || 0,
        generatedKindCounts: numberMap(remote.generatedKindCounts),
        page: Number(remote.page) || 1,
        pageSize: Number(remote.pageSize) || 40,
        total: Number(remote.total) || 0,
        canonicalTotal: Number(remote.total) || 0,
        hasMore: Boolean(remote.hasMore),
        canonicalHasMore: Boolean(remote.hasMore),
    };
}

function parseWorkspaceAssetPayloads(values: unknown): Asset[] {
    if (values == null) return [];
    if (!Array.isArray(values)) throw new Error("素材列表无效");
    const assets: Asset[] = [];
    values.forEach((item, index) => {
        try {
            assets.push(normalizeWorkspaceAssetPayload(item));
        } catch (error) {
            const id = isRecord(item) && typeof item.id === "string" && item.id.trim() ? item.id : `#${index}`;
            console.warn("已隔离无法展示的素材记录", { id, error: error instanceof Error ? error.message : String(error) });
        }
    });
    return assets;
}

export function normalizeWorkspaceAssetPayload(value: unknown): Asset {
    return applyResourceDisplayUrls(parseAssetRecord(value));
}

function applyResourceDisplayUrls(asset: Asset): Asset {
    const storageKey = "data" in asset && asset.data && "storageKey" in asset.data ? asset.data.storageKey : undefined;
    const resourceId = resourceIdFromStorageKey(storageKey);
    if (!resourceId) return asset;
    const url = resourceFileUrl(resourceId);
    const coverUrl = rewriteResourceCoverUrl(asset.coverUrl, resourceId, url);
    if (asset.kind === "video") {
        return { ...asset, coverUrl, data: { ...asset.data, url } };
    }
    if (asset.kind === "audio") {
        return { ...asset, coverUrl, data: { ...asset.data, url } };
    }
    if (asset.kind === "model") {
        return { ...asset, coverUrl, data: { ...asset.data, url } };
    }
    if (asset.kind === "image") {
        return { ...asset, coverUrl, data: { ...asset.data, dataUrl: url } };
    }
    return { ...asset, coverUrl };
}

function rewriteResourceCoverUrl(value: string | undefined, resourceId: string, current: string) {
    if (blobOrEmpty(value) || looksLikeOwnedResourceFileUrl(value, resourceId)) return current;
    return value || current;
}

function looksLikeOwnedResourceFileUrl(value: string | undefined, resourceId: string) {
    if (!value) return false;
    const path = (value.includes("://") ? safeURLPathname(value) : value.split(/[?#]/, 1)[0] || "").replace(/\/+$/, "");
    const match = path.match(/\/(?:api\/)?resources\/([^/]+)\/file$/);
    if (!match) return false;
    try {
        return decodeURIComponent(match[1]) === resourceId;
    } catch {
        return match[1] === resourceId;
    }
}

function safeURLPathname(value: string) {
    try {
        return new URL(value).pathname;
    } catch {
        return value.split(/[?#]/, 1)[0] || "";
    }
}

function resolveDraftAsset(draft: AssetStoreDraftRecord, storeById: Map<string, Asset>) {
    const stored = storeById.get(draft.id);
    if (stored) return stored;
    const snapshot = (draft as AssetStoreDraftWithSnapshot).asset;
    if (!snapshot || snapshot.id !== draft.id) return undefined;
    return applyResourceDisplayUrls(snapshot);
}

async function lookupCanonicalAssets(ids: string[], options: WorkspaceAssetLibraryPageOptions, expected: CapturedUserScope) {
    const found = new Map<string, Asset>();
    for (const chunk of chunkIds(ids, WORKSPACE_ASSET_BATCH_LIMIT)) {
        throwIfAborted(options.signal);
        const result = await lookupWorkspaceAssetsByIds(chunk, { signal: options.signal, expectedScope: expected });
        assertUserScope(expected);
        for (const asset of parseWorkspaceAssetPayloads(result.assets)) found.set(asset.id, asset);
    }
    return found;
}

function draftAfterState(
    id: string,
    deleted: Set<string>,
    upsertById: Map<string, AssetStoreDraftRecord>,
    storeById: Map<string, Asset>,
    before: Asset | undefined,
) {
    if (deleted.has(id)) return undefined;
    const draft = upsertById.get(id);
    if (!draft) return before;
    return resolveDraftAsset(draft, storeById) ?? before;
}

function matchDelta(after: Asset | undefined, before: Asset | undefined, matches: (asset: Asset) => boolean) {
    return Number(Boolean(after && matches(after))) - Number(Boolean(before && matches(before)));
}

function isActiveLibraryAsset(asset: Asset) {
    return asset.kind !== "entity" && asset.status !== "archived";
}

function isActiveFavoriteAsset(asset: Asset) {
    return isActiveLibraryAsset(asset) && asset.metadata?.favorite === true;
}

function isActiveRecentAsset(asset: Asset) {
    return isActiveLibraryAsset(asset) && isRecentAsset(asset);
}

function isActiveGeneratedHistoryAsset(asset: Asset) {
    return isActiveLibraryAsset(asset) && isWorkspaceGeneratedHistoryAsset(asset);
}

function isStatusScopedLibraryAsset(asset: Asset, status?: string) {
    if (asset.kind === "entity") return false;
    if (status === "archived") return asset.status === "archived";
    if (!status || status === "active") return asset.status !== "archived";
    return asset.status === status;
}

function facetKindKey(asset: Asset | undefined, status?: string) {
    return asset && isStatusScopedLibraryAsset(asset, status) ? asset.kind : undefined;
}

function facetCategoryKey(asset: Asset | undefined, status?: string) {
    return asset && isStatusScopedLibraryAsset(asset, status) ? asset.category || "other" : undefined;
}

function facetFolderKey(asset: Asset | undefined, status?: string) {
    return asset && isStatusScopedLibraryAsset(asset, status) ? asset.folderId || "" : undefined;
}

function generatedKindKey(asset: Asset | undefined) {
    return asset && isActiveGeneratedHistoryAsset(asset) ? asset.kind : undefined;
}

function applyFacetDelta(counts: Record<string, number>, beforeKey: string | undefined, afterKey: string | undefined) {
    if (beforeKey === afterKey) return;
    if (beforeKey !== undefined) bumpCount(counts, beforeKey, -1);
    if (afterKey !== undefined) bumpCount(counts, afterKey, 1);
}

function bumpCount(counts: Record<string, number>, key: string, delta: number) {
    const next = (counts[key] || 0) + delta;
    if (next <= 0) delete counts[key];
    else counts[key] = next;
}

function isRecentAsset(asset: Asset) {
    const updated = new Date(asset.updatedAt).getTime();
    return Number.isFinite(updated) && Date.now() - updated <= WORKSPACE_ASSET_RECENT_MS;
}

function matchesLibraryFilters(asset: Asset, options: WorkspaceAssetLibraryPageOptions, query: string) {
    if (asset.kind === "entity") return false;
    if (options.kind && asset.kind !== options.kind) return false;
    if (options.category && (asset.category || "other") !== options.category) return false;
    if (options.status === "archived" && asset.status !== "archived") return false;
    if (options.status === "active" && asset.status === "archived") return false;
    if (options.status && options.status !== "active" && options.status !== "archived" && asset.status !== options.status) return false;
    if (options.uncategorized && asset.folderId) return false;
    if (options.folderId && asset.folderId !== options.folderId) return false;
    if (!matchesExtraClientFilters(asset, options)) return false;
    if (!query) return true;
    return [asset.title, asset.source, ...(asset.tags || [])].join(" ").toLowerCase().includes(query);
}

function matchesExtraClientFilters(asset: Asset, options: WorkspaceAssetLibraryPageOptions) {
    if (options.favorite && asset.metadata?.favorite !== true) return false;
    if (options.recent && !isRecentAsset(asset)) return false;
    if (options.project && workspaceAssetProjectLabel(asset) !== options.project) return false;
    if (options.generated && !isWorkspaceGeneratedHistoryAsset(asset)) return false;
    return true;
}

export function isWorkspaceGeneratedHistoryAsset(asset: Pick<Asset, "kind" | "source" | "metadata">) {
    if (asset.kind !== "image" && asset.kind !== "video" && asset.kind !== "audio") return false;
    return asset.source === "生成任务" || typeof asset.metadata?.generationEffectKey === "string";
}

export function workspaceAssetProjectLabel(asset: Pick<Asset, "metadata">) {
    const projectName = asset.metadata?.projectName;
    if (typeof projectName === "string" && projectName.trim()) return projectName.trim();
    return Array.isArray(asset.metadata?.projectIds) && asset.metadata.projectIds.length ? WORKSPACE_ASSET_LINKED_PROJECT : WORKSPACE_ASSET_UNLINKED_PROJECT;
}

export function workspaceAssetProjectOptions(counts: Record<string, number>) {
    return Object.keys(counts)
        .filter((name) => name !== WORKSPACE_ASSET_UNLINKED_PROJECT && (counts[name] || 0) > 0)
        .sort((left, right) => left.localeCompare(right, "zh-CN"));
}

export function workspaceAssetCountSum(counts: Record<string, number> | undefined) {
    return Object.values(counts || {}).reduce((sum, count) => sum + (Number(count) || 0), 0);
}

export function workspaceAssetAllProjectsCount(counts: Record<string, number>) {
    return workspaceAssetCountSum(counts);
}

export function workspaceAssetTraversalTotal(page: Pick<WorkspaceAssetLibraryPage, "page" | "pageSize" | "canonicalTotal" | "canonicalHasMore">) {
    const total = Math.max(0, page.canonicalTotal);
    if (page.canonicalHasMore || page.page > 1) return total;
    return Math.min(total, Math.max(0, page.pageSize));
}

function markUnsavedCopy(asset: Asset): Asset {
    return { ...asset, metadata: { ...(asset.metadata || {}), unsaved: true } };
}

function countMap(assets: Asset[], keyOf: (asset: Asset) => string | undefined) {
    return assets.reduce<Record<string, number>>((counts, asset) => {
        const key = keyOf(asset) || "";
        counts[key] = (counts[key] || 0) + 1;
        return counts;
    }, {});
}

function numberMap(value: unknown): Record<string, number> {
    if (!value || typeof value !== "object") return {};
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, Number(item) || 0]));
}

function chunkIds(ids: string[], size: number) {
    const chunks: string[][] = [];
    for (let index = 0; index < ids.length; index += size) chunks.push(ids.slice(index, index + size));
    return chunks;
}

function blobOrEmpty(value?: string) {
    return !value || value.startsWith("blob:");
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function throwIfAborted(signal?: AbortSignal) {
    if (signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
}

export { UserScopeAbandonedError };
