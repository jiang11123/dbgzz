import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import { nanoid } from "nanoid";
import { App } from "antd";
import { channelHasGenerationCredential, isBuiltinBeefAPIChannel, useConfigStore } from "@/stores/use-config-store";
import { CanvasNodeType, type CanvasNodeData, type CanvasConnection } from "@/types/canvas";
import { createDefaultUpscaleSettings, deriveUpscaleBatchState, getUpscaleInputNodes, getUpscaleOutputPosition, upscaleParamsForNode, type CanvasUpscaleBatchItem } from "@/lib/canvas/canvas-upscale";
import { fitNodeSize } from "@/lib/canvas/canvas-node-size";
import { mediaResultMetadata } from "@/lib/canvas/canvas-node-semantics";
import { captureUserScope, assertUserScope, type CapturedUserScope } from "@/lib/user-scope-guard";
import { createUpscaleTask, estimateUpscale } from "@/services/api/media-upscale";
import { findGenerationTaskByOperation, queryGenerationTask, type GenerationTask } from "@/services/api/task-center";
import { syncLocalCanvasSnapshot } from "@/services/local-workspace-sync";
import { flushCanvasStorePersistence, useCanvasStore } from "@/stores/canvas/use-canvas-store";

type Dependencies = {
    projectId: string; nodesRef: { current: CanvasNodeData[] }; connectionsRef: { current: CanvasConnection[] };
    setNodes: Dispatch<SetStateAction<CanvasNodeData[]>>; setConnections: Dispatch<SetStateAction<CanvasConnection[]>>;
    setSelectedNodeIds: Dispatch<SetStateAction<Set<string>>>;
    prepareResource: (node: CanvasNodeData) => Promise<string>;
    observeTask: (task: GenerationTask, nodeId: string, scope: CapturedUserScope) => void;
    bindTask?: (task: GenerationTask, nodeId: string) => void;
};

export function useCanvasUpscaleBatch({ projectId, nodesRef, connectionsRef, setNodes, setConnections, setSelectedNodeIds, prepareResource, observeTask, bindTask }: Dependencies) {
    const { modal } = App.useApp();
    const locks = useRef(new Set<string>());
    const mounted = useRef(true);
    const lifetime = useRef(0);
    useEffect(() => {
        mounted.current = true;
        return () => { mounted.current = false; lifetime.current += 1; };
    }, []);
    const liveProject = useRef(projectId); liveProject.current = projectId;
    const startUpscaleBatch = useCallback(async (processor: CanvasNodeData) => {
        if (locks.current.has(processor.id)) return;
        locks.current.add(processor.id);
        const scope = captureUserScope();
        const capturedLifetime = lifetime.current;
        let expectedBatchId = nodesRef.current.find(n => n.id === processor.id)?.metadata?.upscaleBatch?.id;
        const assertCurrent = () => {
            assertUserScope(scope);
            if (!mounted.current || lifetime.current !== capturedLifetime) throw new Error("画布已关闭，停止提交超分任务");
            if (liveProject.current !== projectId) throw new Error("画布已切换，停止提交超分任务");
            const live = nodesRef.current.find(n => n.id === processor.id);
            if (!live) throw new Error("超分节点已删除，停止提交任务");
            if (live.metadata?.upscaleBatch?.id !== expectedBatchId) throw new Error("超分批次已更换，停止提交旧批次");
        };
        const patch = (transform: (nodes: CanvasNodeData[]) => CanvasNodeData[]) => {
            assertCurrent();
            nodesRef.current = transform(nodesRef.current); setNodes(nodesRef.current);
            useCanvasStore.getState().updateProject(projectId, { nodes: nodesRef.current, connections: connectionsRef.current });
        };
        // Store persistence emits ordinary canvas deltas; never race task.bind with a full snapshot sync.
        const save = async () => { assertCurrent(); await flushCanvasStorePersistence(); assertCurrent(); };
        const confirm = async (items: CanvasUpscaleBatchItem[]) => {
            const waiting = items.filter(item => item.status === "waiting");
            if (!waiting.length) throw new Error(items.find(item => item.error)?.error || "没有可提交的素材");
            const reservation = waiting.reduce((sum, item) => sum + (item.reservation || 0), 0);
            if (!waiting.every(item => Number.isFinite(item.reservation) && item.reservation! > 0)) throw new Error("超分费用尚未确认，请重新获取");
            const accepted = await new Promise<boolean>(resolve => modal.confirm({
                title: "确认开始超分？", content: `共 ${waiting.length} 个素材，预计预留 ¥${reservation.toFixed(2)}。完成后按实际费用结算。`,
                okText: "确认超分", cancelText: "取消", onOk: () => resolve(true), onCancel: () => resolve(false),
            }));
            assertCurrent();
            return accepted;
        };
        try {
            const current = nodesRef.current.find(n => n.id === processor.id);
            if (!current) throw new Error("超分节点已删除");
            let batch = current.metadata?.upscaleBatch;
            let rejectedRetryBlocked = false;
            // Only retry proven pre-admission failures once every paid sibling
            // is terminal and delivered. This checkpoint cannot race an active bind.
            if (batch?.items.some(i => i.status === "rejected") && batch.items.every(i => {
                if (i.status === "rejected") return !i.taskId;
                const output = nodesRef.current.find(n => n.id === i.outputNodeId)?.metadata;
                return (output?.taskStatus === "succeeded" && Boolean(output.content || output.storageKey)) || output?.taskStatus === "failed" || output?.taskStatus === "cancelled";
            })) {
                const defaults = createDefaultUpscaleSettings();
                const settings = structuredClone({ ...defaults, ...current.metadata?.upscale, ...processor.metadata?.upscale,
                    image: { ...defaults.image, ...current.metadata?.upscale?.image, ...processor.metadata?.upscale?.image },
                    video: { ...defaults.video, ...current.metadata?.upscale?.video, ...processor.metadata?.upscale?.video },
                });
                const retried = structuredClone(batch);
                let foundReceipt = false;
                for (const item of retried.items.filter(i => i.status === "rejected")) {
                    const task = await findGenerationTaskByOperation(item.clientOperationId, projectId);
                    assertCurrent();
                    if (task) {
                        item.status = "accepted"; item.taskId = task.id; foundReceipt = true;
                        bindTask?.(task, item.outputNodeId); observeTask(task, item.outputNodeId, scope);
                        continue;
                    }
                    const source = nodesRef.current.find(n => n.id === item.sourceNodeId);
                    if (!source || !settings.channelId) continue;
                    try {
                        const params = upscaleParamsForNode(settings, structuredClone(source), await prepareResource(source));
                        assertCurrent(); const quote = await estimateUpscale(params); assertCurrent();
                        item.params = params; item.status = "waiting"; item.error = undefined; item.reservation = quote.reservation; item.quotedAt = Date.now();
                    } catch (cause) { assertCurrent(); item.error = cause instanceof Error ? cause.message : "素材预检失败"; }
                }
                // An unexpected receipt restores observation first; defer retries
                // until the next explicit click so no checkpoint races its bind.
                if (!foundReceipt) {
                    if (!await confirm(retried.items)) return;
                    batch = retried;
                    patch(nodes => nodes.map(n => {
                        if (n.id === current.id) return { ...n, metadata: { ...n.metadata, upscaleBatch: retried } };
                        const item = retried.items.find(i => i.outputNodeId === n.id && i.status === "waiting");
                        return item ? { ...n, metadata: { ...n.metadata, status: "loading", taskType: `canvas_${item.mediaType}`, generationSubmissionState: undefined, errorDetails: undefined, processingLabel: "等待超分提交", workflowOperation: { id: `${item.mediaType}.ai-upscale`, version: 1, config: { ...item.params }, inputs: [{ nodeId: item.sourceNodeId, port: item.mediaType }, { nodeId: current.id, port: "processor" }] } } } : n;
                    }));
                    await save();
                    await syncLocalCanvasSnapshot(projectId, { nodes: nodesRef.current, connections: connectionsRef.current }, scope);
                    assertCurrent();
                } else {
                    const reconciled = { ...batch, items: batch.items.map(i => {
                        const restored = retried.items.find(r => r.outputNodeId === i.outputNodeId && r.status === "accepted" && r.taskId);
                        return restored ?? i;
                    }) };
                    patch(nodes => nodes.map(n => n.id === current.id ? { ...n, metadata: { ...n.metadata, upscaleBatch: reconciled } } : n));
                    await save();
                    return;
                }
            } else if (batch?.items.some(i => i.status === "rejected")) {
                rejectedRetryBlocked = true;
            }
            if (!batch || (batch.items.length > 0 && deriveUpscaleBatchState(batch, nodesRef.current).succeeded === batch.items.length)) {
                if (!useConfigStore.getState().config.channels.some(channel => channel.enabled !== false && isBuiltinBeefAPIChannel(channel) && channelHasGenerationCredential(channel))) throw new Error("暂无可用超分模型，请连接 BeefTV 内置的官方算力");
                const inputs = structuredClone(getUpscaleInputNodes(processor.id, nodesRef.current, connectionsRef.current));
                if (!inputs.length) throw new Error("请连接可读取的图片或视频");
                const defaults = createDefaultUpscaleSettings();
                const stored = current.metadata?.upscale;
                const passed = processor.metadata?.upscale;
                const settings = structuredClone({ ...defaults, ...stored, ...passed,
                    image: { ...defaults.image, ...stored?.image, ...passed?.image },
                    video: { ...defaults.video, ...stored?.video, ...passed?.video },
                });
                if (!settings.channelId) throw new Error("请选择超分渠道");
                const items: CanvasUpscaleBatchItem[] = [];
                // Complete all resource and estimate checks before any paid request.
                for (const source of inputs) {
                    const item: CanvasUpscaleBatchItem = { sourceNodeId: source.id, sourceTitle: source.title || "素材", mediaType: source.type === CanvasNodeType.Video ? "video" : "image", outputNodeId: nanoid(), clientOperationId: nanoid(), status: "waiting" };
                    try {
                        item.params = upscaleParamsForNode(settings, source, await prepareResource(source));
                        assertCurrent(); const quote = await estimateUpscale(item.params); assertCurrent();
                        item.reservation = quote.reservation; item.quotedAt = Date.now();
                    } catch (cause) {
                        assertCurrent(); item.status = "rejected"; item.error = cause instanceof Error ? cause.message : "素材预检失败";
                    }
                    items.push(item);
                }
                if (!await confirm(items)) return;
                batch = { id: nanoid(), createdAt: Date.now(), items };
                const outputs: CanvasNodeData[] = [];
                const downstreamIds = new Set(connectionsRef.current.filter(c => c.fromNodeId === current.id).map(c => c.toNodeId));
                const reusable = nodesRef.current.filter(n => downstreamIds.has(n.id) && (n.type === CanvasNodeType.Image || n.type === CanvasNodeType.Video) && !n.metadata?.content && !n.metadata?.storageKey && !n.metadata?.taskId && !n.metadata?.taskClientOperationId && !n.metadata?.generationSubmissionState);
                for (const item of items) {
                    const source = inputs.find(n => n.id === item.sourceNodeId)!;
                    const emptyIndex = reusable.findIndex(n => n.type === source.type);
                    const empty = emptyIndex >= 0 ? reusable.splice(emptyIndex, 1)[0] : undefined;
                    if (empty) item.outputNodeId = empty.id;
                    const size = empty?.metadata?.manualSize ? { width: empty.width, height: empty.height } : fitNodeSize(source.metadata?.naturalWidth || source.width, source.metadata?.naturalHeight || source.height);
                    outputs.push({ ...empty, id: item.outputNodeId, type: source.type, title: `${item.sourceTitle} · AI超分`, position: empty?.position ?? getUpscaleOutputPosition(current, 0, [...nodesRef.current, ...outputs], size), ...size,
                        metadata: { ...empty?.metadata, ...mediaResultMetadata("derived", { status: item.status === "rejected" ? "error" : "loading", taskType: `canvas_${item.mediaType}`, generationSubmissionState: item.status === "rejected" ? "rejected" : undefined, errorDetails: item.error, processingLabel: "等待超分提交", generatedFromNodeId: source.id, generatedFromProcessingNodeId: current.id, generationMode: item.mediaType, taskClientOperationId: item.clientOperationId,
                            workflowOperation: { id: `${item.mediaType}.ai-upscale`, version: 1, config: { ...item.params }, inputs: [{ nodeId: source.id, port: item.mediaType }, { nodeId: current.id, port: "processor" }] } }) } });
                }
                const frozen = batch;
                connectionsRef.current = [...connectionsRef.current, ...items.filter(i => !downstreamIds.has(i.outputNodeId)).map(i => ({ id: nanoid(), fromNodeId: current.id, toNodeId: i.outputNodeId }))];
                setConnections(connectionsRef.current);
                patch(nodes => [...nodes.filter(n => !outputs.some(o => o.id === n.id)).map(n => n.id === current.id ? { ...n, metadata: { ...n.metadata, upscaleBatch: frozen } } : n), ...outputs]);
                expectedBatchId = frozen.id;
                await save();
                setSelectedNodeIds(new Set(items.map(i => i.outputNodeId)));
            }
            // Retry a failed initial save only after verifying that no operation
            // has been admitted. Once any receipt exists, task.bind owns results.
            if (batch.items.every(i => i.status === "waiting" || i.status === "rejected")) {
                const receipts = await Promise.all(batch.items.filter(i => i.status === "waiting").map(i => findGenerationTaskByOperation(i.clientOperationId, projectId)));
                assertCurrent();
                if (receipts.every(task => !task)) {
                    await syncLocalCanvasSnapshot(projectId, { nodes: nodesRef.current, connections: connectionsRef.current }, scope);
                    assertCurrent();
                }
            }
            const batchId = batch.id;
            const update = (item: CanvasUpscaleBatchItem, values: Partial<CanvasUpscaleBatchItem>) => {
                Object.assign(item, values);
                patch(nodes => nodes.map(n => n.id === processor.id && n.metadata?.upscaleBatch?.id === batchId ? { ...n, metadata: { ...n.metadata, upscaleBatch: { ...n.metadata.upscaleBatch, items: n.metadata.upscaleBatch.items.map(i => i.outputNodeId === item.outputNodeId ? { ...i, ...values } : i) } } } : n));
            };
            for (const original of batch.items) {
                const item = { ...original };
                assertCurrent();
                if (!nodesRef.current.some(n => n.id === item.outputNodeId)) continue;
                if (item.status === "rejected") continue;
                if (item.status !== "waiting") {
                    try {
                        const task = item.taskId ? await queryGenerationTask(item.taskId, { expectedScope: scope }) : await findGenerationTaskByOperation(item.clientOperationId, projectId);
                        assertCurrent();
                        if (task) { update(item, { status: "accepted", taskId: task.id, error: undefined }); bindTask?.(task, item.outputNodeId); observeTask(task, item.outputNodeId, scope); }
                    } catch { /* Unknown receipts remain blocked; never infer permission to resubmit. */ }
                    assertCurrent();
                    continue;
                }
                // A durable backend batch can still say waiting after a lost receipt. Always
                // reconcile the same operation before dispatching a waiting item.
                let existing: GenerationTask | undefined;
                try {
                    existing = await findGenerationTaskByOperation(item.clientOperationId, projectId);
                    assertCurrent();
                } catch (cause) {
                    assertCurrent();
                    update(item, { status: "waiting", error: cause instanceof Error ? cause.message : "原任务查询失败，尚未提交，可继续查询原操作" });
                    continue;
                }
                if (existing) {
                    update(item, { status: "accepted", taskId: existing.id, error: undefined });
                    bindTask?.(existing, item.outputNodeId); observeTask(existing, item.outputNodeId, scope);
                    continue;
                }
                if (!item.params) { update(item, { status: "rejected", error: "缺少已冻结的提交参数，请重新配置新批次" }); continue; }
                if (!item.quotedAt || Date.now() - item.quotedAt > 60_000) {
                    update(item, { status: "rejected", error: "费用预估已过期，请重新确认费用" });
                    await save();
                    continue;
                }
                if (!useConfigStore.getState().config.channels.some(channel => channel.enabled !== false && isBuiltinBeefAPIChannel(channel) && channelHasGenerationCredential(channel))) {
                    update(item, { status: "rejected", error: "暂无可用超分模型，请连接 BeefTV 内置的官方算力" });
                    await save();
                    continue;
                }
                update(item, { status: "submitting" });
                patch(nodes => nodes.map(n => n.id === item.outputNodeId ? { ...n, metadata: { ...n.metadata, generationSubmissionState: "submitting" } } : n));
                // Persist the intent before POST. A crash from this point is uncertain, never waiting.
                await save();
                if (!nodesRef.current.some(n => n.id === item.outputNodeId)) continue;
                try {
                    const task = await createUpscaleTask({ ...item.params, clientOperationId: item.clientOperationId, projectId, nodeId: item.outputNodeId });
                    assertCurrent(); update(item, { status: "accepted", taskId: task.id, error: undefined });
                    patch(nodes => nodes.map(n => n.id === item.outputNodeId ? { ...n, metadata: { ...n.metadata, taskId: task.id, taskStatus: task.status, generationSubmissionState: "accepted" } } : n));
                    bindTask?.(task, item.outputNodeId); observeTask(task, item.outputNodeId, scope);
                } catch (cause) {
                    assertCurrent(); update(item, { status: "unknown", error: cause instanceof Error ? cause.message : "提交回执待确认" });
                    patch(nodes => nodes.map(n => n.id === item.outputNodeId ? { ...n, metadata: { ...n.metadata, generationSubmissionState: "unknown", errorDetails: "提交状态待确认，请查询原任务，暂勿重复提交" } } : n));
                }
                await save();
            }
            if (rejectedRetryBlocked) throw new Error("等待其他项完成后重试未提交项");
        } finally { locks.current.delete(processor.id); }
    }, [projectId, nodesRef, connectionsRef, setNodes, setConnections, setSelectedNodeIds, prepareResource, observeTask, bindTask, modal]);
    return { startUpscaleBatch, resumeUpscaleBatch: startUpscaleBatch };
}
