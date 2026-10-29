import React, { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { AlertCircle, BookOpenCheck, CheckCircle2, ChevronRight, Clapperboard, Copy, Download, FileText, GripVertical, Image as ImageIcon, Lock, Maximize2, MessageSquareText, Move3d, Music2, Pencil, RefreshCw, ScanSearch, Settings2, Star, Trash2, Video, WandSparkles } from "lucide-react";

import { useCanvasNodeActions } from "./canvas-node-action-context";
import { shouldBlockManualRetry } from "@/lib/generation-error";

import { canvasThemes } from "@/lib/canvas-theme";
import { canvasConnectionTilt } from "@/lib/canvas/canvas-connection-tilt";
import { storyboardMinNodeHeight } from "@/lib/canvas/canvas-storyboard-layout";
import { useActiveTheme } from "@/stores/canvas/use-canvas-theme-store";
import { CanvasNodeType, type CanvasNodeData, type CanvasNodeTypeId, type Position } from "@/types/canvas";
import type { CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";
import { ART_CRITIQUE_NODE_TYPE } from "@/lib/art-critique/contracts";
import { getNodeDefinition, getNodeMinSize, shouldKeepAspectRatio } from "@/lib/canvas/node-registry";
import { CanvasNodeContent } from "./canvas-node-content";
import { CanvasVideoCropEditor, type CanvasVideoCropRect } from "./canvas-video-crop-dialog";
import { CanvasImageCropEditor, type CanvasImageCropRect } from "./canvas-node-crop-dialog";
import { CanvasImageAnnotationEditor } from "./canvas-node-annotation-dialog";
import { CanvasImageMaskEditor, type CanvasImageMaskEditPayload } from "./canvas-node-mask-edit-dialog";
import type { AiConfig } from "@/stores/use-config-store";
import { canvasMediaNodeOrigin, canvasMediaNodeRole } from "@/lib/canvas/canvas-node-semantics";

type ResizeCorner = "top-left" | "top-right" | "bottom-left" | "bottom-right";
type CanvasTheme = (typeof canvasThemes)[keyof typeof canvasThemes];

type CanvasNodeProps = {
    data: CanvasNodeData;
    dragOffset?: Position;
    scale: number;
    isSelected: boolean;
    mediaActive?: boolean;
    isRelated: boolean;
    isFocusRelated: boolean;
    isConnectionTarget: boolean;
    connectionApproach?: Position;
    forceInputVisible?: boolean;
    showImageInfo: boolean;
    reduceMediaEffects?: boolean;
    readOnly?: boolean;
    resourceLabel?: CanvasResourceReference;
    mentionReferences?: CanvasResourceReference[];
    renderNodeContent?: (node: CanvasNodeData) => ReactNode;
    drawingProjectId?: string;
    batchCount?: number;
    batchPreviewNodes?: CanvasNodeData[];
    batchExpanded?: boolean;
    batchClosing?: boolean;
    batchOpening?: boolean;
    batchRecovering?: boolean;
    batchPrimary?: boolean;
    batchMotion?: { x: number; y: number; index: number };
    onMouseDown: (event: React.MouseEvent, nodeId: string) => void;
    onHoverStart: (nodeId: string) => void;
    onHoverEnd: (nodeId: string) => void;
    onConnectStart: (event: React.PointerEvent, nodeId: string, handleType: "source" | "target", handleId?: string, anchorRatio?: number) => void;
    onResize: (nodeId: string, width: number, height: number, position?: Position) => void;
    onTitleChange?: (nodeId: string, title: string) => void;
    onContentChange: (nodeId: string, content: string) => void;
    onToggleBatch?: (nodeId: string) => void;
    onSetBatchPrimary?: (node: CanvasNodeData) => void;
    onRetry?: (node: CanvasNodeData) => void;
    onReloadResource?: (node: CanvasNodeData) => void;
    onOpenTaskDetails?: (node: CanvasNodeData) => void;
    onCancelTask?: (node: CanvasNodeData) => void;
    onOpenVersions?: (node: CanvasNodeData) => void;
    onViewImage?: (node: CanvasNodeData) => void;
    onReplaceMedia?: (node: CanvasNodeData) => void;
    onOpenTextEditor?: (node: CanvasNodeData) => void;
    onOpenDrawing?: (node: CanvasNodeData) => void;
    onMediaPlayRequest?: (nodeId: string) => void;
    imageCropActive?: boolean;
    onCancelImageCrop?: () => void;
    onConfirmImageCrop?: (node: CanvasNodeData, crop: CanvasImageCropRect) => void | Promise<void>;
    annotationActive?: boolean;
    onCancelAnnotation?: () => void;
    onConfirmAnnotation?: (node: CanvasNodeData, dataUrl: string) => void | Promise<void>;
    maskEditActive?: boolean;
    maskEditConfig?: AiConfig;
    onCancelMaskEdit?: () => void;
    onConfirmMaskEdit?: (node: CanvasNodeData, payload: CanvasImageMaskEditPayload) => void | Promise<void>;
    videoCropActive?: boolean;
    onCancelVideoCrop?: () => void;
    onConfirmVideoCrop?: (node: CanvasNodeData, crop: CanvasVideoCropRect, sourceDimensions: { width: number; height: number }) => void | Promise<void>;
    onContextMenu: (event: React.MouseEvent, nodeId: string) => void;
};

export const CanvasNode = React.memo(function CanvasNode({
    data,
    dragOffset,
    scale,
    isSelected,
    mediaActive = false,
    isRelated,
    isFocusRelated,
    isConnectionTarget,
    connectionApproach,
    forceInputVisible = false,
    reduceMediaEffects = false,
    readOnly = false,
    mentionReferences = [],
    renderNodeContent,
    drawingProjectId,
    batchCount = 0,
    batchPreviewNodes,
    batchExpanded = false,
    batchClosing = false,
    batchOpening = false,
    batchRecovering = false,
    batchPrimary = false,
    batchMotion,
    onMouseDown,
    onHoverStart,
    onHoverEnd,
    onConnectStart,
    onResize,
    onTitleChange,
    onContentChange,
    onToggleBatch,
    onSetBatchPrimary,
    onRetry,
    onReloadResource,
    onOpenTaskDetails,
    onCancelTask,
    onOpenVersions,
    onViewImage,
    onOpenTextEditor,
    onOpenDrawing,
    onMediaPlayRequest,
    imageCropActive = false,
    onCancelImageCrop,
    onConfirmImageCrop,
    annotationActive = false,
    onCancelAnnotation,
    onConfirmAnnotation,
    maskEditActive = false,
    maskEditConfig,
    onCancelMaskEdit,
    onConfirmMaskEdit,
    videoCropActive = false,
    onCancelVideoCrop,
    onConfirmVideoCrop,
    onContextMenu,
}: CanvasNodeProps) {
    const theme = canvasThemes[useActiveTheme()];
    const [hovered, setHovered] = useState(false);
    const [isEditingContent, setIsEditingContent] = useState(false);
    const [isEditingTitle, setIsEditingTitle] = useState(false);
    const [titleDraft, setTitleDraft] = useState(data.title);
    const { download: downloadNode, duplicate: duplicateNode, deleteNode } = useCanvasNodeActions();
    const hasImageContent = data.type === CanvasNodeType.Image && Boolean(data.metadata?.content);
    const hasVideoContent = data.type === CanvasNodeType.Video && Boolean(data.metadata?.content);
    const hasAudioContent = data.type === CanvasNodeType.Audio && Boolean(data.metadata?.content || data.metadata?.storageKey);
    const isComposerNode = data.type === CanvasNodeType.Config;
    const isDirectorNode = data.type === CanvasNodeType.Director || Boolean(data.metadata?.directorSceneId);
    const isBatchRoot = data.type === CanvasNodeType.Image && Boolean(data.metadata?.isBatchRoot) && batchCount > 1;
    const isBatchChild = data.type === CanvasNodeType.Image && Boolean(data.metadata?.batchRootId);
    const showStatusTrack = Boolean(data.metadata?.locked || isBatchRoot || (isBatchChild && !readOnly));
    const isActive = isConnectionTarget || isSelected || isFocusRelated;
    const nodeState = isFocusRelated ? "focus" : isConnectionTarget ? "target" : isSelected ? "selected" : isRelated && !isBatchChild ? "related" : "idle";
    const showOutputConnection = getNodeDefinition(data.type)?.showOutputConnection !== false;
    const scriptMinHeight = data.type === CanvasNodeType.Script ? storyboardMinNodeHeight(data.metadata?.storyboardComposerHeight) : null;
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const resizeRef = useRef({
        isResizing: false,
        corner: "bottom-right" as ResizeCorner,
        startX: 0,
        startY: 0,
        startLeft: 0,
        startTop: 0,
        startWidth: 0,
        startHeight: 0,
        keepRatio: false,
        ratio: 1,
    });

    useEffect(() => {
        const textarea = textareaRef.current;
        if (!textarea) return;

        const handleWheel = (event: WheelEvent) => event.stopPropagation();
        textarea.addEventListener("wheel", handleWheel, { passive: false });
        return () => textarea.removeEventListener("wheel", handleWheel);
    }, [data.type, isEditingContent]);

    useEffect(() => {
        if (!isEditingContent) return;
        const textarea = textareaRef.current;
        textarea?.focus();
        textarea?.setSelectionRange(textarea.value.length, textarea.value.length);
    }, [isEditingContent]);

    useEffect(() => {
        if (!isEditingTitle) setTitleDraft(data.title);
    }, [data.title, isEditingTitle]);

    useEffect(() => {
        if (!isEditingContent) return;

        const handleOutsidePointerDown = (event: PointerEvent) => {
            const target = event.target;
            if (!(target instanceof Node)) return;
            if (isEditingContent && textareaRef.current?.contains(target)) return;

            setIsEditingContent(false);
        };

        window.addEventListener("pointerdown", handleOutsidePointerDown, true);
        return () => window.removeEventListener("pointerdown", handleOutsidePointerDown, true);
    }, [isEditingContent]);

    const handleResizeMove = useCallback(
        (event: MouseEvent) => {
            if (!resizeRef.current.isResizing) return;

            const dx = (event.clientX - resizeRef.current.startX) / scale;
            const dy = (event.clientY - resizeRef.current.startY) / scale;
            const minSize = getNodeMinSize(data.type);
            const minWidth = minSize.width;
            // 分镜脚本的高度由表格内容动态撑开，覆盖注册表里的静态下限。
            const minHeight = scriptMinHeight || minSize.height;
            const startRight = resizeRef.current.startLeft + resizeRef.current.startWidth;
            const startBottom = resizeRef.current.startTop + resizeRef.current.startHeight;
            const fromLeft = resizeRef.current.corner.includes("left");
            const fromTop = resizeRef.current.corner.includes("top");
            const rawWidth = Math.max(minWidth, resizeRef.current.startWidth + (fromLeft ? -dx : dx));
            const rawHeight = Math.max(minHeight, resizeRef.current.startHeight + (fromTop ? -dy : dy));
            let width = rawWidth;
            let height = rawHeight;
            if (resizeRef.current.keepRatio) {
                const ratio = resizeRef.current.ratio;
                if (Math.abs(dx) >= Math.abs(dy)) {
                    height = width / ratio;
                } else {
                    width = height * ratio;
                }
                if (height < minHeight) {
                    height = minHeight;
                    width = height * ratio;
                }
                if (width < minWidth) {
                    width = minWidth;
                    height = width / ratio;
                }
            }

            onResize(data.id, width, height, {
                x: fromLeft ? startRight - width : resizeRef.current.startLeft,
                y: fromTop ? startBottom - height : resizeRef.current.startTop,
            });
        },
        [data.id, data.type, onResize, scale, scriptMinHeight],
    );

    const handleResizeUp = useCallback(() => {
        resizeRef.current.isResizing = false;
        window.removeEventListener("mousemove", handleResizeMove);
        window.removeEventListener("mouseup", handleResizeUp);
    }, [handleResizeMove]);

    const handleResizeMouseDown = (event: React.MouseEvent, corner: ResizeCorner) => {
        event.stopPropagation();
        event.preventDefault();
        resizeRef.current = {
            isResizing: true,
            corner,
            startX: event.clientX,
            startY: event.clientY,
            startLeft: data.position.x,
            startTop: data.position.y,
            startWidth: data.width,
            startHeight: data.height,
            keepRatio: shouldKeepAspectRatio(data),
            ratio: (data.metadata?.naturalWidth || data.width) / (data.metadata?.naturalHeight || data.height || 1),
        };
        window.addEventListener("mousemove", handleResizeMove);
        window.addEventListener("mouseup", handleResizeUp);
    };

    useEffect(() => {
        return () => {
            window.removeEventListener("mousemove", handleResizeMove);
            window.removeEventListener("mouseup", handleResizeUp);
        };
    }, [handleResizeMove, handleResizeUp]);

    const commitTitle = () => {
        const next = titleDraft.trim();
        setIsEditingTitle(false);
        if (!next) {
            setTitleDraft(data.title);
            return;
        }
        if (next !== data.title) onTitleChange?.(data.id, next);
    };

    const connectionTilt = isConnectionTarget && !reduceMediaEffects && !dragOffset
        ? canvasConnectionTilt(data, connectionApproach) : undefined;

    return (
        <div
            data-node-id={data.id}
            data-canvas-node-type={data.type}
            data-canvas-parent-id={data.parentId || undefined}
            data-node-selected={isSelected ? "true" : "false"}
            data-node-state={nodeState}
            data-node-status={data.metadata?.status || "idle"}
            data-media-role={canvasMediaNodeRole(data) || undefined}
            data-result-origin={canvasMediaNodeOrigin(data) || undefined}
            data-task-status={data.metadata?.taskStatus || undefined}
            data-task-id={data.metadata?.taskId || undefined}
            data-task-cancellable={data.metadata?.status === "loading" && (data.metadata?.taskStatus === "queued" || data.metadata?.taskStatus === "running") ? "true" : "false"}
            data-task-stage={data.metadata?.taskStage || undefined}
            data-task-progress={typeof data.metadata?.taskProgress === "number" ? String(data.metadata.taskProgress) : undefined}
            data-subtitle-count={data.metadata?.subtitleEntries?.length ? String(data.metadata.subtitleEntries.length) : undefined}
            data-subtitle-updated-at={data.metadata?.subtitleUpdatedAt || undefined}
            data-subtitle-first-text={data.metadata?.subtitleEntries?.[0]?.text || undefined}
            data-subtitle-position={data.metadata?.subtitleStyle?.position || undefined}
            data-conversion-status={data.metadata?.mediaConversion?.status || undefined}
            data-conversion-operation={data.metadata?.mediaConversion?.operation || undefined}
            data-conversion-result={data.metadata?.mediaConversion?.resultStorageKey || undefined}
            data-video-segment-source={data.metadata?.videoSegmentSourceNodeId || undefined}
            data-video-segment-range={data.metadata?.videoSegmentStartMs !== undefined && data.metadata?.videoSegmentEndMs !== undefined ? `${data.metadata.videoSegmentStartMs}-${data.metadata.videoSegmentEndMs}` : undefined}
            data-video-crop-source={data.metadata?.videoCropSourceNodeId || undefined}
            data-video-crop-rect={data.metadata?.videoCrop ? `${data.metadata.videoCrop.x},${data.metadata.videoCrop.y},${data.metadata.videoCrop.width},${data.metadata.videoCrop.height}` : undefined}
            data-video-retake-source={data.metadata?.videoRetakeSourceNodeId || undefined}
            data-video-retake-count={data.metadata?.videoRetakeCount !== undefined ? String(data.metadata.videoRetakeCount) : undefined}
            data-audio-extract-source={data.metadata?.audioExtractSourceNodeId || undefined}
            data-audio-extract-range={data.metadata?.audioExtractStartMs !== undefined && data.metadata?.audioExtractEndMs !== undefined ? `${data.metadata.audioExtractStartMs}-${data.metadata.audioExtractEndMs}` : undefined}
            data-video-frame-source={data.metadata?.videoFrameSourceNodeId || undefined}
            data-video-frame-time={data.metadata?.videoFrameTimeMs !== undefined ? String(data.metadata.videoFrameTimeMs) : undefined}
            data-video-merge-source-count={data.metadata?.videoMergeSourceNodeIds?.length ? String(data.metadata.videoMergeSourceNodeIds.length) : undefined}
            data-media-operation-error={data.metadata?.mediaOperationError || undefined}
            data-node-hovered={hovered ? "true" : undefined}
            data-asset-category={data.metadata?.assetCategory || undefined}
            className={`node-element absolute flex select-none flex-col ${dragOffset ? "cursor-grabbing" : data.type === CanvasNodeType.Drawing ? "cursor-pointer" : "cursor-default"} ${isSelected ? "z-[var(--z-node-toolbar)]" : isFocusRelated || isConnectionTarget ? "z-[var(--z-node-active)]" : "z-[var(--z-node)]"}`}
            style={{
                transform: `translate(${data.position.x + (dragOffset?.x || 0)}px, ${data.position.y + (dragOffset?.y || 0)}px)`,
                width: data.width,
                height: data.height,
                contain: "layout style",
            }}
            onMouseEnter={() => {
                setHovered(true);
                onHoverStart(data.id);
            }}
            onMouseLeave={() => {
                setHovered(false);
                onHoverEnd(data.id);
            }}
            onContextMenu={(event) => onContextMenu(event, data.id)}
        >
            {!data.metadata?.reusableWorkflow ? <NodeExternalHeader
                node={data}
                scale={scale}
                dimensionLabel={null}
                active={isSelected || isFocusRelated}
                editable={!readOnly && !data.metadata?.locked && Boolean(onTitleChange)}
                editing={isEditingTitle}
                draft={titleDraft}
                theme={theme}
                onDraftChange={setTitleDraft}
                onDragStart={readOnly ? undefined : (event) => onMouseDown(event, data.id)}
                onEdit={() => setIsEditingTitle(true)}
                onCommit={commitTitle}
                onCancel={() => { setTitleDraft(data.title); setIsEditingTitle(false); }}
            /> : null}
            <div
                className="canvas-node-shell relative h-full w-full overflow-visible rounded-[var(--node-radius)]"
                data-node-selected={isSelected ? "true" : "false"}
                data-node-state={nodeState}
                data-connection-tilt={connectionTilt ? "true" : undefined}
                data-state={data.metadata?.status || (isActive ? "active" : isRelated ? "related" : "idle")}
                style={{
                    background: hasImageContent || hasVideoContent || isDirectorNode ? "transparent" : theme.node.fill,
                    // 固定占位但不绘制描边，避免聚焦切换时边框宽度变化造成白边跳动。
                    border: isComposerNode || isDirectorNode ? "0" : `1px solid ${isSelected || isFocusRelated || isConnectionTarget ? theme.node.activeStroke : "transparent"}`,
                    boxShadow: isComposerNode || isDirectorNode ? "none" : isSelected || isFocusRelated ? theme.node.hoverShadow : theme.node.shadow,
                    "--connection-tilt-x": `${connectionTilt?.rotateX || 0}deg`,
                    "--connection-tilt-y": `${connectionTilt?.rotateY || 0}deg`,
                    transformOrigin: connectionTilt?.origin,
                } as React.CSSProperties}
                onMouseDown={(event) => onMouseDown(event, data.id)}
                onDoubleClick={(event) => {
                    if (isBatchRoot) {
                        event.stopPropagation();
                        onToggleBatch?.(data.id);
                        return;
                    }
                    if (data.type === CanvasNodeType.Image && hasImageContent) {
                        event.stopPropagation();
                        onViewImage?.(data);
                        return;
                    }
                    if (data.metadata?.directorSceneId) {
                        event.stopPropagation();
                        return;
                    }
                    if (data.type === CanvasNodeType.Drawing) {
                        event.stopPropagation();
                        onOpenDrawing?.(data);
                        return;
                    }
                    if (!readOnly && data.type === CanvasNodeType.Text && data.metadata?.workflowKind === "character" && data.metadata.characterAssetId) {
                        event.stopPropagation();
                        onOpenTextEditor?.(data);
                        return;
                    }
                    if (readOnly || data.type !== CanvasNodeType.Text) return;
                    event.stopPropagation();
                    setIsEditingContent(true);
                }}
            >
                <div
                    className={`relative flex h-full w-full items-center justify-center rounded-[inherit] ${annotationActive || maskEditActive || (imageCropActive && hasImageContent) || (videoCropActive && hasVideoContent) || isBatchRoot || data.type === CanvasNodeType.Script || data.type === CanvasNodeType.BatchTable || data.type === CanvasNodeType.Upscale || isComposerNode ? "overflow-visible" : "overflow-hidden"}`}
                    style={
                        {
                            background: hasImageContent || hasVideoContent || hasAudioContent || isDirectorNode ? "transparent" : theme.node.fill,
                            "--batch-from-x": `${batchMotion?.x || 0}px`,
                            "--batch-from-y": `${batchMotion?.y || 0}px`,
                            "--batch-from-rotate": `${6 + (batchMotion?.index || 0) * 4}deg`,
                            animation: isBatchChild && (batchClosing || batchOpening) ? (batchClosing ? `canvas-batch-child-out var(--motion-dur-base-calc) var(--motion-ease-in-out) both` : `canvas-batch-child-in var(--motion-dur-slow-calc) var(--motion-ease-out) both`) : undefined,
                            animationDelay: isBatchChild && (batchClosing || batchOpening) ? `${batchClosing ? 0 : 45 + (batchMotion?.index || 0) * 24}ms` : undefined,
                        } as React.CSSProperties
                    }
                >
                    {/* 仅在执行中或异常时显示状态；成功来源由内部元数据保留，不占用卡片视觉层。 */}
                    {data.metadata?.status && data.metadata.status !== "idle" && data.metadata.status !== "success" && data.type !== CanvasNodeType.Frame ? (
                        <NodeStatusBadge status={data.metadata.status} resultPending={data.metadata.taskStatus === "succeeded" && data.metadata.resourceReloadAvailable === true} />
                    ) : null}
                    <CanvasNodeContent
                        node={data}
                        theme={theme}
                        isEditingContent={isEditingContent}
                        textareaRef={textareaRef}
                        isBatchRoot={isBatchRoot}
                        batchCount={batchCount}
                        batchPreviewNodes={batchPreviewNodes}
                        batchExpanded={batchExpanded}
                        batchOpening={batchOpening}
                        batchRecovering={batchRecovering}
                        renderNodeContent={renderNodeContent}
                        drawingProjectId={drawingProjectId}
                        projectId={drawingProjectId}
                        mentionReferences={mentionReferences}
                        onContentChange={onContentChange}
                        onStopEditing={() => setIsEditingContent(false)}
                        onRetry={onRetry}
                        onReloadResource={onReloadResource}
                        onOpenTaskDetails={onOpenTaskDetails}
                        onCancelTask={onCancelTask}
                        onToggleBatch={() => onToggleBatch?.(data.id)}
                        reduceMediaEffects={reduceMediaEffects}
                        mediaActive={mediaActive}
                        scale={scale}
                        onMediaPlayRequest={onMediaPlayRequest}
                    />
                    {imageCropActive && hasImageContent ? (
                        <CanvasImageCropEditor
                            imageUrl={data.metadata?.content || ""}
                            imageDimensions={{ width: Math.max(1, data.metadata?.naturalWidth || data.width), height: Math.max(1, data.metadata?.naturalHeight || data.height) }}
                            onCancel={() => onCancelImageCrop?.()}
                            onConfirm={(crop) => onConfirmImageCrop?.(data, crop)}
                        />
                    ) : null}
                    {annotationActive && hasImageContent ? (
                        <CanvasImageAnnotationEditor
                            image={{ url: data.metadata?.content || "", storageKey: data.metadata?.storageKey }}
                            scale={scale}
                            onCancel={() => onCancelAnnotation?.()}
                            onConfirm={(dataUrl) => onConfirmAnnotation?.(data, dataUrl)}
                        />
                    ) : null}
                    {maskEditActive && maskEditConfig && hasImageContent ? (
                        <CanvasImageMaskEditor
                            imageDimensions={{ width: Math.max(1, data.metadata?.naturalWidth || data.width), height: Math.max(1, data.metadata?.naturalHeight || data.height) }}
                            scale={scale}
                            config={maskEditConfig}
                            onCancel={() => onCancelMaskEdit?.()}
                            onConfirm={(payload) => onConfirmMaskEdit?.(data, payload)}
                        />
                    ) : null}
                    {videoCropActive && hasVideoContent ? (
                        <CanvasVideoCropEditor
                            videoUrl={data.metadata?.content || ""}
                            videoDimensions={{
                                width: Math.max(1, data.metadata?.naturalWidth || data.width),
                                height: Math.max(1, data.metadata?.naturalHeight || data.height),
                            }}
                            onCancel={() => onCancelVideoCrop?.()}
                            onConfirm={(crop, sourceDimensions) => onConfirmVideoCrop?.(data, crop, sourceDimensions)}
                        />
                    ) : null}
                </div>

                {data.type === CanvasNodeType.Text && data.metadata?.workflowKind !== "character" && !readOnly ? (
                    <div
                        className={`canvas-node-inline-edit absolute bottom-[10%] left-1/2 z-[var(--node-z-overlay)] -translate-x-1/2 motion-safe:transition motion-safe:duration-200 ${isSelected ? "pointer-events-auto translate-y-0 opacity-100" : "pointer-events-none translate-y-3 opacity-0"}`}
                        aria-hidden={!isSelected}
                        onMouseDown={(event) => event.stopPropagation()}
                        onPointerDown={(event) => event.stopPropagation()}
                    >
                        <button
                            type="button"
                            className="canvas-node-inline-action inline-flex h-9 items-center gap-2 px-3 text-xs font-medium backdrop-blur-xl transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                            style={{ outlineColor: theme.accent.primary }}
                            tabIndex={isSelected ? 0 : -1}
                            onClick={(event) => { event.stopPropagation(); onOpenTextEditor?.(data); }}
                            aria-label="放大编辑文本"
                        >
                            <Maximize2 className="size-3.5" />
                            放大编辑
                        </button>
                    </div>
                ) : null}

                {data.metadata?.versionLabel ? (
                    <button
                        type="button"
                        // 版本徽标必须能在节点参数面板打开时继续点击；它是版本对比的稳定入口，
                        // 不能被 resize handle 或面板的 textarea 覆盖。
                        className="absolute left-3 top-3 z-[var(--node-z-overlay)] grid size-7 place-items-center rounded-[var(--r-full)] border p-0.5 text-[var(--node-badge-fs)] font-semibold leading-none backdrop-blur-md transition-[transform,background,border-color,box-shadow] hover:-translate-y-px focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 motion-reduce:hover:translate-y-0"
                        style={{
                            background: data.metadata.versionPrimary ? theme.accent.primarySoft : theme.toolbar.panel,
                            borderColor: data.metadata.versionPrimary ? theme.accent.primary : theme.toolbar.border,
                            color: data.metadata.versionPrimary ? theme.accent.primary : theme.node.text,
                            outlineColor: theme.accent.primary,
                        }}
                        title={data.metadata.versionLabel + (data.metadata.versionPrimary ? " · 主版本" : "") + "，点击查看版本对比"}
                        aria-label={data.metadata.versionLabel + (data.metadata.versionPrimary ? "，主版本" : "") + "，查看版本对比"}
                        onMouseDown={(event) => event.stopPropagation()}
                        onClick={(event) => { event.stopPropagation(); onOpenVersions?.(data); }}
                    >
                        {data.metadata.versionLabel}
                    </button>
                ) : null}
                {showStatusTrack ? (
                    <div className={`absolute right-3 top-3 z-[var(--node-z-overlay)] flex min-w-0 items-center justify-end gap-1 ${data.metadata?.versionLabel ? "max-w-[calc(100%-104px)]" : "max-w-[calc(100%-24px)]"}`}>
                        {isBatchRoot ? <BatchToggleBadge count={batchCount} expanded={batchExpanded} theme={theme} onToggle={() => onToggleBatch?.(data.id)} /> : null}
                        {isBatchChild && !readOnly ? <BatchPrimaryBadge visible={batchPrimary || hovered || isSelected} selected={batchPrimary} theme={theme} onSelect={() => onSetBatchPrimary?.(data)} /> : null}
                        {data.metadata?.locked ? <NodeLockBadge theme={theme} /> : null}
                    </div>
                ) : null}
                {/* 批次子图操作条：成功子项提供下载/副本/设为主图，失败子项提供重试/删除 */}
                {isBatchChild && !readOnly && (hasImageContent || data.metadata?.status === "error") && (hovered || isSelected) ? (
                    <div
                        className="absolute inset-x-0 bottom-2 z-[var(--node-z-overlay)] flex justify-center"
                        onMouseDown={(event) => event.stopPropagation()}
                        onPointerDown={(event) => event.stopPropagation()}
                    >
                        <div className="flex items-center gap-0.5 rounded-[var(--r-md)] border px-1 py-1 backdrop-blur-xl" style={{ background: `${theme.toolbar.panel}e6`, borderColor: theme.toolbar.border }}>
                            {hasImageContent ? <BatchChildActionButton theme={theme} label="下载图片" icon={<Download className="size-3.5" />} onClick={() => downloadNode?.(data)} /> : null}
                            {hasImageContent ? <BatchChildActionButton theme={theme} label="创建副本" icon={<Copy className="size-3.5" />} onClick={() => duplicateNode?.(data)} /> : null}
                            {hasImageContent ? (
                                <BatchChildActionButton theme={theme} label={batchPrimary ? "当前主图" : "设为主图"} icon={<Star className={`size-3.5 ${batchPrimary ? "fill-current" : ""}`} style={{ color: theme.accent.primary }} />} onClick={() => onSetBatchPrimary?.(data)} />
                            ) : null}
                            {data.metadata?.status === "error" && data.metadata.resourceReloadAvailable ? <BatchChildActionButton theme={theme} label="继续取回" icon={<Download className="size-3.5" />} onClick={() => onReloadResource?.(data)} /> : null}
                            {data.metadata?.status === "error" && !shouldBlockManualRetry({ code: data.metadata.generationErrorCode || data.metadata.taskErrorCode, message: data.metadata.errorDetails }, data.metadata.taskStage) ? <BatchChildActionButton theme={theme} label="重新生成" icon={<RefreshCw className="size-3.5" />} onClick={() => onRetry?.(data)} /> : null}
                            {data.metadata?.status === "error" && data.metadata.taskId && onOpenTaskDetails ? <BatchChildActionButton theme={theme} label="查看原任务" icon={<ScanSearch className="size-3.5" />} onClick={() => onOpenTaskDetails(data)} /> : null}
                            {data.metadata?.status === "error" ? <BatchChildActionButton theme={theme} label="删除" icon={<Trash2 className="size-3.5" />} danger onClick={() => deleteNode?.(data)} /> : null}
                        </div>
                    </div>
                ) : null}
                {/* 批次主图位（折叠根节点封面）常驻下载按钮 */}
                {isBatchRoot && hasImageContent && !readOnly ? (
                    <div className="absolute bottom-2 right-2 z-[var(--node-z-overlay)]" onMouseDown={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}>
                        <BatchChildActionButton theme={theme} label="下载主图" icon={<Download className="size-3.5" />} onClick={() => downloadNode?.(data)} />
                    </div>
                ) : null}
                {!readOnly && !data.metadata?.locked && (isSelected || hovered) ? <>
                    <ResizeHandle corner="top-left" onMouseDown={handleResizeMouseDown} />
                    <ResizeHandle corner="top-right" onMouseDown={handleResizeMouseDown} />
                    <ResizeHandle corner="bottom-left" onMouseDown={handleResizeMouseDown} />
                    <ResizeHandle corner="bottom-right" onMouseDown={handleResizeMouseDown} />
                </> : null}
            </div>

            {!readOnly && data.type !== CanvasNodeType.Script && data.type !== CanvasNodeType.BatchTable && data.type !== CanvasNodeType.WorkflowControl ? <ConnectionSideRail side="left" scale={scale} theme={theme} visible={hovered || isSelected || forceInputVisible} onPointerDown={(event, anchorRatio) => onConnectStart(event, data.id, "target", undefined, anchorRatio)} /> : null}
            {!readOnly && data.type !== CanvasNodeType.Script && data.type !== CanvasNodeType.Config && showOutputConnection ? <ConnectionSideRail side="right" scale={scale} theme={theme} visible={hovered || isSelected} onPointerDown={(event, anchorRatio) => onConnectStart(event, data.id, "source", undefined, anchorRatio)} /> : null}

        </div>
    );
}, areCanvasNodePropsEqual);

function usesCustomNodeContentRenderer(node: CanvasNodeData) {
    return (
        node.type === CanvasNodeType.Config ||
        node.type === CanvasNodeType.Script ||
        node.type === CanvasNodeType.BatchTable ||
        node.type === CanvasNodeType.Director ||
        Boolean(node.metadata?.directorSceneId) ||
        Boolean(node.metadata?.workflowKind)
    );
}

function areCanvasNodePropsEqual(previous: CanvasNodeProps, next: CanvasNodeProps) {
    return (
        previous.data === next.data &&
        previous.dragOffset?.x === next.dragOffset?.x &&
        previous.dragOffset?.y === next.dragOffset?.y &&
        previous.scale === next.scale &&
        previous.isSelected === next.isSelected &&
        previous.mediaActive === next.mediaActive &&
        previous.isRelated === next.isRelated &&
        previous.isFocusRelated === next.isFocusRelated &&
        previous.isConnectionTarget === next.isConnectionTarget &&
        previous.connectionApproach?.x === next.connectionApproach?.x &&
        previous.connectionApproach?.y === next.connectionApproach?.y &&
        previous.forceInputVisible === next.forceInputVisible &&
        previous.showImageInfo === next.showImageInfo &&
        previous.reduceMediaEffects === next.reduceMediaEffects &&
        previous.readOnly === next.readOnly &&
        previous.resourceLabel === next.resourceLabel &&
        previous.mentionReferences === next.mentionReferences &&
        (!usesCustomNodeContentRenderer(next.data) || previous.renderNodeContent === next.renderNodeContent) &&
        previous.drawingProjectId === next.drawingProjectId &&
        previous.batchCount === next.batchCount &&
        previous.batchPreviewNodes === next.batchPreviewNodes &&
        previous.batchExpanded === next.batchExpanded &&
        previous.batchClosing === next.batchClosing &&
        previous.batchOpening === next.batchOpening &&
        previous.batchRecovering === next.batchRecovering &&
        previous.batchPrimary === next.batchPrimary &&
        previous.batchMotion?.x === next.batchMotion?.x &&
        previous.batchMotion?.y === next.batchMotion?.y &&
        previous.batchMotion?.index === next.batchMotion?.index &&
        previous.onMouseDown === next.onMouseDown &&
        previous.onHoverStart === next.onHoverStart &&
        previous.onHoverEnd === next.onHoverEnd &&
        previous.onConnectStart === next.onConnectStart &&
        previous.onResize === next.onResize &&
        previous.onTitleChange === next.onTitleChange &&
        previous.onContentChange === next.onContentChange &&
        previous.onToggleBatch === next.onToggleBatch &&
        previous.onSetBatchPrimary === next.onSetBatchPrimary &&
        previous.onRetry === next.onRetry &&
        previous.onReloadResource === next.onReloadResource &&
        previous.onOpenTaskDetails === next.onOpenTaskDetails &&
        previous.onCancelTask === next.onCancelTask &&
        previous.onOpenVersions === next.onOpenVersions &&
        previous.onViewImage === next.onViewImage &&
        previous.onReplaceMedia === next.onReplaceMedia &&
        previous.onOpenTextEditor === next.onOpenTextEditor &&
        previous.onOpenDrawing === next.onOpenDrawing &&
        previous.imageCropActive === next.imageCropActive &&
        (!next.imageCropActive || (previous.onCancelImageCrop === next.onCancelImageCrop && previous.onConfirmImageCrop === next.onConfirmImageCrop)) &&
        previous.annotationActive === next.annotationActive &&
        (!next.annotationActive || (previous.onCancelAnnotation === next.onCancelAnnotation && previous.onConfirmAnnotation === next.onConfirmAnnotation)) &&
        previous.maskEditActive === next.maskEditActive &&
        (!next.maskEditActive || (previous.maskEditConfig === next.maskEditConfig && previous.onCancelMaskEdit === next.onCancelMaskEdit && previous.onConfirmMaskEdit === next.onConfirmMaskEdit)) &&
        previous.videoCropActive === next.videoCropActive &&
        (!next.videoCropActive || (previous.onCancelVideoCrop === next.onCancelVideoCrop && previous.onConfirmVideoCrop === next.onConfirmVideoCrop)) &&
        previous.onContextMenu === next.onContextMenu
    );
}

function NodeLockBadge({ theme }: { theme: CanvasTheme }) {
    return <span className="pointer-events-none grid size-7 shrink-0 place-items-center rounded-md border backdrop-blur" style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.muted }} title="节点已锁定"><Lock className="size-3.5" /></span>;
}

function BatchToggleBadge({ count, expanded, theme, onToggle }: { count: number; expanded: boolean; theme: CanvasTheme; onToggle: () => void }) {
    return (
        <button type="button" className="canvas-node-tool-button inline-flex h-7 shrink-0 items-center gap-1 rounded-md border px-2 text-[var(--fs-tiny)] font-semibold backdrop-blur-md" style={{ background: `${theme.toolbar.panel}d9`, borderColor: `${theme.toolbar.border}cc`, color: theme.node.text }} aria-expanded={expanded} aria-label={expanded ? "收起图片组" : "展开图片组"} onClick={(event) => { event.stopPropagation(); onToggle(); }} onMouseDown={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}>
            <span className="leading-none" style={{ color: theme.accent.primary }}>{count}</span>
            <ChevronRight className={`size-3 opacity-55 transition-transform ${expanded ? "rotate-90" : ""}`} />
        </button>
    );
}

function BatchPrimaryBadge({ visible, selected, theme, onSelect }: { visible: boolean; selected: boolean; theme: CanvasTheme; onSelect: () => void }) {
    return (
        <button type="button" className={`canvas-node-tool-button inline-flex h-7 shrink-0 items-center gap-1 rounded-md border px-2 text-[var(--fs-tiny)] font-medium backdrop-blur-md transition-opacity ${visible ? "opacity-100" : "pointer-events-none opacity-0"}`} style={{ background: theme.toolbar.panel, borderColor: selected ? theme.accent.primary : theme.toolbar.border, color: selected ? theme.accent.primary : theme.node.text }} aria-label={selected ? "当前主图" : "设置为主图"} aria-pressed={selected} onClick={(event) => { event.stopPropagation(); onSelect(); }} onMouseDown={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}>
            <Star className={`size-3 ${selected ? "fill-current" : ""}`} style={{ color: theme.accent.primary }} />
            {selected ? "当前主图" : "主图"}
        </button>
    );
}

function BatchChildActionButton({ theme, label, icon, onClick, danger = false }: { theme: CanvasTheme; label: string; icon: ReactNode; onClick: () => void; danger?: boolean }) {
    return (
        <button
            type="button"
            data-canvas-no-zoom
            className="canvas-node-inline-action grid size-8 place-items-center rounded-[var(--r-sm)] p-0 backdrop-blur-xl transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
            style={{ color: danger ? theme.accent.danger : theme.node.text, outlineColor: theme.accent.primary }}
            title={label}
            aria-label={label}
            onClick={(event) => { event.stopPropagation(); onClick(); }}
            onMouseDown={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
        >
            {icon}
        </button>
    );
}

function ResizeHandle({ corner, onMouseDown }: { corner: ResizeCorner; onMouseDown: (event: React.MouseEvent, corner: ResizeCorner) => void }) {
    const positionClass = {
        "top-left": "-left-[14px] -top-[14px] cursor-nwse-resize",
        "top-right": "-right-[14px] -top-[14px] cursor-nesw-resize",
        "bottom-left": "-bottom-[14px] -left-[14px] cursor-nesw-resize",
        "bottom-right": "-bottom-[14px] -right-[14px] cursor-nwse-resize",
    }[corner];

    return <div className={`absolute z-[var(--node-z-handle)] size-7 ${positionClass}`} onMouseDown={(event) => onMouseDown(event, corner)} />;
}

function NodeExternalHeader({ node, scale, dimensionLabel, active, editable, editing, draft, theme, onDragStart, onDraftChange, onEdit, onCommit, onCancel }: {
    node: CanvasNodeData;
    scale: number;
    dimensionLabel: string | null;
    active: boolean;
    editable: boolean;
    editing: boolean;
    draft: string;
    theme: CanvasTheme;
    onDraftChange: (value: string) => void;
    onDragStart?: (event: React.MouseEvent) => void;
    onEdit: () => void;
    onCommit: () => void;
    onCancel: () => void;
}) {
    const titleInputRef = useRef<HTMLInputElement>(null);
    useEffect(() => {
        if (!editing) return;
        const commitOutsideInput = (event: PointerEvent) => {
            const input = titleInputRef.current;
            if (!input || !(event.target instanceof Node) || input.contains(event.target)) return;
            // 画布手势可能阻止鼠标默认失焦，主动触发同一条 onBlur 保存路径。
            input.blur();
        };
        window.addEventListener("pointerdown", commitOutsideInput, true);
        return () => window.removeEventListener("pointerdown", commitOutsideInput, true);
    }, [editing]);
    const inverseScale = 1 / Math.max(scale, 0.05);
    const isDirectorNode = node.type === CanvasNodeType.Director || Boolean(node.metadata?.directorSceneId);
    const Icon = isDirectorNode ? Move3d : nodeTypeIcon(node.type, node);
    const displayTitle = node.title && node.title !== "豆包账号"
        ? node.title
        : node.type === CanvasNodeType.DoubaoAccount
            ? (node.metadata?.doubaoAccountNode?.mode === "image" ? "豆包图片" : node.metadata?.doubaoAccountNode?.mode === "video" ? "豆包视频" : "豆包文字")
            : node.title;

    return (
        <div
            className="canvas-node-external-header absolute bottom-full left-0 z-[var(--node-z-overlay)] flex min-h-6 items-center gap-1"
            data-expanded={active || editing ? "true" : undefined}
            data-editing={editing ? "true" : undefined}
            style={{
                "--canvas-node-width": `${node.width}px`,
                "--canvas-node-header-width": `min(240px, calc(var(--canvas-node-width) * var(--canvas-live-scale, ${scale})))`,
                borderRadius: "var(--r-sm)",
                color: active ? theme.node.text : theme.node.label,
                transform: `scale(var(--canvas-live-inverse-scale, ${inverseScale}))`,
                transformOrigin: "left bottom",
            } as React.CSSProperties}
            onMouseDown={(event) => {
                // LibTV 的节点标题图标区域同时承担拖拽入口；名称按钮仍保留独立的重命名点击。
                // 只在非交互子控件上把事件交给画布选择控制器，避免点击标题时误触发移动。
                if (event.button !== 0) return;
                if ((event.target as HTMLElement).closest("button, input")) return;
                onDragStart?.(event);
            }}
            onPointerDown={(event) => {
                if (event.button !== 0) return;
                if ((event.target as HTMLElement).closest("button, input")) return;
                event.stopPropagation();
            }}
        >
            <div className="flex min-w-0 flex-1 items-center gap-1">
                <button
                    type="button"
                    // LibTV 标题行只展示节点类型图标；保留无障碍拖动按钮，但不额外绘制抓手，
                    // 节点主体仍支持拖动，避免标题前出现一组原版没有的竖向点。
                    className="flex size-0 shrink-0 touch-none items-center justify-center overflow-hidden rounded p-0 opacity-0 cursor-grab active:cursor-grabbing disabled:cursor-not-allowed focus-visible:outline focus-visible:outline-1"
                    aria-label={node.metadata?.locked ? "节点已锁定" : `拖动节点：${node.title}`}
                    title={node.metadata?.locked ? "节点已锁定，请先解锁" : "拖动此处移动节点；点击名称可重命名"}
                    disabled={!onDragStart || Boolean(node.metadata?.locked)}
                    onPointerDown={(event) => {
                        if (event.button !== 0) return;
                        // HTML / SVG 正文在跨源沙箱中；捕获指针，避免经过 iframe 后丢失 move / up。
                        event.preventDefault();
                        event.stopPropagation();
                        event.currentTarget.setPointerCapture(event.pointerId);
                        onDragStart?.(event);
                    }}
                >
                    {node.metadata?.locked ? <Lock className="size-3" /> : <GripVertical className="size-3" strokeWidth={1.8} />}
                </button>
                <Icon className="canvas-node-title-type-icon size-3 shrink-0" strokeWidth={1.8} data-node-header-icon={isDirectorNode ? "director" : undefined} />
                {editing ? (
                    <input
                        ref={titleInputRef}
                        autoFocus
                        value={draft}
                        className="h-6 min-w-20 max-w-[190px] flex-1 truncate rounded bg-transparent px-1.5 text-xs font-medium outline-none"
                        style={{ background: "transparent", color: theme.node.text }}
                        onChange={(event) => onDraftChange(event.target.value)}
                        onFocus={(event) => event.currentTarget.select()}
                        onBlur={onCommit}
                        onKeyDown={(event) => {
                            if (event.key === "Enter") event.currentTarget.blur();
                            if (event.key === "Escape") onCancel();
                        }}
                        aria-label="节点名称"
                    />
                ) : editable ? (
                    <button type="button" className="group flex min-w-0 flex-1 items-center gap-1 rounded px-0.5 text-left text-xs font-medium outline-none transition-opacity hover:opacity-100 focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-1" style={{ opacity: active ? 1 : 0.78, outlineColor: theme.node.muted }} onClick={onEdit} title={displayTitle} aria-label={`编辑节点名称：${displayTitle}`}>
                        <span className="canvas-node-title-text min-w-0 truncate">{displayTitle}</span>
                        <Pencil className="canvas-node-title-edit-icon size-2.5 shrink-0 opacity-55 transition-opacity group-hover:opacity-100" />
                    </button>
                ) : (
                    <span className="canvas-node-title-text min-w-0 flex-1 truncate text-xs font-medium" title={displayTitle} style={{ opacity: active ? 1 : 0.78 }}>{displayTitle}</span>
                )}
            </div>
            {dimensionLabel ? <span className="ml-auto shrink-0 whitespace-nowrap text-[var(--fs-micro)] font-medium leading-none tabular-nums" style={{ color: theme.node.muted }}>{dimensionLabel}</span> : null}
        </div>
    );
}

function nodeTypeIcon(type: CanvasNodeTypeId, node?: CanvasNodeData) {
    if (type === CanvasNodeType.DoubaoAccount) {
        const mode = node?.metadata?.doubaoAccountNode?.mode;
        if (mode === "image") return ImageIcon;
        if (mode === "video") return Video;
        return MessageSquareText;
    }
    if (type === CanvasNodeType.Image) return ImageIcon;
    if (type === CanvasNodeType.Video) return Video;
    if (type === CanvasNodeType.Audio) return Music2;
    if (type === CanvasNodeType.Drawing) return Pencil;
    if (type === CanvasNodeType.Script) return Clapperboard;
    if (type === CanvasNodeType.Config) return Settings2;
    if (type === CanvasNodeType.Skill) return BookOpenCheck;
    if (type === ART_CRITIQUE_NODE_TYPE) return ScanSearch;
    return FileText;
}

// 节点状态徽章（对应 #97 决策2：左上角状态指示，loading/success/error）
function NodeStatusBadge({ status, resultPending }: { status: "loading" | "success" | "error"; resultPending?: boolean }) {
    if (status === "loading") return null;
    if (status === "error") {
        return (
            <div
                className="pointer-events-none absolute left-2 top-2 z-20 flex items-center gap-1 rounded-full px-2 py-0.5 backdrop-blur-sm"
                style={{ background: "color-mix(in oklch, var(--status-error) 20%, transparent)", color: "var(--status-error)" }}
                aria-label={resultPending ? "结果待放入画布" : "生成失败"}
            >
                <AlertCircle className="size-3" strokeWidth={2} />
                <span className="text-[var(--fs-micro)] font-medium leading-none">{resultPending ? "待放入画布" : "失败"}</span>
            </div>
        );
    }
    // success：短暂闪现后淡出（由 CSS animation 控制，2s 后消失）
    return (
        <div
            className="pointer-events-none absolute left-2 top-2 z-20 flex items-center gap-1 rounded-full px-2 py-0.5 backdrop-blur-sm"
            style={{ background: "color-mix(in oklch, var(--status-success) 20%, transparent)", color: "var(--status-success)", animation: "canvas-status-success-fade 2s ease-out forwards" }}
            aria-label="生成完成"
        >
            <CheckCircle2 className="size-3" strokeWidth={2} />
            <span className="text-[var(--fs-micro)] font-medium leading-none">完成</span>
        </div>
    );
}

function ConnectionSideRail({ side, scale, theme, visible = false, onPointerDown }: { side: "left" | "right"; scale: number; theme: CanvasTheme; visible?: boolean; onPointerDown: (event: React.PointerEvent, anchorRatio: number) => void }) {
    const handleRef = useRef<HTMLSpanElement>(null);
    const [railHovered, setRailHovered] = useState(false);
    const inverseScale = 1 / Math.max(scale, 0.05);
    const railSize = 80;
    // Keep the control responsive to zoom, but avoid sub-pixel circles and
    // strokes at far zoom levels where the plus sign appears visually off-center.
    const handleSize = Math.max(20, 8 * inverseScale);
    // LibTV centers the visual quick-add icon in an approximately 80px
    // circular hit zone, then offsets it toward the node edge. Keep that
    // visual layer separate from the real centered connection anchor.
    const sideOffset = side === "left" ? 25 : -25;

    const resetHandle = useCallback(() => {
        if (!handleRef.current) return;
        handleRef.current.style.transform = `translate(${sideOffset}px, 0) scale(1)`;
    }, [sideOffset]);

    const updateHandle = (event: React.PointerEvent<HTMLButtonElement>) => {
        const bounds = event.currentTarget.getBoundingClientRect();
        const width = Math.max(bounds.width, 1);
        const height = Math.max(bounds.height, 1);
        const followLimit = 30;
        const deltaX = event.clientX - (bounds.left + width / 2);
        const deltaY = event.clientY - (bounds.top + height / 2);
        const offsetScreenX = Math.max(-followLimit, Math.min(followLimit, deltaX));
        const offsetScreenY = Math.max(-followLimit, Math.min(followLimit, deltaY));
        const focus = 1 + Math.max(0, 1 - Math.hypot(offsetScreenX, offsetScreenY) / followLimit) * 0.1;
        // While the pointer is inside the rail LibTV uses the rail center as
        // the origin. The side-specific +/-25px offset is only the resting
        // position used after leaving the rail.
        const offsetX = offsetScreenX * inverseScale;
        const offsetY = offsetScreenY * inverseScale;
        if (handleRef.current) handleRef.current.style.transform = `translate(${offsetX}px, ${offsetY}px) scale(${focus})`;
    };

    return (
        <button
            type="button"
            data-canvas-connection-rail={side}
            className={`group pointer-events-auto absolute top-1/2 z-[var(--node-z-overlay)] flex -translate-y-1/2 items-center justify-center touch-none cursor-crosshair rounded-full outline-none transition-opacity duration-150 ${visible || railHovered ? "opacity-100" : "opacity-0"}`}
            style={{ width: railSize, height: `min(100%, ${railSize}px)`, cursor: "crosshair", ...(side === "left" ? { right: "100%" } : { left: "100%" }) }}
            onPointerEnter={(event) => {
                setRailHovered(true);
                updateHandle(event);
            }}
            onPointerMove={updateHandle}
            onPointerLeave={() => {
                setRailHovered(false);
                resetHandle();
            }}
            onPointerDown={(event) => onPointerDown(event, 0.5)}
            aria-label={`${side === "left" ? "输入" : "输出"}连接点，单击创建节点或拖动连线`}
        >
            <span
                ref={handleRef}
                className="absolute left-1/2 top-1/2 block transition-transform duration-[80ms] ease-out group-hover:brightness-125 group-focus-visible:brightness-125"
                style={{
                    width: handleSize,
                    height: handleSize,
                    marginLeft: -handleSize / 2,
                    marginTop: -handleSize / 2,
                    transform: `translate(${sideOffset}px, 0) scale(1)`,
                    transition: "transform 80ms ease-out",
                    transformOrigin: "center",
                    willChange: "transform",
                }}
            >
                <svg
                    aria-hidden="true"
                    className="block"
                    width={handleSize}
                    height={handleSize}
                    viewBox="0 0 20 20"
                    fill="none"
                    style={{
                        position: "absolute",
                        left: "50%",
                        top: "50%",
                        marginLeft: -handleSize / 2,
                        marginTop: -handleSize / 2,
                    }}
                >
                    <circle cx="10" cy="10" r="9.35" fill={theme.spatial.elevated} />
                    <circle cx="10" cy="10" r="9.35" stroke={theme.node.activeStroke} strokeWidth="1.2" />
                    <path d="M10 6.5v7M6.5 10h7" stroke={theme.node.activeStroke} strokeWidth="1.5" strokeLinecap="round" />
                </svg>
            </span>
        </button>
    );
}
