import { describe, expect, test } from "bun:test";
import { discoverBackendTasks, mergeTaskHistory } from "../src/pages/tasks/task-discovery";
import type { GenerationTask } from "../src/services/api/task-center";

const task = (id: string, status: GenerationTask["status"], updatedAt = "2026-09-30T10:00:00Z", projectId = "unloaded-canvas"): GenerationTask => ({
    id, status, updatedAt, createdAt: updatedAt, projectId, type: "canvas_image", prompt: id, attempts: 1,
});

describe("task discovery", () => {
    test("includes running and failed tasks from unloaded canvases or deleted nodes", async () => {
        const calls: unknown[] = [];
        const result = await discoverBackendTasks(async (limit, options) => {
            calls.push([limit, options]);
            return options?.activeOnly ? [task("running", "running", undefined, "other-canvas")] : [task("failed", "failed")];
        }, []);
        expect(result.incomplete).toBe(false);
        expect(result.tasks.map((item) => item.id).sort()).toEqual(["failed", "running"]);
        expect(calls).toEqual([[100, undefined], [100, { activeOnly: true }]]);
    });

    test("authoritative backend status wins over newer local snapshots and duplicate IDs", () => {
        const result = mergeTaskHistory([
            task("shared", "running", "2026-10-01T00:00:00Z"),
            task("shared", "succeeded"),
            task("local:canvas:node", "failed"),
            task("local:canvas:node", "running", "2026-09-29T00:00:00Z"),
        ], [task("shared", "failed"), task("shared", "queued", "2026-09-29T00:00:00Z")]);
        expect(result).toHaveLength(2);
        expect(result.every((item) => item.status === "failed")).toBe(true);
    });

    test("uses the newer backend observation when recent and active requests overlap", async () => {
        const result = await discoverBackendTasks(async (_, options) => options?.activeOnly
            ? [task("shared", "running", "2026-09-30T11:00:00Z")]
            : [task("shared", "queued")], []);
        expect(result.tasks).toHaveLength(1);
        expect(result.tasks[0].status).toBe("running");
    });

    test("retains previous backend state and local history on offline refresh without claiming completeness", async () => {
        const previous = [task("backend", "running")];
        const result = await discoverBackendTasks(async () => { throw new Error("offline"); }, previous);
        expect(result.incomplete).toBe(true);
        expect(result.tasks).toEqual(previous);
        expect(mergeTaskHistory([task("local:canvas:node", "failed")], result.tasks)).toHaveLength(2);
    });

    test("does not report an empty successful query when offline without cache", async () => {
        const result = await discoverBackendTasks(async () => { throw new Error("offline"); }, []);
        expect(result).toEqual({ tasks: [], incomplete: true });
    });

    test("keeps successful active query results when recent history fails", async () => {
        const result = await discoverBackendTasks(async (_, options) => {
            if (!options?.activeOnly) throw new Error("recent unavailable");
            return [task("new", "running")];
        }, [task("old", "failed")]);
        expect(result.incomplete).toBe(true);
        expect(result.tasks.map((item) => item.id).sort()).toEqual(["new", "old"]);
    });

    test("fresh terminal state replaces cached running state even if active query fails", async () => {
        const result = await discoverBackendTasks(async (_, options) => {
            if (options?.activeOnly) throw new Error("active unavailable");
            return [task("same", "failed")];
        }, [task("same", "running")]);
        expect(result.incomplete).toBe(true);
        expect(result.tasks).toEqual([task("same", "failed")]);
    });

    test("successful empty refresh clears removed backend rows", async () => {
        const result = await discoverBackendTasks(async () => [], [task("removed", "failed")]);
        expect(result).toEqual({ tasks: [], incomplete: false });
    });
});
