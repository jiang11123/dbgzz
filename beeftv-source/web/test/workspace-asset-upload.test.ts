import { afterEach, expect, mock, test } from "bun:test";
import { setActiveUserScope } from "@/lib/user-scope";
import { captureUserScope, UserScopeAbandonedError } from "@/lib/user-scope-guard";

const writes: Array<{ title: string; folderId: string }> = [];
let uploads: string[] = [];
let release: () => void;
let gate: Promise<void>;
let persistCount = 0;
let persistError: Error | undefined;
let failedName = "";
function resetGate() { gate = new Promise<void>((resolve) => { release = resolve; }); }
resetGate();
mock.module("@/services/image-storage", () => ({ uploadImage: async () => { throw new Error("unused"); } }));
mock.module("@/services/file-storage", () => ({ uploadMediaFile: async (file: File) => {
    uploads.push(file.name);
    await gate;
    if (file.name === failedName) throw new Error("upload failed");
    return { url: file.name, storageKey: `resource:${file.name}`, bytes: 1, mimeType: "video/mp4" };
} }));
mock.module("@/services/workspace-asset-repository", () => ({ persistWorkspaceAssetChanges: async () => { persistCount++; if (persistError) throw persistError; } }));
mock.module("@/stores/use-asset-store", () => ({ useAssetStore: { getState: () => ({ addAsset: (asset: { title: string; folderId: string }) => writes.push(asset) }) } }));
const { uploadWorkspaceAssetFiles } = await import("@/services/workspace-asset-upload");
const files = (prefix: string, count: number) => Array.from({ length: count }, (_, i) => new File(["x"], `${prefix}${i}.mp4`, { type: "video/mp4" }));
afterEach(() => { writes.length = 0; uploads = []; persistCount = 0; persistError = undefined; failedName = ""; resetGate(); });

test("six-file batch settles exactly once while another picker batch starts", async () => {
    setActiveUserScope("upload-owner");
    const scope = captureUserScope();
    const first = uploadWorkspaceAssetFiles(files("first", 6), "folder-a", scope);
    expect(uploads.length).toBe(4);
    // A new picker submission has its own cursor; neither submission needs a mounted view.
    const second = uploadWorkspaceAssetFiles(files("second", 2), "folder-b", scope);
    release();
    expect(await first).toMatchObject({ completed: 6, failed: 0 });
    expect(await second).toMatchObject({ completed: 2, failed: 0 });
    expect(writes.length).toBe(8);
    expect(new Set(writes.map((asset) => asset.title)).size).toBe(8);
    expect(writes.filter((asset) => asset.folderId === "folder-a").length).toBe(6);
    expect(persistCount).toBe(2);
});

test("A to B to A abandons in-flight completion and queued files", async () => {
    setActiveUserScope("upload-a");
    const pending = uploadWorkspaceAssetFiles(files("old", 6), "", captureUserScope());
    setActiveUserScope("upload-b");
    setActiveUserScope("upload-a");
    release();
    await expect(pending).rejects.toBeInstanceOf(UserScopeAbandonedError);
    expect(uploads.length).toBe(4);
    expect(writes.length).toBe(0);
    expect(persistCount).toBe(0);
});

test("one upload failure does not discard the remaining queue or successful settlement", async () => {
    setActiveUserScope("upload-partial");
    failedName = "partial0.mp4";
    const pending = uploadWorkspaceAssetFiles(files("partial", 6), "", captureUserScope());
    release();
    expect(await pending).toMatchObject({ completed: 5, failed: 1 });
    expect(writes.length).toBe(5);
    expect(persistCount).toBe(1);
});

test("persistence failure is reported separately from completed uploads", async () => {
    setActiveUserScope("upload-persist");
    persistError = new Error("disk unavailable");
    const pending = uploadWorkspaceAssetFiles(files("saved", 1), "", captureUserScope());
    release();
    expect(await pending).toEqual({ completed: 1, failed: 0, persistenceError: persistError });
});
