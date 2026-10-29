import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { ownedResourceIdFromMediaRef } from "@/services/api/resources";
import { apiClient, configureApiRuntime } from "@/services/api/request";
import { downloadOwnedOrBrowserMedia, isWailsNativeShell, reportOwnedMediaSave, saveOwnedNativeArchiveFiles, saveOwnedOrBrowserBlob, saveOwnedOrBrowserVideoBlob } from "@/services/desktop-media-save";
import { sanitizeDownloadFileName } from "@/lib/canvas/canvas-media-download";
import { getActiveUserScope, setActiveUserScope } from "@/lib/user-scope";
import { captureUserScope, UserScopeAbandonedError } from "@/lib/user-scope-guard";

const originalWindow = globalThis.window;
const originalFetch = globalThis.fetch;
const originalAdapter = apiClient.defaults.adapter;
const originalScope = getActiveUserScope();

afterEach(() => {
    globalThis.window = originalWindow;
    globalThis.fetch = originalFetch;
    apiClient.defaults.adapter = originalAdapter;
    setActiveUserScope(originalScope);
    configureApiRuntime("/api", "");
});

describe("native media save", () => {
    test("extracts owned resource IDs and rejects arbitrary remote URLs", () => {
        configureApiRuntime("http://127.0.0.1:43123/api", "token");
        expect(ownedResourceIdFromMediaRef("resource:abc123")).toBe("abc123");
        expect(ownedResourceIdFromMediaRef(undefined, "http://127.0.0.1:43123/api/resources/abc123/file")).toBe("abc123");
        expect(ownedResourceIdFromMediaRef(undefined, "/api/resources/abc123/file")).toBe("abc123");
        expect(ownedResourceIdFromMediaRef(undefined, "https://cdn.example.com/api/resources/abc123/file")).toBe("");
        expect(ownedResourceIdFromMediaRef(undefined, "data:video/mp4;base64,AAAA")).toBe("");
        expect(ownedResourceIdFromMediaRef(undefined, "blob:http://127.0.0.1:3000/abc")).toBe("");
    });

    test("sanitizes download file names", () => {
        expect(sanitizeDownloadFileName("../evil:name?.mp4")).toBe("evil_name.mp4");
        expect(sanitizeDownloadFileName("镜头 01.MP4")).toBe("镜头 01.mp4");
    });

    test("native shell uses the Wails save binding and treats empty path as cancel", async () => {
        const calls: Array<[string, string]> = [];
        Object.assign(globalThis, {
            window: {
                location: { protocol: "wails:" },
                go: {
                    main: {
                        DesktopApp: {
                            SaveOwnedMedia: async (fileName: string, resourceID: string) => {
                                calls.push([fileName, resourceID]);
                                return false;
                            },
                        },
                    },
                },
            },
        });
        expect(isWailsNativeShell()).toBe(true);
        expect(await downloadOwnedOrBrowserMedia({ fileName: "clip.mp4", resourceId: "abc123", browserUrl: "https://example.com/secret.mp4" })).toBe("cancelled");
        expect(calls).toEqual([["clip.mp4", "abc123"]]);
    });

    test("native shell does not fetch remote URLs when a resource id is missing", async () => {
        let fetched = false;
        globalThis.fetch = (async () => {
            fetched = true;
            return new Response("nope");
        }) as typeof fetch;
        Object.assign(globalThis, {
            window: {
                location: { protocol: "wails:" },
                go: { main: { DesktopApp: { SaveOwnedMedia: async () => true } } },
            },
        });
        await expect(downloadOwnedOrBrowserMedia({ fileName: "clip.mp4", browserUrl: "https://example.com/video.mp4" })).rejects.toThrow("没有可导出的本机文件");
        expect(fetched).toBe(false);
    });

    test("browser path keeps saveAs and does not require a Wails binding", () => {
        Object.assign(globalThis, { window: { location: { protocol: "http:" } } });
        expect(isWailsNativeShell()).toBe(false);
        const nodeEditor = readFileSync(resolve(import.meta.dir, "../src/pages/canvas/use-canvas-node-editor.ts"), "utf8");
        const assets = readFileSync(resolve(import.meta.dir, "../src/pages/assets/index.tsx"), "utf8");
        const projectAssets = readFileSync(resolve(import.meta.dir, "../src/pages/projects/detail/assets.tsx"), "utf8");
        expect(nodeEditor).toContain("downloadOwnedOrBrowserMedia");
        expect(nodeEditor).not.toContain("saveAs(");
        expect(assets).toContain("downloadOwnedOrBrowserMedia");
        expect(projectAssets).toContain("downloadOwnedOrBrowserMedia");
        const runtime = readFileSync(resolve(import.meta.dir, "../src/services/desktop-runtime.ts"), "utf8");
        expect(runtime).toContain("SaveOwnedMedia");
        expect(runtime).toContain("SaveOwnedArtifact");
        const helper = readFileSync(resolve(import.meta.dir, "../src/services/desktop-media-save.ts"), "utf8");
        expect(helper).toContain("saveAs(browserUrl, fileName)");
        expect(helper).toContain("SaveOwnedArtifact");
        expect(helper).toContain("bytesToBase64");
        expect(helper).not.toContain("Array.from(bytes)");
        expect(helper).toContain("32 * 1024 * 1024");
        expect(readFileSync(resolve(import.meta.dir, "../src/lib/canvas/canvas-export.ts"), "utf8")).toContain("saveOwnedNativeArchiveFiles");
        expect(readFileSync(resolve(import.meta.dir, "../src/pages/assets/asset-transfer.ts"), "utf8")).toContain("saveOwnedOrBrowserBlob");
        const timeline = readFileSync(resolve(import.meta.dir, "../src/components/canvas/canvas-timeline-dialog.tsx"), "utf8");
        expect(timeline).toContain("saveOwnedOrBrowserVideoBlob");
        const handleExport = timeline.slice(timeline.indexOf("const handleExport ="), timeline.indexOf("const handleCreateAssembledNode ="));
        expect(handleExport.indexOf("captureUserScope()")).toBeLessThan(handleExport.indexOf("await runExport()"));
        expect(handleExport.indexOf("setFinalizingExport(true)")).toBeLessThan(handleExport.indexOf("await saveOwnedOrBrowserVideoBlob"));
        expect(handleExport).toContain('if (saved === "saved") message.success');
        expect(timeline).toContain("disabled={finalizingExport}");
        const saveGo = readFileSync(resolve(import.meta.dir, "../../backend/internal/bootstrap/owned_media_save.go"), "utf8");
        expect(saveGo).toContain("os.Rename(tmpPath, dest)");
        expect(saveGo).not.toContain(".beeftv-old");
        expect(saveGo).toContain("32 << 20");
    });

    test("native ZIP artifacts use the bounded Wails save binding", async () => {
        const calls: Array<[string, string]> = [];
        Object.assign(globalThis, {
            window: {
                location: { protocol: "wails:" },
                go: {
                    main: {
                        DesktopApp: {
                            SaveOwnedArtifact: async (fileName: string, data: string) => {
                                calls.push([fileName, data]);
                                return true;
                            },
                        },
                    },
                },
            },
        });
        const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "application/zip" });
        expect(await saveOwnedOrBrowserBlob("画布.zip", blob)).toBe("saved");
        expect(calls[0]?.[0]).toBe("画布.zip");
        expect(calls[0]?.[1]).toBe("AQID");
    });

    test("subtitle export saves UTF-8 SRT through the native artifact binding and reports cancel/error correctly", async () => {
        const subtitle = readFileSync(resolve(import.meta.dir, "../src/components/canvas/canvas-subtitle-dialog.tsx"), "utf8");
        const exportSrt = subtitle.slice(subtitle.indexOf("const exportSrt ="), subtitle.indexOf("const runAiHighlight ="));
        expect(exportSrt).toContain("reportOwnedMediaSave(message, saveOwnedOrBrowserBlob(");
        expect(exportSrt).not.toContain("saveAs(");
        const content = "1\n00:00:00,000 --> 00:00:01,500\n你好，字幕。\n";
        const calls: Array<[string, string]> = [];
        let outcome: boolean | Error = true;
        Object.assign(globalThis, { window: { location: { protocol: "wails:" }, go: { main: { DesktopApp: {
            SaveOwnedArtifact: async (name: string, data: string) => {
                calls.push([name, data]);
                if (outcome instanceof Error) throw outcome;
                return outcome;
            },
        } } } } });
        const messages: string[] = [];
        const message = { success: (text: string) => messages.push(text), error: (text: string) => messages.push(text) };
        const save = () => reportOwnedMediaSave(message, saveOwnedOrBrowserBlob("片段.srt", new Blob([content], { type: "text/plain;charset=utf-8" })));
        await save();
        expect(calls[0]?.[0]).toBe("片段.srt");
        expect(Buffer.from(calls[0]![1], "base64").toString("utf8")).toBe(content);
        expect(messages).toEqual(["已保存到所选位置"]);
        messages.length = 0;
        outcome = false;
        await save();
        expect(messages).toEqual([]);
        outcome = new Error("磁盘空间不足");
        await save();
        expect(messages).toEqual(["磁盘空间不足"]);
    });
});

function nativeVideoSave(save: (name: string, id: string) => Promise<boolean> = async () => true) {
    setActiveUserScope("native-video-export-owner");
    Object.assign(globalThis, { window: {
        location: { protocol: "wails:" },
        go: { main: { DesktopApp: {
            SaveOwnedMedia: save,
            SaveOwnedArtifact: async () => { throw new Error("video must not cross the artifact bridge"); },
        } } },
    } });
    return captureUserScope();
}

describe("native video export resource save", () => {
    test("large archive passes only owned references and small metadata, without uploading a backup", async () => {
        const expected = nativeVideoSave();
        const blob = new Blob([new Uint8Array(33 * 1024 * 1024)], { type: "application/zip" });
        apiClient.defaults.adapter = async () => { throw new Error("archive must not be uploaded"); };
        window.go!.main!.DesktopApp!.SaveOwnedArchive = async (name, entries) => {
            expect(name).toBe("画布.zip");
            expect(entries).toEqual([{ name: "projects.json", data: Buffer.from('{"projects":[]}').toString("base64") }, { name: "media/video.mp4", resourceId: "owned-video" }]);
            return false;
        };
        expect(await saveOwnedNativeArchiveFiles("画布.zip", [{ name: "projects.json", data: '{"projects":[]}' }, { name: "media/video.mp4", data: blob, resourceId: "owned-video" }], expected)).toBe("cancelled");
    });
    test("33 MiB uploads real multipart Blob and saves the returned owned resource", async () => {
        const saved: Array<[string, string]> = [];
        const expected = nativeVideoSave(async (name, id) => { saved.push([name, id]); return true; });
        const blob = new Blob([new Uint8Array(33 * 1024 * 1024)], { type: "video/mp4" });
        const requests: string[] = [];
        apiClient.defaults.adapter = async (config) => {
            requests.push(config.url!);
            expect(config.url).toBe("/resources");
            expect(config.data).toBeInstanceOf(FormData);
            expect(config.data.get("kind")).toBe("video");
            const file = config.data.get("file") as File;
            expect(file.size).toBe(blob.size);
            expect(file.type).toBe("video/mp4");
            expect(file.name).toBe("clip_name.mp4");
            expect(config.headers.get("X-Idempotency-Key")).toMatch(/^video-export:/);
            return { data: { code: 0, data: { resource: { id: "owned-33", status: "ready" } } }, status: 200, statusText: "OK", headers: {}, config };
        };
        expect(await saveOwnedOrBrowserVideoBlob("../clip:name.mp4", blob, expected)).toBe("saved");
        expect(requests).toEqual(["/resources"]);
        expect(saved).toEqual([["clip_name.mp4", "owned-33"]]);
    });

    test("51 MiB uploads all binary chunks and completes before opening native save", async () => {
        const events: string[] = [];
        const expected = nativeVideoSave(async (_name, id) => { events.push("save:" + id); return true; });
        const blob = new Blob([new Uint8Array(51 * 1024 * 1024)], { type: "video/mp4" });
        const sizes: number[] = [];
        const chunkSize = 8 * 1024 * 1024;
        apiClient.defaults.adapter = async (config) => {
            events.push(config.url!);
            let data: object;
            if (config.url === "/resources/uploads") {
                expect(JSON.parse(config.data)).toMatchObject({ fileName: "long.mp4", kind: "video", size: blob.size });
                data = { uploadId: "export-session", chunkSize, chunkCount: 7 };
            } else if (config.url?.includes("/chunks/")) {
                expect(config.data).toBeInstanceOf(Blob);
                expect(config.headers.get("Content-Type")).toBe("application/octet-stream");
                sizes.push(config.data.size);
                data = { index: sizes.length - 1 };
            } else {
                expect(config.url).toBe("/resources/uploads/export-session/complete");
                expect(sizes.reduce((sum, n) => sum + n, 0)).toBe(blob.size);
                data = { resource: { id: "owned-51", status: "ready" } };
            }
            return { data: { code: 0, data }, status: 200, statusText: "OK", headers: {}, config };
        };
        expect(await saveOwnedOrBrowserVideoBlob("long.mp4", blob, expected)).toBe("saved");
        expect(sizes).toEqual([...Array(6).fill(chunkSize), 3 * 1024 * 1024]);
        expect(events).toEqual(["/resources/uploads", ...Array.from({ length: 7 }, (_, i) => `/resources/uploads/export-session/chunks/${i}`), "/resources/uploads/export-session/complete", "save:owned-51"]);
    });

    test("native save cancellation stays silent", async () => {
        const expected = nativeVideoSave(async () => false);
        apiClient.defaults.adapter = async (config) => ({ data: { code: 0, data: { resource: { id: "cancelled-video" } } }, status: 200, statusText: "OK", headers: {}, config });
        const messages: string[] = [];
        const result = saveOwnedOrBrowserVideoBlob("clip.mp4", new Blob(["video"]), expected);
        expect(await result).toBe("cancelled");
        await reportOwnedMediaSave({ success: (text) => messages.push(text), error: (text) => messages.push(text) }, result);
        expect(messages).toEqual([]);
    });

    test("upload failure does not open native save", async () => {
        let saves = 0;
        const expected = nativeVideoSave(async () => { saves++; return true; });
        apiClient.defaults.adapter = async () => { throw new Error("local disk full"); };
        await expect(saveOwnedOrBrowserVideoBlob("clip.mp4", new Blob(["video"]), expected)).rejects.toThrow("local disk full");
        expect(saves).toBe(0);
    });

    test("native write failure propagates instead of reporting saved", async () => {
        const expected = nativeVideoSave(async () => { throw new Error("cannot write selected path"); });
        apiClient.defaults.adapter = async (config) => ({ data: { code: 0, data: { resource: { id: "write-error-video" } } }, status: 200, statusText: "OK", headers: {}, config });
        await expect(saveOwnedOrBrowserVideoBlob("clip.mp4", new Blob(["video"]), expected)).rejects.toThrow("cannot write selected path");
    });

    test("scope changes while rendering prevent upload and save", async () => {
        const expected = nativeVideoSave();
        setActiveUserScope("different-owner");
        let requests = 0;
        apiClient.defaults.adapter = async () => { requests++; throw new Error("unexpected upload"); };
        await expect(saveOwnedOrBrowserVideoBlob("clip.mp4", new Blob(["video"]), expected)).rejects.toBeInstanceOf(UserScopeAbandonedError);
        expect(requests).toBe(0);
    });

    test("scope changes during upload prevent native save", async () => {
        let saves = 0;
        const expected = nativeVideoSave(async () => { saves++; return true; });
        apiClient.defaults.adapter = async (config) => {
            setActiveUserScope("different-owner");
            return { data: { code: 0, data: { resource: { id: "old-owner-video" } } }, status: 200, statusText: "OK", headers: {}, config };
        };
        await expect(saveOwnedOrBrowserVideoBlob("clip.mp4", new Blob(["video"]), expected)).rejects.toBeInstanceOf(UserScopeAbandonedError);
        expect(saves).toBe(0);
    });

    test("browser video export does not upload an owned resource", async () => {
        Object.assign(globalThis, { window: { location: { protocol: "http:" } } });
        let requests = 0;
        apiClient.defaults.adapter = async () => { requests++; throw new Error("unexpected upload"); };
        expect(await saveOwnedOrBrowserVideoBlob("clip.mp4", new Blob(["video"]), captureUserScope())).toBe("saved");
        expect(requests).toBe(0);
    });
});
