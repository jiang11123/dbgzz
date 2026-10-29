import { create } from "zustand";
import { persist, type PersistStorage, type StorageValue } from "zustand/middleware";

import { nanoid } from "nanoid";
import type { AssetCategory } from "@/lib/asset-category";
import { parseAssetRecord } from "@/lib/asset-record";
import { parseAssetStorageDocumentRecovering, rebaseAssetSnapshot, serializeAssetStorageDocument, type AssetStorageDocument } from "@/lib/asset-storage-revision";
import { parseCanvasStorageDocument } from "@/lib/canvas/canvas-storage-revision";
import { localForageStorageForScope } from "@/lib/localforage-storage";
import { getActiveUserScope } from "@/lib/user-scope";
import { assertUserScope, captureUserScope, userScopeMatches, type CapturedUserScope } from "@/lib/user-scope-guard";
import { resourceFileUrl, resourceIdFromStorageKey } from "@/services/api/resources";
import { cleanupUnusedImages, collectImageStorageKeys, resolveImageUrl, uploadImage } from "@/services/image-storage";
import { cleanupUnusedMedia, collectMediaStorageKeys, resolveMediaUrl } from "@/services/file-storage";
import { flushGenerationAssetStorageLocks, insertOrReturnGenerationAsset, withGenerationArtifactCommitLock, withGenerationAssetStorageLock } from "@/services/generation-asset-repository";
import { CANVAS_STORE_KEY, commitPendingCanvasStorePersistenceLocked, pendingCanvasStorePersistence, withCanvasStorePersistenceLock } from "@/stores/canvas/use-canvas-store";
import { readAllCanvasSyncDrafts } from "@/services/canvas-sync-drafts";

export type AssetKind = "text" | "image" | "video" | "audio" | "model" | "entity";
export type { AssetCategory } from "@/lib/asset-category";
export type AssetStatus = "draft" | "review" | "confirmed" | "archived";
export type TextAsset = AssetBase<"text"> & { data: { content: string } };
export type ImageAsset = AssetBase<"image"> & { data: { dataUrl: string; storageKey?: string; width: number; height: number; bytes: number; mimeType: string } };
export type VideoAsset = AssetBase<"video"> & { data: { url: string; storageKey?: string; width: number; height: number; durationMs?: number; hasAudio?: boolean; bytes: number; mimeType: string } };
export type AudioAsset = AssetBase<"audio"> & { data: { url: string; storageKey?: string; durationMs?: number; bytes: number; mimeType: string } };
export type ModelAsset = AssetBase<"model"> & { data: { url: string; storageKey?: string; bytes: number; mimeType: string; fileName: string } };
export type EntityAsset = AssetBase<"entity"> & { data: { definition: Record<string, unknown> } };
export type Asset = TextAsset | ImageAsset | VideoAsset | AudioAsset | ModelAsset | EntityAsset;
export type NewAsset =
    | Omit<TextAsset, "id" | "createdAt" | "updatedAt">
    | Omit<ImageAsset, "id" | "createdAt" | "updatedAt">
    | Omit<VideoAsset, "id" | "createdAt" | "updatedAt">
    | Omit<AudioAsset, "id" | "createdAt" | "updatedAt">
    | Omit<ModelAsset, "id" | "createdAt" | "updatedAt">
    | Omit<EntityAsset, "id" | "createdAt" | "updatedAt">;

type AssetBase<T extends AssetKind> = {
    id: string;
    kind: T;
    title: string;
    coverUrl: string;
    tags: string[];
    folderId?: string;
    category?: AssetCategory;
    status?: AssetStatus;
    primaryVersionId?: string;
    source?: string;
    note?: string;
    arkAssetId?: string;
    portraitCertified?: boolean;
    pendingRemoteUpload?: boolean;
    remoteUploadError?: string;
    createdAt: string;
    updatedAt: string;
    metadata?: Record<string, unknown>;
};

type AssetStore = {
    hydrated: boolean;
    assets: Asset[];
    addAsset: (asset: NewAsset) => string;
    addGenerationAsset: (effectKey: string, asset: NewAsset, signal?: AbortSignal) => Promise<string>;
    updateAsset: (id: string, patch: Partial<Omit<Asset, "id" | "createdAt">>) => void;
    removeAsset: (id: string, options?: { cleanupMedia?: boolean }) => Promise<void>;
    replaceAssets: (assets: Asset[]) => void;
    cleanupImages: (extra?: unknown) => Promise<void>;
};

export const ASSET_STORE_KEY = "infinite-canvas:asset_store";

type PersistedAssetState = Pick<AssetStore, "assets">;
type ObservedAssetPersist = {
    assets: Asset[];
    revision: number;
};

type QueuedAssetPersist = {
    name: string;
    scope: string;
    epoch: number;
    baseAssets: Asset[];
    baseRevision: number;
    assets: Asset[];
    token: number;
};

export type AssetStoreDraftKind = "upsert" | "delete";

export type AssetStoreDraft = {
    kind: AssetStoreDraftKind;
    version: number;
    /** Upsert payload captured at edit time. Delete drafts are tombstones only. */
    asset?: Asset;
};

export type AssetStoreDraftRecord = AssetStoreDraft & { id: string };

type AssetStoreDraftDocument = {
    drafts: Record<string, AssetStoreDraft>;
    clocks: Record<string, number>;
};

export const ASSET_STORE_DRAFTS_KEY = "infinite-canvas:asset_store_drafts";

let suppressAssetStorePersistence = 0;
let suppressAssetStoreDraftTracking = 0;
const assetMemoryStates = new Map<string, PersistedAssetState>();
const observedAssetPersists = new Map<string, ObservedAssetPersist>();
const queuedAssetPersists = new Map<string, QueuedAssetPersist>();
const assetPersistTokens = new Map<string, number>();
const assetOperations = new Map<Promise<unknown>, CapturedUserScope>();
/** Uncommitted commit-intent, keyed by userScope so A→B→A can recover without auto-dispatch. */
const assetStoreDrafts = new Map<string, Map<string, AssetStoreDraft>>();
/** Per-asset high-water version; survives ack so an older ack cannot match a new edit. */
const assetStoreDraftClocks = new Map<string, Map<string, number>>();
const hydratedAssetDraftScopes = new Set<string>();
const hydratingAssetDraftScopes = new Map<string, Promise<void>>();
const assetDraftWriteChains = new Map<string, Promise<unknown>>();
const assetDraftWriteFailures = new Map<string, unknown>();
const generationAssetFailures = new Map<string, unknown>();

function assetPersistNamespace(scope: CapturedUserScope) {
    return `${scope.userScope}\0${scope.epoch}`;
}

function dropAbandonedAssetPersists(live: CapturedUserScope) {
    for (const [key, queued] of [...queuedAssetPersists.entries()]) {
        if (queued.scope === live.userScope && queued.epoch === live.epoch) continue;
        queuedAssetPersists.delete(key);
        assetPersistTokens.delete(key);
    }
}

function cloneAssetSnapshot(asset: Asset): Asset {
    return parseAssetRecord(JSON.parse(JSON.stringify(asset)));
}

function cloneAssetStoreDraft(draft: AssetStoreDraft): AssetStoreDraft {
    return {
        kind: draft.kind,
        version: draft.version,
        ...(draft.kind === "upsert" && draft.asset ? { asset: cloneAssetSnapshot(draft.asset) } : {}),
    };
}

function parsePersistedAssetStoreDraftDocument(raw: string | null): { drafts: Map<string, AssetStoreDraft>; clocks: Map<string, number> } {
    const drafts = new Map<string, AssetStoreDraft>();
    const clocks = new Map<string, number>();
    if (!raw) return { drafts, clocks };
    try {
        const parsed = JSON.parse(raw) as { drafts?: Record<string, { kind?: unknown; version?: unknown; asset?: unknown }>; clocks?: Record<string, unknown> };
        if (!parsed || typeof parsed !== "object") return { drafts, clocks };
        if (parsed.clocks && typeof parsed.clocks === "object") {
            for (const [id, value] of Object.entries(parsed.clocks)) {
                const version = Number(value);
                if (!id || !Number.isInteger(version) || version < 1) continue;
                clocks.set(id, version);
            }
        }
        if (!parsed.drafts || typeof parsed.drafts !== "object") return { drafts, clocks };
        for (const [id, value] of Object.entries(parsed.drafts)) {
            if (!id || (value?.kind !== "upsert" && value?.kind !== "delete")) continue;
            const version = Number(value.version);
            if (!Number.isInteger(version) || version < 1) continue;
            const draft: AssetStoreDraft = { kind: value.kind, version };
            if (value.kind === "upsert" && value.asset !== undefined) {
                try {
                    draft.asset = parseAssetRecord(value.asset);
                } catch {
                    // Keep the upsert intent even if a historical snapshot is unreadable.
                }
            }
            drafts.set(id, draft);
            const clock = clocks.get(id) ?? 0;
            if (version > clock) clocks.set(id, version);
        }
    } catch {
        // Recoverable commit-intent only; a bad cache must not block the asset library.
    }
    return { drafts, clocks };
}

function snapshotAssetStoreDraftDocument(userScope: string): AssetStoreDraftDocument {
    const drafts: Record<string, AssetStoreDraft> = {};
    const source = assetStoreDrafts.get(userScope);
    if (source) {
        for (const [id, draft] of source) drafts[id] = cloneAssetStoreDraft(draft);
    }
    const clocks: Record<string, number> = {};
    const clockSource = assetStoreDraftClocks.get(userScope);
    if (clockSource) {
        for (const [id, version] of clockSource) clocks[id] = version;
    }
    return { drafts, clocks };
}

function serializeAssetStoreDraftDocument(document: AssetStoreDraftDocument) {
    return JSON.stringify(document);
}

function isEmptyAssetStoreDraftDocument(serialized: string) {
    try {
        const parsed = JSON.parse(serialized) as AssetStoreDraftDocument;
        const draftCount = parsed?.drafts && typeof parsed.drafts === "object" ? Object.keys(parsed.drafts).length : 0;
        const clockCount = parsed?.clocks && typeof parsed.clocks === "object" ? Object.keys(parsed.clocks).length : 0;
        return draftCount === 0 && clockCount === 0;
    } catch {
        return true;
    }
}

async function writeSerializedAssetStoreDrafts(userScope: string, serialized: string) {
    const storage = localForageStorageForScope(userScope);
    if (isEmptyAssetStoreDraftDocument(serialized)) {
        await storage.removeItem(ASSET_STORE_DRAFTS_KEY);
        return;
    }
    await storage.setItem(ASSET_STORE_DRAFTS_KEY, serialized);
}

function scheduleAssetStoreDraftPersist(userScope: string, captured = captureUserScope()) {
    const serialized = serializeAssetStoreDraftDocument(snapshotAssetStoreDraftDocument(userScope));
    const previous = assetDraftWriteChains.get(userScope) ?? Promise.resolve();
    const run = previous.then(undefined, () => undefined).then(async () => {
        try {
            await writeSerializedAssetStoreDrafts(userScope, serialized);
            assetDraftWriteFailures.delete(userScope);
        } catch (error) {
            assetDraftWriteFailures.set(userScope, error);
            throw error;
        }
    });
    const tail = run.then(() => undefined, () => undefined);
    assetDraftWriteChains.set(userScope, tail);
    void tail.then(() => {
        if (assetDraftWriteChains.get(userScope) === tail) assetDraftWriteChains.delete(userScope);
    });
    if (captured.userScope === userScope) return trackAssetOperation(run, captured);
    void run.then(undefined, () => undefined);
    return run;
}

function nextAssetStoreDraftVersion(userScope: string, id: string) {
    const clocks = assetStoreDraftClocks.get(userScope) ?? new Map<string, number>();
    const current = Math.max(clocks.get(id) ?? 0, assetStoreDrafts.get(userScope)?.get(id)?.version ?? 0);
    const version = current + 1;
    clocks.set(id, version);
    assetStoreDraftClocks.set(userScope, clocks);
    return version;
}

/**
 * Hydration merge order:
 * 1. Read durable drafts and clocks.
 * 2. In-process memory drafts win every overlapping id. An edit made while
 *    getItem awaited is newer than that durable snapshot, even when the
 *    durable counter is larger.
 * 3. Durable fills ids that memory does not have.
 * 4. clocks[id] = max(durable clocks, durable draft versions, memory clocks,
 *    memory draft versions).
 * 5. If a memory-winning draft is at or below that high-water, bump it to
 *    high-water + 1 so an older ack cannot match the new edit.
 * Upsert snapshots project into effective assets without a backend save.
 * Delete drafts stay tombstones and drop matching effective assets.
 */
function mergeHydratedAssetStoreDrafts(
    durableDrafts: Map<string, AssetStoreDraft>,
    durableClocks: Map<string, number>,
    memoryDrafts: Map<string, AssetStoreDraft>,
    memoryClocks: Map<string, number>,
) {
    const clocks = new Map<string, number>();
    const ids = new Set([...durableDrafts.keys(), ...durableClocks.keys(), ...memoryDrafts.keys(), ...memoryClocks.keys()]);
    for (const id of ids) {
        clocks.set(
            id,
            Math.max(durableClocks.get(id) ?? 0, durableDrafts.get(id)?.version ?? 0, memoryClocks.get(id) ?? 0, memoryDrafts.get(id)?.version ?? 0),
        );
    }

    const merged = new Map<string, AssetStoreDraft>();
    for (const [id, draft] of durableDrafts) merged.set(id, cloneAssetStoreDraft(draft));
    let bumped = false;
    for (const [id, draft] of memoryDrafts) {
        const highWater = clocks.get(id) ?? draft.version;
        if (highWater > draft.version) {
            const version = highWater + 1;
            clocks.set(id, version);
            merged.set(id, { ...cloneAssetStoreDraft(draft), version });
            bumped = true;
        } else {
            merged.set(id, cloneAssetStoreDraft(draft));
        }
    }
    return { merged, clocks, bumped };
}

function applyAssetStoreDraftsToEffectiveAssets(drafts: Map<string, AssetStoreDraft>) {
    withAssetStorePersistenceSuppressed(() => {
        runAssetStoreProjection(() => {
            useAssetStore.setState((state) => {
                const upserts = new Map<string, Asset>();
                const deleted = new Set<string>();
                for (const [id, draft] of drafts) {
                    if (draft.kind === "delete") deleted.add(id);
                    else if (draft.asset) upserts.set(id, cloneAssetSnapshot(draft.asset));
                }
                const next: Asset[] = [];
                const seen = new Set<string>();
                for (const asset of state.assets) {
                    if (deleted.has(asset.id)) continue;
                    next.push(upserts.get(asset.id) ?? asset);
                    seen.add(asset.id);
                }
                for (const [id, asset] of upserts) {
                    if (seen.has(id) || deleted.has(id)) continue;
                    next.unshift(asset);
                }
                return { assets: next };
            });
        });
    });
}

export async function hydrateAssetStoreDrafts(userScope = getActiveUserScope()) {
    if (hydratedAssetDraftScopes.has(userScope)) return;
    const pending = hydratingAssetDraftScopes.get(userScope);
    if (pending) return pending;
    const entryScope = captureUserScope();

    const done = (async () => {
        const durable = parsePersistedAssetStoreDraftDocument(await localForageStorageForScope(userScope).getItem(ASSET_STORE_DRAFTS_KEY));
        const memoryDrafts = assetStoreDrafts.get(userScope) ?? new Map<string, AssetStoreDraft>();
        const memoryClocks = assetStoreDraftClocks.get(userScope) ?? new Map<string, number>();
        const { merged, clocks, bumped } = mergeHydratedAssetStoreDrafts(durable.drafts, durable.clocks, memoryDrafts, memoryClocks);
        if (merged.size) assetStoreDrafts.set(userScope, merged);
        else assetStoreDrafts.delete(userScope);
        if (clocks.size) assetStoreDraftClocks.set(userScope, clocks);
        else assetStoreDraftClocks.delete(userScope);
        hydratedAssetDraftScopes.add(userScope);
        if (entryScope.userScope === userScope && userScopeMatches(entryScope)) applyAssetStoreDraftsToEffectiveAssets(merged);
        if (memoryDrafts.size > 0 || bumped) scheduleAssetStoreDraftPersist(userScope);
    })();

    hydratingAssetDraftScopes.set(userScope, done);
    try {
        await done;
    } finally {
        if (hydratingAssetDraftScopes.get(userScope) === done) hydratingAssetDraftScopes.delete(userScope);
    }
}

function markAssetStoreDraft(id: string, kind: AssetStoreDraftKind, expected?: CapturedUserScope) {
    if (suppressAssetStoreDraftTracking) return;
    const captured = expected ?? captureUserScope();
    if (expected) assertUserScope(expected);
    const userScope = captured.userScope;
    const drafts = assetStoreDrafts.get(userScope) ?? new Map<string, AssetStoreDraft>();
    const version = nextAssetStoreDraftVersion(userScope, id);
    if (kind === "delete") {
        drafts.set(id, { kind, version });
    } else {
        const asset = useAssetStore.getState().assets.find((item) => item.id === id);
        drafts.set(id, { kind, version, ...(asset ? { asset: cloneAssetSnapshot(asset) } : {}) });
    }
    assetStoreDrafts.set(userScope, drafts);
    scheduleAssetStoreDraftPersist(userScope, captured);
}

/** Record an explicit delete intent without waiting for removeAsset. 404 is idempotent. */
export function recordAssetStoreDraft(id: string, kind: AssetStoreDraftKind, expected?: CapturedUserScope) {
    markAssetStoreDraft(id, kind, expected);
}

export function peekAssetStoreDraft(userScope: string, id: string) {
    return assetStoreDrafts.get(userScope)?.get(id);
}

/** Apply a server projection without treating the local patch as a new uncommitted write. */
export function runAssetStoreProjection<T>(operation: () => T): T {
    suppressAssetStoreDraftTracking += 1;
    try {
        return operation();
    } finally {
        suppressAssetStoreDraftTracking -= 1;
    }
}

export function readAssetStoreDrafts(expected: CapturedUserScope) {
    assertUserScope(expected);
    const drafts = assetStoreDrafts.get(expected.userScope) ?? new Map<string, AssetStoreDraft>();
    const upserts: AssetStoreDraftRecord[] = [];
    const deletes: AssetStoreDraftRecord[] = [];
    for (const [id, draft] of drafts) {
        if (draft.kind === "upsert") upserts.push({ id, ...draft });
        else deletes.push({ id, ...draft });
    }
    return { upserts, deletes };
}

/** Ack only the submitted version. A later local edit keeps its draft. Clocks stay. */
export function ackAssetStoreDraft(expected: CapturedUserScope, id: string, version: number) {
    if (!userScopeMatches(expected)) return;
    const drafts = assetStoreDrafts.get(expected.userScope);
    if (!drafts) return;
    const current = drafts.get(id);
    if (!current || current.version !== version) return;
    drafts.delete(id);
    if (drafts.size) assetStoreDrafts.set(expected.userScope, drafts);
    else assetStoreDrafts.delete(expected.userScope);
    scheduleAssetStoreDraftPersist(expected.userScope, expected);
}

export function unloadAssetStoreDraftsForTests() {
    assetStoreDrafts.clear();
    assetStoreDraftClocks.clear();
    hydratedAssetDraftScopes.clear();
    hydratingAssetDraftScopes.clear();
    assetDraftWriteChains.clear();
    assetDraftWriteFailures.clear();
}

export async function resetAssetStoreDraftsForTests() {
    const scopes = new Set([...assetStoreDrafts.keys(), ...assetStoreDraftClocks.keys(), ...hydratedAssetDraftScopes, ...assetDraftWriteChains.keys(), getActiveUserScope()]);
    const pending = [...assetDraftWriteChains.values()];
    await Promise.all(pending);
    unloadAssetStoreDraftsForTests();
    await Promise.all([...scopes].map((scope) => localForageStorageForScope(scope).removeItem(ASSET_STORE_DRAFTS_KEY)));
}

function recordAssetStorageDocument(scope: string, document: AssetStorageDocument) {
    observedAssetPersists.set(scope, {
        assets: document.state.assets,
        revision: document.storageRevision,
    });
}

function withAssetStorePersistenceSuppressed<T>(operation: () => T) {
    suppressAssetStorePersistence += 1;
    try {
        return operation();
    } finally {
        suppressAssetStorePersistence -= 1;
    }
}

async function commitPendingAssetStorePersistenceLocked(scope: string, epoch = captureUserScope().epoch) {
    const expected: CapturedUserScope = { userScope: scope, epoch };
    const namespace = assetPersistNamespace(expected);
    const storage = localForageStorageForScope(scope);
    let committed: AssetStorageDocument | null = null;

    while (true) {
        if (!userScopeMatches(expected)) {
            queuedAssetPersists.delete(namespace);
            return committed;
        }
        const queued = queuedAssetPersists.get(namespace);
        if (!queued) return committed;

        // 读取旧版本时允许隔离历史坏记录；真正写回前，queued.assets 已经由 persistAssetState 严格校验。
        // 这样既不会用伪造默认值掩盖坏数据，也不会让一条旧记录阻断整库的后续写入。
        const recovery = parseAssetStorageDocumentRecovering(await storage.getItem(queued.name), queued.baseAssets);
        if (recovery.invalid.length) {
            console.warn("素材本地缓存包含无法恢复的历史记录，写回时将隔离这些记录", {
                scope,
                invalid: recovery.invalid,
            });
        }
        if (!userScopeMatches(expected)) {
            queuedAssetPersists.delete(namespace);
            return committed;
        }
        const durable = recovery.document;
        const rebased = rebaseAssetSnapshot({
            document: durable,
            baseAssets: queued.baseAssets,
            localAssets: queued.assets,
            baseRevision: queued.baseRevision,
        });
        if (!userScopeMatches(expected)) {
            queuedAssetPersists.delete(namespace);
            return committed;
        }
        await storage.setItem(queued.name, serializeAssetStorageDocument(rebased));
        if (!userScopeMatches(expected)) {
            queuedAssetPersists.delete(namespace);
            return committed;
        }
        committed = rebased;
        recordAssetStorageDocument(scope, rebased);

        const latest = queuedAssetPersists.get(namespace);
        if (!latest || latest.token === queued.token) {
            if (latest?.token === queued.token) queuedAssetPersists.delete(namespace);
            return committed;
        }

        latest.baseAssets = queued.assets;
        latest.baseRevision = rebased.storageRevision;
    }
}

async function writeQueuedAssetPersist(scope: string, epoch: number, _token: number) {
    await withGenerationAssetStorageLock(scope, () => commitPendingAssetStorePersistenceLocked(scope, epoch));
}

async function readPersistedAssetDocumentForScope(scope: string) {
    const recovery = parseAssetStorageDocumentRecovering(await localForageStorageForScope(scope).getItem(ASSET_STORE_KEY));
    if (recovery.invalid.length) {
        console.warn("素材本地缓存包含无法恢复的历史记录，已隔离并保留其诊断信息", {
            scope,
            invalid: recovery.invalid,
        });
    }
    return recovery.document;
}

/**
 * 登记一个素材写操作，供登出、切换账号和页面卸载前统一冲刷。
 *
 * 这里不能直接对 finally 返回的 Promise 放任不管：原操作失败时，finally 派生的
 * Promise 也会拒绝并产生未处理拒绝。用 then 的成功/失败分支做同一个清理动作，
 * 既保留原 Promise 给调用方观察真实错误，也不会制造第二条未处理错误链。
 */
function trackAssetOperation<T>(operation: Promise<T>, captured: CapturedUserScope) {
    assetOperations.set(operation, captured);
    const cleanup = () => assetOperations.delete(operation);
    void operation.then(cleanup, cleanup);
    return operation;
}

function persistAssetState(name: string, value: StorageValue<AssetStore>) {
    const captured = captureUserScope();
    const scope = captured.userScope;
    const namespace = assetPersistNamespace(captured);
    const nextAssets = value.state.assets.map(parseAssetRecord);
    const queued = queuedAssetPersists.get(namespace);
    const observed = observedAssetPersists.get(scope);
    const baseAssets = assetMemoryStates.get(scope)?.assets ?? observed?.assets ?? [];
    assetMemoryStates.set(scope, { assets: nextAssets });
    if (suppressAssetStorePersistence) return;

    const token = (assetPersistTokens.get(namespace) ?? 0) + 1;
    assetPersistTokens.set(namespace, token);
    queuedAssetPersists.set(namespace, {
        name,
        scope,
        epoch: captured.epoch,
        baseAssets: queued?.baseAssets ?? baseAssets,
        baseRevision: queued?.baseRevision ?? observed?.revision ?? 0,
        assets: nextAssets,
        token,
    });
    return trackAssetOperation(writeQueuedAssetPersist(scope, captured.epoch, token), captured);
}

function generationAssetFailureKey(scope: string, effectKey: string) {
    return `${scope}\0${effectKey}`;
}

function trackGenerationAssetOperation<T>(scope: string, effectKey: string, captured: CapturedUserScope, operation: Promise<T>) {
    const failureKey = generationAssetFailureKey(scope, effectKey);
    return trackAssetOperation(
        operation.then(
            (value) => {
                generationAssetFailures.delete(failureKey);
                return value;
            },
            (error) => {
                throw error;
            },
        ),
        captured,
    );
}

function operationsFor(expected: CapturedUserScope) {
    return [...assetOperations.entries()].flatMap(([operation, captured]) => (captured.userScope === expected.userScope && captured.epoch === expected.epoch ? [operation] : []));
}

function generationFailureFor(expected: CapturedUserScope) {
    const prefix = `${expected.userScope}\0`;
    for (const [key, error] of generationAssetFailures) {
        if (key.startsWith(prefix)) return error;
    }
}

export async function flushAssetStorePersistence(expectedScope?: CapturedUserScope) {
    const expected = expectedScope ?? captureUserScope();
    assertUserScope(expected);
    const namespace = assetPersistNamespace(expected);
    dropAbandonedAssetPersists(expected);

    while (true) {
        assertUserScope(expected);
        const scopedOperations = operationsFor(expected);
        if (scopedOperations.length) {
            await Promise.all(scopedOperations);
            continue;
        }

        const queued = queuedAssetPersists.get(namespace);
        if (queued) {
            await writeQueuedAssetPersist(queued.scope, queued.epoch, queued.token);
            continue;
        }

        await flushGenerationAssetStorageLocks();
        if (!operationsFor(expected).length && !queuedAssetPersists.has(namespace)) break;
    }

    const draftWrites = assetDraftWriteChains.get(expected.userScope);
    if (draftWrites) await draftWrites;
    assertUserScope(expected);

    const draftFailure = assetDraftWriteFailures.get(expected.userScope);
    if (draftFailure !== undefined) throw draftFailure;

    const failure = generationFailureFor(expected);
    if (failure !== undefined) throw failure;
}

export function hasActiveAssetStorePersistence() {
    // queuedAssetPersists can retain a failed save for explicit retry. Active
    // operations cover running and lock-waiting writes, including draft IO.
    return assetOperations.size > 0 || assetDraftWriteChains.size > 0;
}

const assetStorage: PersistStorage<AssetStore> = {
    getItem: async (name) => {
        const scope = getActiveUserScope();
        const value = await localForageStorageForScope(scope).getItem(name);
        if (!value) {
            assetMemoryStates.set(scope, { assets: [] });
            observedAssetPersists.set(scope, { assets: [], revision: 0 });
            return null;
        }
        const recovery = parseAssetStorageDocumentRecovering(value);
        if (recovery.invalid.length) {
            console.warn("素材本地缓存包含无法恢复的历史记录，已隔离并保留其诊断信息", {
                scope,
                invalid: recovery.invalid,
            });
        }
        const document = recovery.document;
        // 持久化恢复只恢复结构化记录，不能为每个 resource: key 逐条读取资源元数据或 Blob。
        // 远程资源直接使用受鉴权的 file URL；本地 legacy key 仍恢复为 Blob URL，避免兼容性回归。
        const assets = await Promise.all(document.state.assets.map((asset) => normalizePersistedAsset(asset)));
        const hydratedDocument = { ...document, state: { assets } };
        assetMemoryStates.set(scope, { assets });
        recordAssetStorageDocument(scope, hydratedDocument);
        return hydratedDocument as unknown as StorageValue<AssetStore>;
    },
    setItem: persistAssetState,
    removeItem: (name) => {
        const scope = getActiveUserScope();
        return localForageStorageForScope(scope).removeItem(name);
    },
};

async function normalizePersistedAsset(asset: Asset): Promise<Asset> {
    asset = parseAssetRecord(asset);
    const storageKey = "data" in asset && asset.data && "storageKey" in asset.data ? asset.data.storageKey : undefined;
    const resourceId = resourceIdFromStorageKey(storageKey);
    if (resourceId) {
        const url = resourceFileUrl(resourceId);
        if (asset.kind === "video" || asset.kind === "audio" || asset.kind === "model") return { ...asset, data: { ...asset.data, url } } as Asset;
        if (asset.kind === "image") return { ...asset, coverUrl: asset.coverUrl.startsWith("blob:") ? url : asset.coverUrl, data: { ...asset.data, dataUrl: url } };
    }

    // 非 resource: key 是早期本地存储格式，必须继续从 localForage 恢复，
    // 但只在确有本地 key 时读取，不让远程资源重新走逐条网络查询。
    if (asset.kind === "video" && storageKey) return { ...asset, data: { ...asset.data, url: await resolveMediaUrl(storageKey, asset.data.url) } };
    if (asset.kind === "audio" && storageKey) return { ...asset, data: { ...asset.data, url: await resolveMediaUrl(storageKey, asset.data.url) } };
    if (asset.kind === "model" && storageKey) return { ...asset, data: { ...asset.data, url: await resolveMediaUrl(storageKey, asset.data.url) } };
    if (asset.kind !== "image") return asset;
    if (storageKey) {
        return {
            ...asset,
            coverUrl: asset.coverUrl.startsWith("blob:") ? await resolveImageUrl(storageKey, asset.coverUrl) : asset.coverUrl,
            data: { ...asset.data, dataUrl: await resolveImageUrl(storageKey, asset.data.dataUrl) },
        };
    }
    if (!asset.data.dataUrl.startsWith("data:image/")) return asset;
    const image = await uploadImage(asset.data.dataUrl);
    return { ...asset, coverUrl: asset.coverUrl.startsWith("data:image/") ? image.url : asset.coverUrl, data: { ...asset.data, dataUrl: image.url, storageKey: image.storageKey, bytes: image.bytes, mimeType: image.mimeType } };
}

async function generationAssetId(effectKey: string) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(effectKey));
    return `generation_${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export const useAssetStore = create<AssetStore>()(
    persist(
        (set, get) => ({
            hydrated: false,
            assets: [],
            addAsset: (asset) => {
                const now = new Date().toISOString();
                const id = nanoid();
                set((state) => ({ assets: [parseAssetRecord({ ...asset, id, createdAt: now, updatedAt: now }), ...state.assets] }));
                markAssetStoreDraft(id, "upsert");
                return id;
            },
            addGenerationAsset: (effectKey, asset, signal) => {
                const scope = getActiveUserScope();
                const publicationBase = observedAssetPersists.get(scope) ?? { assets: get().assets, revision: 0 };
                return trackGenerationAssetOperation(
                    scope,
                    effectKey,
                    captureUserScope(),
                    (async () => {
                        const id = await generationAssetId(effectKey);
                        let persistedDocument: AssetStorageDocument | null = null;
                        return insertOrReturnGenerationAsset<Asset>({
                            storageScope: scope,
                            effectKey,
                            assetId: id,
                            createAsset: () => {
                                const now = new Date().toISOString();
                                return parseAssetRecord({
                                    ...asset,
                                    id,
                                    createdAt: now,
                                    updatedAt: now,
                                    metadata: { ...asset.metadata, generationEffectKey: effectKey },
                                });
                            },
                            updateAssets: (updater) => {
                                withAssetStorePersistenceSuppressed(() => {
                                    set((state) => {
                                        if (!persistedDocument) return { assets: updater(state.assets) };
                                        const liveDocument = rebaseAssetSnapshot({
                                            document: persistedDocument,
                                            baseAssets: publicationBase.assets,
                                            localAssets: state.assets,
                                            baseRevision: publicationBase.revision,
                                        });
                                        const generationAssets = updater(persistedDocument.state.assets);
                                        const published = rebaseAssetSnapshot({
                                            document: liveDocument,
                                            baseAssets: persistedDocument.state.assets,
                                            localAssets: generationAssets,
                                            baseRevision: persistedDocument.storageRevision,
                                        });
                                        return { assets: published.state.assets };
                                    });
                                });
                            },
                            readAssets: () => get().assets,
                            readPersistedAssets: async () => {
                                try {
                                    await commitPendingAssetStorePersistenceLocked(scope);
                                    persistedDocument = await readPersistedAssetDocumentForScope(scope);
                                    recordAssetStorageDocument(scope, persistedDocument);
                                    return persistedDocument.state.assets;
                                } catch (error) {
                                    generationAssetFailures.set(generationAssetFailureKey(scope, effectKey), error);
                                    throw error;
                                }
                            },
                            isAssetDeleted: () => Boolean(persistedDocument?.tombstones.assets[id]),
                            requireCrossRealmLock: true,
                            signal,
                            persistAssets: async (assets) => {
                                const durable = persistedDocument ?? (await readPersistedAssetDocumentForScope(scope));
                                const nextDocument: AssetStorageDocument = {
                                    ...durable,
                                    state: { assets },
                                    storageRevision: durable.storageRevision + 1,
                                };
                                try {
                                    await localForageStorageForScope(scope).setItem(ASSET_STORE_KEY, serializeAssetStorageDocument(nextDocument));
                                } catch (error) {
                                    generationAssetFailures.set(generationAssetFailureKey(scope, effectKey), error);
                                    throw error;
                                }
                                persistedDocument = nextDocument;
                                recordAssetStorageDocument(scope, nextDocument);
                            },
                        });
                    })(),
                );
            },
            updateAsset: (id, patch) => {
                set((state) => ({
                    assets: state.assets.map((asset) => (asset.id === id ? parseAssetRecord({ ...asset, ...patch, updatedAt: new Date().toISOString() }) : asset)),
                }));
                markAssetStoreDraft(id, "upsert");
            },
            removeAsset: async (id, options) => {
                let remainingAssets: Asset[] = [];
                let removedAsset: Asset | undefined;
                set((state) => {
                    removedAsset = state.assets.find((asset) => asset.id === id);
                    const assets = state.assets.filter((asset) => asset.id !== id);
                    remainingAssets = assets;
                    return { assets };
                });
                markAssetStoreDraft(id, "delete");
                // 没有本地媒体定位时没有需要由该删除动作回收的 Blob；跳过全库扫描，
                // 避免纯文本/远程资源删除依赖浏览器 IndexedDB 驱动。
                if (options?.cleanupMedia === false) return;
                if (!removedAsset || (!collectImageStorageKeys(removedAsset).size && !collectMediaStorageKeys(removedAsset).size)) return;
                await get().cleanupImages({ assets: remainingAssets });
            },
            replaceAssets: (assets) => set({ assets: assets.map(parseAssetRecord) }),
            cleanupImages: async (extra) => {
                const scope = getActiveUserScope();
                const frozenExtraImageKeys = collectImageStorageKeys(extra);
                const frozenExtraMediaKeys = collectMediaStorageKeys(extra);
                await new Promise<void>((resolve, reject) => {
                    window.setTimeout(() =>
                        withGenerationArtifactCommitLock(scope, async () => {
                            const syncDrafts = await readAllCanvasSyncDrafts(scope);
                            // 固定锁序：artifact -> Canvas（释放）-> Asset，避免跨 store 锁重入。
                            const canvasProjects = await withCanvasStorePersistenceLock(scope, async () => {
                                await commitPendingCanvasStorePersistenceLocked(scope);
                                const durableCanvas = parseCanvasStorageDocument(await localForageStorageForScope(scope).getItem(CANVAS_STORE_KEY));
                                return pendingCanvasStorePersistence(scope)?.projects ?? durableCanvas.state.projects;
                            });
                            await withGenerationAssetStorageLock(scope, async () => {
                                await commitPendingAssetStorePersistenceLocked(scope);
                                const durableAssets = (await readPersistedAssetDocumentForScope(scope)).state.assets;
                                const references = { projects: canvasProjects, assets: durableAssets, syncDrafts };
                                const imageKeys = new Set([...frozenExtraImageKeys, ...collectImageStorageKeys(references)]);
                                const mediaKeys = new Set([...frozenExtraMediaKeys, ...collectMediaStorageKeys(references)]);
                                await cleanupUnusedImages(
                                    [...imageKeys].map((storageKey) => ({ storageKey })),
                                    scope,
                                );
                                await cleanupUnusedMedia(
                                    [...mediaKeys].map((storageKey) => ({ storageKey })),
                                    scope,
                                );
                            });
                        }).then(resolve, reject),
                    );
                });
            },
        }),
        {
            name: ASSET_STORE_KEY,
            storage: assetStorage,
            partialize: (state) => ({ assets: state.assets }) as StorageValue<AssetStore>["state"],
            onRehydrateStorage: () => () => {
                useAssetStore.setState({ hydrated: true });
                void hydrateAssetStoreDrafts();
            },
        },
    ),
);
