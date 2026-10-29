import { describe, expect, test } from "bun:test";
import { DIRECTOR_PANORAMA_PROMPT, generateDirectorPanorama, recoverDirectorPanoramaTasks } from "../src/lib/canvas/director/director-panorama-generation";
import { getActiveUserScope, setActiveUserScope } from "../src/lib/user-scope";
import { UserScopeAbandonedError } from "../src/lib/user-scope-guard";
import { defaultConfig } from "../src/stores/use-config-store";
import type { UploadedImage } from "../src/services/image-storage";
import type { GenerationTask } from "../src/services/api/task-center";
import type { ImageAsset } from "../src/stores/use-asset-store";

function deferred<T = void>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

const uploaded = (url: string, key: string): UploadedImage => ({ url, storageKey: key, width: 800, height: 400, bytes: 100, mimeType: "image/png" });
const input = () => ({ file: new File(["test"], "参考图.png", { type: "image/png" }), config: defaultConfig, sceneId: "scene-1", projectId: "project-1" });
const task = (patch: Partial<GenerationTask> = {}): GenerationTask => ({ id: "task-1", projectId: "project-1", type: "canvas_image", status: "succeeded", prompt: "", attempts: 1, createdAt: "2026-01-01", updatedAt: "2026-01-01", outputs: [{ outputIndex: 0, mediaType: "image", materializedAssetId: "asset-1" }], ...patch });
const asset = (): ImageAsset => ({ id: "asset-1", kind: "image", title: "生成图片", coverUrl: "blob:output", tags: ["生成"], source: "生成任务", createdAt: "2026-01-01", updatedAt: "2026-01-01", metadata: { source: "generation-task" }, data: { dataUrl: "blob:output", storageKey: "image:output", width: 800, height: 400, bytes: 100, mimeType: "image/png" } });

describe("导演台 AI 全景图", () => {
    test("上传期间关闭会话后不再提交付费任务", async () => {
        const controller = new AbortController();
        let submits = 0;
        await expect(generateDirectorPanorama({ ...input(), signal: controller.signal }, {
            selectModel: () => "image-model",
            upload: async () => { controller.abort(); return uploaded("blob:source", "image:source"); },
            submit: async () => { submits++; return task(); }, wait: async () => task(),
            materialize: async (value) => value, findAsset: asset, updateAsset: () => {},
        })).rejects.toThrow("生成会话已结束");
        expect(submits).toBe(0);
    });

    test("已接单任务关闭观察者后不物化结果且传递取消信号", async () => {
        const controller = new AbortController();
        let materializations = 0;
        await expect(generateDirectorPanorama({ ...input(), signal: controller.signal }, {
            selectModel: () => "image-model", upload: async () => uploaded("blob:source", "image:source"),
            submit: async () => task({ status: "running" }),
            wait: async (_id, options) => { controller.abort(); expect(options?.signal?.aborted).toBe(true); return task(); },
            materialize: async (value) => { materializations++; return value; }, findAsset: asset, updateAsset: () => {},
        })).rejects.toThrow("生成会话已结束");
        expect(materializations).toBe(0);
    });

    test("上传和生成等待期间切换账号都不会写入新账号", async () => {
        const previous = getActiveUserScope();
        try {
            for (const changeAt of ["upload", "wait", "materialize"] as const) {
                setActiveUserScope("owner-a");
                let submits = 0, materializations = 0, patches = 0;
                await expect(generateDirectorPanorama(input(), {
                    selectModel: () => "image-model",
                    upload: async () => { if (changeAt === "upload") setActiveUserScope("owner-b"); return uploaded("blob:source", "image:source"); },
                    submit: async () => { submits++; return task(); },
                    wait: async () => { if (changeAt === "wait") setActiveUserScope("owner-b"); return task(); },
                    materialize: async (value) => { materializations++; if (changeAt === "materialize") setActiveUserScope("owner-b"); return value; },
                    findAsset: asset, updateAsset: () => { patches++; },
                })).rejects.toBeInstanceOf(UserScopeAbandonedError);
                expect(submits).toBe(changeAt === "upload" ? 0 : 1);
                expect(materializations).toBe(changeAt === "materialize" ? 1 : 0);
                expect(patches).toBe(0);
            }
        } finally {
            setActiveUserScope(previous);
        }
    });

    test("等待期间 A→B→A 不重新提交付费任务", async () => {
        const previous = getActiveUserScope();
        setActiveUserScope("owner-a");
        const entered = deferred();
        const gate = deferred();
        let submits = 0, materializations = 0, patches = 0;
        try {
            const pending = generateDirectorPanorama(input(), {
                selectModel: () => "image-model",
                upload: async () => uploaded("blob:source", "image:source"),
                submit: async () => { submits++; return task({ status: "running" }); },
                wait: async () => { entered.resolve(); await gate.promise; return task(); },
                materialize: async (value) => { materializations++; return value; },
                findAsset: asset, updateAsset: () => { patches++; },
            });
            await entered.promise;
            setActiveUserScope("owner-b");
            setActiveUserScope("owner-a");
            gate.resolve();
            await expect(pending).rejects.toBeInstanceOf(UserScopeAbandonedError);
            expect(submits).toBe(1);
            expect(materializations).toBe(0);
            expect(patches).toBe(0);
        } finally {
            gate.resolve();
            setActiveUserScope(previous);
        }
    });

    test("恢复观察期间 A→B→A 停止且不物化", async () => {
        const previous = getActiveUserScope();
        setActiveUserScope("owner-a");
        const entered = deferred();
        const gate = deferred();
        let materializations = 0, patches = 0;
        try {
            const pending = recoverDirectorPanoramaTasks("project-1", "scene-1", undefined, {
                list: async () => [task({ status: "running", clientContext: { source: "director-panorama", sceneId: "scene-1" } })],
                query: async () => task({ status: "running" }),
                wait: async () => { entered.resolve(); await gate.promise; return task(); },
                materialize: async (value) => { materializations++; return value; },
                findAsset: asset,
                updateAsset: () => { patches++; },
            });
            await entered.promise;
            setActiveUserScope("owner-b");
            setActiveUserScope("owner-a");
            gate.resolve();
            await expect(pending).rejects.toBeInstanceOf(UserScopeAbandonedError);
            expect(materializations).toBe(0);
            expect(patches).toBe(0);
        } finally {
            gate.resolve();
            setActiveUserScope(previous);
        }
    });
    test("没有图片模型时不上传也不创建付费任务", async () => {
        let uploads = 0;
        await expect(generateDirectorPanorama(input(), {
            selectModel: () => "", upload: async () => { uploads++; return uploaded("blob:source", "image:source"); },
            submit: async () => { throw new Error("不应提交"); }, wait: async () => task(), materialize: async () => task(), findAsset: asset, updateAsset: () => {},
        })).rejects.toThrow("选择可用的图片模型");
        expect(uploads).toBe(0);
    });

    test("提交任务并复用唯一产物素材，任务更新可上报", async () => {
        const uploads: Array<string | Blob> = [];
        const updates: string[] = [];
        const patches: unknown[] = [];
        let materializations = 0;
        const result = await generateDirectorPanorama({ ...input(), onTaskUpdate: (value) => updates.push(value.id) }, {
            selectModel: () => "image-model",
            upload: async (value) => { uploads.push(value); return uploaded("blob:source", "image:source"); },
            submit: async (options) => {
                expect(options.projectId).toBe("project-1");
                expect(options.mode).toBe("image");
                expect(options.config.model).toBe("image-model");
                expect(options.config.count).toBe("1");
                expect(options.referenceImages?.[0]?.storageKey).toBe("image:source");
                expect(options.prompt).toBe(DIRECTOR_PANORAMA_PROMPT);
                expect(options.metadata).toEqual({ source: "director-panorama", sceneId: "scene-1" });
                options.onTaskUpdate?.(task({ status: "queued" }));
                return task({ status: "queued" });
            },
            wait: async (_id, options) => { options?.onTaskUpdate?.(task({ status: "running" })); return task(); },
            materialize: async (value) => { materializations++; return value; },
            findAsset: asset,
            updateAsset: (_id, patch) => patches.push(patch),
        });
        expect(uploads).toHaveLength(1);
        expect(updates).toEqual(["task-1", "task-1"]);
        expect(materializations).toBe(1);
        expect(result).toEqual({ id: "asset-1", name: "AI 全景图 · 参考图.png", url: "blob:output", storageKey: "image:output", width: 800, height: 400 });
        expect(patches).toMatchObject([{ metadata: { source: "director-panorama-ai", sceneId: "scene-1", taskId: "task-1" } }]);
    });

    test("刷新后仅恢复本场景任务，并使用幂等物化结果", async () => {
        const ids: string[] = [];
        const patches: unknown[] = [];
        const recovered = await recoverDirectorPanoramaTasks("project-1", "scene-1", undefined, {
            list: async () => [task({ clientContext: { source: "director-panorama", sceneId: "scene-1" } }), task({ id: "other", clientContext: { source: "director-panorama", sceneId: "scene-2" } })],
            query: async (id) => { ids.push(id); return task(); },
            wait: async () => { throw new Error("完成任务不应等待"); },
            materialize: async (value) => value,
            findAsset: asset,
            updateAsset: (_id, patch) => patches.push(patch),
        });
        expect(recovered).toBe(1);
        expect(ids).toEqual(["task-1"]);
        expect(patches).toMatchObject([{ title: "AI 全景图" }]);
    });

    test("进行中的任务可重接；缺少图片产物不会写入素材", async () => {
        let waits = 0;
        let updates = 0;
        const recovered = await recoverDirectorPanoramaTasks("project-1", "scene-1", undefined, {
            list: async () => [task({ status: "running", clientContext: { source: "director-panorama", sceneId: "scene-1" } })],
            query: async () => task({ status: "running" }),
            wait: async () => { waits++; return task({ outputs: [] }); },
            materialize: async (value) => value,
            findAsset: asset,
            updateAsset: () => { updates++; },
        });
        expect(waits).toBe(1);
        expect(recovered).toBe(0);
        expect(updates).toBe(0);
    });
});
