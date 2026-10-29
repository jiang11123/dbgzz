import { expect, test } from "bun:test";
import { confirmCanvasGeneration, waitForCanvasPreparation } from "@/pages/canvas/canvas-generation-preflight";
import { runCanvasGenerationSubmissionOnce } from "@/lib/canvas/canvas-generation-submission";
import { getClientDiagnosticEvents, recordDiagnosticEvent, setDiagnosticUserScope } from "@/services/diagnostics/client-diagnostics";

test("preparation timeout releases the lock and late reads cannot submit", async () => {
    let resolveRead!: (value: string) => void;
    const read = new Promise<string>((resolve) => { resolveRead = resolve; });
    const locks = new Map<string, Promise<unknown>>();
    let submits = 0;
    const first = runCanvasGenerationSubmissionOnce(locks, "node", async () => {
        await waitForCanvasPreparation(() => read, new AbortController().signal, 5);
        submits++;
    });
    await expect(first).rejects.toThrow("尚未提交生成任务");
    expect(locks.size).toBe(0);
    await runCanvasGenerationSubmissionOnce(locks, "node", async () => { submits++; });
    resolveRead("late");
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(submits).toBe(1);
});

test("aborting preparation settles even when the read never resolves", async () => {
    const controller = new AbortController();
    const pending = waitForCanvasPreparation(() => new Promise(() => {}), controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
});

test("external dialog close resolves cancellation; abort destroys the dialog", async () => {
    let callbacks!: Parameters<Parameters<typeof confirmCanvasGeneration>[0]>[0];
    let destroyed = 0;
    const open = (input: typeof callbacks) => { callbacks = input; return { destroy: () => { destroyed++; } }; };
    const first = confirmCanvasGeneration(open, new AbortController().signal);
    callbacks.afterClose();
    expect(await first).toBe(false);
    const controller = new AbortController();
    const second = confirmCanvasGeneration(open, controller.signal);
    controller.abort();
    callbacks.onOk();
    expect(await second).toBe(false);
    expect(destroyed).toBe(1);
});

test("routine background polling requests never evict generation action or error diagnostics from 500-event ring buffer", () => {
    setDiagnosticUserScope("diag-eviction-test-user");
    recordDiagnosticEvent({
        level: "info",
        category: "action",
        code: "generation_submit_started",
        reason: "validation",
        canvasId: "canvas_1",
        message: "画布生成提交：generation_submit_started (mode=video model=beefapi::kling-video-v3)",
    });
    recordDiagnosticEvent({
        level: "error",
        category: "action",
        code: "generation_preflight_failed",
        reason: "references",
        canvasId: "canvas_1",
        message: "画布生成提交：generation_preflight_failed (mode=video model=beefapi::kling-video-v3 refs=i:2,v:1,a:0,c:0 当前模型无法支持这组输入和参数：最多支持 1 张参考图)",
    });
    for (let i = 0; i < 600; i++) {
        recordDiagnosticEvent({
            level: "info",
            category: "request",
            code: "api_response",
            httpStatus: 200,
            message: `GET /canvas-projects/canvas_1 -> 200`,
        });
    }
    const events = getClientDiagnosticEvents();
    expect(events.length).toBe(500);
    expect(events.some((e) => e.code === "generation_submit_started")).toBe(true);
    expect(events.some((e) => e.code === "generation_preflight_failed" && e.message.includes("最多支持 1 张参考图"))).toBe(true);
});

test("real generation hook handles preparation, cancellation and retry without paid calls", async () => {
    const child = Bun.spawn([process.execPath, "run", "test/fixtures/generation-preflight.fixture.ts"], { cwd: import.meta.dir + "/..", stdout: "pipe", stderr: "pipe" });
    const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ status, stderr }).toEqual({ status: 0, stderr: "" });
    expect(stdout).toContain("PASS: preflight lifecycle");
}, 15000);

