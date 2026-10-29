import { useCallback, useEffect, useLayoutEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { App } from "antd";
import copyToClipboard from "copy-to-clipboard";
import { nanoid } from "nanoid";

import { NODE_DEFAULT_SIZE } from "@/constant/canvas";
import { FOLDER_COLLAPSED_HEIGHT, FOLDER_COLLAPSED_WIDTH, FRAME_HEADER_HEIGHT, getFrameChildIds, getFrameChildren, isFrameNode } from "@/lib/canvas/canvas-frame";
import { alignCanvasNodes, layoutCanvasAuto, layoutCanvasFlow, layoutCanvasNodes, nextCanvasVersionLabel, spreadCanvasNodes, type CanvasAlignmentMode } from "@/lib/canvas/canvas-layout";
import { applyCanvasConnectionPromptSync } from "@/lib/canvas/canvas-resource-references";
import { createCanvasNode, isHiddenBatchChild, removeCanvasNodes } from "@/lib/canvas/canvas-project-domain";
import { isolateCopiedDirectorScenes, isolateCopiedNodeMetadata, nextCopiedNodeTitle } from "@/lib/canvas/canvas-node-copy";
import { canOpenCanvasNodePromptPanel, mediaGeneratorMetadata } from "@/lib/canvas/canvas-node-semantics";
import { getCanvasNodeCreationDisabledReason } from "@/lib/canvas/canvas-feature-availability";
import { CanvasNodeType, type CanvasConnection, type CanvasFolderStyle, type CanvasFolderTheme, type CanvasNodeData, type CanvasNodeMetadata, type CanvasNodeTypeId, type ContextMenuState, type Position } from "@/types/canvas";
import { cloneCanvasDrawing } from "@/lib/canvas/canvas-drawing-storage";
import type { CanvasDrawingEngine } from "@/lib/canvas/canvas-drawing-engine";
import { useEffectiveConfig } from "@/stores/use-config-store";
import { workflowProviderPluginEnabled } from "@/lib/plugins/builtin/workflows";
import { usePluginStore } from "@/stores/use-plugin-store";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import type { DirectorScene } from "@/types/director";
import { isCanvasNodeGenerating } from "@/lib/canvas/canvas-node-task-state";
import { cancelWorkflowRun } from "@/services/api/canvas-workflows";
import { cancelGenerationTask } from "@/services/api/task-center";
import { canvasTaskConfirmation } from "./canvas-task-confirmation";
import { subscribeUserScope } from "@/lib/user-scope";
import { captureUserScope, userScopeMatches } from "@/lib/user-scope-guard";

type CanvasClipboard = {
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
    directorScenes?: DirectorScene[];
};

const CANVAS_NODES_CLIPBOARD_PREFIX = "open-ai-canvas-nodes:";
const CANVAS_NODES_JSON_CLIPBOARD_PREFIX = "open-ai-canvas-nodes-json:";
const CANVAS_NODES_CLIPBOARD_STORAGE_KEY = "open-ai-canvas:nodes-clipboard";

type UseCanvasNodeOperationsOptions = {
    projectId: string;
    viewportScale?: number;
    defaultDrawingEngine: CanvasDrawingEngine;
    nodesRef: { current: CanvasNodeData[] };
    connectionsRef: { current: CanvasConnection[] };
    selectedNodeIdsRef: { current: Set<string> };
    getCanvasCenter: () => Position;
    setNodes: Dispatch<SetStateAction<CanvasNodeData[]>>;
    setConnections: Dispatch<SetStateAction<CanvasConnection[]>>;
    setSelectedNodeIds: Dispatch<SetStateAction<Set<string>>>;
    setSelectedConnectionId: Dispatch<SetStateAction<string | null>>;
    setContextMenu: Dispatch<SetStateAction<ContextMenuState | null>>;
    setDialogNodeId: Dispatch<SetStateAction<string | null>>;
    onNodesDeleted: (removedIds: Set<string>, nextNodes: CanvasNodeData[], removedNodes: CanvasNodeData[]) => void;
};

export function useCanvasNodeOperations({
    projectId,
    viewportScale = 1,
    defaultDrawingEngine,
    nodesRef,
    connectionsRef,
    selectedNodeIdsRef,
    getCanvasCenter,
    setNodes,
    setConnections,
    setSelectedNodeIds,
    setSelectedConnectionId,
    setContextMenu,
    setDialogNodeId,
    onNodesDeleted,
}: UseCanvasNodeOperationsOptions) {
    const { message, modal } = App.useApp();
    const deletionContext = useRef({ projectId });
    if (deletionContext.current.projectId !== projectId) deletionContext.current = { projectId };
    const mounted = useRef(true);
    const deleteConfirmation = useRef<{ destroy?: () => void } | null>(null);
    useLayoutEffect(() => {
        mounted.current = true;
        const dismiss = () => {
            const pending = deleteConfirmation.current;
            deleteConfirmation.current = null;
            pending?.destroy?.();
        };
        const unsubscribe = subscribeUserScope(dismiss);
        return () => {
            mounted.current = false;
            unsubscribe();
            dismiss();
        };
    }, [projectId]);
    const effectiveConfig = useEffectiveConfig();
    const runtimeStatuses = usePluginStore((state) => state.runtimeStatuses);
    const clipboardRef = useRef<CanvasClipboard | null>(null);
    const preferCopiedNodesRef = useRef(false);
    const markerWritePendingRef = useRef(false);
    const markerWriteSequenceRef = useRef(0);
    const internalMarkerWriteRef = useRef(false);
    const [hasCopiedNodes, setHasCopiedNodes] = useState(false);

    const releaseCopiedNodesPastePriority = useCallback(() => {
        if (internalMarkerWriteRef.current) return;
        markerWriteSequenceRef.current += 1;
        markerWritePendingRef.current = false;
        preferCopiedNodesRef.current = false;
    }, []);

    const shouldPreferCopiedNodes = useCallback(() => markerWritePendingRef.current || preferCopiedNodesRef.current, []);

    useEffect(() => {
        window.addEventListener("copy", releaseCopiedNodesPastePriority);
        window.addEventListener("cut", releaseCopiedNodesPastePriority);
        window.addEventListener("blur", releaseCopiedNodesPastePriority);
        return () => {
            window.removeEventListener("copy", releaseCopiedNodesPastePriority);
            window.removeEventListener("cut", releaseCopiedNodesPastePriority);
            window.removeEventListener("blur", releaseCopiedNodesPastePriority);
        };
    }, [releaseCopiedNodesPastePriority]);

    const commitNodes = useCallback((nextNodes: CanvasNodeData[]) => {
        nodesRef.current = nextNodes;
        setNodes(nextNodes);
    }, [nodesRef, setNodes]);

    const commitConnections = useCallback((nextConnections: CanvasConnection[]) => {
        connectionsRef.current = nextConnections;
        setConnections(nextConnections);
    }, [connectionsRef, setConnections]);

    const isolateDirectorCopies = useCallback((copies: CanvasNodeData[], idMap: ReadonlyMap<string, string>, sourceScenes?: DirectorScene[]) => {
        const store = useCanvasStore.getState();
        const project = store.projects.find((item) => item.id === projectId);
        const isolated = isolateCopiedDirectorScenes(copies, sourceScenes || project?.directorScenes || [], idMap);
        if (project && isolated.scenes.length) store.updateProject(projectId, { directorScenes: [...project.directorScenes, ...isolated.scenes] });
        return isolated.nodes;
    }, [projectId]);

    const cloneDrawingForNode = useCallback((source: CanvasNodeData, target: CanvasNodeData, failureMessage: string) => {
        const sourceDrawingId = source.metadata?.drawingId;
        const targetDrawingId = target.metadata?.drawingId;
        if (!projectId || !sourceDrawingId || !targetDrawingId) return;
        void cloneCanvasDrawing(projectId, sourceDrawingId, targetDrawingId).then((saved) => {
            if (!saved) {
                if (source.metadata?.drawingShapeCount) message.warning("原绘图内容未在本机找到，已创建空白副本");
                return;
            }
            // 克隆落盘后提升修订号，确保已经挂载的新卡片重新读取派生预览。
            commitNodes(nodesRef.current.map((node) => node.id === target.id ? {
                ...node,
                metadata: {
                    ...node.metadata,
                    drawingEngine: saved.engine,
                    drawingRevision: saved.revision,
                    drawingUpdatedAt: saved.updatedAt,
                    drawingShapeCount: saved.shapeCount,
                    drawingPageCount: saved.pageCount,
                },
            } : node));
        }).catch(() => message.error(failureMessage));
    }, [commitNodes, message, nodesRef, projectId]);

    const selectNodes = useCallback((ids: Set<string>) => {
        selectedNodeIdsRef.current = ids;
        setSelectedNodeIds(ids);
        setSelectedConnectionId(null);
    }, [selectedNodeIdsRef, setSelectedConnectionId, setSelectedNodeIds]);

    const createNode = useCallback((type: CanvasNodeTypeId, position?: Position, workflowProvider?: "runninghub", metadataOverride?: CanvasNodeMetadata) => {
        const disabledReason = getCanvasNodeCreationDisabledReason(type);
        if (disabledReason) {
            message.info(disabledReason);
            return;
        }
        const selectedWorkflowProvider = type === CanvasNodeType.Config
            ? workflowProvider || (workflowProviderPluginEnabled(runtimeStatuses, "runninghub") ? "runninghub" : undefined)
            : undefined;
        if (selectedWorkflowProvider && !workflowProviderPluginEnabled(runtimeStatuses, selectedWorkflowProvider)) {
            message.error("RunningHub 工作流插件未启用");
            return;
        }
        const workflowTitle = type === CanvasNodeType.Config && selectedWorkflowProvider === "runninghub" ? "RunningHub 工作流" : undefined;
        let metadata: CanvasNodeMetadata | undefined = type === CanvasNodeType.Drawing
            ? { drawingEngine: defaultDrawingEngine }
            : type === CanvasNodeType.Config
                ? { generationMode: "image", workflowProvider: selectedWorkflowProvider || "model" }
                : type === CanvasNodeType.Image || type === CanvasNodeType.Video || type === CanvasNodeType.Audio
                    ? mediaGeneratorMetadata({ generationMode: type === CanvasNodeType.Image ? "image" : type === CanvasNodeType.Video ? "video" : "audio" })
                : undefined;
        if (metadataOverride) metadata = { ...metadata, ...metadataOverride };
        const center = position || getCanvasCenter();
        // Only menu-created nodes use the implicit canvas center; explicit
        // canvas/connection coordinates remain untouched.
        const creationPosition = position || center;
        const node = createCanvasNode(type, creationPosition, metadata);
        // Keep the processing controls below the card within the initial view.
        if (type === CanvasNodeType.Upscale && !position) node.position.y -= 220 / Math.max(0.5, viewportScale || 1);
        if (type === CanvasNodeType.Text) {
            const nextNumber = nodesRef.current.filter((item) => item.type === CanvasNodeType.Text).length + 1;
            node.title = `文本节点 ${nextNumber}`;
        }
        if (type === CanvasNodeType.Image || type === CanvasNodeType.Video || type === CanvasNodeType.Audio) {
            const nextNumber = nodesRef.current.filter((item) => item.type === type).length + 1;
            const label = type === CanvasNodeType.Image ? "图片节点" : type === CanvasNodeType.Video ? "视频节点" : "音频节点";
            node.title = `${label} ${nextNumber}`;
        }
        if (type === CanvasNodeType.MediaConversion) node.title = "智能剪辑";
        if (type === CanvasNodeType.DoubaoAccount) {
            const mode = metadataOverride?.doubaoAccountNode?.mode || "chat";
            const label = mode === "image" ? "豆包图片" : mode === "video" ? "豆包视频" : "豆包文字";
            const count = nodesRef.current.filter((item) => item.type === CanvasNodeType.DoubaoAccount && item.metadata?.doubaoAccountNode?.mode === mode).length + 1;
            node.title = `${label} ${count}`;
            const targetWidth = mode === "video" ? 440 : 380;
            const targetHeight = mode === "video" ? 480 : mode === "image" ? 420 : 380;
            node.position.x += (node.width - targetWidth) / 2;
            node.position.y += (node.height - targetHeight) / 2;
            node.width = targetWidth;
            node.height = targetHeight;
        }
        if (workflowTitle) node.title = workflowTitle;
        commitNodes([...nodesRef.current, node]);
        selectNodes(new Set([node.id]));
        if (type === CanvasNodeType.Script) setDialogNodeId(null);
        if (canOpenCanvasNodePromptPanel(node) && type !== CanvasNodeType.Text) setDialogNodeId(node.id);
    }, [commitNodes, defaultDrawingEngine, effectiveConfig.runningHub.enabled, effectiveConfig.runningHub.workflows.length, getCanvasCenter, message, nodesRef, runtimeStatuses, selectNodes, setDialogNodeId, viewportScale]);

    const createFolder = useCallback((position?: Position, linked?: { id: string; projectId: string; title: string; style: CanvasFolderStyle; theme: CanvasFolderTheme; createdAt: string }) => {
        const folder = createCanvasNode(CanvasNodeType.Frame, position || getCanvasCenter(), {
            frame: {
                collapsed: true,
                expandedWidth: NODE_DEFAULT_SIZE[CanvasNodeType.Frame].width,
                expandedHeight: NODE_DEFAULT_SIZE[CanvasNodeType.Frame].height,
            },
            folder: {
                style: linked?.style || "glass",
                theme: linked?.theme || "aurora",
                createdAt: linked?.createdAt || new Date().toISOString(),
                assetFolderId: linked?.id,
                projectId: linked?.projectId,
            },
        });
        folder.title = linked?.title || "我的文件";
        folder.width = FOLDER_COLLAPSED_WIDTH;
        folder.height = FOLDER_COLLAPSED_HEIGHT;
        commitNodes([...nodesRef.current, folder]);
        selectNodes(new Set([folder.id]));
        message.success(linked ? "素材文件夹已放到画布，打开可浏览其中内容" : "文件夹已创建，可拖入任意非容器节点");
    }, [commitNodes, getCanvasCenter, message, nodesRef, selectNodes]);

    const arrangeSelectedNodes = useCallback((mode: "row" | "column" | "grid" | "flow") => {
        const selected = nodesRef.current.filter((node) => selectedNodeIdsRef.current.has(node.id) && !node.metadata?.locked && !isFrameNode(node));
        if (selected.length < 2) return;
        const positions = mode === "flow" ? layoutCanvasFlow(selected, connectionsRef.current) : layoutCanvasNodes(selected, mode);
        commitNodes(nodesRef.current.map((node) => positions.has(node.id) ? { ...node, position: positions.get(node.id)! } : node));
        message.success(mode === "flow" ? "已按连线整理" : "已整理选中节点");
    }, [commitNodes, connectionsRef, message, nodesRef, selectedNodeIdsRef]);

    const autoArrangeCanvasNodes = useCallback(() => {
        const currentNodes = nodesRef.current;
        const selectedIds = selectedNodeIdsRef.current;
        const hasSelection = selectedIds.size > 0;
        const candidates = currentNodes.filter((node) => {
            if (node.metadata?.locked || isFrameNode(node) || isHiddenBatchChild(node, currentNodes)) return false;
            if (hasSelection) return selectedIds.has(node.id);
            return !node.parentId;
        });
        if (candidates.length < 2) {
            message.info(hasSelection ? "请至少选择两个可整理节点" : "画布中至少需要两个可整理节点");
            return;
        }

        const positions = layoutCanvasAuto(candidates, connectionsRef.current);
        commitNodes(currentNodes.map((node) => positions.has(node.id) ? { ...node, position: positions.get(node.id)! } : node));
        message.success(hasSelection ? "已按媒体分类整理选中节点" : "已按媒体分类整理画布");
    }, [commitNodes, connectionsRef, message, nodesRef, selectedNodeIdsRef]);

    const spreadSelectedNodes = useCallback(() => {
        const currentNodes = nodesRef.current;
        const selected = currentNodes.filter((node) => selectedNodeIdsRef.current.has(node.id) && !node.metadata?.locked && !isFrameNode(node) && !isHiddenBatchChild(node, currentNodes));
        if (selected.length < 2) {
            message.info("请至少选择两个可整理节点");
            return;
        }
        const positions = spreadCanvasNodes(selected);
        if (!positions.size) return;
        commitNodes(currentNodes.map((node) => positions.has(node.id) ? { ...node, position: positions.get(node.id)! } : node));
        message.success("已按相对布局加大间距");
    }, [commitNodes, message, nodesRef, selectedNodeIdsRef]);

    const alignSelectedNodes = useCallback((mode: CanvasAlignmentMode) => {
        const selected = nodesRef.current.filter((node) => selectedNodeIdsRef.current.has(node.id) && !node.metadata?.locked && !isFrameNode(node));
        if (selected.length < 2 || ((mode === "distributeX" || mode === "distributeY") && selected.length < 3)) return;
        const positions = alignCanvasNodes(selected, mode);
        commitNodes(nodesRef.current.map((node) => positions.has(node.id) ? { ...node, position: positions.get(node.id)! } : node));
        message.success(mode === "distributeX" || mode === "distributeY" ? "已等距分布选中节点" : "已对齐选中节点");
    }, [commitNodes, message, nodesRef, selectedNodeIdsRef]);

    const createStoryboardGroup = useCallback(() => {
        const images = nodesRef.current
            .filter((node) => selectedNodeIdsRef.current.has(node.id) && !node.metadata?.locked && node.type === CanvasNodeType.Image && Boolean(node.metadata?.content))
            .sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x);
        if (images.length < 2) {
            message.warning("请至少选择两张已有图片");
            return;
        }
        const gap = 24;
        const padding = 24;
        const columns = Math.min(4, Math.ceil(Math.sqrt(images.length)));
        const rows = Math.ceil(images.length / columns);
        const cellWidth = Math.max(...images.map((node) => node.width));
        const cellHeight = Math.max(...images.map((node) => node.height));
        const left = Math.min(...images.map((node) => node.position.x));
        const top = Math.min(...images.map((node) => node.position.y));
        const frameWidth = padding * 2 + columns * cellWidth + (columns - 1) * gap;
        const frameHeight = FRAME_HEADER_HEIGHT + padding * 2 + rows * cellHeight + (rows - 1) * gap;
        const frame = createCanvasNode(CanvasNodeType.Frame, { x: left + frameWidth / 2 - padding, y: top + frameHeight / 2 - FRAME_HEADER_HEIGHT - padding }, {
            workflowKind: "storyboard",
            workflowTitle: "分镜组",
            frame: { collapsed: false, expandedWidth: frameWidth, expandedHeight: frameHeight },
        });
        frame.title = `分镜组 · ${images.length} 镜`;
        frame.position = { x: left - padding, y: top - FRAME_HEADER_HEIGHT - padding };
        frame.width = frameWidth;
        frame.height = frameHeight;
        const imageIndex = new Map(images.map((node, index) => [node.id, index]));
        const nextNodes: CanvasNodeData[] = [
            ...nodesRef.current.map((node) => {
                const index = imageIndex.get(node.id);
                if (index === undefined) return node;
                const column = index % columns;
                const row = Math.floor(index / columns);
                return {
                    ...node,
                    parentId: frame.id,
                    position: {
                        x: frame.position.x + padding + column * (cellWidth + gap) + (cellWidth - node.width) / 2,
                        y: frame.position.y + FRAME_HEADER_HEIGHT + padding + row * (cellHeight + gap) + (cellHeight - node.height) / 2,
                    },
                    metadata: { ...node.metadata, workflowKind: node.metadata?.workflowKind || "shot", shotIndex: node.metadata?.shotIndex || index + 1 },
                };
            }),
            frame,
        ];
        commitNodes(nextNodes);
        selectNodes(new Set([frame.id]));
        message.success(`已创建 ${images.length} 镜分镜组`);
    }, [commitNodes, message, nodesRef, selectNodes, selectedNodeIdsRef]);

    const createReferenceGroup = useCallback(() => {
        const media = nodesRef.current
            .filter((node) => selectedNodeIdsRef.current.has(node.id) && !node.metadata?.locked && (node.type === CanvasNodeType.Image || node.type === CanvasNodeType.Video) && Boolean(node.metadata?.content))
            .sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x);
        if (media.length < 2) {
            message.warning("请至少选择两个已有图片或视频节点");
            return;
        }
        const gap = 20;
        const padding = 24;
        const columns = Math.min(3, Math.ceil(Math.sqrt(media.length)));
        const rows = Math.ceil(media.length / columns);
        const cellWidth = Math.max(...media.map((node) => node.width));
        const cellHeight = Math.max(...media.map((node) => node.height));
        const left = Math.min(...media.map((node) => node.position.x));
        const top = Math.min(...media.map((node) => node.position.y));
        const frameWidth = padding * 2 + columns * cellWidth + (columns - 1) * gap;
        const frameHeight = FRAME_HEADER_HEIGHT + padding * 2 + rows * cellHeight + (rows - 1) * gap;
        const frame = createCanvasNode(CanvasNodeType.Frame, { x: left + frameWidth / 2, y: top + frameHeight / 2 }, {
            workflowKind: "reference_set",
            workflowTitle: "引用组",
            referenceAssetNodeIds: media.map((node) => node.id),
            frame: { collapsed: false, expandedWidth: frameWidth, expandedHeight: frameHeight },
        });
        frame.title = `引用组 · ${media.length} 项`;
        frame.position = { x: left - padding, y: top - FRAME_HEADER_HEIGHT - padding };
        frame.width = frameWidth;
        frame.height = frameHeight;
        const mediaIndex = new Map(media.map((node, index) => [node.id, index]));
        commitNodes([
            ...nodesRef.current.map((node) => {
                const index = mediaIndex.get(node.id);
                if (index === undefined) return node;
                const column = index % columns;
                const row = Math.floor(index / columns);
                return {
                    ...node,
                    parentId: frame.id,
                    position: {
                        x: frame.position.x + padding + column * (cellWidth + gap) + (cellWidth - node.width) / 2,
                        y: frame.position.y + FRAME_HEADER_HEIGHT + padding + row * (cellHeight + gap) + (cellHeight - node.height) / 2,
                    },
                    metadata: { ...node.metadata, referenceSetId: frame.id },
                };
            }),
            frame,
        ]);
        selectNodes(new Set([frame.id]));
        message.success(`已创建 ${media.length} 项引用组，折叠后可作为路由节点`);
    }, [commitNodes, message, nodesRef, selectNodes, selectedNodeIdsRef]);

    const toggleNodeLocked = useCallback((nodeId: string) => {
        const target = nodesRef.current.find((node) => node.id === nodeId);
        if (!target) return;
        const locked = !target.metadata?.locked;
        commitNodes(nodesRef.current.map((node) => node.id === nodeId ? { ...node, metadata: { ...node.metadata, locked } } : node));
        message.success(locked ? "节点已锁定位置和尺寸" : "节点已解锁");
    }, [commitNodes, message, nodesRef]);

    const removeNodes = useCallback((ids: Set<string>) => {
        if (!ids.size) return;
        const previousNodes = nodesRef.current;
        const previousConnections = connectionsRef.current;
        const result = removeCanvasNodes(previousNodes, ids);
        const removedNodes = previousNodes.filter((node) => result.removedIds.has(node.id));
        const nextConnections = previousConnections.filter((connection) => !result.removedIds.has(connection.fromNodeId) && !result.removedIds.has(connection.toNodeId));
        const nextNodes = applyCanvasConnectionPromptSync(previousNodes, previousConnections, result.nodes, nextConnections);
        commitNodes(nextNodes);
        commitConnections(nextConnections);
        selectNodes(new Set());
        onNodesDeleted(result.removedIds, nextNodes, removedNodes);
    }, [commitConnections, commitNodes, connectionsRef, nodesRef, onNodesDeleted, selectNodes]);

    const deleteNodes = useCallback((ids: Set<string>) => {
        if (!ids.size || deleteConfirmation.current || !mounted.current) return;
        const requestedIds = new Set(ids);
        const removedIds = removeCanvasNodes(nodesRef.current, requestedIds).removedIds;
        const removedNodes = nodesRef.current.filter((node) => removedIds.has(node.id));
        const activeBatchItems = removedNodes.flatMap((node) => node.metadata?.generationBatches?.flatMap((batch) =>
            batch.items.filter((item) => ["waiting", "submitting", "queued", "running"].includes(item.status))) || []);
        const hasActiveWorkflow = removedNodes.some(node => ["queued", "running"].includes(node.metadata?.reusableWorkflow?.run?.status || "") || node.metadata?.reusableWorkflow?.intent);
        if (!hasActiveWorkflow && !removedNodes.some((node) => isCanvasNodeGenerating(node)) && !activeBatchItems.length) {
            removeNodes(requestedIds);
            return;
        }
        const context = deletionContext.current;
        const expectedScope = captureUserScope();
        const pending: { destroy?: () => void } = {};
        deleteConfirmation.current = pending;
        const isCurrent = () => mounted.current && deletionContext.current === context && userScopeMatches(expectedScope);
        const confirmation = modal.confirm({
            ...canvasTaskConfirmation,
            title: "删除正在生成的节点？",
            content: "任务已提交后可能产生费用。",
            okText: "确认删除",
            cancelText: "取消",
            afterClose: () => { if (deleteConfirmation.current === pending) deleteConfirmation.current = null; },
            onOk: async () => {
                if (deleteConfirmation.current !== pending || !isCurrent()) return;
                const currentRemovedIds = removeCanvasNodes(nodesRef.current, requestedIds).removedIds;
                const currentRemovedNodes = nodesRef.current.filter((node) => currentRemovedIds.has(node.id));
                const taskIds = new Set([
                    ...currentRemovedNodes.filter((node) => isCanvasNodeGenerating(node)).map((node) => node.metadata?.taskId),
                    ...currentRemovedNodes.flatMap((node) => node.metadata?.generationBatches?.flatMap((batch) =>
                        batch.items.filter((item) => ["submitting", "queued", "running"].includes(item.status)).map((item) => item.taskId)) || []),
                ].filter((id): id is string => Boolean(id)));
                // Start cancellation before removing nodes; failures must not block deletion.
                const workflowRuns = new Set(currentRemovedNodes.flatMap(node => {
                    const run = node.metadata?.reusableWorkflow?.run;
                    return run && ["queued", "running"].includes(run.status) ? [run.id] : [];
                }));
                const cancellations = [...[...taskIds].map((id) => cancelGenerationTask(id)), ...[...workflowRuns].map(id => cancelWorkflowRun(id, { expectedScope }))];
                removeNodes(requestedIds);
                const results = await Promise.allSettled(cancellations);
                if (isCurrent() && results.some((result) => result.status === "rejected")) {
                    message.warning("节点已删除，未能取消的任务将继续运行。");
                }
            },
        });
        pending.destroy = confirmation.destroy;
    }, [message, modal, nodesRef, removeNodes]);

    const deleteConnection = useCallback((connectionId: string) => {
        const previousNodes = nodesRef.current;
        const previousConnections = connectionsRef.current;
        const nextConnections = previousConnections.filter((item) => item.id !== connectionId);
        const nextNodes = applyCanvasConnectionPromptSync(previousNodes, previousConnections, previousNodes, nextConnections);
        if (nextNodes !== previousNodes) commitNodes(nextNodes);
        commitConnections(nextConnections);
        setSelectedConnectionId((current) => current === connectionId ? null : current);
        setContextMenu((current) => current?.type === "connection" && current.connectionId === connectionId ? null : current);
    }, [commitConnections, commitNodes, connectionsRef, nodesRef, setContextMenu, setSelectedConnectionId]);

    const duplicateNode = useCallback((nodeId: string, duplicateMode: "variant" | "copy" = "variant") => {
        const source = nodesRef.current.find((node) => node.id === nodeId);
        if (!source) return;
        const sources = isFrameNode(source) ? [source, ...getFrameChildren(source.id, nodesRef.current)] : [source];
        const idMap = new Map(sources.map((node, index) => [node.id, `${node.type}-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 7)}`]));
        const versionRootId = duplicateMode === "variant" && !isFrameNode(source) ? source.metadata?.versionOfNodeId || source.id : undefined;
        const versionLabel = versionRootId ? nextCanvasVersionLabel(versionRootId, nodesRef.current) : undefined;
        const copyTitle = duplicateMode === "copy" ? nextCopiedNodeTitle(source.title, nodesRef.current.map((node) => node.title)) : undefined;
        const copiedNodes = isolateDirectorCopies(sources.map((node) => {
            const metadata = isolateCopiedNodeMetadata(node, idMap);
            if (node.type === CanvasNodeType.Drawing) {
                metadata.drawingId = `${idMap.get(node.id)}-document`;
                metadata.drawingRevision = 0;
                metadata.drawingUpdatedAt = undefined;
                metadata.drawingShapeCount = 0;
                metadata.drawingPageCount = 1;
            }
            if (node.id === source.id && versionRootId) {
                metadata.versionOfNodeId = versionRootId;
                metadata.versionLabel = versionLabel;
                metadata.versionPrimary = false;
            }
            return {
                ...node,
                id: idMap.get(node.id)!,
                title: node.id === source.id ? copyTitle || `${node.title.replace(/ · [A-Z]$/, "")} · ${versionLabel || "副本"}` : node.title,
                position: { x: node.position.x + 36, y: node.position.y + 36 },
                parentId: node.parentId ? idMap.get(node.parentId) || node.parentId : undefined,
                metadata,
            };
        }), idMap);
        const copiedIds = new Set(sources.map((node) => node.id));
        const copiedConnections = connectionsRef.current
            .filter((connection) => copiedIds.has(connection.fromNodeId) && copiedIds.has(connection.toNodeId))
            .map((connection) => ({ ...connection, id: nanoid(), fromNodeId: idMap.get(connection.fromNodeId)!, toNodeId: idMap.get(connection.toNodeId)! }));
        if (!isFrameNode(source)) {
            connectionsRef.current.filter((connection) => connection.toNodeId === source.id && !copiedIds.has(connection.fromNodeId)).forEach((connection) => copiedConnections.push({ ...connection, id: nanoid(), toNodeId: idMap.get(source.id)! }));
        }
        const id = idMap.get(source.id)!;
        const nextNodes = [
            ...nodesRef.current.map((node) => node.id === source.id && versionRootId && !node.metadata?.versionLabel ? { ...node, title: `${node.title} · A`, metadata: { ...node.metadata, versionOfNodeId: versionRootId, versionLabel: "A", versionPrimary: true, generationResultPlacement: "replace-node" as const } } : node),
            ...copiedNodes,
        ];
        commitNodes(nextNodes);
        commitConnections([...connectionsRef.current, ...copiedConnections]);
        selectNodes(new Set([id]));
        const sourceByTargetId = new Map(sources.map((sourceNode) => [idMap.get(sourceNode.id), sourceNode]));
        copiedNodes.filter((node) => node.type === CanvasNodeType.Drawing).forEach((targetNode) => {
            const sourceNode = sourceByTargetId.get(targetNode.id);
            if (sourceNode) cloneDrawingForNode(sourceNode, targetNode, "绘图副本保存失败，请重新复制");
        });
        setDialogNodeId(canOpenCanvasNodePromptPanel(copiedNodes.find((node) => node.id === id)) ? id : null);
    }, [cloneDrawingForNode, commitConnections, commitNodes, connectionsRef, isolateDirectorCopies, nodesRef, selectNodes, setDialogNodeId]);

    const setPrimaryVersion = useCallback((nodeId: string) => {
        const target = nodesRef.current.find((node) => node.id === nodeId);
        if (!target) return;
        const rootId = target.metadata?.versionOfNodeId || target.id;
        commitNodes(nodesRef.current.map((node) => (node.metadata?.versionOfNodeId || node.id) === rootId ? { ...node, metadata: { ...node.metadata, versionPrimary: node.id === nodeId } } : node));
        message.success(`已将 ${target.metadata?.versionLabel || target.title} 设为主版本`);
    }, [commitNodes, message, nodesRef]);

    const copyNodesToClipboard = useCallback((targetIds: Set<string>) => {
        if (!targetIds.size) return;
        const copyIds = new Set(targetIds);
        nodesRef.current.forEach((node) => {
            if (targetIds.has(node.id) && isFrameNode(node)) getFrameChildIds(node.id, nodesRef.current).forEach((childId) => copyIds.add(childId));
        });
        const copiedNodes = nodesRef.current
            .filter((node) => copyIds.has(node.id))
            .map((node) => ({ ...node, position: { ...node.position }, metadata: node.metadata ? { ...node.metadata, frame: node.metadata.frame ? { ...node.metadata.frame } : undefined } : undefined }));
        if (!copiedNodes.length) return;
        const copiedConnections = connectionsRef.current.filter((connection) => copyIds.has(connection.fromNodeId) && copyIds.has(connection.toNodeId)).map((connection) => ({ ...connection }));
        const sceneIds = new Set(copiedNodes.map((node) => node.metadata?.directorSceneId));
        const directorScenes = structuredClone((useCanvasStore.getState().projects.find((item) => item.id === projectId)?.directorScenes || []).filter((scene) => sceneIds.has(scene.id)));
        clipboardRef.current = { nodes: copiedNodes, connections: copiedConnections, directorScenes };
        try {
            sessionStorage.setItem(CANVAS_NODES_CLIPBOARD_STORAGE_KEY, JSON.stringify(clipboardRef.current));
        } catch {
            // 大型媒体节点可能超过浏览器存储配额，当前页面内仍可正常粘贴。
        }
        setHasCopiedNodes(true);
        // 写入完成前或写入失败时优先内部节点，避免快速粘贴读到系统残留图片。
        const marker = `${CANVAS_NODES_CLIPBOARD_PREFIX}${Date.now()}:${copiedNodes.length}`;
        const sequence = markerWriteSequenceRef.current + 1;
        markerWriteSequenceRef.current = sequence;
        markerWritePendingRef.current = true;
        preferCopiedNodesRef.current = true;
        try {
            internalMarkerWriteRef.current = true;
            copyToClipboard(marker, { format: "text/plain" });
            internalMarkerWriteRef.current = false;
            if (markerWriteSequenceRef.current !== sequence) return;
            markerWritePendingRef.current = false;
            preferCopiedNodesRef.current = true;
        } catch {
            internalMarkerWriteRef.current = false;
            if (markerWriteSequenceRef.current !== sequence) return;
            markerWritePendingRef.current = false;
            preferCopiedNodesRef.current = true;
        }
    }, [connectionsRef, nodesRef, projectId]);

    const copySelectedNodes = useCallback(() => {
        copyNodesToClipboard(new Set(selectedNodeIdsRef.current));
    }, [copyNodesToClipboard, selectedNodeIdsRef]);

    const pasteCopiedNodes = useCallback((position?: Position) => {
        const clipboard = clipboardRef.current;
        if (!clipboard?.nodes.length) return false;
        const center = position || getCanvasCenter();
        const bounds = clipboard.nodes.reduce((current, node) => ({
            left: Math.min(current.left, node.position.x),
            top: Math.min(current.top, node.position.y),
            right: Math.max(current.right, node.position.x + node.width),
            bottom: Math.max(current.bottom, node.position.y + node.height),
        }), { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity });
        const dx = center.x - (bounds.left + bounds.right) / 2;
        const dy = center.y - (bounds.top + bounds.bottom) / 2;
        const idMap = new Map(clipboard.nodes.map((node, index) => [node.id, `${node.type}-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 7)}`]));
        const copiedSourceIds = new Set(clipboard.nodes.map((node) => node.id));
        const reservedTitles = new Set(nodesRef.current.map((node) => node.title));
        const nextNodes = isolateDirectorCopies(clipboard.nodes.map((node) => {
            const metadata = isolateCopiedNodeMetadata(node, idMap);
            const title = nextCopiedNodeTitle(node.title, reservedTitles);
            reservedTitles.add(title);
            if (node.type === CanvasNodeType.Drawing && metadata) {
                metadata.drawingId = `${idMap.get(node.id)}-document`;
                metadata.drawingRevision = 0;
                metadata.drawingUpdatedAt = undefined;
                metadata.drawingShapeCount = 0;
                metadata.drawingPageCount = 1;
            }
            return {
                ...node,
                id: idMap.get(node.id)!,
                title,
                position: { x: node.position.x + dx, y: node.position.y + dy },
                parentId: node.parentId ? idMap.get(node.parentId) : undefined,
                metadata,
            };
        }), idMap, clipboard.directorScenes);
        // 1) 剪贴板内部连线；2) 仍保留到画布上未复制参考节点的入边（只复制结果节点时常见）。
        const nextConnections = clipboard.connections.flatMap((connection, index) => {
            const fromNodeId = idMap.get(connection.fromNodeId);
            const toNodeId = idMap.get(connection.toNodeId);
            return fromNodeId && toNodeId ? [{ ...connection, id: `conn-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 7)}`, fromNodeId, toNodeId }] : [];
        });
        connectionsRef.current.forEach((connection) => {
            if (!copiedSourceIds.has(connection.toNodeId) || copiedSourceIds.has(connection.fromNodeId)) return;
            const toNodeId = idMap.get(connection.toNodeId);
            if (!toNodeId) return;
            // 参考节点仍在画布上时，粘贴结果应重新挂上同一入边。
            if (!nodesRef.current.some((node) => node.id === connection.fromNodeId)) return;
            nextConnections.push({ ...connection, id: nanoid(), toNodeId });
        });
        commitNodes([...nodesRef.current, ...nextNodes]);
        commitConnections([...connectionsRef.current, ...nextConnections]);
        const sourceByTargetId = new Map(clipboard.nodes.map((sourceNode) => [idMap.get(sourceNode.id), sourceNode]));
        nextNodes.filter((node) => node.type === CanvasNodeType.Drawing).forEach((targetNode) => {
            const sourceNode = sourceByTargetId.get(targetNode.id);
            if (sourceNode) cloneDrawingForNode(sourceNode, targetNode, "绘图副本保存失败，请重新粘贴");
        });
        const topLevelIds = new Set(nextNodes.filter((node) => !node.parentId).map((node) => node.id));
        selectNodes(topLevelIds);
        setContextMenu(null);
        const primaryNode = nextNodes.find((node) => !node.parentId);
        setDialogNodeId(canOpenCanvasNodePromptPanel(primaryNode) ? primaryNode!.id : null);
        return true;
    }, [cloneDrawingForNode, commitConnections, commitNodes, connectionsRef, getCanvasCenter, isolateDirectorCopies, nodesRef, selectNodes, setContextMenu, setDialogNodeId]);

    const restoreCopiedNodesFromText = useCallback((value: string) => {
        const isMarker = value.startsWith(CANVAS_NODES_CLIPBOARD_PREFIX);
        const isLegacyJSON = value.startsWith(CANVAS_NODES_JSON_CLIPBOARD_PREFIX);
        if (!isMarker && !isLegacyJSON) return false;
        try {
            const serialized = isLegacyJSON ? value.slice(CANVAS_NODES_JSON_CLIPBOARD_PREFIX.length) : sessionStorage.getItem(CANVAS_NODES_CLIPBOARD_STORAGE_KEY);
            if (!serialized) return false;
            const parsed = JSON.parse(serialized) as Partial<CanvasClipboard>;
            if (!parsed.nodes?.length) return false;
            clipboardRef.current = { nodes: parsed.nodes, connections: parsed.connections || [], directorScenes: parsed.directorScenes };
            setHasCopiedNodes(true);
            preferCopiedNodesRef.current = true;
            markerWritePendingRef.current = false;
            return true;
        } catch {
            return false;
        }
    }, []);

    return {
        alignSelectedNodes,
        autoArrangeCanvasNodes,
        arrangeSelectedNodes,
        spreadSelectedNodes,
        copyNodesToClipboard,
        copySelectedNodes,
        createFolder,
        createNode,
        createReferenceGroup,
        createStoryboardGroup,
        deleteConnection,
        deleteNodes,
        duplicateNode,
        hasCopiedNodes,
        pasteCopiedNodes,
        restoreCopiedNodesFromText,
        releaseCopiedNodesPastePriority,
        setPrimaryVersion,
        shouldPreferCopiedNodes,
        toggleNodeLocked,
    };
}
