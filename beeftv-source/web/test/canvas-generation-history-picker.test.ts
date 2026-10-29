import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { generationHistoryPreviewImageSrc } from "../src/components/canvas/canvas-generation-history-picker";
import {
    assertCanvasGenerationHistoryTaskForInsert,
    awaitCanvasGenerationHistoryDetailIfValid,
    canvasGenerationHistorySelectStillValid,
    insertableCanvasGenerationHistoryTasks,
    type CanvasGenerationHistorySelectGate,
} from "../src/lib/canvas/canvas-generation-history";
import { reuseGeneratedMediaStorageKey } from "../src/lib/canvas/canvas-generation-task-sync";
import { insertCanvasGenerationHistoryTask } from "../src/pages/canvas/canvas-generation-orchestration";
import { localTaskHistoryFromProjects } from "../src/lib/local-task-history";
import { captureUserScopeEpoch, setActiveUserScope } from "../src/lib/user-scope";
import { listGenerationTasks, type GenerationTask } from "../src/services/api/task-center";
import { CanvasNodeType, type CanvasNodeData } from "../src/types/canvas";
import type { CanvasProject } from "../src/stores/canvas/use-canvas-store";

const picker = readFileSync(resolve(import.meta.dir, "../src/components/canvas/canvas-generation-history-picker.tsx"), "utf8");
const historySource = readFileSync(resolve(import.meta.dir, "../src/lib/canvas/canvas-generation-history.ts"), "utf8");
const definitions = readFileSync(resolve(import.meta.dir, "../src/lib/canvas/tool-registry/definitions/add-node-menu-tools.tsx"), "utf8");
const project = readFileSync(resolve(import.meta.dir, "../src/pages/canvas/project.tsx"), "utf8");
const orchestration = readFileSync(resolve(import.meta.dir, "../src/pages/canvas/canvas-generation-orchestration.ts"), "utf8");
const orchestrationHook = readFileSync(resolve(import.meta.dir, "../src/pages/canvas/use-canvas-generation-orchestration.ts"), "utf8");
const localHistory = readFileSync(resolve(import.meta.dir, "../src/lib/local-task-history.ts"), "utf8");
const taskSync = readFileSync(resolve(import.meta.dir, "../src/lib/canvas/canvas-generation-task-sync.ts"), "utf8");

function succeededImageSummary(partial: Partial<GenerationTask> = {}): GenerationTask {
    return {
        id: "016077a262cc8f86b127e1cad4b6bf9f",
        projectId: "lelvpvjEnuJ98wD_f2FI7",
        type: "canvas_image",
        status: "succeeded",
        prompt: "金色湖畔露营车",
        previewUrl: "/api/resources/generated-image/file",
        previewKind: "image",
        clientContext: { nodeId: "image-1790921196364-0djku" },
        attempts: 1,
        createdAt: "2026-10-02T15:18:58.000Z",
        updatedAt: "2026-10-02T15:18:58.000Z",
        ...partial,
    };
}

function succeededImageDetail(partial: Partial<GenerationTask> = {}): GenerationTask {
    return succeededImageSummary({
        resultJson: JSON.stringify({
            mode: "image",
            images: [{ storageKey: "resource:generated-image", url: "/api/resources/generated-image/file" }],
        }),
        ...partial,
    });
}

function wipedCanvasProject(): CanvasProject {
    return {
        id: "lelvpvjEnuJ98wD_f2FI7",
        title: "未命名项目",
        nodes: [{
            id: "image-1790921196364-0djku",
            type: CanvasNodeType.Image,
            title: "图片",
            position: { x: 0, y: 0 },
            width: 320,
            height: 180,
            metadata: {
                taskId: "016077a262cc8f86b127e1cad4b6bf9f",
                taskStatus: "succeeded",
                status: "loading",
                content: "",
                storageKey: "",
            },
        }],
        connections: [],
        createdAt: "2026-10-02T06:05:27.000Z",
        updatedAt: "2026-10-02T07:30:19.000Z",
    } as CanvasProject;
}

function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((nextResolve, nextReject) => {
        resolve = nextResolve;
        reject = nextReject;
    });
    return { promise, resolve, reject };
}

function selectGate(partial: Partial<CanvasGenerationHistorySelectGate> = {}): CanvasGenerationHistorySelectGate {
    return {
        open: true,
        projectId: "lelvpvjEnuJ98wD_f2FI7",
        epoch: captureUserScopeEpoch(),
        mounted: true,
        selectionEpoch: 0,
        ...partial,
    };
}

describe("LibTV generation history picker", () => {
    test("queries and filters successful media generation tasks", () => {
        expect(picker).toContain('title="生成历史"');
        expect(picker).toContain("listGenerationTasks(100, { projectId, activeOnly: false }, undefined, signal)");
        expect(picker).toContain("insertableCanvasGenerationHistoryTasks");
        expect(picker).toContain("queryGenerationTask(task.id, { signal: request.signal })");
        expect(picker).toContain("awaitCanvasGenerationHistoryDetailIfValid");
        expect(picker).toContain("canvasGenerationHistorySelectStillValid");
        expect(picker).toContain("captureUserScopeEpoch");
        expect(picker).not.toContain("resolveCanvasGenerationHistoryTaskForInsert");
        expect(historySource).not.toContain("queryGenerationTask");
        expect(historySource).not.toContain("queryTask");
        expect(historySource).not.toContain("await import(");
        expect(historySource).toContain('import type { GenerationTask } from "@/services/api/task-center"');
        expect(historySource).toContain("assertCanvasGenerationHistoryTaskForInsert");
        expect(historySource).not.toContain("filter((task) => Boolean(task.resultJson");
        expect(picker).toContain("enabled: open && Boolean(projectId.trim())");
        expect(picker).not.toContain("localTaskHistoryFromProjects");
        expect(picker).not.toContain("isLocalWorkspaceMode");
        expect(picker).not.toContain("loadCanvasGenerationHistory");
        expect(picker).toContain("query.isError ? <>生成历史暂时无法读取");
        expect(picker).toContain('queryKey: ["canvas-generation-history", scope, projectId]');
        expect(historySource).toContain("export function insertableCanvasGenerationHistoryTasks");
        expect(historySource).not.toContain("loadCanvasGenerationHistory");
        expect(historySource).not.toContain("listGenerationTasks");
    });

    test("lists a succeeded backend task even when the canvas node has no content", () => {
        expect(picker).not.toContain("localTaskHistoryFromProjects");
        expect(localTaskHistoryFromProjects([wipedCanvasProject()]).some((task) => !task.resultJson)).toBe(true);

        const listed = insertableCanvasGenerationHistoryTasks([
            succeededImageSummary(),
            succeededImageSummary({ id: "other-canvas", projectId: "other-canvas" }),
            succeededImageSummary({ id: "failed", status: "failed" }),
            succeededImageSummary({ id: "text-task", type: "canvas_text" }),
        ], { projectId: "lelvpvjEnuJ98wD_f2FI7" });
        expect(listed.map((task) => task.id)).toEqual(["016077a262cc8f86b127e1cad4b6bf9f"]);
        expect(listed.every((task) => task.resultJson === undefined)).toBe(true);
        expect(listed[0]?.previewUrl).toBe("/api/resources/generated-image/file");
        expect(listed[0]?.clientContext?.nodeId).toBe("image-1790921196364-0djku");
    });

    test("select validates fetched detail strictly and keeps list summaries free of resultJson", () => {
        const summary = succeededImageSummary();
        const detail = succeededImageDetail();
        expect(summary.resultJson).toBeUndefined();
        const resolved = assertCanvasGenerationHistoryTaskForInsert(detail, {
            projectId: "lelvpvjEnuJ98wD_f2FI7",
            expectedId: summary.id,
        });
        expect(resolved.resultJson).toContain("resource:generated-image");

        expect(() => assertCanvasGenerationHistoryTaskForInsert({ ...detail, status: "failed", error: "上游内容审核未通过" }, {
            projectId: "lelvpvjEnuJ98wD_f2FI7",
            expectedId: summary.id,
        })).toThrow("上游内容审核未通过");
        expect(() => assertCanvasGenerationHistoryTaskForInsert(detail, {
            projectId: "other-canvas",
            expectedId: summary.id,
        })).toThrow("生成任务不属于当前画布");
        expect(() => assertCanvasGenerationHistoryTaskForInsert({ ...detail, resultJson: undefined }, {
            projectId: "lelvpvjEnuJ98wD_f2FI7",
            expectedId: summary.id,
        })).toThrow("该任务没有可插入的生成结果");
        expect(() => assertCanvasGenerationHistoryTaskForInsert({ ...detail, id: "other-task" }, {
            projectId: "lelvpvjEnuJ98wD_f2FI7",
            expectedId: summary.id,
        })).toThrow("该任务没有可插入的生成结果");
        expect(() => assertCanvasGenerationHistoryTaskForInsert({ ...detail, projectId: "" }, {
            projectId: "lelvpvjEnuJ98wD_f2FI7",
            expectedId: summary.id,
        })).toThrow("生成任务不属于当前画布");
        expect(() => assertCanvasGenerationHistoryTaskForInsert(detail, {
            projectId: "   ",
            expectedId: summary.id,
        })).toThrow("生成任务不属于当前画布");
        expect(() => assertCanvasGenerationHistoryTaskForInsert(detail, {
            projectId: "",
            expectedId: summary.id,
        })).toThrow("生成任务不属于当前画布");
        expect(insertableCanvasGenerationHistoryTasks([succeededImageSummary({ projectId: "" })], { projectId: "   " })).toEqual([]);
    });

    test("delayed detail is not inserted after picker close, canvas switch, user-scope change, or unmount", async () => {
        const detail = succeededImageDetail();
        const selected: GenerationTask[] = [];

        const applyDelayed = async (
            mutateLive: (live: CanvasGenerationHistorySelectGate) => void,
        ) => {
            const captured = selectGate();
            const live = selectGate({ epoch: captured.epoch });
            const pending = deferred<GenerationTask>();
            const applied = awaitCanvasGenerationHistoryDetailIfValid({
                detail: pending.promise,
                captured,
                live: () => live,
                expectedId: detail.id,
            }).then((resolved) => {
                if (resolved) selected.push(resolved);
            });
            mutateLive(live);
            pending.resolve(detail);
            await applied;
        };

        await applyDelayed((live) => {
            live.open = false;
        });
        expect(selected).toEqual([]);
        expect(canvasGenerationHistorySelectStillValid(selectGate(), selectGate({ open: false }))).toBe(false);

        // Closing and immediately reopening the same canvas must not resurrect
        // the selection that the user cancelled, even if the transport resolves.
        await applyDelayed((live) => {
            live.open = false;
            live.selectionEpoch += 1;
            live.open = true;
        });
        expect(selected).toEqual([]);

        await applyDelayed((live) => {
            live.projectId = "other-canvas";
        });
        expect(selected).toEqual([]);
        expect(canvasGenerationHistorySelectStillValid(
            selectGate(),
            selectGate({ projectId: "other-canvas" }),
        )).toBe(false);

        const beforeScope = captureUserScopeEpoch();
        setActiveUserScope("other-user");
        expect(canvasGenerationHistorySelectStillValid(
            selectGate({ epoch: beforeScope }),
            selectGate(),
        )).toBe(false);
        const scopePending = deferred<GenerationTask>();
        const scopeCaptured = selectGate({ epoch: beforeScope });
        const scopeApplied = awaitCanvasGenerationHistoryDetailIfValid({
            detail: scopePending.promise,
            captured: scopeCaptured,
            live: () => selectGate(),
            expectedId: detail.id,
        });
        scopePending.resolve(detail);
        expect(await scopeApplied).toBeUndefined();

        await applyDelayed((live) => {
            live.mounted = false;
        });
        expect(selected).toEqual([]);
        expect(canvasGenerationHistorySelectStillValid(selectGate(), selectGate({ mounted: false }))).toBe(false);

        const validCaptured = selectGate();
        const validPending = deferred<GenerationTask>();
        const validApplied = awaitCanvasGenerationHistoryDetailIfValid({
            detail: validPending.promise,
            captured: validCaptured,
            live: () => validCaptured,
            expectedId: detail.id,
        });
        validPending.resolve(detail);
        expect((await validApplied)?.id).toBe(detail.id);
        setActiveUserScope("guest");
    });

    test("history API failure is not turned into an empty list", async () => {
        await expect(listGenerationTasks(100, { projectId: "lelvpvjEnuJ98wD_f2FI7", activeOnly: false }, {
            listBackend: async () => {
                throw new Error("backend down");
            },
        })).rejects.toThrow("backend down");
        const listQuery = picker.slice(picker.indexOf("const query = useQuery"), picker.indexOf("const tasks = useMemo"));
        expect(listQuery).not.toContain(".catch(");
        expect(picker).toContain("query.isError ? <>生成历史暂时无法读取");
    });

    test("keeps project scope when listing insertable history", () => {
        const listed = insertableCanvasGenerationHistoryTasks([
            succeededImageSummary(),
            succeededImageSummary({ id: "foreign", projectId: "canvas-b" }),
        ], { projectId: "lelvpvjEnuJ98wD_f2FI7", keyword: "湖畔" });
        expect(listed).toHaveLength(1);
        expect(insertableCanvasGenerationHistoryTasks([succeededImageSummary()], { projectId: "lelvpvjEnuJ98wD_f2FI7", keyword: "无匹配" })).toEqual([]);
    });

    test("inserts from persisted resultJson without requiring node preview", async () => {
        const task = succeededImageDetail({ previewUrl: undefined });
        const persisted: CanvasNodeData[][] = [];
        const result = await insertCanvasGenerationHistoryTask({
            task,
            projectId: "lelvpvjEnuJ98wD_f2FI7",
            center: { x: 40, y: 40 },
            nodes: wipedCanvasProject().nodes,
            assets: [],
            persist: async (nodes) => { persisted.push(nodes); },
            ensureAsset: async () => ({ assetId: "asset-generated" }),
            applyResult: async (nodes, applied) => {
                expect(applied.resultJson).toContain("resource:generated-image");
                const node = { ...nodes[0], metadata: { ...nodes[0].metadata, content: "/api/resources/generated-image/file", storageKey: "resource:generated-image", status: "success" as const } };
                return { nodes: [node], updated: true, nodeId: node.id, node };
            },
            readLiveNodes: () => wipedCanvasProject().nodes,
        });
        expect(result.node.metadata?.storageKey).toBe("resource:generated-image");
        expect(persisted).toHaveLength(1);
        expect(persisted[0].some((node) => node.metadata?.storageKey === "resource:generated-image")).toBe(true);
    });

    test("is exposed from the add-node menu and applies the result to a canvas node", () => {
        expect(definitions).toContain('id: "generation-history"');
        expect(definitions).toContain("onOpenGenerationHistory");
        expect(orchestration).toContain("applyGenerationTaskResultToNodes");
        expect(project).toContain("insertGenerationHistoryTask");
        expect(localHistory).toContain("localResultJson");
        expect(localHistory).toContain("resultJson");
        expect(localHistory).toContain("storageKey");
        expect(orchestrationHook).toContain("setGenerationHistoryOpen(false)");
        expect(taskSync).toContain("reuseGeneratedMediaStorageKey");
        expect(taskSync).toContain("reuseAudioKey");
        expect(taskSync).toContain("reuseVideoKey");
        expect(taskSync).toContain("reuseImageKey");
    });

    test("persists the inserted node to the local canvas document before closing success", () => {
        const helperStart = orchestration.indexOf("export async function insertCanvasGenerationHistoryTask");
        const helper = orchestration.slice(helperStart);
        expect(helper).toContain("bindMissingCanvasResourceAssets");
        expect(helper).toContain("bindMissingCanvasResourceAssets([applied.node]");
        expect(helper).toContain("rebaseInsertedCanvasNode");
        expect(helper).toContain("readLiveNodes");
        expect(helper).toContain("canvasNodesMissingResourceAssetBinding");
        expect(helper).toContain("await input.persist(nextNodes)");
        expect(helper.indexOf("await input.persist(nextNodes)")).toBeLessThan(helper.indexOf("return { node: insertedNodes[0], nextNodes, insertedNodes }"));

        const hookStart = orchestrationHook.indexOf("const insertGenerationHistoryTask = useCallback");
        const hookEnd = orchestrationHook.indexOf("const reconcileImageBatchRootNode", hookStart);
        const insert = orchestrationHook.slice(hookStart, hookEnd);
        expect(insert).toContain("runOwnedCanvasHistoryInsert");
        expect(insert).toContain("insertingHistory.current.tryEnter()");
        expect(orchestrationHook).toContain("createInsertingHistoryGate");
        expect(insert).toContain("persistCanvasDocument(owner.canvasId, { nodes: persisted })");
        expect(insert).toContain("ensureCanvasNodeAsset");
        expect(insert).toContain("insertedNodes.reduce");
        expect(insert).toContain("rebaseInsertedCanvasNode(nodes, inserted)");
        expect(insert).toContain("expectedScope: captureUserScope()");
        expect(insert.indexOf("runOwnedCanvasHistoryInsert")).toBeLessThan(insert.indexOf("setGenerationHistoryOpen(false)"));
        expect(insert.indexOf("runOwnedCanvasHistoryInsert")).toBeLessThan(insert.indexOf('message.success("已从生成历史插入到画布")'));
        expect(insert.indexOf("flushCanvasStorePersistence")).toBe(-1);
        expect(insert.indexOf("saveCanvasProject")).toBe(-1);
        expect(project).toContain("insertGenerationHistoryTask");
    });

    test("does not use audio or video file URLs as card image sources", () => {
        const audioUrl = "http://127.0.0.1:3184/api/resources/audio-owned/file";
        const audioTask = {
            id: "task-audio",
            projectId: "7vvfM674HnenwTekmj88V",
            type: "canvas_audio",
            status: "succeeded",
            prompt: "一段旁白",
            previewUrl: audioUrl,
            resultJson: JSON.stringify({ mode: "audio", audio: { dataUrl: audioUrl, url: audioUrl, storageKey: "resource:audio-owned" } }),
            attempts: 1,
            createdAt: "2026-09-24T00:00:00.000Z",
            updatedAt: "2026-09-24T00:00:00.000Z",
        } as GenerationTask;
        const videoTask = {
            ...audioTask,
            id: "task-video",
            type: "canvas_video",
            previewUrl: "http://127.0.0.1:3184/api/resources/video-owned/file",
            resultJson: JSON.stringify({ mode: "video", video: { dataUrl: "http://127.0.0.1:3184/api/resources/video-owned/file" } }),
        } as GenerationTask;
        const imageTask = {
            ...audioTask,
            id: "task-image",
            type: "canvas_image",
            previewUrl: "data:image/png;base64,abc",
            resultJson: JSON.stringify({ mode: "image", images: [{ dataUrl: "data:image/png;base64,abc" }] }),
        } as GenerationTask;

        expect(generationHistoryPreviewImageSrc(audioTask)).toBe("");
        expect(generationHistoryPreviewImageSrc(videoTask)).toBe("");
        expect(generationHistoryPreviewImageSrc(imageTask)).toBe("data:image/png;base64,abc");
        expect(reuseGeneratedMediaStorageKey(undefined, audioUrl)).toBe("resource:audio-owned");
        expect(reuseGeneratedMediaStorageKey("image:local-1", "http://127.0.0.1:3184/api/resources/video-owned/file")).toBe("image:local-1");
        expect(reuseGeneratedMediaStorageKey(undefined, "data:audio/mpeg;base64,AAA")).toBe("");
    });
});
