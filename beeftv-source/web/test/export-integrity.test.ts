import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { unzipSync } from "fflate";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
import type { Asset } from "@/stores/use-asset-store";
import { getClientDiagnosticSnapshot, recordDiagnosticEvent, setDiagnosticUserScope } from "@/services/diagnostics/client-diagnostics";
import { installLocalForageStoreFactoryForTests } from "@/lib/localforage-storage";

const blobs = new Map<string, Blob>();
const unreadable = new Set<string>();
const blockedReads = new Map<string, Promise<Blob | undefined>>();
const restored = new Map<string, Blob>();
const drawings = new Map<string, { version: 1; drawingId: string; snapshot: object; revision: number; updatedAt: string; shapeCount: number; pageCount: number }>();
const getBlob = async (key: string) => {
    if (blockedReads.has(key)) return blockedReads.get(key);
    if (unreadable.has(key)) throw new Error("fixture disk read error");
    return blobs.get(key);
};
const setBlob = async (key: string, blob: Blob) => { restored.set(key, blob); };
mock.module("@/services/file-storage", () => ({ getMediaBlob: getBlob, setMediaBlob: setBlob }));
mock.module("@/services/image-storage", () => ({ getImageBlob: getBlob, setImageBlob: setBlob }));
mock.module("@/lib/canvas/canvas-drawing-storage", () => ({
    loadCanvasDrawing: async (_projectId: string, drawingId: string) => drawings.get(drawingId) ?? null,
    loadCanvasDrawingPreview: async () => null,
    loadCanvasDrawingRender: async () => null,
}));
mock.module("@/services/workspace-mode", () => ({ isLocalWorkspaceMode: () => true }));

const { exportCanvasProjects, openCanvasArchive } = await import("@/lib/canvas/canvas-export");
const { exportAssets, readAssetPackage } = await import("@/pages/assets/asset-transfer");
const { createZip, readZip } = await import("@/lib/zip");
const { archiveFileExtension, ExportIntegrityError } = await import("@/lib/export-integrity");
const { reportOwnedMediaSave } = await import("@/services/desktop-media-save");
const { http } = await import("@/services/api/request");
const originalWindow = globalThis.window;
const saved: { name: string; data: string }[] = [];
const diagnosticRecords = new Map<string, unknown>();
let acceptSave = true;

beforeEach(() => {
    // This shell fixture has a window but no IndexedDB. Preserve diagnostic
    // writes with an async memory store; swallowing ready()'s missing-driver
    // error would leave localforage repeatedly waiting for an installed method.
    installLocalForageStoreFactoryForTests(storeName => ({
        ready: async () => {},
        getItem: async (key: string) => diagnosticRecords.get(`${storeName}:${key}`) ?? null,
        setItem: async (key: string, value: unknown) => { diagnosticRecords.set(`${storeName}:${key}`, value); return value; },
    }) as LocalForage);
    blobs.clear();
    restored.clear();
    unreadable.clear();
    blockedReads.clear();
    drawings.clear();
    saved.length = 0;
    acceptSave = true;
    Object.assign(globalThis, {
        window: {
            location: { protocol: "wails:" },
            go: { main: { DesktopApp: { SaveOwnedArtifact: async (name: string, data: string) => {
                saved.push({ name, data });
                return acceptSave;
            } } } },
        },
    });
});
afterEach(async () => {
    try { await getClientDiagnosticSnapshot(); }
    finally {
        globalThis.window = originalWindow;
        installLocalForageStoreFactoryForTests();
    }
});

function project(keys: string[]): CanvasProject {
    return {
        id: "canvas-fixture", title: "测试画布", nodes: keys.map((storageKey, index) => ({
            id: `node-${index}`, type: "video", title: `片段 ${index + 1}`,
            video: { storageKey, url: "", width: 320, height: 180 },
        })), edges: [],
    } as unknown as CanvasProject;
}

test("a stalled media read reports progress and cancellation prevents any later archive save", async () => {
    let finishRead!: (blob: Blob) => void;
    blockedReads.set("video:blocked", new Promise<Blob>((resolve) => { finishRead = resolve; }));
    const controller = new AbortController();
    const phases: string[] = [];
    const exporting = exportCanvasProjects([project(["video:blocked"])], "取消测试", { signal: controller.signal, onProgress: (progress) => phases.push(progress.phase) });
    expect(phases).toEqual(["media"]);
    controller.abort();
    await expect(exporting).rejects.toHaveProperty("name", "AbortError");
    finishRead(new Blob(["late video"]));
    await Promise.resolve();
    await Promise.resolve();
    expect(saved).toEqual([]);
    expect(phases).toEqual(["media"]);
});

test("per-file export progress cannot evict a real bind failure", async () => {
    setDiagnosticUserScope("export-retention");
    recordDiagnosticEvent({ category: "task", level: "error", code: "retained-bind-failure", message: "绑定失败" });
    const keys = Array.from({ length: 600 }, (_, index) => `video:retention-${index}`);
    for (const key of keys) blobs.set(key, new Blob(["x"]));
    await exportCanvasProjects([project(keys)]);
    const { events, coverage } = await getClientDiagnosticSnapshot();
    expect(coverage.persisted).toBe(true);
    expect(coverage.writeErrorCount).toBe(0);
    expect([...diagnosticRecords.values()].some(value => String(value).includes("retained-bind-failure"))).toBe(true);
    expect(events.some(event => event.code === "retained-bind-failure")).toBe(true);
    expect(events.filter(event => event.code?.startsWith("canvas_export_")).length).toBeLessThanOrEqual(4);
});

function mediaAsset(key?: string): Asset {
    return {
        id: "asset-fixture", kind: "audio", title: "配音", coverUrl: "", tags: [],
        createdAt: "2026-09-30", updatedAt: "2026-09-30",
        data: { storageKey: key, url: "", bytes: 4, mimeType: "audio/wav" },
    };
}

test("complete canvas archive contains every referenced media byte", async () => {
    blobs.set("video:one", new Blob([new Uint8Array([1, 2, 3])], { type: "video/mp4" }));
    blobs.set("audio:voice", new Blob([new Uint8Array([4, 5])], { type: "audio/wav" }));
    expect(await exportCanvasProjects([project([...blobs.keys()])])).toBe("saved");
    expect(saved).toHaveLength(1);
    const archive = unzipSync(Buffer.from(saved[0].data, "base64"));
    const manifest = JSON.parse(new TextDecoder().decode(archive["projects.json"]));
    expect(manifest.projects[0].files).toHaveLength(2);
    for (const file of manifest.projects[0].files) {
        expect(archive[file.path]).toEqual(new Uint8Array(await blobs.get(file.storageKey)!.arrayBuffer()));
    }
});

test("folder cover export embeds canonical bytes and drops source resource identity", async () => {
    const canvas = { ...project([]), folderId: "folder" };
    const read = spyOn(http, "raw").mockResolvedValue({ data: new Blob(["cover bytes"], { type: "image/jpeg" }) } as never);
    try {
        await exportCanvasProjects([canvas], "备份", { folders: [{ id: "folder", name: "剧集", createdAt: "", updatedAt: "", coverResourceId: "old-cover", coverDataUrl: "http://old-host.invalid/stale" }] });
        const archive = await readZip(new Blob([Buffer.from(saved[0].data, "base64")]));
        const manifest = JSON.parse(await archive.get("projects.json")!.text());
        const folder = manifest.folders[0];
        expect(folder.coverResourceId).toBeUndefined();
        expect(folder.coverDataUrl).toBeUndefined();
        expect(folder.coverMimeType).toBe("image/jpeg");
        expect(await archive.get(folder.coverPath)!.text()).toBe("cover bytes");
        expect(read.mock.calls[0][0]).toMatchObject({ url: "/resources/old-cover/file?proxy=1", expectedScope: expect.any(Object) });
    } finally { read.mockRestore(); }
});

test("missing and empty blobs are all reported before saving an archive", async () => {
    blobs.set("video:empty", new Blob([]));
    const result = exportCanvasProjects([project(["video:missing", "video:empty", "video:missing"])]);
    const error = await result.catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ExportIntegrityError);
    expect((error as InstanceType<typeof ExportIntegrityError>).missingFiles).toEqual([
        { owner: "测试画布", reference: "video:empty" },
        { owner: "测试画布", reference: "video:missing" },
    ]);
    const messages: string[] = [];
    let successes = 0;
    await reportOwnedMediaSave({ error: (text) => messages.push(text), success: () => { successes += 1; } }, result);
    expect(messages[0]).toContain("缺少 2 个文件");
    expect(messages[0]).toContain("video:missing");
    expect(messages[0]).toContain("video:empty");
    expect(successes).toBe(0);
    expect(saved).toHaveLength(0);
});

test("missing drawing document blocks current-canvas backup but can be excluded for history", async () => {
    const canvas = project([]);
    canvas.nodes = [{ id: "drawing", type: "drawing", title: "分镜手稿", metadata: { drawingId: "sketch" } }] as CanvasProject["nodes"];
    await expect(exportCanvasProjects([canvas])).rejects.toThrow("画板 分镜手稿");
    expect(saved).toHaveLength(0);
    expect(await exportCanvasProjects([canvas], "历史", { includeLocalDrawings: false })).toBe("saved");
});

test("asset archive refuses missing files, including a missing media reference", async () => {
    await expect(exportAssets([mediaAsset("audio:missing")])).rejects.toThrow("audio:missing");
    await expect(exportAssets([mediaAsset()])).rejects.toThrow("配音：媒体文件");
    expect(saved).toHaveLength(0);
});

test("complete asset archive retains bytes; save cancellation is not success", async () => {
    blobs.set("audio:voice", new Blob([new Uint8Array([4, 5, 6, 7])], { type: "audio/wav" }));
    acceptSave = false;
    let successes = 0;
    const result = exportAssets([mediaAsset("audio:voice")]);
    expect(await result).toBe("cancelled");
    await reportOwnedMediaSave({ error: () => { throw new Error("unexpected error"); }, success: () => { successes += 1; } }, result);
    expect(successes).toBe(0);
    const archive = unzipSync(Buffer.from(saved[0].data, "base64"));
    const manifest = JSON.parse(new TextDecoder().decode(archive["assets.json"]));
    expect(archive[manifest.files[0].path]).toEqual(new Uint8Array([4, 5, 6, 7]));
});

test("multiple canvases retain nested timeline media and collision-prone names with per-canvas deduplication", async () => {
    const keys = ["video:a/b", "video:a_b", "audio:voice"];
    for (const [index, key] of keys.entries()) blobs.set(key, new Blob([`media-${index}`], { type: "video/mp4" }));
    const first = project([keys[0], keys[0], keys[1]]);
    first.timeline = { version: 2, tracks: [], durationMs: 6000, clips: [{ id: "audio", kind: "audio", nodeId: "voice", trackId: "voice", startMs: 0, durationMs: 6000, directMedia: { id: "voice", kind: "audio", title: "配音", storageKey: keys[2] } }] };
    const second = { ...project([keys[1]]), id: "other-canvas", title: "同名画布" };
    first.title = "同名画布";
    await exportCanvasProjects([first, second]);
    const archive = await readZip(new Blob([Buffer.from(saved[0].data, "base64")]));
    const manifest = JSON.parse(await archive.get("projects.json")!.text());
    expect(manifest.projects.map((item: { files: unknown[] }) => item.files.length)).toEqual([3, 1]);
    const allPaths = manifest.projects.flatMap((item: { files: { path: string }[] }) => item.files.map((file) => file.path));
    expect(new Set(allPaths).size).toBe(4);
    for (const item of manifest.projects) for (const file of item.files) {
        expect(await archive.get(file.path)!.text()).toBe(await blobs.get(file.storageKey)!.text());
    }
    expect(manifest.projects[0].project.timeline.clips[0].directMedia.storageKey).toBe(keys[2]);
    expect(manifest.projects[0].files.map((file: { storageKey: string }) => file.storageKey).sort()).toEqual([...keys].sort());
});

test("a media read rejection is reported alongside other missing references and never saves", async () => {
    unreadable.add("video:disk-error");
    await expect(exportCanvasProjects([project(["video:disk-error", "video:missing"])]))
        .rejects.toThrow("video:disk-error（读取失败）");
    await expect(exportAssets([mediaAsset("video:disk-error")])).rejects.toThrow("读取失败");
    expect(saved).toHaveLength(0);
});

test("asset package imports into empty storage with every byte, and shared media is packaged once", async () => {
    const original = new Blob(["voice fixture"], { type: "audio/wav" });
    blobs.set("audio:voice", original);
    const asset = mediaAsset("audio:voice");
    await exportAssets([asset, { ...asset, id: "second-reference" }]);
    const file = new File([Buffer.from(saved[0].data, "base64")], "assets.zip");
    const archive = await readZip(file);
    const manifest = JSON.parse(await archive.get("assets.json")!.text());
    expect(manifest.files).toHaveLength(1);
    blobs.clear();
    const imported = await readAssetPackage(file);
    expect(imported).toHaveLength(2);
    expect(restored.size).toBe(1);
    expect(await restored.get("audio:voice")!.text()).toBe(await original.text());
    expect(restored.get("audio:voice")!.type).toBe("audio/wav");
});

test("empty workspace and empty asset list still produce honest empty archives", async () => {
    expect(await exportCanvasProjects([])).toBe("saved");
    expect(saved).toHaveLength(1);
    const workspace = unzipSync(Buffer.from(saved[0].data, "base64"));
    expect(JSON.parse(new TextDecoder().decode(workspace["projects.json"])).projects).toEqual([]);
    saved.length = 0;
    expect(await exportAssets([])).toBe("saved");
    expect(saved).toHaveLength(1);
    const assets = JSON.parse(new TextDecoder().decode(unzipSync(Buffer.from(saved[0].data, "base64"))["assets.json"]));
    expect(assets.assets).toEqual([]);
    expect(assets.files).toEqual([]);
});

test("generic JSON is not claimed as glTF; genuine glTF keeps its extension", () => {
    expect(archiveFileExtension("application/json", "bin")).toBe("bin");
    expect(archiveFileExtension("application/json; charset=utf-8", "bin")).toBe("bin");
    expect(archiveFileExtension("model/gltf+json", "bin")).toBe("gltf");
    expect(archiveFileExtension("model/gltf-binary", "bin")).toBe("glb");
    expect(archiveFileExtension("image/png", "bin")).toBe("png");
    expect(archiveFileExtension("audio/mpeg", "wav")).toBe("mp3");
});

test("canvas archive stores generic JSON with the fallback extension", async () => {
    blobs.set("file:notes", new Blob(["{}"], { type: "application/json" }));
    blobs.set("model:hero", new Blob([new Uint8Array([1, 2, 3])], { type: "model/gltf+json" }));
    const canvas = project(["file:notes", "model:hero"]);
    expect(await exportCanvasProjects([canvas])).toBe("saved");
    const archive = unzipSync(Buffer.from(saved[0].data, "base64"));
    const manifest = JSON.parse(new TextDecoder().decode(archive["projects.json"]));
    const paths = manifest.projects[0].files.map((file: { path: string }) => file.path).sort();
    expect(paths.some((path: string) => path.endsWith(".bin"))).toBe(true);
    expect(paths.some((path: string) => path.endsWith(".gltf"))).toBe(true);
    expect(paths.some((path: string) => path.endsWith(".json") && path.includes("files/"))).toBe(false);
});

test("duplicate sanitized drawing names fail instead of overwriting archive entries", async () => {
    drawings.set("a/b", { version: 1, drawingId: "a/b", snapshot: {}, revision: 1, updatedAt: "2026-10-02", shapeCount: 0, pageCount: 1 });
    drawings.set("a_b", { version: 1, drawingId: "a_b", snapshot: {}, revision: 1, updatedAt: "2026-10-02", shapeCount: 0, pageCount: 1 });
    const canvas = project([]);
    canvas.nodes = [
        { id: "one", type: "drawing", title: "稿一", metadata: { drawingId: "a/b" } },
        { id: "two", type: "drawing", title: "稿二", metadata: { drawingId: "a_b" } },
    ] as CanvasProject["nodes"];
    await expect(exportCanvasProjects([canvas])).rejects.toThrow("重名文件");
    expect(saved).toHaveLength(0);
});

test("canvas ZIP opens with all bytes after the source cache is emptied", async () => {
    blobs.set("video:one", new Blob([new Uint8Array([9, 8, 7])], { type: "video/mp4" }));
    blobs.set("audio:voice", new Blob(["voice-bytes"], { type: "audio/wav" }));
    expect(await exportCanvasProjects([project([...blobs.keys()])])).toBe("saved");
    const archiveFile = new File([Buffer.from(saved[0].data, "base64")], "workspace.zip");
    blobs.clear();
    restored.clear();
    const archive = await openCanvasArchive(archiveFile);
    expect(archive.data.projects).toHaveLength(1);
    const files = new Map(archive.data.projects[0].files.map((file) => [file.storageKey, archive.files.get(file.path)!]));
    expect(files.size).toBe(2);
    expect(new Uint8Array(await files.get("video:one")!.arrayBuffer())).toEqual(new Uint8Array([9, 8, 7]));
    expect(await files.get("audio:voice")!.text()).toBe("voice-bytes");
});

test("empty workspace ZIP opens with no media writes", async () => {
    blobs.clear();
    restored.clear();
    expect(await exportCanvasProjects([])).toBe("saved");
    const archiveFile = new File([Buffer.from(saved[0].data, "base64")], "empty.zip");
    blobs.clear();
    restored.clear();
    const archive = await openCanvasArchive(archiveFile);
    expect(archive.data.projects).toEqual([]);
    expect(restored.size).toBe(0);
});

test("missing media and corrupt canvas ZIP fail before writing restored files", async () => {
    restored.clear();
    const missing = await createZip([{
        name: "projects.json",
        data: JSON.stringify({
            app: "infinite-canvas",
            version: 4,
            exportedAt: "2026-10-02T00:00:00.000Z",
            projects: [{ project: { id: "broken", title: "损坏画布", nodes: [] }, files: [{ storageKey: "video:missing", path: "projects/broken/files/missing.mp4", mimeType: "video/mp4", bytes: 3 }] }],
        }),
    }]);
    await expect(openCanvasArchive(new File([missing], "missing.zip"))).rejects.toThrow("missing.mp4");
    expect(restored.size).toBe(0);

    const corrupt = await createZip([{ name: "projects.json", data: "{not-json" }]);
    await expect(openCanvasArchive(new File([corrupt], "corrupt.zip"))).rejects.toThrow("已损坏");
    expect(restored.size).toBe(0);
});

test("malformed asset archive fails before writing partial media; duplicate ZIP entries fail instead of overwriting", async () => {
    const archive = await createZip([{ name: "assets.json", data: JSON.stringify({ assets: [], files: [{ storageKey: "audio:a", path: "a.wav" }, { storageKey: "audio:b", path: "b.wav" }] }) }, { name: "a.wav", data: "A" }]);
    await expect(readAssetPackage(new File([archive], "broken.zip"))).rejects.toThrow("b.wav");
    expect(restored.size).toBe(0);
    await expect(createZip([{ name: "same", data: "A" }, { name: "same", data: "B" }])).rejects.toThrow("重名文件");
});
