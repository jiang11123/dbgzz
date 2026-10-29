import { beforeEach, expect, test } from "bun:test";
import { ApiError } from "@/services/api/request";
import type { GenerationTask } from "@/services/api/task-center";
import { getClientDiagnosticEvents, recordDiagnosticEvent, setDiagnosticUserScope } from "@/services/diagnostics/client-diagnostics";
import { recordCanvasBindingDiagnostic } from "@/services/diagnostics/canvas-binding-diagnostics";

let scopeNumber = 0;
beforeEach(() => { setDiagnosticUserScope(`binding-test-${++scopeNumber}`); });

test("binding refusal retains the actual server task instead of borrowing the latest request trace", () => {
    const task = { id: "paid-video", clientOperationId: "canvas:" + "a".repeat(110) } as GenerationTask;
    recordCanvasBindingDiagnostic({
        phase: "refused", canvasId: "canvas-1", nodeId: "video-1", outputIndex: 0, task,
        error: new ApiError("节点已绑定到其他任务", { status: 409, reason: "node_task_mismatch", requestId: "req-bind", details: {
            canvasBinding: { source: "server", nodeId: "video-1", nodeTaskId: "new-task", nodeClientOperationId: "canvas:new",
                revision: 42, nodePresent: true, nodeHasMedia: false, prompt: "never-export-prompt", url: "https://secret.example/clip" },
        } }),
    });
    const [event] = getClientDiagnosticEvents();
    expect(event).toMatchObject({ taskId: "paid-video", canvasId: "canvas-1", requestId: "req-bind", reason: "node_task_mismatch",
        canvasBinding: { source: "server", nodeTaskId: "new-task", clientOperationId: task.clientOperationId, nodeHasMedia: false, revision: 42 } });
    expect(JSON.stringify(event)).not.toContain("never-export");
    expect(JSON.stringify(event)).not.toContain("secret.example");
    for (let index = 0; index < 600; index++) recordDiagnosticEvent({ category: "request", level: "info", message: "GET /tasks" });
    expect(getClientDiagnosticEvents().some(event => event.code === "generation_bind_refused")).toBe(true);
});

test("missing node is distinguishable from unobserved node and bindings clear with user scope", () => {
    recordCanvasBindingDiagnostic({ phase: "requested", canvasId: "canvas-1", nodeId: "deleted", outputIndex: 0, task: { id: "paid-video" } as GenerationTask });
    expect(getClientDiagnosticEvents()[0].canvasBinding?.nodePresent).toBeUndefined();
    expect(getClientDiagnosticEvents()[0].canvasBinding?.nodeHasMedia).toBeUndefined();
    recordCanvasBindingDiagnostic({ phase: "requested", canvasId: "canvas-1", nodeId: "deleted", outputIndex: 0, task: { id: "paid-video" } as GenerationTask, project: { nodes: [] } as any });
    expect(getClientDiagnosticEvents()[1].canvasBinding?.nodePresent).toBe(false);
    recordCanvasBindingDiagnostic({ phase: "requested", canvasId: "canvas-1", nodeId: "text", outputIndex: 0, task: { id: "paid-video" } as GenerationTask, project: { nodes: [{id:"text",type:"text",metadata:{content:"private prompt"}}] } as any });
    expect(getClientDiagnosticEvents()[2].canvasBinding?.nodeHasMedia).toBe(false);
    setDiagnosticUserScope("other-user");
    expect(getClientDiagnosticEvents()).toEqual([]);
});
