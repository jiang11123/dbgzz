import type { Dispatch, SetStateAction } from "react";
import { assetResourceId, bindCanvasNodeResourceAsset, canvasNodeResourceId, extractOwnedResourceId } from "@/lib/canvas/canvas-resource-id";
import { assertUserScope, isUserScopeAbandonedError, type CapturedUserScope } from "@/lib/user-scope-guard";
import { CanvasStaleScopeError } from "@/services/canvas-revision-conflict";
import { persistCanvasDocument } from "@/services/local-workspace-repository";
import type { ensureCanvasNodeAsset } from "@/services/project-asset-sync";
import { useAssetStore } from "@/stores/use-asset-store";
import { useCanvasStore, type CanvasProject } from "@/stores/canvas/use-canvas-store";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import type { TimelineDirectMedia } from "@/types/timeline";
import { CanvasGenerationTargetSaveError } from "./canvas-generation-errors";

export function isCanvasMediaAssetGuardError(error: unknown) {
    const message = error instanceof Error ? error.message : error && typeof error === "object" && "message" in error && typeof (error as { message?: unknown }).message === "string" ? (error as { message: string }).message : "";
    return message.includes("画布媒体尚未进入素材库") || message.includes("画布媒体与素材库记录不一致");
}

function propagateBatchRootAssetIds(nodes: CanvasNodeData[]) {
    const byId = new Map(nodes.map((node) => [node.id, node]));
    let changed = false;
    const next = nodes.map((node) => {
        if (!node.metadata?.isBatchRoot || !node.metadata.primaryImageId) return node;
        const primary = byId.get(node.metadata.primaryImageId);
        if (!primary) return node;
        const rootResourceId = canvasNodeResourceId(node);
        const primaryResourceId = canvasNodeResourceId(primary);
        if (!rootResourceId || !primaryResourceId || rootResourceId !== primaryResourceId) return node;
        if (node.metadata?.assetId) return node;
        const primaryAssetId = primary.metadata?.assetId;
        if (!primaryAssetId) return node;
        changed = true;
        return { ...node, metadata: { ...node.metadata, assetId: primaryAssetId } };
    });
    return { nodes: changed ? next : nodes, changed };
}

export function syncInMemoryCanvasProjectMediaAssets(project: CanvasProject): boolean {
    const assets = useAssetStore.getState().assets;
    const firstPass = propagateBatchRootAssetIds(project.nodes);
    let changed = firstPass.changed;
    const boundNodes = firstPass.nodes.map((node) => {
        const bound = bindCanvasNodeResourceAsset(node, firstPass.nodes, assets);
        if (bound !== node) changed = true;
        return bound;
    });
    const secondPass = propagateBatchRootAssetIds(boundNodes);
    if (secondPass.changed) changed = true;
    if (changed) {
        project.nodes = secondPass.nodes;
        useCanvasStore.getState().updateProject(project.id, { nodes: secondPass.nodes });
    }
    return changed;
}

function timelineDirectMediaToNode(media: TimelineDirectMedia): CanvasNodeData {
    const type = media.kind === "audio" ? CanvasNodeType.Audio : media.kind === "video" ? CanvasNodeType.Video : CanvasNodeType.Image;
    return {
        id: media.id,
        type,
        title: media.title,
        position: { x: 0, y: 0 },
        width: media.width || 320,
        height: media.height || (type === CanvasNodeType.Audio ? 120 : 240),
        metadata: {
            assetId: media.assetId,
            content: media.url || media.dataUrl || media.content || "",
            storageKey: media.storageKey,
            naturalWidth: media.width,
            naturalHeight: media.height,
            durationMs: media.durationMs,
            bytes: media.bytes,
            mimeType: media.mimeType,
        },
    };
}

export type HealCanvasProjectMediaAssetsResult = {
    healed: boolean;
    current: boolean;
    nodes: CanvasNodeData[];
    timeline?: CanvasProject["timeline"];
};

export async function healCanvasProjectMediaAssets(
    project: CanvasProject,
    options: {
        ensureNodeAsset?: typeof ensureCanvasNodeAsset;
        signal?: AbortSignal;
        expectedScope: CapturedUserScope;
        liveScope?: () => CapturedUserScope;
        isCurrent?: () => boolean;
        nodesRef?: { current: CanvasNodeData[] };
        setNodes?: Dispatch<SetStateAction<CanvasNodeData[]>>;
    },
): Promise<HealCanvasProjectMediaAssetsResult> {
    const assertScopeActive = () => {
        if (options.signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
        assertUserScope(options.expectedScope, options.liveScope?.());
    };
    const isScopeCurrent = () => (options.isCurrent ? options.isCurrent() : true);

    assertScopeActive();
    if (!isScopeCurrent()) {
        return { healed: false, current: false, nodes: project.nodes, timeline: project.timeline };
    }
    const latest = useCanvasStore.getState().openProject(project.id);
    if (!latest) {
        return { healed: false, current: false, nodes: project.nodes, timeline: project.timeline };
    }
    project = latest;
    const originalNodes = new Map(project.nodes.map((node) => [node.id, node]));
    const originalPageNodes = options.nodesRef ? new Map(options.nodesRef.current.map((node) => [node.id, node])) : originalNodes;
    const originalClips = new Map(project.timeline?.clips.map((clip) => [clip.id, clip]) ?? []);

    const ensure = options.ensureNodeAsset ?? (await import("@/services/project-asset-sync")).ensureCanvasNodeAsset;
    const assets = useAssetStore.getState().assets;

    const clearedNodeIds = new Set<string>();
    const normalizedNodes = project.nodes.map((node) => {
        const resId = canvasNodeResourceId(node);
        if (!resId || !node.metadata?.assetId) return node;
        const declared = assets.find((item) => item.id === node.metadata?.assetId);
        const declaredResId = declared ? assetResourceId(declared) : "";
        if (declared && declaredResId && declaredResId !== resId) {
            clearedNodeIds.add(node.id);
            return { ...node, metadata: { ...node.metadata, assetId: undefined } };
        }
        return node;
    });

    const normalizedById = new Map(normalizedNodes.map((node) => [node.id, node]));
    const ensuredAssetIdByKey = new Map<string, string>();
    const ensuredAssetIdByNodeId = new Map<string, string>();
    const fallbackAssetIdByResource = new Map<string, string>();

    for (const node of normalizedNodes) {
        if (node.type !== CanvasNodeType.Image && node.type !== CanvasNodeType.Video && node.type !== CanvasNodeType.Audio) continue;
        const resId = canvasNodeResourceId(node);
        if (!resId) continue;
        if (node.metadata?.isBatchRoot && node.metadata.primaryImageId && !node.metadata.assetId) {
            const primary = normalizedById.get(node.metadata.primaryImageId);
            if (primary && canvasNodeResourceId(primary) === resId) continue;
        }
        assertScopeActive();
        const declaredAssetId = node.metadata?.assetId || "";
        const ensureKey = `${resId}::${declaredAssetId}`;
        let assetId = ensuredAssetIdByKey.get(ensureKey);
        if (!assetId) {
            if (!isScopeCurrent()) {
                return { healed: false, current: false, nodes: project.nodes, timeline: project.timeline };
            }
            const result = await ensure({
                canvasId: project.id,
                domainProjectId: project.projectId,
                node,
                source: "canvas-manual",
                signal: options.signal,
                expectedScope: options.expectedScope,
            });
            assertScopeActive();
            if (result.assetId) {
                assetId = result.assetId;
                ensuredAssetIdByKey.set(ensureKey, assetId);
                if (!fallbackAssetIdByResource.has(resId)) {
                    fallbackAssetIdByResource.set(resId, assetId);
                }
            }
        }
        if (assetId) {
            ensuredAssetIdByNodeId.set(node.id, assetId);
        }
        if (!isScopeCurrent()) {
            return { healed: false, current: false, nodes: project.nodes, timeline: project.timeline };
        }
    }

    let nodesChanged = clearedNodeIds.size > 0;
    const stampedNodes = normalizedNodes.map((node) => {
        const assetId = ensuredAssetIdByNodeId.get(node.id);
        if (!assetId || node.metadata?.assetId === assetId) return node;
        nodesChanged = true;
        return { ...node, metadata: { ...node.metadata, assetId } };
    });
    const batchPass = propagateBatchRootAssetIds(stampedNodes);
    if (batchPass.changed) nodesChanged = true;
    const healedNodes = batchPass.nodes;

    let timelineChanged = false;
    let healedTimeline = project.timeline;
    if (project.timeline?.clips?.length) {
        const nextClips = [...project.timeline.clips];
        for (let index = 0; index < nextClips.length; index += 1) {
            const clip = nextClips[index];
            const media = clip.directMedia;
            if (!media || media.kind === "text") continue;
            const resId = extractOwnedResourceId(media.storageKey, media.url || media.dataUrl || media.content);
            if (!resId) continue;
            const declaredClipAsset = media.assetId ? assets.find((item) => item.id === media.assetId) : undefined;
            const declaredClipResId = declaredClipAsset ? assetResourceId(declaredClipAsset) : "";
            const declaredClipMismatch = Boolean(declaredClipResId && declaredClipResId !== resId);
            const effectiveClipAssetId = declaredClipMismatch ? undefined : media.assetId;
            const ensureKey = `${resId}::${effectiveClipAssetId || ""}`;
            let assetId = ensuredAssetIdByKey.get(ensureKey) || (!effectiveClipAssetId ? fallbackAssetIdByResource.get(resId) : undefined);
            if (!assetId) {
                if (!isScopeCurrent()) {
                    return { healed: false, current: false, nodes: project.nodes, timeline: project.timeline };
                }
                assertScopeActive();
                const result = await ensure({
                    canvasId: project.id,
                    domainProjectId: project.projectId,
                    node: timelineDirectMediaToNode({ ...media, assetId: effectiveClipAssetId }),
                    source: "canvas-manual",
                    signal: options.signal,
                    expectedScope: options.expectedScope,
                });
                assertScopeActive();
                if (result.assetId) {
                    assetId = result.assetId;
                    ensuredAssetIdByKey.set(ensureKey, assetId);
                    if (!fallbackAssetIdByResource.has(resId)) {
                        fallbackAssetIdByResource.set(resId, assetId);
                    }
                }
                if (!isScopeCurrent()) {
                    return { healed: false, current: false, nodes: project.nodes, timeline: project.timeline };
                }
            }
            const nextAssetId = assetId || effectiveClipAssetId;
            if (media.assetId !== nextAssetId) {
                timelineChanged = true;
                nextClips[index] = { ...clip, directMedia: { ...media, assetId: nextAssetId } };
            }
        }
        if (timelineChanged) {
            healedTimeline = { ...project.timeline, clips: nextClips };
        }
    }

    if (!isScopeCurrent()) {
        return { healed: false, current: false, nodes: project.nodes, timeline: project.timeline };
    }

    assertScopeActive();
    const current = useCanvasStore.getState().openProject(project.id);
    if (!current) return { healed: false, current: false, nodes: [], timeline: undefined };

    // Only apply the binding that was ensured. Media, graph and timeline edits
    // made while awaiting asset registration belong to the current document.
    const healedById = new Map(healedNodes.map((node) => [node.id, node]));
    const stampNodes = (nodes: CanvasNodeData[], originals = originalNodes) =>
        nodes.map((node) => {
            const original = originals.get(node.id);
            const healed = healedById.get(node.id);
            if (!original || !healed || node.type !== original.type || node.type !== healed.type ||
                canvasNodeResourceId(node) !== canvasNodeResourceId(original) || canvasNodeResourceId(node) !== canvasNodeResourceId(healed) ||
                node.metadata?.assetId !== original.metadata?.assetId) return node;
            // A page can lag the synchronous store binding, or already have its
            // own explicit selection that has not reached the store yet.
            if (original.metadata?.assetId && original.metadata.assetId !== originalNodes.get(node.id)?.metadata?.assetId) return node;
            const assetId = healed.metadata?.assetId;
            return node.metadata?.assetId === assetId ? node : { ...node, metadata: { ...node.metadata, assetId } };
        });
    const mergedNodes = stampNodes(current.nodes);
    const healedClips = new Map(healedTimeline?.clips.map((clip) => [clip.id, clip]) ?? []);
    const mergedTimeline = timelineChanged && current.timeline ? {
        ...current.timeline,
        clips: current.timeline.clips.map((clip) => {
            const original = originalClips.get(clip.id)?.directMedia;
            const media = clip.directMedia;
            const healed = healedClips.get(clip.id)?.directMedia;
            if (!original || !media || !healed || media.id !== original.id || media.kind !== original.kind || media.assetId !== original.assetId ||
                extractOwnedResourceId(media.storageKey, media.url || media.dataUrl || media.content) !== extractOwnedResourceId(original.storageKey, original.url || original.dataUrl || original.content)) return clip;
            return media.assetId === healed.assetId ? clip : { ...clip, directMedia: { ...media, assetId: healed.assetId } };
        }),
    } : current.timeline;
    useCanvasStore.getState().updateProject(project.id, { nodes: mergedNodes, ...(mergedTimeline ? { timeline: mergedTimeline } : {}) });
    if (options.nodesRef) options.nodesRef.current = stampNodes(options.nodesRef.current, originalPageNodes);
    options.setNodes?.((nodes) => stampNodes(nodes, originalPageNodes));

    return {
        healed: nodesChanged || timelineChanged,
        current: true,
        nodes: mergedNodes,
        timeline: mergedTimeline,
    };
}

export async function persistCanvasGenerationTarget(input: {
    projectId: string;
    nodeId: string;
    clientOperationId?: string;
    signal?: AbortSignal;
    expectedScope: CapturedUserScope;
    ensureNodeAsset?: typeof ensureCanvasNodeAsset;
    isCurrent?: () => boolean;
}, persist: typeof persistCanvasDocument = persistCanvasDocument) {
    const assertCurrent = () => {
        if (input.signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
        assertUserScope(input.expectedScope);
        if (input.isCurrent && !input.isCurrent()) throw new DOMException("The canvas operation was abandoned", "AbortError");
    };
    const rethrowIfControlError = (error: unknown) => {
        if (isUserScopeAbandonedError(error) || error instanceof CanvasStaleScopeError || (error instanceof Error && error.name === "AbortError")) throw error;
    };
    assertCurrent();
    const project = useCanvasStore.getState().openProject(input.projectId);
    if (!project?.nodes.some((node) => node.id === input.nodeId)) throw new CanvasGenerationTargetSaveError(undefined, "生成节点已不存在，未开始生成");
    if (input.clientOperationId) {
        project.nodes = project.nodes.map((node) => node.id === input.nodeId ? { ...node, metadata: { ...node.metadata, taskClientOperationId: input.clientOperationId, generationSubmissionState: "submitting" } } : node);
        useCanvasStore.getState().updateProject(project.id, { nodes: project.nodes });
    }
    syncInMemoryCanvasProjectMediaAssets(project);
    try {
        await persist(input.projectId, { nodes: project.nodes, connections: project.connections }, input.expectedScope);
    } catch (error) {
        rethrowIfControlError(error);
        if (isCanvasMediaAssetGuardError(error)) {
            try {
                const healed = await healCanvasProjectMediaAssets(project, {
                    ensureNodeAsset: input.ensureNodeAsset,
                    signal: input.signal,
                    expectedScope: input.expectedScope,
                    isCurrent: input.isCurrent,
                });
                if (!healed.current) throw new DOMException("The canvas operation was abandoned", "AbortError");
                assertCurrent();
                const current = useCanvasStore.getState().openProject(input.projectId);
                if (!current) throw new CanvasGenerationTargetSaveError(undefined, "生成节点已不存在，未开始生成");
                await persist(
                    input.projectId,
                    {
                        nodes: current.nodes,
                        connections: current.connections,
                        ...(current.timeline ? { timeline: current.timeline } : {}),
                    },
                    input.expectedScope,
                );
            } catch (retryError) {
                rethrowIfControlError(retryError);
                throw new CanvasGenerationTargetSaveError(retryError);
            }
        } else {
            throw new CanvasGenerationTargetSaveError(error);
        }
    }
    assertCurrent();
    const current = useCanvasStore.getState().openProject(input.projectId);
    if (!current?.nodes.some((node) => node.id === input.nodeId)) {
        // 保存期间的删除也必须提交；旧快照的回执不能让节点在下次打开时重现。
        if (current) await persist(input.projectId, { nodes: current.nodes, connections: current.connections }, input.expectedScope);
        throw new CanvasGenerationTargetSaveError(undefined, "生成节点已不存在，未开始生成");
    }
}
