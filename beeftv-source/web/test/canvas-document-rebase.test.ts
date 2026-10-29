import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { rebaseCanvasDocumentThreeWay, settleInFlightGenerationOverlay } from "../src/lib/canvas/canvas-document-rebase";
import type { CanvasProject } from "../src/stores/canvas/use-canvas-store";
import { CanvasNodeType, type CanvasNodeData } from "../src/types/canvas";

function node(id: string, title: string, metadata: CanvasNodeData["metadata"] = {}, position = { x: 0, y: 0 }): CanvasNodeData {
    return { id, type: CanvasNodeType.Image, title, position, width: 320, height: 220, metadata };
}

function project(nodes: CanvasNodeData[], revision: number, title = "画布"): CanvasProject {
    return {
        id: "c1",
        revision,
        title,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        nodes,
        connections: [],
        chatSessions: [],
        activeChatId: null,
        backgroundMode: "grid",
        showImageInfo: false,
        viewport: { x: 0, y: 0, k: 1 },
        directorScenes: [],
    };
}

describe("settleInFlightGenerationOverlay", () => {
    test("settle comment matches overlay empty-string exception", () => {
        const source = readFileSync(resolve(import.meta.dir, "../src/lib/canvas/canvas-document-rebase.ts"), "utf8");
        expect(source).not.toContain("人类写过的 content（含空串）保留");
        expect(source).toContain("loading/error 上的空 content 是 overlay");
        expect(source).toContain("人类写过的非空 content 保留");
        expect(source).toContain("非 overlay 上的空串按真实编辑保留");
        expect(source).toContain("不同 taskId 不会写回旧 storageKey");
    });

    test("in-flight loading overlay adopts remote success and keeps Agent sibling nodes", () => {
        const original = node("image-origin", "原图", { taskId: "task-1", status: "idle", prompt: "猫" });
        const camp = node("node-camp", "秋日旅行·露营桌", { status: "idle" }, { x: 80, y: 40 });
        const lake = node("node-lake", "秋日旅行·湖畔横移", { status: "idle" }, { x: 160, y: 40 });
        const base = project([original, camp, lake], 10);
        const local = project([
            { ...original, metadata: { taskId: "task-1", status: "loading", taskStatus: "running", taskProgress: 42, taskStage: "出图中", prompt: "猫" } },
            camp,
            lake,
        ], 10);
        const remote = project([
            { ...original, metadata: { taskId: "task-1", status: "success", taskStatus: "succeeded", taskProgress: 100, content: "https://media/gen", storageKey: "res-gen", prompt: "猫" } },
            camp,
            lake,
        ], 14);
        const settled = settleInFlightGenerationOverlay({ base, local, remote });
        const rebased = rebaseCanvasDocumentThreeWay({ base, local: settled, remote });
        expect(rebased.conflict).toBe(false);
        expect(rebased.project.nodes.map((item) => item.id)).toEqual(["image-origin", "node-camp", "node-lake"]);
        expect(rebased.project.nodes[0]?.metadata?.status).toBe("success");
        expect(rebased.project.nodes[0]?.metadata?.content).toBe("https://media/gen");
        expect(rebased.project.nodes[1]?.title).toBe("秋日旅行·露营桌");
        expect(rebased.project.nodes[2]?.title).toBe("秋日旅行·湖畔横移");
    });

    test("same-field human content edit keeps local value and remains a recoverable conflict", () => {
        const original = node("image-origin", "原图", { taskId: "task-1", status: "idle", content: "旧图" });
        const base = project([original], 10);
        const local = project([{ ...original, metadata: { taskId: "task-1", status: "loading", content: "人类改过的内容" } }], 10);
        const remote = project([{ ...original, metadata: { taskId: "task-1", status: "success", content: "https://media/gen", storageKey: "res-gen" } }], 14);
        const settled = settleInFlightGenerationOverlay({ base, local, remote });
        expect(settled.nodes[0]?.metadata?.content).toBe("人类改过的内容");
        expect(settled.nodes[0]?.metadata?.status).toBe("loading");
        const rebased = rebaseCanvasDocumentThreeWay({ base, local: settled, remote });
        expect(rebased.conflict).toBe(true);
        expect(rebased.project.nodes[0]?.metadata?.content).toBe("人类改过的内容");
        expect(rebased.project.nodes[0]?.metadata?.status).not.toBe("success");
    });

    test("new task deleting content adopts remote success as a normal clear of the old result", () => {
        const original = node("image-origin", "原图", { taskId: "task-old", status: "success", content: "旧图", storageKey: "old-key" });
        const base = project([original], 10);
        const local = project([{
            ...original,
            metadata: { taskId: "task-2", status: "loading", taskStatus: "running", taskProgress: 12, prompt: "猫" },
        }], 10);
        const remote = project([{
            ...original,
            metadata: { taskId: "task-2", status: "success", taskStatus: "succeeded", taskProgress: 100, content: "https://media/new", storageKey: "res-new", prompt: "猫" },
        }], 14);
        expect(Object.prototype.hasOwnProperty.call(local.nodes[0]?.metadata || {}, "content")).toBe(false);
        const settled = settleInFlightGenerationOverlay({ base, local, remote });
        expect(settled.nodes[0]?.metadata?.status).toBe("success");
        expect(settled.nodes[0]?.metadata?.content).toBe("https://media/new");
        expect(settled.nodes[0]?.metadata?.storageKey).toBe("res-new");
        const rebased = rebaseCanvasDocumentThreeWay({ base, local: settled, remote });
        expect(rebased.conflict).toBe(false);
        expect(rebased.project.nodes[0]?.metadata?.content).toBe("https://media/new");
    });

    test("same-task in-flight empty overlay adopts remote bound success", () => {
        const original = node("node-dlu63hran9ns-43e87554d6", "秋日旅行", {
            taskId: "e24cb37f0a7d146afc8560456d88a550",
            status: "success",
            taskStatus: "succeeded",
            content: "/api/resources/8edbd8862c4714bbe42424d83e63bc08/file",
            storageKey: "resource:8edbd8862c4714bbe42424d83e63bc08",
        });
        const base = project([original], 34);
        const local = project([{ ...original, metadata: { ...original.metadata, status: "loading", content: "", storageKey: undefined, assetId: undefined } }], 34);
        const remote = project([original], 34);
        const settled = settleInFlightGenerationOverlay({ base, local, remote });
        expect(settled.nodes[0]?.metadata?.status).toBe("success");
        expect(settled.nodes[0]?.metadata?.content).toBe("/api/resources/8edbd8862c4714bbe42424d83e63bc08/file");
        expect(settled.nodes[0]?.metadata?.storageKey).toBe("resource:8edbd8862c4714bbe42424d83e63bc08");
        const rebased = rebaseCanvasDocumentThreeWay({ base, local: settled, remote });
        expect(rebased.conflict).toBe(false);
        expect(rebased.project.nodes[0]?.metadata?.status).toBe("success");
        expect(rebased.project.nodes[0]?.metadata?.storageKey).toBe("resource:8edbd8862c4714bbe42424d83e63bc08");
    });

    test("in-flight nonempty human content still wins over remote success", () => {
        const original = node("image-origin", "原图", { taskId: "task-1", status: "idle", content: "旧图", storageKey: "old-key" });
        const base = project([original], 10);
        const local = project([{ ...original, metadata: { taskId: "task-1", status: "loading", content: "人类改过的内容" } }], 10);
        const remote = project([{ ...original, metadata: { taskId: "task-1", status: "success", content: "https://media/gen", storageKey: "res-gen" } }], 14);
        const settled = settleInFlightGenerationOverlay({ base, local, remote });
        expect(settled.nodes[0]?.metadata?.content).toBe("人类改过的内容");
        expect(settled.nodes[0]?.metadata?.status).toBe("loading");
        const rebased = rebaseCanvasDocumentThreeWay({ base, local: settled, remote });
        expect(rebased.conflict).toBe(true);
        expect(rebased.project.nodes[0]?.metadata?.content).toBe("人类改过的内容");
    });

    test("baseline empty content on first generation is not treated as a human clear", () => {
        const original = node("image-origin", "原图", { taskId: "task-1", status: "idle", content: "" });
        const base = project([original], 10);
        const local = project([{ ...original, metadata: { taskId: "task-1", status: "loading", content: "", taskStatus: "running" } }], 10);
        const remote = project([{ ...original, metadata: { taskId: "task-1", status: "success", content: "https://media/gen", storageKey: "res-gen" } }], 14);
        const settled = settleInFlightGenerationOverlay({ base, local, remote });
        expect(settled.nodes[0]?.metadata?.status).toBe("success");
        expect(settled.nodes[0]?.metadata?.content).toBe("https://media/gen");
        const rebased = rebaseCanvasDocumentThreeWay({ base, local: settled, remote });
        expect(rebased.conflict).toBe(false);
    });

    test("remote taskStatus succeeded without bound media is not authoritative completion", () => {
        const original = node("image-origin", "原图", { taskId: "task-1", status: "idle", content: "旧图" });
        const base = project([original], 10);
        const local = project([{
            ...original,
            metadata: { taskId: "task-1", status: "loading", content: "https://local-kept", storageKey: "local-key", taskStatus: "running" },
        }], 10);
        const remote = project([{
            ...original,
            metadata: { taskId: "task-1", status: "loading", taskStatus: "succeeded", taskProgress: 100, content: "" },
        }], 21);
        const settled = settleInFlightGenerationOverlay({ base, local, remote });
        expect(settled.nodes[0]).toBe(local.nodes[0]);
        expect(settled.nodes[0]?.metadata?.status).toBe("loading");
        expect(settled.nodes[0]?.metadata?.content).toBe("https://local-kept");
        expect(settled.nodes[0]?.metadata?.storageKey).toBe("local-key");
        expect(settled.nodes[0]?.metadata?.taskStatus).toBe("running");
    });

    test("remote success without media result does not clear local media fields", () => {
        const original = node("image-origin", "原图", { taskId: "task-1", status: "idle", content: "旧图" });
        const base = project([original], 10);
        const local = project([{
            ...original,
            metadata: { taskId: "task-1", status: "error", content: "https://local-kept", storageKey: "local-key", errorDetails: "画布已在别处更新" },
        }], 10);
        const remote = project([{
            ...original,
            metadata: { taskId: "task-1", status: "success", taskStatus: "succeeded", content: "" },
        }], 14);
        const settled = settleInFlightGenerationOverlay({ base, local, remote });
        expect(settled.nodes[0]).toBe(local.nodes[0]);
        expect(settled.nodes[0]?.metadata?.content).toBe("https://local-kept");
        expect(settled.nodes[0]?.metadata?.storageKey).toBe("local-key");
        expect(settled.nodes[0]?.metadata?.status).toBe("error");
    });

    test("idle or human non-overlay status is not overwritten by remote bound success", () => {
        const original = node("image-origin", "原图", { taskId: "task-1", status: "idle", content: "旧图" });
        const base = project([original], 10);
        const idleLocal = project([{ ...original, metadata: { taskId: "task-1", status: "idle", content: "旧图", prompt: "人类改了提示" } }], 10);
        const successLocal = project([{ ...original, metadata: { taskId: "task-1", status: "success", content: "人类留下的图" } }], 10);
        const remote = project([{ ...original, metadata: { taskId: "task-1", status: "success", content: "https://media/gen", storageKey: "res-gen" } }], 14);
        const settledIdle = settleInFlightGenerationOverlay({ base, local: idleLocal, remote });
        const settledSuccess = settleInFlightGenerationOverlay({ base, local: successLocal, remote });
        expect(settledIdle.nodes[0]).toBe(idleLocal.nodes[0]);
        expect(settledIdle.nodes[0]?.metadata?.status).toBe("idle");
        expect(settledIdle.nodes[0]?.metadata?.content).toBe("旧图");
        expect(settledIdle.nodes[0]?.metadata?.prompt).toBe("人类改了提示");
        expect(settledSuccess.nodes[0]).toBe(successLocal.nodes[0]);
        expect(settledSuccess.nodes[0]?.metadata?.content).toBe("人类留下的图");
    });

    test("error overlay of the same in-flight task adopts remote bound success", () => {
        const original = node("image-origin", "原图", { taskId: "task-1", status: "idle", prompt: "猫" });
        const base = project([original], 10);
        const local = project([{
            ...original,
            metadata: {
                taskId: "task-1",
                status: "error",
                generationErrorCode: "canvas_conflict",
                errorDetails: "云端画布已有更新，已停止覆盖；请保留本地草稿并加载最新版本",
                prompt: "猫",
            },
        }], 10);
        const remote = project([{
            ...original,
            metadata: { taskId: "task-1", status: "success", taskStatus: "succeeded", content: "https://media/gen", storageKey: "res-gen", prompt: "猫" },
        }], 14);
        const settled = settleInFlightGenerationOverlay({ base, local, remote });
        expect(settled.nodes[0]?.metadata?.status).toBe("success");
        expect(settled.nodes[0]?.metadata?.content).toBe("https://media/gen");
        expect(settled.nodes[0]?.metadata?.errorDetails).toBeUndefined();
        expect(settled.nodes[0]?.metadata?.generationErrorCode).toBeUndefined();
        const rebased = rebaseCanvasDocumentThreeWay({ base, local: settled, remote });
        expect(rebased.conflict).toBe(false);
    });

    test("new-task overlay does not adopt a different remote task's bound success", () => {
        const original = node("node-dlu63hran9ns-43e87554d6", "秋日旅行", {
            taskId: "e24cb37f0a7d146afc8560456d88a550",
            status: "success",
            taskStatus: "succeeded",
            content: "/api/resources/8edbd8862c4714bbe42424d83e63bc08/file",
            storageKey: "resource:8edbd8862c4714bbe42424d83e63bc08",
        });
        const base = project([original], 34);
        const local = project([{
            ...original,
            metadata: { taskId: "task-new", status: "loading", taskStatus: "running", prompt: "新提示" },
        }], 34);
        const remote = project([original], 34);
        expect(Object.prototype.hasOwnProperty.call(local.nodes[0]?.metadata || {}, "content")).toBe(false);
        const settled = settleInFlightGenerationOverlay({ base, local, remote });
        expect(settled.nodes[0]).toBe(local.nodes[0]);
        expect(settled.nodes[0]?.metadata?.taskId).toBe("task-new");
        expect(settled.nodes[0]?.metadata?.status).toBe("loading");
        expect(settled.nodes[0]?.metadata?.storageKey).toBeUndefined();
        expect(Object.prototype.hasOwnProperty.call(settled.nodes[0]?.metadata || {}, "content")).toBe(false);
    });

    test("real human empty-string clear on non-overlay is not settled as overlay", () => {
        const original = node("image-origin", "原图", {
            taskId: "task-1",
            status: "success",
            content: "旧图",
            storageKey: "old-key",
        });
        const base = project([original], 10);
        const local = project([{ ...original, metadata: { ...original.metadata, content: "" } }], 10);
        const remote = project([original], 14);
        const settled = settleInFlightGenerationOverlay({ base, local, remote });
        expect(settled.nodes[0]).toBe(local.nodes[0]);
        expect(settled.nodes[0]?.metadata?.status).toBe("success");
        expect(settled.nodes[0]?.metadata?.content).toBe("");
        expect(settled.nodes[0]?.metadata?.storageKey).toBe("old-key");
    });
});

describe("rebaseCanvasDocumentThreeWay node timestamps", () => {
    const stamp = (item: CanvasNodeData): CanvasNodeData => ({ ...item, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z" });

    test("remote delete drops a node whose local copy only gained createdAt/updatedAt", () => {
        const assistant = node("a1", "助手文本");
        const kept = node("k1", "保留");
        const result = rebaseCanvasDocumentThreeWay({
            base: project([assistant, kept], 7),
            local: project([stamp(assistant), kept], 7),
            remote: project([kept], 8),
        });
        expect(result.conflict).toBe(false);
        expect(result.project.nodes.map((item) => item.id)).toEqual(["k1"]);
    });

    test("remote delete of a locally retitled node is still a conflict and keeps the local node", () => {
        const assistant = node("a1", "助手文本");
        const result = rebaseCanvasDocumentThreeWay({
            base: project([assistant], 7),
            local: project([{ ...stamp(assistant), title: "本地改过的标题" }], 7),
            remote: project([], 8),
        });
        expect(result.conflict).toBe(true);
        expect(result.project.nodes.map((item) => item.title)).toEqual(["本地改过的标题"]);
    });
});
