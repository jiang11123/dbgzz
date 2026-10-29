import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
    assetFolderQueryKey,
    assetLibraryQueryKey,
    assetPickerQueryKey,
    dropStaleAssetViewQueries,
    expectedScopeFromQueryKey,
    keepAssetViewPlaceholder,
    mergeHistoryLibraryAssets,
    runAssetViewAction,
    shouldSuppressAssetViewError,
    subscribeAssetViewScope,
} from "@/components/assets/asset-view-session";
import { getActiveUserScope, getActiveUserScopeEpoch, setActiveUserScope } from "@/lib/user-scope";
import { assertUserScope, captureUserScope, userScopeMatches } from "@/lib/user-scope-guard";

function deferred<T = void>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

function switchScope(userId: string) {
    const previous = getActiveUserScope();
    setActiveUserScope(userId);
    return () => setActiveUserScope(previous);
}

function read(path: string) {
    return readFileSync(resolve(import.meta.dir, path), "utf8");
}

describe("asset view session controller", () => {
    test("query keys carry the captured epoch and delayed reads reuse that identity", async () => {
        const restore = switchScope("owner-a");
        try {
            const entry = captureUserScope();
            const key = assetLibraryQueryKey(entry, "history", 2, "image");
            expect(key[0]).toBe("asset-library");
            expect(key[1]).toBe("owner-a");
            expect(key[2]).toBe(entry.epoch);
            expect(expectedScopeFromQueryKey(key)).toEqual(entry);
            expect(expectedScopeFromQueryKey(assetFolderQueryKey(entry))).toEqual(entry);
            expect(expectedScopeFromQueryKey(assetPickerQueryKey(entry, 1, 40))).toEqual(entry);

            const started = deferred();
            const gate = deferred();
            let capturedAtDispatch: ReturnType<typeof captureUserScope> | undefined;
            const pending = (async () => {
                started.resolve();
                await gate.promise;
                capturedAtDispatch = expectedScopeFromQueryKey(key);
                return capturedAtDispatch;
            })();
            await started.promise;
            setActiveUserScope("owner-b");
            setActiveUserScope("owner-a");
            gate.resolve();
            const dispatched = await pending;
            expect(dispatched).toEqual(entry);
            expect(userScopeMatches(dispatched!)).toBe(false);
            expect(getActiveUserScope()).toBe("owner-a");
            expect(getActiveUserScopeEpoch()).toBeGreaterThan(entry.epoch);
        } finally {
            restore();
        }
    });

    test("placeholder data stays only inside the same epoch", () => {
        const restore = switchScope("owner-a");
        try {
            const entry = captureUserScope();
            const previous = [{ id: "a-private" }];
            const same = keepAssetViewPlaceholder(previous, { queryKey: assetLibraryQueryKey(entry, 1) }, entry);
            expect(same).toBe(previous);
            setActiveUserScope("owner-b");
            const next = captureUserScope();
            expect(keepAssetViewPlaceholder(previous, { queryKey: assetLibraryQueryKey(entry, 1) }, next)).toBeUndefined();
        } finally {
            restore();
        }
    });

    test("history load-more appends, first page replaces, and A→B→A starts empty", () => {
        const page1 = [
            { id: "hist-a", status: "confirmed" },
            { id: "hist-archived", status: "archived" },
        ];
        const page2 = [
            { id: "hist-a", status: "confirmed" },
            { id: "hist-b", status: "confirmed" },
        ];
        const first = mergeHistoryLibraryAssets([], page1, 1);
        expect(first.map((asset) => asset.id)).toEqual(["hist-a"]);
        const more = mergeHistoryLibraryAssets(first, page2, 2);
        expect(more.map((asset) => asset.id)).toEqual(["hist-a", "hist-b"]);
        const replaced = mergeHistoryLibraryAssets(more, page2, 1);
        expect(replaced.map((asset) => asset.id)).toEqual(["hist-a", "hist-b"]);

        const afterRemount = mergeHistoryLibraryAssets([], [{ id: "hist-a2", status: "confirmed" }], 1);
        expect(afterRemount.map((asset) => asset.id)).toEqual(["hist-a2"]);
        expect(afterRemount.some((asset) => asset.id === "hist-b")).toBe(false);
    });

    test("deferred upload after A→B→A does not persist or toast", async () => {
        const restore = switchScope("owner-a");
        const started = deferred();
        const gate = deferred();
        const events: string[] = [];
        try {
            const entry = captureUserScope();
            const pending = runAssetViewAction(entry, async (expected) => {
                started.resolve();
                await gate.promise;
                assertUserScope(expected);
                events.push("persist");
                events.push("toast");
                return "saved";
            });
            await started.promise;
            setActiveUserScope("owner-b");
            setActiveUserScope("owner-a");
            gate.resolve();
            expect(await pending).toBeUndefined();
            expect(events).toEqual([]);
            expect(userScopeMatches(entry)).toBe(false);
        } finally {
            restore();
        }
    });

    test("ordinary delayed network error after A→B→A is swallowed instead of rethrown", async () => {
        const restore = switchScope("owner-a");
        const started = deferred();
        const gate = deferred();
        try {
            const entry = captureUserScope();
            const pending = runAssetViewAction(entry, async () => {
                started.resolve();
                await gate.promise;
                throw new Error("确认失败：网络中断");
            });
            await started.promise;
            setActiveUserScope("owner-b");
            setActiveUserScope("owner-a");
            gate.resolve();
            expect(await pending).toBeUndefined();
            expect(shouldSuppressAssetViewError(new Error("确认失败：网络中断"), entry)).toBe(true);
            expect(userScopeMatches(entry)).toBe(false);
        } finally {
            restore();
        }
    });

    test("ordinary network error still throws while the entry scope is live", async () => {
        const restore = switchScope("owner-a");
        try {
            const entry = captureUserScope();
            await expect(runAssetViewAction(entry, async () => {
                throw new Error("确认失败：网络中断");
            })).rejects.toThrow("确认失败：网络中断");
            expect(shouldSuppressAssetViewError(new Error("确认失败：网络中断"), entry)).toBe(false);
        } finally {
            restore();
        }
    });

    test("generation change drops cached library, folder, and picker queries before the next view", () => {
        const restore = switchScope("owner-a");
        const removed: string[] = [];
        const queryClient = {
            removeQueries: ({ queryKey }: { queryKey: readonly unknown[] }) => {
                removed.push(String(queryKey[0]));
            },
        };
        let notified = 0;
        const unsubscribe = subscribeAssetViewScope(queryClient, () => {
            notified += 1;
        });
        try {
            dropStaleAssetViewQueries(queryClient);
            expect(removed.splice(0)).toEqual(["asset-library", "asset-folders", "asset-picker"]);
            setActiveUserScope("owner-b");
            expect(removed).toEqual(["asset-library", "asset-folders", "asset-picker"]);
            expect(notified).toBe(1);
        } finally {
            unsubscribe();
            restore();
        }
    });
});

describe("asset page and picker wiring", () => {
    test("assets page remounts on generation and binds library reads to the query-key epoch", () => {
        const page = read("../src/pages/assets/index.tsx");
        expect(page).toContain("useAssetViewGeneration(queryClient)");
        expect(page).toContain("key={generation}");
        expect(page).toContain("useState(() => captureUserScope())");
        expect(page).toContain("assetLibraryQueryKey(entryScope");
        expect(page).toContain("assetFolderQueryKey(entryScope)");
        expect(page).toContain("expectedScope: expectedScopeFromQueryKey(queryKey)");
        expect(page).toContain("keepAssetViewPlaceholder(previousData, previousQuery, entryScope)");
        expect(page).toContain("mergeHistoryLibraryAssets(current, next, historyPage)");
        const upload = page.slice(page.indexOf("const saveAsset ="), page.indexOf("const base =", page.indexOf("const saveAsset =")));
        expect(upload).toMatch(/uploadImage\(imageFile, \(loaded, total\) => \{[\s\S]*?\}, scope\)\)/);
        expect(upload).toContain("userScopeMatches(scope)");
        expect(page).toContain("persistWorkspaceAssetChanges(scope)");
        expect(page).toContain("listWorkspaceAssetFolders(expectedScopeFromQueryKey(queryKey))");
        expect(page).toContain("canonicalHasMore");
        expect(page).toContain("generated: true");
        expect(page).toContain("加载更多");
        expect(page).not.toContain("回收站");
        expect(page).toContain('okText="永久删除"');
        expect(page).toContain("runAssetViewAction(entryScope");
        expect(page).toContain("shouldSuppressAssetViewError(error, entryScope)");
        expect(page).toContain("refreshDeletedAssets(scope)");
        expect(page).not.toContain("runAssetViewAction(captureUserScope()");
        expect(page).not.toContain("keepPreviousData");
        expect(page).not.toContain('queryKey: [...ASSET_LIBRARY_QUERY_KEY');

        const readModel = page.slice(page.indexOf("const readModelFile"), page.indexOf("const copyAssetText"));
        expect(readModel).toContain("addAsset({");
        expect(readModel).toContain("await persistWorkspaceAssetChanges(scope)");
        expect(readModel.indexOf("await persistWorkspaceAssetChanges(scope)")).toBeGreaterThan(readModel.indexOf("addAsset({"));
        expect(readModel).toContain("3D 模型已保存");
        expect(readModel).toContain('localSavedRemotePendingMessage("3D 模型已在本地保存"');
    });

    test("picker remounts on generation and does not recapture live identity in queryFn", () => {
        const picker = read("../src/components/assets/asset-library-picker-modal.tsx");
        expect(picker).toContain("useAssetViewGeneration(queryClient)");
        expect(picker).toContain("key={generation}");
        expect(picker).toContain("assetPickerQueryKey(entryScope");
        expect(picker).toContain("expectedScope: expectedScopeFromQueryKey(queryKey)");
        expect(picker).toContain("runAssetViewAction(entryScope");
        expect(picker).toContain("await onConfirm(selectedIds, scope)");
        expect(picker).not.toContain("clearWorkspaceArchivedAssets");
        expect(picker).not.toContain("回收站");
        expect(picker).toContain("onConfirm: (ids: string[], expectedScope: CapturedUserScope)");
        expect(picker).toContain("onUpload: (files: FileList, expectedScope: CapturedUserScope)");
        expect(picker).toContain("await onConfirm(selectedIds, scope)");
        expect(picker).toContain("upload!.onUpload(files, scope)");
        expect(picker).toContain("await onFolderAction(folderId, scope)");
        expect(picker).toContain("shouldSuppressAssetViewError");
        expect(picker).not.toContain('queryKey: ["asset-picker", userId');
        expect(picker).not.toContain("isLocalWorkspaceMode");
    });

    test("direct upload handler retains the page entry scope", () => {
        const page = read("../src/pages/assets/index.tsx");
        const handler = read("../src/services/workspace-asset-upload.ts");
        expect(page).toContain("await uploadWorkspaceAssetFiles(files, folderId, entryScope)");
        expect(handler).toContain("expected: CapturedUserScope");
        expect(handler).not.toContain("useEffect");
        expect(handler).toContain("uploadMediaFile(file, \"video\", undefined, expected)");
        expect(handler).toContain("uploadImage(file, undefined, expected)");
        expect(handler).toContain("persistWorkspaceAssetChanges(expected)");
        expect(handler).toContain("if (!userScopeMatches(expected)) return");
        expect(handler).toContain("isUserScopeAbandonedError(error) || !userScopeMatches(expected)");
    });

    test("picker parents carry expectedScope into async confirm, upload, and insert work", () => {
        const create = read("../src/pages/create/index.tsx");
        expect(create).toContain("const uploadLibraryAssets = async (files: FileList | File[], expectedScope: CapturedUserScope)");
        expect(create).toContain("const handleLibrarySelect = (selectedIds: string[], expectedScope: CapturedUserScope)");
        expect(create).toContain("uploadImage(file, undefined, expectedScope)");
        expect(create).toContain("uploadMediaFile(file, \"create-upload\", undefined, expectedScope)");
        expect(create).toContain("externalAssetSources.uploadExternalFiles(files, folderId, undefined, expectedScope)");

        const canvasPicker = read("../src/components/canvas/asset-picker-modal.tsx");
        expect(canvasPicker).toContain("onInsert: (payloads: InsertAssetPayload[], expectedScope: CapturedUserScope)");
        expect(canvasPicker).toContain("await onInsert(assetPickerItemsToInsertPayloads(ids, items), expectedScope)");

        const projectPicker = read("../src/components/canvas/canvas-project-asset-modal.tsx");
        expect(projectPicker).toContain("getWorkspaceAsset(item.project.id, undefined, { expectedScope })");
        expect(projectPicker).toContain("await onInsertFolder(folderId, expectedScope)");

        const canvasUpload = read("../src/pages/canvas/use-canvas-upload.ts");
        expect(canvasUpload).toContain("uploadImage(payload.dataUrl, undefined, expectedScope)");
        expect(canvasUpload).toContain("expectedScope && !userScopeMatches(expectedScope)");

        const projectAssets = read("../src/pages/projects/detail/assets.tsx");
        expect(projectAssets).toContain("linkProjectAsset(detail.project.id,");
        expect(projectAssets).toContain("undefined, expectedScope");
        expect(projectAssets).toContain("replaceProjectCharacterRepresentations(detail.project.id, imageAsset.id");
        expect(projectAssets).toContain("expectedScope");
        expect(projectAssets).toContain("uploadMediaFile(file, \"character-voice\", undefined, expectedScope)");
        expect(projectAssets).toContain("shouldSuppressAssetViewError(error, variables.expectedScope)");

        const projectSettings = read("../src/pages/projects/detail/settings.tsx");
        expect(projectSettings).toContain("uploadImage(file, undefined, expectedScope)");
        expect(projectSettings).toContain("updateProject(projectId, { coverResourceId }, expectedScope)");
        expect(projectSettings).toContain("shouldSuppressAssetViewError(error, variables.expectedScope)");
    });
});
