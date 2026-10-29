import { expect, test } from "bun:test";
import { canvasNodeNeedsGenerationRecovery, carryGenerationRecoveryRestore, consumeGenerationRecoveryRestore, isGenerationRecoveryRestored, resetInterruptedGeneration } from "@/lib/canvas/canvas-project-generation";
import { normalizeCanvasMediaNodeSemanticsList } from "@/lib/canvas/canvas-node-semantics";
import { mergeCanvasRefreshPatch } from "@/lib/canvas/canvas-patch-merge";
import { proposalCanvasContent } from "@/pages/canvas/canvas-assistant-proposal-snapshot";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
import { CanvasNodeType, type CanvasNodeData, type CanvasNodeMetadata } from "@/types/canvas";

const node = (id: string, metadata?: CanvasNodeMetadata, type = CanvasNodeType.Image): CanvasNodeData => ({ id, type, title: id, position: { x: 0, y: 0 }, width: 320, height: 320, metadata });

const recoverable: Array<[string, CanvasNodeData]> = [
    ["loading without a task", node("loading", { status: "loading" })],
    ["loading with a task", node("loading-task", { status: "loading", taskId: "t1" })],
    ["failed with a task", node("error-task", { status: "error", taskId: "t2", taskStatus: "failed" })],
    ["succeeded without content", node("empty", { status: "success", taskId: "t3", taskStatus: "succeeded" })],
    ["pending agent continuation", node("continuation", { status: "success", content: "/c", agentGenerationContinuation: { id: "c", taskId: "t4", status: "pending" } })],
    ["older interrupted node", node("legacy", { status: "error", errorDetails: "页面刷新后生成已中断，请重新生成。" })],
];
const settled: Array<[string, CanvasNodeData]> = [
    ["result target no longer accepts the task", node("target-unavailable", { status: "error", taskId: "t-unavailable", taskStatus: "succeeded", generationErrorCode: "result_target_unavailable" })],
    ["finished with content", node("done", { status: "success", taskId: "t5", taskStatus: "succeeded", content: "/x", storageKey: "resource:x" })],
    ["upload in progress", node("upload", { fileUpload: "uploading", fileUploadProgress: 30 })],
    ["aggregate batch root", node("root", { status: "loading", isBatchRoot: true, batchChildIds: ["a", "b"] })],
    ["plain error without a task", node("plain-error", { status: "error", errorDetails: "生成失败" })],
    ["no metadata", node("empty-meta")],
];

for (const [label, item] of recoverable) test(`recovery covers: ${label}`, () => {
    expect(canvasNodeNeedsGenerationRecovery(item)).toBe(true);
});
for (const [label, item] of settled) test(`recovery skips: ${label}`, () => {
    expect(canvasNodeNeedsGenerationRecovery(item)).toBe(false);
});

test("restoring a snapshot hands exactly the recoverable nodes to recovery", () => {
    const restored = resetInterruptedGeneration([...recoverable, ...settled].map(([, item]) => item));
    for (const item of restored) expect(isGenerationRecoveryRestored(item)).toBe(canvasNodeNeedsGenerationRecovery(item));
    // The visible restore text stays as before; it is not the control signal.
    expect(restored.find((item) => item.id === "loading")?.metadata?.errorDetails).toBe("正在从任务中心恢复生成状态...");
});

test("the restore record survives the load normalization and is handed out once, in every copy", () => {
    const [restored] = normalizeCanvasMediaNodeSemanticsList(resetInterruptedGeneration([node("video", { status: "loading", taskId: "t6" }, CanvasNodeType.Video)]));
    expect(isGenerationRecoveryRestored(restored)).toBe(true);
    const copy = { ...restored, metadata: { ...restored.metadata, taskProgress: 10 } };
    consumeGenerationRecoveryRestore([restored]);
    expect(isGenerationRecoveryRestored(restored)).toBe(false);
    expect(isGenerationRecoveryRestored(copy)).toBe(false);
});

test("nodes that did not come from a restore are never treated as restored", () => {
    const live = node("live", { status: "loading" });
    expect(isGenerationRecoveryRestored(live)).toBe(false);
    // The proposal check runs the same restore step on the live nodes; that must not mark them.
    proposalCanvasContent([live], []);
    expect(isGenerationRecoveryRestored(live)).toBe(false);
    // A saved or cloned copy (what a refresh brings back) carries no record.
    const [restored] = resetInterruptedGeneration([node("saved", { status: "loading", taskId: "t7" })]);
    expect(isGenerationRecoveryRestored(JSON.parse(JSON.stringify(restored)))).toBe(false);
    expect(isGenerationRecoveryRestored(structuredClone(restored))).toBe(false);
});

test("the restore record adds nothing to the saved node", () => {
    const source = node("pending", { status: "error", taskId: "t8", taskStatus: "failed" });
    const [restored] = resetInterruptedGeneration([source]);
    expect(isGenerationRecoveryRestored(restored)).toBe(true);
    expect(Object.keys(restored.metadata!)).toEqual(Object.keys(source.metadata!));
    expect(JSON.stringify(restored.metadata)).toBe(JSON.stringify(source.metadata));
    expect(proposalCanvasContent([restored], [])).toBe(proposalCanvasContent([source], []));
});

test("a late task survives the real three-way merge with a prompt edited on the same node", () => {
    const cached = node("same-node", { status: "idle", prompt: "Original prompt" });
    const project: CanvasProject = { id: "canvas", title: "Canvas", nodes: [cached], connections: [], chatSessions: [], activeChatId: null, viewport: { x: 0, y: 0, k: 1 }, createdAt: "2026-10-01", updatedAt: "2026-10-01" };
    const live = [{ ...cached, metadata: { ...cached.metadata, prompt: "Unsaved local prompt" } }];
    const restored = resetInterruptedGeneration([{ ...cached, metadata: { ...cached.metadata, status: "loading", taskId: "late-task", taskStatus: "running" } }]);
    const merged = mergeCanvasRefreshPatch(project, { ...project, nodes: restored }, live, []).nodes;
    // The persisted-field merge deliberately does not own the in-memory restore record.
    expect(isGenerationRecoveryRestored(merged[0])).toBe(false);
    const adopted = carryGenerationRecoveryRestore(merged, restored);
    expect(adopted[0].metadata?.prompt).toBe("Unsaved local prompt");
    expect(adopted[0].metadata?.taskId).toBe("late-task");
    expect(isGenerationRecoveryRestored(adopted[0])).toBe(true);
    expect(adopted[0]).not.toBe(merged[0]);
    // All copies share one claim, including the observed incoming snapshot.
    const copy = { ...adopted[0], metadata: { ...adopted[0].metadata } };
    consumeGenerationRecoveryRestore([adopted[0]]);
    for (const item of [restored[0], adopted[0], copy]) expect(isGenerationRecoveryRestored(item)).toBe(false);
    expect(carryGenerationRecoveryRestore(merged, restored)).toBe(merged);
});

test("carrying restore records preserves identity when there is nothing to add", () => {
    const restored = resetInterruptedGeneration([node("pending", { status: "loading", taskId: "same-task" })]);
    expect(carryGenerationRecoveryRestore(restored, restored)).toBe(restored);
    expect(carryGenerationRecoveryRestore(restored, [])).toBe(restored);
    const completed = [node("pending", { status: "success", taskId: "same-task", content: "/result" })];
    expect(carryGenerationRecoveryRestore(completed, restored)).toBe(completed);
    expect(isGenerationRecoveryRestored(completed[0])).toBe(false);
});

for (const [label, replacement] of [
    ["task", { taskId: "new-task" }],
    ["submission", { taskClientOperationId: "new-operation" }],
    ["continuation", { agentGenerationContinuation: { id: "new-continuation", taskId: "continuation-task", status: "pending" } }],
    ["continuation task", { agentGenerationContinuation: { id: "continuation", taskId: "new-continuation-task", status: "pending" } }],
] satisfies Array<[string, CanvasNodeMetadata]>) test(`a restored record cannot claim a different ${label}`, () => {
    const source = node("pending", { status: "loading", taskId: "old-task", taskClientOperationId: "old-operation", agentGenerationContinuation: { id: "continuation", taskId: "continuation-task", status: "pending" } });
    const restored = resetInterruptedGeneration([source]);
    const live = [{ ...source, metadata: { ...source.metadata, ...replacement } }];
    expect(carryGenerationRecoveryRestore(live, restored)).toBe(live);
    expect(isGenerationRecoveryRestored(live[0])).toBe(false);
    expect(isGenerationRecoveryRestored(restored[0])).toBe(true);
});
