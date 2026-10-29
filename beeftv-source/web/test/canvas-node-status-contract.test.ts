import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const nodeSource = readFileSync(new URL("../src/components/canvas/canvas-node.tsx", import.meta.url), "utf8");
const contentSource = readFileSync(new URL("../src/components/canvas/canvas-node-content.tsx", import.meta.url), "utf8");
const progressSource = readFileSync(new URL("../src/components/canvas/canvas-node-generation-progress.tsx", import.meta.url), "utf8");

test("canvas nodes expose a stable generation status for visual audits", () => {
    expect(nodeSource).toContain('data-node-status={data.metadata?.status || "idle"}');
    expect(nodeSource).toContain("data-task-id={data.metadata?.taskId || undefined}");
    expect(nodeSource).toContain("data-task-cancellable=");
    expect(contentSource).toContain("<CanvasNodeGenerationProgress");
    expect(progressSource).toContain("生成中");
    expect(nodeSource).toContain('aria-label={resultPending ? "结果待放入画布" : "生成失败"}');
    expect(nodeSource).toContain('aria-label="生成完成"');
});

test("loading and error states keep user recovery actions available", () => {
    expect(contentSource).toContain("onOpenTaskDetails={props.onOpenTaskDetails}");
    expect(contentSource).toContain("onCancelTask={props.onCancelTask}");
    expect(progressSource).toContain("onOpenTaskDetails?.(node)");
    expect(progressSource).toContain("onCancelTask(node)");
    expect(contentSource).toContain("重新生成");
});
