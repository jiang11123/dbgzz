import { Component, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { AlertCircle, BookOpenCheck, Download, Image as ImageIcon, LoaderCircle, Music2, Pencil, Play, RefreshCw, Video } from "lucide-react";

import { VideoPlayer } from "@/components/video-player";
import { CachedResourceImage } from "@/components/cached-resource-image";
import { GenerationFailureNotice } from "@/components/generation/generation-failure-notice";
import { explainGenerationError } from "@/lib/generation-error";
import { canvasNodeFailureExplanation, canRecoverOrRetryDepthCapture } from "@/lib/canvas/canvas-depth-capture";
import { isGenerationTaskSubmissionUncertain } from "@/lib/generation-task-display";
import { canvasNodeOperation } from "@/lib/operation-progress";
import { useOperationProgress } from "@/stores/use-operation-progress";
import { canvasRichTextHTML } from "@/lib/canvas/canvas-rich-text";
import { fitImageNodeToDecodedSize, fitNodeSize } from "@/lib/canvas/canvas-node-size";
import { loadCanvasDrawingPreview } from "@/lib/canvas/canvas-drawing-storage";
import { canvasNodeVideoPreviewUrl, inferVideoHasAudio } from "@/lib/canvas/canvas-media-preview";
import { bindCanvasVideoHoverPreview } from "@/lib/canvas/canvas-video-hover-preview";
import { canvasVideoPresentationState } from "@/lib/canvas/canvas-video-presentation";
import { buildLibTVImagePreviewUrl, buildLibTVVideoSourceUrl } from "@/lib/canvas/libtv-import";
import type { CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";
import type { CanvasTheme } from "@/lib/canvas-theme";
import { formatBytes } from "@/lib/image-utils";
import { resourceIdFromStorageKey } from "@/services/api/resources";
import type { GenerationTask } from "@/services/api/task-center";
import { cacheResourceObjectUrl, getCachedResourceObjectUrl, peekCachedResourceObjectUrl, scheduleResourceBlobCache } from "@/services/resource-blob-cache";
import { resolveMediaUrl } from "@/services/file-storage";
import { useResourceVideoPlayback } from "@/hooks/use-resource-video-playback";
import { resolveImageUrl } from "@/services/image-storage";
import { recordDiagnosticEvent } from "@/services/diagnostics/client-diagnostics";
import { canvasNodeDiagnosticContext, recordCanvasVideoDiagnostic } from "@/services/diagnostics/canvas-media-diagnostics";
import { acquireCanvasVideoPreview, canvasDerivedPreviewSourceKey, canvasVideoPreviewNeedsHydration } from "@/services/canvas-video-preview";
import { acquireCanvasVideoSource } from "@/services/canvas-video-source";
import { getActiveUserScopeEpoch, subscribeUserScope } from "@/lib/user-scope";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { getNodeDefinition } from "@/lib/canvas/node-registry";
import { ART_CRITIQUE_NODE_TYPE } from "@/lib/art-critique/contracts";
import { createDefaultSubtitleStyle } from "@/types/timeline";
import { CanvasResourceMentionTextarea } from "./canvas-resource-mention-textarea";
import { CanvasAudioPlayer } from "./canvas-audio-player";
import { useCanvasNodeActions } from "./canvas-node-action-context";
import { CanvasSubtitleOverlay } from "./canvas-subtitle-overlay";
import { CanvasFileUploadContent } from "./canvas-file-upload-content";
import { CanvasNodeGenerationProgress } from "./canvas-node-generation-progress";
import { MarkdownNodeContent } from "./nodes/markdown-node";
import { ChartNodeContent } from "./nodes/chart-node";
import { CompareNodeContent } from "./nodes/compare-node";
import { ColorGradeNodeContent } from "./nodes/color-grade-node";
import { HtmlNodeContent } from "./nodes/html-node";
import { PanoramaNodeContent } from "./nodes/panorama-node";
import { SvgNodeContent } from "./nodes/svg-node";
import { ArtCritiqueNodeContent } from "./nodes/ai-art-critique-node";
import { MediaConversionNodeContent } from "./nodes/media-conversion-node";
import { DoubaoAccountNodeContent } from "./nodes/doubao-account-node";
import { UpscaleNodeContent } from "./nodes/upscale-node";
import { MEDIA_CONVERSION_NODE_TYPE } from "@/lib/media-conversion/contracts";

export type CanvasNodeContentProps = {
    node: CanvasNodeData;
    theme: CanvasTheme;
    isEditingContent: boolean;
    textareaRef: RefObject<HTMLTextAreaElement | null>;
    isBatchRoot: boolean;
    batchCount: number;
    batchPreviewNodes?: CanvasNodeData[];
    batchExpanded: boolean;
    batchOpening: boolean;
    batchRecovering: boolean;
    renderNodeContent?: (node: CanvasNodeData) => ReactNode;
    drawingProjectId?: string;
    projectId?: string;
    onContentChange: (nodeId: string, content: string) => void;
    onStopEditing: () => void;
    mentionReferences: CanvasResourceReference[];
    onRetry?: (node: CanvasNodeData) => void;
    onReloadResource?: (node: CanvasNodeData) => void;
    onOpenTaskDetails?: (node: CanvasNodeData) => void;
    onCancelTask?: (node: CanvasNodeData) => void;
    onToggleBatch?: () => void;
    reduceMediaEffects?: boolean;
    mediaActive?: boolean;
    scale?: number;
    onMediaPlayRequest?: (nodeId: string) => void;
};

export function CanvasNodeContent(props: CanvasNodeContentProps) {
    // 单个节点的脏数据/渲染异常不允许炸掉整棵画布树：这里兜底成节点内的错误卡片。
    return (
        <NodeContentErrorBoundary key={props.node.id} node={props.node} theme={props.theme}>
            <CanvasNodeContentBody {...props} />
        </NodeContentErrorBoundary>
    );
}

class NodeContentErrorBoundary extends Component<{ node: CanvasNodeData; theme: CanvasTheme; children: ReactNode }, { error: Error | null }> {
    state = { error: null as Error | null };

    static getDerivedStateFromError(error: unknown) {
        return { error: error instanceof Error ? error : new Error(String(error)) };
    }

    componentDidUpdate(previous: { node: CanvasNodeData }) {
        if (previous.node.id !== this.props.node.id && this.state.error) this.setState({ error: null });
    }

    render() {
        if (!this.state.error) return this.props.children;
        const { theme } = this.props;
        return (
            <div className="flex h-full w-full flex-col items-center justify-center gap-2 overflow-hidden p-3 pt-8 text-center text-xs" style={{ color: theme.node.text }}>
                <AlertCircle className="size-4 shrink-0" style={{ color: theme.accent.danger }} aria-hidden />
                <span className="break-all opacity-80">节点渲染出错：{this.state.error.message}</span>
            </div>
        );
    }
}

function CanvasNodeContentBody(props: CanvasNodeContentProps) {
    const operation = useOperationProgress(state => canvasNodeOperation(state.entries, props.projectId, props.node.id, props.node.metadata?.taskId));
    if (props.node.type === CanvasNodeType.Upscale) return <UpscaleNodeContent node={props.node} theme={props.theme} />;
    if (props.node.type === CanvasNodeType.DoubaoAccount) return <DoubaoAccountNodeContent node={props.node} theme={props.theme} />;
    if (props.node.metadata?.fileUpload) return <CanvasFileUploadContent node={props.node} theme={props.theme} reduceMotion={props.reduceMediaEffects} />;
    if (operation) return <CanvasNodeGenerationProgress node={props.node} theme={props.theme} operation={operation} onOpenTaskDetails={props.onOpenTaskDetails} onCancelTask={props.onCancelTask} />;
    const hasCustomContent = props.node.type === CanvasNodeType.Config
        || Boolean(props.node.metadata?.reusableWorkflow)
        || Boolean(props.node.metadata?.workflowSlot)
        || props.node.type === CanvasNodeType.Script
        || props.node.type === CanvasNodeType.BatchTable
        || props.node.type === CanvasNodeType.Director
        || Boolean(props.node.metadata?.directorSceneId)
        || (props.node.metadata?.workflowKind === "character" && Boolean(props.node.metadata.characterAssetId))
        || (props.node.metadata?.workflowKind === "story_input" && !props.isEditingContent)
        || (props.node.metadata?.workflowKind === "styleboard" && !props.node.metadata.content);
    if (hasCustomContent && props.renderNodeContent) return props.renderNodeContent(props.node);
    if (props.node.type === ART_CRITIQUE_NODE_TYPE) return <ArtCritiqueNodeContent node={props.node} />;
    if (props.node.type === MEDIA_CONVERSION_NODE_TYPE) return <MediaConversionNodeContent node={props.node} theme={props.theme} />;
    if (props.isBatchRoot) return <ImageNodeContent {...props} />;
    if (props.node.metadata?.status === "loading") return <CanvasNodeGenerationProgress node={props.node} theme={props.theme} onOpenTaskDetails={props.onOpenTaskDetails} onCancelTask={props.onCancelTask} />;
    if (props.node.metadata?.status === "error") return <ErrorContent node={props.node} theme={props.theme} onRetry={props.onRetry} onReloadResource={props.onReloadResource} onOpenTaskDetails={props.onOpenTaskDetails} />;

    const pluginDefinition = getNodeDefinition(props.node.type)?.plugin;
    if (pluginDefinition) return <PluginCanvasNodeContent {...props} renderer={pluginDefinition.renderer} schema={pluginDefinition.schema} />;
    const Renderer = nodeContentRenderers[props.node.type];
    return Renderer ? <Renderer {...props} /> : <UnknownNodeContent theme={props.theme} />;
}

function PluginCanvasNodeContent({ node, theme, renderer, schema }: CanvasNodeContentProps & { renderer: "declarative" | "sandbox"; schema: Record<string, unknown> }) {
    if (renderer === "sandbox") {
        return <div className="flex h-full w-full items-center justify-center p-4 text-center text-xs" style={{ color: theme.node.placeholder }}>
            插件节点等待隔离运行时
        </div>;
    }
    const data = node.metadata?.pluginData || {};
    const fields = Object.keys(schema.properties && typeof schema.properties === "object" ? schema.properties as Record<string, unknown> : schema);
    return <div className="flex h-full w-full flex-col gap-3 overflow-auto p-4 pt-10 text-xs" style={{ color: theme.node.text }}>
        {fields.length ? fields.map((field) => <div key={field} className="flex flex-col gap-1">
            <span className="font-medium opacity-60">{field}</span>
            <span className="whitespace-pre-wrap break-words opacity-90">{formatPluginValue(data[field] ?? (field === "content" ? node.metadata?.content : undefined))}</span>
        </div>) : <span className="whitespace-pre-wrap break-words">{node.metadata?.content || "插件节点"}</span>}
    </div>;
}

function formatPluginValue(value: unknown) {
    if (value === undefined || value === null || value === "") return "未设置";
    return typeof value === "string" ? value : JSON.stringify(value);
}

const nodeContentRenderers: Partial<Record<string, (props: CanvasNodeContentProps) => ReactNode>> = {
    [CanvasNodeType.Text]: TextContent,
    [CanvasNodeType.Script]: UnknownNodeContent,
    [CanvasNodeType.Skill]: SkillContent,
    [CanvasNodeType.Image]: ImageNodeContent,
    [CanvasNodeType.Config]: EmptyImageContent,
    [CanvasNodeType.Video]: VideoNodeContent,
    [CanvasNodeType.Audio]: AudioNodeContent,
    [CanvasNodeType.Drawing]: DrawingContent,
    [CanvasNodeType.Frame]: UnknownNodeContent,
    [CanvasNodeType.Markdown]: MarkdownNodeContent,
    [CanvasNodeType.Svg]: SvgNodeContent,
    [CanvasNodeType.Html]: HtmlNodeContent,
    [CanvasNodeType.Panorama]: PanoramaNodeContent,
    [CanvasNodeType.Compare]: CompareNodeContent,
    [CanvasNodeType.Chart]: ChartNodeContent,
    [CanvasNodeType.ColorGrade]: ColorGradeNodeContent,
};

function DrawingContent({ node, theme, drawingProjectId }: CanvasNodeContentProps) {
    const shapeCount = node.metadata?.drawingShapeCount || 0;
    const pageCount = node.metadata?.drawingPageCount || 1;
    const [previewUrl, setPreviewUrl] = useState(node.metadata?.drawingPreviewUrl || "");

    useEffect(() => {
        const drawingId = node.metadata?.drawingId;
        const fallbackPreview = node.metadata?.drawingPreviewUrl || "";
        setPreviewUrl(fallbackPreview);
        if (!drawingProjectId || !drawingId) return;
        let active = true;
        let objectUrl = "";
        void loadCanvasDrawingPreview(drawingProjectId, drawingId).then((preview) => {
            if (!active) return;
            if (!preview) {
                setPreviewUrl(fallbackPreview);
                return;
            }
            objectUrl = URL.createObjectURL(preview);
            setPreviewUrl(objectUrl);
        }).catch((error) => console.warn("读取绘图节点预览失败", error));
        return () => {
            active = false;
            if (objectUrl) URL.revokeObjectURL(objectUrl);
        };
    }, [drawingProjectId, node.metadata?.drawingId, node.metadata?.drawingPreviewUrl, node.metadata?.drawingRevision]);

    return (
        <div className="relative h-full w-full overflow-hidden" style={{ background: theme.node.panel, color: theme.node.text }}>
            {previewUrl ? (
                <img src={previewUrl} alt="绘图预览" className="absolute inset-0 h-full w-full object-cover" draggable={false} />
            ) : (
                <div className="absolute inset-0 grid place-items-center" style={{ background: theme.node.panel, backgroundImage: `radial-gradient(circle, ${theme.node.stroke} 1px, transparent 1px)`, backgroundSize: "18px 18px" }}>
                    <div className="flex flex-col items-center gap-2 rounded-[var(--r-lg)] px-4 py-3" style={{ border: `1px solid ${theme.node.edge}`, background: theme.node.fill, color: theme.node.muted }}>
                        <span className="grid size-10 place-items-center rounded-[var(--r-md)]" style={{ background: theme.toolbar.panel, border: `1px solid ${theme.node.edge}`, color: theme.node.text }}>
                            <Pencil className="size-5" />
                        </span>
                        <span className="text-[var(--fs-tiny)] font-medium">打开绘图</span>
                    </div>
                </div>
            )}
            <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between gap-3 px-4 pb-3 pt-12" style={{ background: `linear-gradient(to top, ${theme.node.fill}, ${theme.node.fill}e6 55%, transparent)` }}>
                <div className="min-w-0">
                    <div className="truncate text-xs font-semibold" title={node.title || "绘图"}>{node.title || "绘图"}</div>
                    <div className="mt-0.5 text-[var(--fs-tiny)]" style={{ color: theme.node.muted }}>{shapeCount} 个图形 · {pageCount} 个页面</div>
                </div>
                <Pencil className="size-3.5 shrink-0" style={{ color: theme.accent.primary }} />
            </div>
        </div>
    );
}

function ErrorContent({ node, theme, onRetry, onReloadResource, onOpenTaskDetails }: Pick<CanvasNodeContentProps, "node" | "theme" | "onRetry" | "onReloadResource" | "onOpenTaskDetails">) {
    const explanation = canvasNodeFailureExplanation(node);
    const batchChild = Boolean(node.metadata?.batchRootId);
    const localDepthAction = canRecoverOrRetryDepthCapture(node);
    const upscaleAction = Boolean(node.metadata?.workflowOperation?.id.endsWith(".ai-upscale"));
    const errorDisplayTask = {
        provider: node.metadata?.taskProvider,
        status: (node.metadata?.taskStatus || "failed") as GenerationTask["status"],
        stage: node.metadata?.taskStage,
        officialStatus: node.metadata?.taskOfficialStatus,
        errorCode: node.metadata?.taskErrorCode || node.metadata?.generationErrorCode,
    };
    const submissionUncertain = isGenerationTaskSubmissionUncertain(errorDisplayTask) || explanation.uncertain;
    return (
        <div
            data-canvas-no-zoom
            data-canvas-wheel-scroll
            className="canvas-node-error-content flex max-w-[260px] flex-col items-center gap-3 overflow-y-auto px-3 py-2 text-center"
            style={{
                boxSizing: "border-box",
                width: `min(260px, calc(${Math.max(1, node.width)}px * var(--canvas-live-scale, 1)))`,
                maxHeight: `calc(${Math.max(1, node.height)}px * var(--canvas-live-scale, 1))`,
                transform: "scale(var(--canvas-live-inverse-scale, 1))",
                transformOrigin: "center center",
            }}
        >
            <div className="w-full" style={{ color: submissionUncertain ? theme.node.text : theme.accent.danger }}>
                <GenerationFailureNotice
                    compact
                    summaryOnly={batchChild}
                    explanation={explanation}
                    context={{ ...canvasNodeDiagnosticContext(node), model: node.metadata?.model, createdAt: node.metadata?.taskCreatedAt, stage: node.metadata?.taskStage, providerRequestId: node.metadata?.taskProviderRequestId, failureDiagnostics: node.metadata?.taskFailureDiagnostics, errorSummary: node.metadata?.generationErrorSummary, completedAt: node.metadata?.taskCompletedAt, updatedAt: node.metadata?.taskUpdatedAt }}
                    onOpenDetails={node.metadata?.taskId && onOpenTaskDetails ? () => onOpenTaskDetails(node) : undefined}
                    onRetry={!localDepthAction && (submissionUncertain || explanation.uncertain || explanation.category === "download_failed") ? undefined : onRetry ? () => onRetry(node) : undefined}
                    retryLabel={upscaleAction ? node.metadata?.taskId ? "取回原结果" : "重试未提交项" : explanation.category === "result_target_unavailable" ? "生成历史" : localDepthAction && node.metadata?.taskStatus === "succeeded" ? "恢复结果" : node.metadata?.isBatchRoot ? "重新生成失败项" : "重新生成"}
                />
            </div>
            {node.metadata?.resourceReloadAvailable ? (
                <button
                    type="button"
                    className="inline-flex h-8 items-center gap-1.5 rounded-[var(--r-md)] px-3 text-xs font-medium transition-colors"
                    style={{ background: theme.accent.primary, color: theme.accent.onPrimary }}
                    onClick={(event) => { event.stopPropagation(); onReloadResource?.(node); }}
                    onMouseDown={(event) => event.stopPropagation()}
                >
                    <Download className="size-3.5" />
                    继续取回
                </button>
            ) : null}
        </div>
    );
}

function UnknownNodeContent({ theme }: Pick<CanvasNodeContentProps, "theme">) {
    return <div className="flex h-full w-full items-center justify-center text-sm" style={{ color: theme.node.placeholder }}>未知节点</div>;
}

function TextContent({ node, theme, isEditingContent, textareaRef, mentionReferences, onContentChange, onStopEditing }: CanvasNodeContentProps) {
    const fontSize = node.metadata?.fontSize || 14;
    const textStyle = { fontSize: `${fontSize}px`, lineHeight: `${Math.round(fontSize * 1.65)}px`, color: theme.node.text, boxSizing: "border-box" } as CSSProperties;
    const richTextHTML = useMemo(() => canvasRichTextHTML(node.metadata?.richText), [node.metadata?.richText]);

    return (
        <div className="flex h-full w-full flex-col overflow-hidden pt-10">
            {isEditingContent ? (
                <CanvasResourceMentionTextarea
                    ref={textareaRef}
                    className="thin-scrollbar m-0 block h-full w-full resize-none appearance-none overflow-y-auto whitespace-pre-wrap break-words border-none bg-transparent px-4 pb-4 pt-0 font-mono outline-none select-text"
                    style={textStyle}
                    value={node.metadata?.content || ""}
                    references={mentionReferences}
                    highlightLabels={false}
                    onChange={(value) => onContentChange(node.id, value)}
                    onBlur={onStopEditing}
                    onKeyDown={(event) => {
                        if (event.key === "Escape") onStopEditing();
                    }}
                    onMouseDown={(event) => event.stopPropagation()}
                    onPointerDown={(event) => event.stopPropagation()}
                    onWheel={(event) => event.stopPropagation()}
                />
            ) : richTextHTML ? (
                <div
                    className="thin-scrollbar block h-full w-full select-text overflow-y-auto break-words bg-transparent px-4 pb-4 font-mono [&_a]:underline [&_blockquote]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_blockquote]:opacity-70 [&_code]:rounded [&_code]:bg-black/6 [&_code]:px-1 dark:[&_code]:bg-white/8 [&_h1]:my-2 [&_h1]:text-[1.55em] [&_h1]:font-semibold [&_h2]:my-2 [&_h2]:text-[1.3em] [&_h2]:font-semibold [&_h3]:my-1.5 [&_h3]:text-[1.12em] [&_h3]:font-semibold [&_hr]:my-3 [&_li]:my-0.5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-1 [&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-black/90 [&_pre]:p-2 [&_pre]:text-white [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5"
                    style={textStyle}
                    onWheel={(event) => event.stopPropagation()}
                    dangerouslySetInnerHTML={{ __html: richTextHTML }}
                />
            ) : node.metadata?.content ? (
                <div className="thin-scrollbar block h-full w-full select-text overflow-y-auto whitespace-pre-wrap break-words bg-transparent px-4 pb-4 pt-0 font-mono" style={textStyle} onWheel={(event) => event.stopPropagation()}>
                    {node.metadata.content}
                </div>
            ) : <EmptyTextNodeContent theme={theme} />}
        </div>
    );
}

function EmptyTextNodeContent({ theme }: Pick<CanvasNodeContentProps, "theme">) {
    return (
        <div className="pointer-events-none flex h-full w-full flex-col overflow-hidden px-6 pb-4 pt-5" style={{ color: theme.node.text }} aria-hidden>
            <div className="flex flex-1 items-center justify-center">
                <div className="canvas-node-empty-text-mark flex flex-col items-center gap-1.5 opacity-30">
                    {[0, 1, 2, 3].map((line) => <span key={line} className="h-1 w-14 rounded-full" style={{ background: theme.node.text }} />)}
                </div>
            </div>
            <div className="canvas-node-text-footer border-t pt-2" style={{ borderColor: theme.node.stroke }} />
        </div>
    );
}

function SkillContent({ node, theme }: CanvasNodeContentProps) {
    const skill = node.metadata?.skillSnapshot;
    const tags = skill?.tags?.slice(0, 4) || [];
    const template = skill?.template || node.metadata?.content || "";

    return (
        <div className="flex h-full w-full flex-col overflow-hidden p-4" style={{ color: theme.node.text }}>
            <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                    <div className="flex items-center gap-2">
                        <span className="grid size-8 shrink-0 place-items-center rounded-[var(--r-md)]" style={{ background: `${theme.node.activeStroke}18`, color: theme.node.activeStroke }}>
                            <BookOpenCheck className="size-4" />
                        </span>
                        <div className="min-w-0">
                            <div className="truncate text-sm font-semibold" title={skill?.name || node.title || "技能"}>{skill?.name || node.title || "技能"}</div>
                            <div className="mt-0.5 flex items-center gap-1.5 text-[var(--fs-label)]" style={{ color: theme.node.muted }}>
                                <span>{skillCategoryLabel(skill?.category)}</span><span>·</span><span>{skillOutputModeLabel(skill?.outputMode)}</span>
                                {skill?.version ? <><span>·</span><span>v{skill.version}</span></> : null}
                            </div>
                        </div>
                    </div>
                </div>
            </div>
            {skill?.description ? <div className="mt-3 line-clamp-2 text-xs leading-5" style={{ color: theme.node.muted }}>{skill.description}</div> : null}
            <div className="thin-scrollbar mt-3 min-h-0 flex-1 overflow-hidden rounded-[var(--r-md)] px-3 py-2 text-xs leading-5" style={{ background: theme.node.panel, color: theme.node.text }}>
                <div className="mb-1 font-semibold opacity-55">模板</div>
                <div className="line-clamp-4 whitespace-pre-wrap break-words">{template || "未配置技能模板"}</div>
            </div>
            <div className="mt-3 flex flex-wrap gap-1.5">
                {tags.length ? tags.map((tag) => <span key={tag} className="rounded-[var(--r-sm)] bg-black/5 px-1.5 py-0.5 text-[var(--fs-tiny)] dark:bg-white/6" style={{ color: theme.node.muted }}>{tag}</span>) : <span className="text-[var(--fs-label)]" style={{ color: theme.node.muted }}>连接到图片、视频、音频或文本节点后生效</span>}
            </div>
        </div>
    );
}

function skillCategoryLabel(category?: string) {
    if (category === "writing") return "剧情";
    if (category === "storyboard") return "分镜";
    if (category === "image") return "生图";
    if (category === "video") return "视频";
    return "通用";
}

function skillOutputModeLabel(mode?: string) {
    if (mode === "json") return "JSON";
    if (mode === "image_prompt") return "生图提示词";
    if (mode === "workflow") return "工作流";
    return "文本";
}

function ImageNodeContent(props: CanvasNodeContentProps) {
    if (!props.node.metadata?.content && props.isBatchRoot) {
        const content = props.node.metadata?.status === "loading"
            ? <CanvasNodeGenerationProgress node={props.node} theme={props.theme} />
            : props.node.metadata?.status === "error"
                ? <div className="flex h-full w-full items-center justify-center overflow-hidden"><ErrorContent node={props.node} theme={props.theme} onRetry={props.onRetry} onReloadResource={props.onReloadResource} onOpenTaskDetails={props.onOpenTaskDetails} /></div>
                : <EmptyImageContent {...props} isBatchRoot={false} />;
        return <BatchFrame batchPreviewNodes={props.batchPreviewNodes} batchCount={props.batchCount} batchExpanded={props.batchExpanded} batchOpening={props.batchOpening} batchRecovering={props.batchRecovering} theme={props.theme} onToggleBatch={props.onToggleBatch}>{content}</BatchFrame>;
    }
    if (!props.node.metadata?.content) return <EmptyImageContent {...props} />;
    return <ImageContent scale={props.scale} batchPreviewNodes={props.batchPreviewNodes} node={props.node} theme={props.theme} isBatchRoot={props.isBatchRoot} batchCount={props.batchCount} batchExpanded={props.batchExpanded} batchOpening={props.batchOpening} batchRecovering={props.batchRecovering} onToggleBatch={props.onToggleBatch} />;
}

function EmptyImageContent({ node, theme, isBatchRoot, batchCount, batchPreviewNodes, batchExpanded, batchOpening, batchRecovering, onToggleBatch }: CanvasNodeContentProps) {
    const isCharacterReference = node.metadata?.workflowKind === "character" && node.metadata?.characterView === "multi";
    const content = (
        <div className="flex h-full w-full flex-col items-center justify-center overflow-hidden" style={{ color: theme.node.muted }}>
            <ImageIcon className="canvas-node-empty-image-mark size-14 opacity-30" strokeWidth={1.35} aria-hidden />
            {isCharacterReference ? (
                <div className="max-w-[80%] text-center">
                    <div className="truncate text-xs font-medium" title={node.metadata?.characterName || node.title} style={{ color: theme.node.muted }}>{node.metadata?.characterName || node.title}</div>
                    <div className="mt-1 text-[var(--fs-tiny)] tracking-[0.12em] opacity-50">多视角参考 · 待生成</div>
                </div>
            ) : null}
        </div>
    );
    if (isBatchRoot) return <BatchFrame batchPreviewNodes={batchPreviewNodes} batchCount={batchCount} batchExpanded={batchExpanded} batchOpening={batchOpening} batchRecovering={batchRecovering} theme={theme} onToggleBatch={onToggleBatch}>{content}</BatchFrame>;
    return content;
}

function VideoNodeContent({ node, theme, mediaActive = false, onMediaPlayRequest }: CanvasNodeContentProps) {
    if (node.metadata?.workflowKind === "video_retake") {
        return <VideoRetakeNodeContent node={node} theme={theme} mediaActive={mediaActive} onMediaPlayRequest={onMediaPlayRequest} />;
    }
    const playerBoxRef = useRef<HTMLDivElement>(null);
    const { updateMediaNode } = useCanvasNodeActions();
    const { url, loading, error, compatible, requestCompatible, retry, retryEpoch } = useVideoPlaybackUrl(node, mediaActive);
    const subtitleEntries = node.metadata?.subtitleEntries || [];
    const subtitleStyle = node.metadata?.subtitleStyle || createDefaultSubtitleStyle();
    const [currentTimeMs, setCurrentTimeMs] = useState(0);
    const [videoSize, setVideoSize] = useState<{ width: number; height: number } | null>(null);
    const [firstFramePresented, setFirstFramePresented] = useState(false);
    const [playbackError, setPlaybackError] = useState(false);

    useEffect(() => {
        setFirstFramePresented(false);
        setPlaybackError(false);
    }, [mediaActive, url]);

    useEffect(() => {
        if (!mediaActive || !url) return;
        recordCanvasVideoDiagnostic(node, "load_requested");
        const timer = window.setTimeout(() => {
            const video = playerBoxRef.current?.querySelector("video");
            if (!video || video.readyState < 2) recordCanvasVideoDiagnostic(node, "load_stalled", video);
        }, 10_000);
        return () => window.clearTimeout(timer);
    }, [mediaActive, url, retryEpoch, node.id]);

    useEffect(() => { if (mediaActive && error) recordCanvasVideoDiagnostic(node, "source_failed"); }, [mediaActive, error, node.id]);

    useEffect(() => {
        const box = playerBoxRef.current;
        const video = box?.querySelector("video");
        if (!video) return;
        const handleLoadedMetadata = () => {
            if (video.videoWidth <= 0 || video.videoHeight <= 0) return;
            recordCanvasVideoDiagnostic(node, "metadata_loaded", video);
            setVideoSize({ width: video.videoWidth, height: video.videoHeight });
            if (!compatible && (node.metadata?.naturalWidth !== video.videoWidth || node.metadata?.naturalHeight !== video.videoHeight)) {
                updateMediaNode?.(node.id, (current) => ({ ...current, metadata: { ...current.metadata, naturalWidth: video.videoWidth, naturalHeight: video.videoHeight } }));
            }
        };
        video.addEventListener("loadedmetadata", handleLoadedMetadata);
        handleLoadedMetadata();
        if (!subtitleEntries.length) return () => video.removeEventListener("loadedmetadata", handleLoadedMetadata);
        const handleTimeUpdate = () => setCurrentTimeMs(Math.round(video.currentTime * 1000));
        video.addEventListener("timeupdate", handleTimeUpdate);
        return () => {
            video.removeEventListener("timeupdate", handleTimeUpdate);
            video.removeEventListener("loadedmetadata", handleLoadedMetadata);
        };
    }, [node.id, node.metadata?.naturalHeight, node.metadata?.naturalWidth, subtitleEntries.length, updateMediaNode, url, compatible]);

    if (!node.metadata?.content) return <EmptyVideoContent theme={theme} />;

    const sourceRatio = (videoSize?.width || node.metadata?.naturalWidth || node.width) / Math.max(1, videoSize?.height || node.metadata?.naturalHeight || node.height);
    const fitHeight = Math.min(node.height, node.width / Math.max(0.01, sourceRatio));
    const fitWidth = Math.round(fitHeight * sourceRatio);
    const activeEntry = subtitleEntries.find((entry) => currentTimeMs >= entry.startMs && currentTimeMs < entry.endMs);
    const activeHighlight = activeEntry ? (node.metadata?.subtitleHighlights || []).find((item) => item.entryIndex === activeEntry.index) : undefined;
    const presentation = canvasVideoPresentationState({ active: mediaActive, hasSource: Boolean(url), firstFramePresented });

    return (
        <div ref={playerBoxRef} className="relative flex h-full w-full items-center justify-center overflow-hidden rounded-[var(--node-radius)] bg-black" onErrorCapture={(event) => {
            // A failed <source> does not bubble a video error to Vidstack.
            if (event.target instanceof HTMLSourceElement) { recordCanvasVideoDiagnostic(node, "playback_failed", playerBoxRef.current?.querySelector("video")); if (!requestCompatible()) setPlaybackError(true); }
        }}>
            {node.metadata?.outputParameterWarning ? <div role="status" className="absolute left-2 right-2 top-2 z-[var(--node-z-overlay)] rounded-md px-3 py-2 text-xs leading-relaxed" style={{ background: theme.node.panel, color: theme.node.text }}>{node.metadata.outputParameterWarning}</div> : null}
            <div className={`absolute inset-0 ${presentation.showPoster ? "opacity-100" : "opacity-0"}`}>
                <InactiveVideoPreview node={node} theme={theme} onPlay={() => onMediaPlayRequest?.(node.id)} hoverEnabled={!mediaActive} showPlayButton={!mediaActive} />
            </div>
            {presentation.showLoading ? <div role="status" className="pointer-events-none absolute inset-0 z-[var(--node-z-overlay)] flex flex-col items-center justify-center gap-2 bg-black/15 text-white/75"><LoaderCircle className="size-5 animate-spin" /><span className="text-xs">{loading ? "正在准备视频预览" : "正在加载视频"}</span></div> : null}
            {error ? <div role="status" className="absolute inset-0 z-[var(--node-z-overlay)] flex flex-col items-center justify-center gap-3 bg-black/80 px-4 text-center text-xs text-white/80"><span>{error}</span><button type="button" data-canvas-no-zoom className="rounded border px-3 py-1" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); retry(); }}>重新加载</button></div> : null}
            {playbackError ? <div role="status" className="absolute inset-0 z-[var(--node-z-overlay)] grid place-items-center bg-black/80 px-4 text-center text-xs text-white/80">视频已导入，当前无法播放预览。原文件仍可下载和使用。</div> : null}
            {mediaActive && url ? (
                <div className={`absolute ${presentation.showVideo ? "opacity-100" : "pointer-events-none opacity-0"}`} style={{ width: fitWidth, height: Math.round(fitHeight) }}>
                    <VideoPlayer key={retryEpoch} src={url} mimeType={compatible ? "video/mp4" : node.metadata?.mimeType} title={node.title || "视频"} hasAudio={inferVideoHasAudio(node.metadata)} autoPlay preload="metadata" brandColor={theme.accent.primary} className="h-full w-full rounded-[var(--node-radius)] bg-black" dataCanvasNoZoom compactControls onFirstFramePresented={() => { setFirstFramePresented(true); recordCanvasVideoDiagnostic(node, "first_frame", playerBoxRef.current?.querySelector("video")); }} onError={() => { recordCanvasVideoDiagnostic(node, "playback_failed", playerBoxRef.current?.querySelector("video")); if (!requestCompatible()) setPlaybackError(true); }} onPlay={() => scheduleResourceBlobCache(node.metadata?.storageKey || "")} />
                    {activeEntry && activeEntry.text.trim() ? <CanvasSubtitleOverlay text={activeEntry.text} highlight={activeHighlight} style={subtitleStyle} /> : null}
                </div>
            ) : null}
        </div>
    );
}

function VideoRetakeNodeContent({ node, theme, mediaActive = false, onMediaPlayRequest }: Pick<CanvasNodeContentProps, "node" | "theme" | "mediaActive" | "onMediaPlayRequest">) {
    const [progress, setProgress] = useState(0);
    const { updateMetadata } = useCanvasNodeActions();
    const count = Math.min(5, Math.max(0, node.metadata?.videoRetakeCount || 0));
    const segments = node.metadata?.videoRetakeSegments || [];
    const referenceMode = node.metadata?.videoRetakeReferenceMode || "reference";
    const webSearch = Boolean(node.metadata?.videoRetakeWebSearch);
    const autoValidate = node.metadata?.videoRetakeAutoValidate !== false;
    const autoLink = node.metadata?.videoRetakeAutoLink !== false;
    const playbackNode = useMemo(() => ({ ...node, metadata: { ...node.metadata, workflowKind: undefined } }), [node]);
    return (
        <div className="flex h-full w-full flex-col overflow-hidden rounded-[var(--node-radius)] bg-black text-white">
            <div className="relative min-h-0 flex-[0.78] overflow-hidden">
                <VideoNodeContent {...({ node: playbackNode, theme, mediaActive, onMediaPlayRequest } as CanvasNodeContentProps)} />
                <div className="pointer-events-none absolute inset-x-0 bottom-0 z-[var(--node-z-overlay)] space-y-1 bg-gradient-to-t from-black/85 to-transparent px-3 pb-2 pt-8 text-[var(--fs-tiny)]">
                    <div className="flex items-center justify-between"><span>回放进度</span><span>{Math.round(progress)}s</span></div>
                    <input aria-label="回放进度" className="pointer-events-auto h-1 w-full accent-white" type="range" min={0} max={Math.max(1, Math.round((node.metadata?.durationMs || 1000) / 1000))} value={Math.min(progress, Math.max(1, Math.round((node.metadata?.durationMs || 1000) / 1000)))} onChange={(event) => setProgress(Number(event.target.value))} />
                </div>
            </div>
            <div className="min-h-0 flex-1 space-y-2 overflow-auto border-t border-white/10 bg-[#171717] px-3 py-2 text-[var(--fs-tiny)]" onPointerDown={(event) => event.stopPropagation()} onWheel={(event) => event.stopPropagation()}>
                <div className="flex items-center justify-between"><span className="font-medium">{count}/5 个片段</span><span className="opacity-60">片段重拍</span></div>
                <div className="flex items-center gap-1">
                    {(["reference", "mark", "character"] as const).map((mode) => <button key={mode} type="button" className={`rounded px-2 py-1 ${referenceMode === mode ? "bg-white/16 text-white" : "text-white/65 hover:bg-white/8"}`} onClick={() => updateMetadata?.(node.id, { videoRetakeReferenceMode: mode })}>{mode === "reference" ? "参考" : mode === "mark" ? "标记" : "角色库"}</button>)}
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                    {segments.length ? segments.slice(0, 5).map((segment, index) => <button key={`${segment.startMs}-${segment.endMs}`} type="button" className="rounded bg-white/10 px-1.5 py-0.5 text-white/85" onClick={() => setProgress(Math.round(segment.startMs / 1000))}>{index + 1} {((segment.endMs - segment.startMs) / 1000).toFixed(1)}s</button>) : <span className="rounded bg-white/10 px-1.5 py-0.5 text-white/70">1 {((node.metadata?.durationMs || 0) / 1000).toFixed(1)}s</span>}
                </div>
                <textarea aria-label="片段重拍提示词" className="min-h-10 w-full resize-none rounded border border-white/10 bg-black/20 px-2 py-1.5 text-[var(--fs-tiny)] text-white outline-none placeholder:text-white/40 focus:border-white/30" placeholder="留空＝原样重跑一次；也可以写要改什么，例如：把黄色台灯换成白色台灯" value={node.metadata?.prompt || ""} onChange={(event) => updateMetadata?.(node.id, { prompt: event.target.value })} />
                <div className="flex items-center gap-1.5"><button type="button" className="rounded bg-white/10 px-2 py-1" onClick={() => undefined}>2.5</button><button type="button" className="rounded bg-white/10 px-2 py-1" onClick={() => undefined}>720P · 1个 ·</button><span className="ml-auto text-white/55">1380</span></div>
                <button type="button" className="text-white/70" onClick={() => undefined}>高级设置</button>
                <div className="space-y-1 border-t border-white/10 pt-1.5">
                    <ToggleLine label="联网搜索" value={webSearch} onChange={(value) => updateMetadata?.(node.id, { videoRetakeWebSearch: value })} />
                    <ToggleLine label="自动校验素材" value={autoValidate} onChange={(value) => updateMetadata?.(node.id, { videoRetakeAutoValidate: value })} />
                    <ToggleLine label="智能引用 AutoLink" value={autoLink} onChange={(value) => updateMetadata?.(node.id, { videoRetakeAutoLink: value })} />
                </div>
            </div>
        </div>
    );
}

function ToggleLine({ label, value, onChange }: { label: string; value: boolean; onChange: (value: boolean) => void }) {
    return <label className="flex items-center justify-between text-white/65"><span>{label}</span><button type="button" role="switch" aria-checked={value} className={`relative h-4 w-7 rounded-full ${value ? "bg-white/70" : "bg-white/20"}`} onClick={() => onChange(!value)}><span className={`absolute top-0.5 size-3 rounded-full bg-black transition-transform ${value ? "translate-x-3.5" : "translate-x-0.5"}`} /></button></label>;
}

function AudioNodeContent({ node, theme }: CanvasNodeContentProps) {
    if (!node.metadata?.content && !node.metadata?.storageKey) return <EmptyAudioContent theme={theme} />;
    return <CanvasAudioPlayer node={node} theme={theme} />;
}

export function InactiveVideoPreview({ node, theme, onPlay, hoverEnabled = true, showPlayButton = true }: Pick<CanvasNodeContentProps, "node" | "theme"> & { onPlay: () => void; hoverEnabled?: boolean; showPlayButton?: boolean }) {
    const previewRef = useRef<HTMLDivElement>(null);
    const nearViewport = useNearViewport(previewRef);
    const [scopeEpoch, setScopeEpoch] = useState(getActiveUserScopeEpoch);
    const sourceKey = canvasDerivedPreviewSourceKey(node);
    const [derivedPreview, setDerivedPreview] = useState<{ sourceKey: string; epoch: number; content: string }>();
    const persistedPreviewUrl = canvasNodeVideoPreviewUrl(node);
    const derivedPreviewUrl = derivedPreview?.sourceKey === sourceKey && derivedPreview.epoch === getActiveUserScopeEpoch() ? derivedPreview.content : "";
    const previewNeedsHydration = canvasVideoPreviewNeedsHydration(node);
    const previewUrl = previewNeedsHydration ? derivedPreviewUrl || persistedPreviewUrl : persistedPreviewUrl;
    const [hydrating, setHydrating] = useState(false);

    useEffect(() => {
        if (!hoverEnabled) return;
        const element = previewRef.current;
        if (!element) return;
        const content = node.metadata?.content || "";
        const fallback = node.metadata?.importSource?.provider === "libtv" ? buildLibTVVideoSourceUrl(content) : content;
        return bindCanvasVideoHoverPreview(element, (signal) => acquireCanvasVideoSource(node.metadata?.storageKey, fallback, signal));
    }, [hoverEnabled, node.metadata?.content, node.metadata?.storageKey, node.metadata?.importSource?.provider]);

    useEffect(() => {
        return subscribeUserScope((epoch) => { setDerivedPreview(undefined); setScopeEpoch(epoch.generation); });
    }, []);

    useEffect(() => {
        if (!previewNeedsHydration || !nearViewport || (!node.metadata?.storageKey && !node.metadata?.content)) {
            setHydrating(false);
            return;
        }
        let active = true;
        const lease = acquireCanvasVideoPreview(node);
        setDerivedPreview(undefined);
        setHydrating(true);
        void lease.promise
            .then((videoPreview) => {
                if (active && scopeEpoch === getActiveUserScopeEpoch() && videoPreview) setDerivedPreview({ sourceKey, epoch: scopeEpoch, content: videoPreview.content });
            })
            .catch(() => undefined)
            .finally(() => {
                if (active) setHydrating(false);
            });
        return () => { active = false; lease.release(); };
    }, [nearViewport, sourceKey, previewNeedsHydration, scopeEpoch]);

    if (previewUrl) {
        return <div ref={previewRef} className="group/video-preview relative size-full overflow-hidden rounded-[var(--node-radius)] bg-black">
            <CachedResourceImage storageKey={derivedPreviewUrl === previewUrl ? undefined : node.metadata?.videoPreview?.storageKey} src={previewUrl} alt={`${node.title || "视频"} 静态预览`} loading="lazy" decoding="async" draggable={false} className="pointer-events-none size-full select-none object-contain" fallback={<InactiveMediaCard icon={<Video className="size-7" />} title={node.title || "视频"} hint="首帧暂不可用，点击播放视频" theme={theme} />} loadingFallback={<InactiveMediaCard icon={<Video className="size-7" />} title={node.title || "视频"} hint="正在读取首帧" theme={theme} />} />
            {showPlayButton ? <VideoPreviewPlayButton title={node.title || "视频"} onPlay={onPlay} /> : null}
        </div>;
    }
    return <div ref={previewRef} className="group/video-preview relative size-full">
        <InactiveMediaCard icon={<Video className="size-7" />} title={node.title || "视频"} hint={hydrating ? "正在生成首帧" : nearViewport ? "点击播放视频" : "进入视口后加载首帧"} theme={theme} />
        {showPlayButton ? <VideoPreviewPlayButton title={node.title || "视频"} onPlay={onPlay} /> : null}
    </div>;
}

function VideoPreviewPlayButton({ title, onPlay }: { title: string; onPlay: () => void }) {
    return <button type="button" className="absolute left-1/2 top-1/2 z-[var(--node-z-overlay)] grid size-11 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-black/62 text-white shadow-lg backdrop-blur transition-[transform,background-color,opacity] hover:scale-105 hover:bg-black/78 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white" aria-label={`播放 ${title}`} title="播放视频" onPointerDown={(event) => event.stopPropagation()} onMouseDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); onPlay(); }}><Play className="ml-0.5 size-5 fill-current" /></button>;
}

function useVideoPlaybackUrl(node: CanvasNodeData, active: boolean) {
    const rawContent = node.metadata?.content || "";
    const fallback = node.metadata?.importSource?.provider === "libtv" ? buildLibTVVideoSourceUrl(rawContent) : rawContent;
    const storageKey = node.metadata?.storageKey || "";
    return useResourceVideoPlayback(storageKey, fallback, active);
}

function InactiveMediaCard({ icon, title, hint, theme }: { icon: ReactNode; title: string; hint: string; theme: CanvasTheme }) {
    return <div className="flex size-full flex-col items-center justify-center gap-2 rounded-[var(--node-radius)] px-4 text-center" style={{ background: theme.node.fill, color: theme.node.muted }}><span className="opacity-40">{icon}</span><span className="max-w-full truncate text-xs font-medium" title={title}>{title}</span><span className="text-[var(--fs-tiny)] opacity-50">{hint}</span></div>;
}

function MediaLoadingState({ icon, label }: { icon: ReactNode; label: string }) {
    return <div role="status" className="flex size-full flex-col items-center justify-center gap-2 rounded-[var(--node-radius)] bg-black text-white/75"><span className="grid size-10 place-items-center rounded-full bg-white/10">{icon}</span><span className="text-xs font-medium">{label}</span></div>;
}

function EmptyMediaContent({ icon, label, color }: { icon: ReactNode; label: string; color: string }) {
    return <div className="flex h-full w-full flex-col items-center justify-center gap-3" style={{ color }}>{icon}<span className="text-sm">{label}</span></div>;
}

function EmptyVideoContent({ theme }: { theme: CanvasTheme }) {
    return <div className="flex h-full w-full items-center justify-center" style={{ color: theme.node.muted }}><Play className="canvas-node-empty-video-mark size-14 fill-current opacity-30" strokeWidth={1.2} aria-hidden /></div>;
}

function EmptyAudioContent({ theme }: { theme: CanvasTheme }) {
    return <div className="flex h-full w-full items-center justify-center" style={{ color: theme.node.muted }}><Music2 className="canvas-node-empty-audio-mark size-14 opacity-30" strokeWidth={1.25} aria-hidden /></div>;
}

function ImageContent({ node, theme, scale = 1, isBatchRoot, batchCount, batchPreviewNodes, batchExpanded, batchOpening, batchRecovering, onToggleBatch }: Pick<CanvasNodeContentProps, "node" | "theme" | "scale" | "isBatchRoot" | "batchCount" | "batchPreviewNodes" | "batchExpanded" | "batchOpening" | "batchRecovering" | "onToggleBatch">) {
    const imageContainerRef = useRef<HTMLDivElement>(null);
    const nearViewport = useNearViewport(imageContainerRef);
    const { url, loading, error, retry, fail } = useNodeResourceUrl(node, nearViewport);
    const importedFromLibTV = node.metadata?.importSource?.provider === "libtv";
    const { updateMediaNode } = useCanvasNodeActions();
    const measuredSizeRef = useRef<{ width: number; height: number } | null>(null);
    const compactStatus = node.width * scale < 140 || node.height * scale < 80;

    /**
     * 让节点跟随图片真实比例。
     *
     * 上传接口的 width/height 是可选的（services/api/resources.ts），拿不到时节点会落到
     * 默认的横向比例，竖图就被放进一个宽盒子、两侧留黑。这里在图片解码后量真实尺寸并校正。
     *
     * 判据是「用户有没有手动定过尺寸」，**不是**「有没有量过尺寸」——后者会让所有已经
     * 存过 naturalWidth 的旧节点永远得不到修正（第一版就是这么写的，所以没生效）。
     * 手动拉过（manualSize）或自由比例（freeResize）的节点只补记尺寸、不动宽高。
     */
    const fitToImage = (element: HTMLImageElement) => {
        // LibTV 已提供原图尺寸和节点尺寸；960px 缩略图不能反向覆盖这些数据。
        if (importedFromLibTV) return;
        const naturalWidth = element.naturalWidth;
        const naturalHeight = element.naturalHeight;
        if (!naturalWidth || !naturalHeight) return;
        if (measuredSizeRef.current?.width === naturalWidth && measuredSizeRef.current.height === naturalHeight) return;
        measuredSizeRef.current = { width: naturalWidth, height: naturalHeight };
        updateMediaNode?.(node.id, (current) => fitImageNodeToDecodedSize(current, naturalWidth, naturalHeight));
    };

    return (
        <BatchFrame batchPreviewNodes={batchPreviewNodes} batchCount={isBatchRoot ? batchCount : 0} batchExpanded={batchExpanded} batchOpening={batchOpening} batchRecovering={batchRecovering} theme={theme} onToggleBatch={onToggleBatch}>
            <div ref={imageContainerRef} className="h-full w-full overflow-hidden rounded-[var(--node-radius)]">
                {error ? (
                    <div role="status" aria-label="图片加载失败" className="flex size-full items-center justify-center text-center text-xs" style={{ background: theme.node.fill, color: theme.node.text }}>
                        <div className="flex flex-col items-center gap-2" style={{ transform: "scale(var(--canvas-live-inverse-scale, 1))", transformOrigin: "center" }}>
                            {!compactStatus ? <span>图片加载失败</span> : null}
                            <button type="button" data-canvas-no-zoom aria-label="重新加载图片" title="重新加载图片" className={`inline-flex items-center justify-center gap-1.5 rounded border focus-visible:outline focus-visible:outline-2 ${compactStatus ? "size-7" : "px-3 py-1"}`} style={{ borderColor: theme.node.stroke, color: theme.node.text }} onPointerDown={(event) => event.stopPropagation()} onMouseDown={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); retry(); }}>
                                <RefreshCw className="size-4 shrink-0" aria-hidden />
                                {!compactStatus ? "重新加载" : null}
                            </button>
                        </div>
                    </div>
                ) : url ? <img src={url} alt={node.title} loading="lazy" decoding="async" draggable={false} onDragStart={(event) => event.preventDefault()} onError={fail} onLoad={(event) => fitToImage(event.currentTarget)} className={`pointer-events-none block h-full w-full select-none ${node.metadata?.freeResize ? "object-fill" : "object-contain"}`} /> : <div role="status" aria-label="正在加载图片" className="grid size-full place-items-center" style={{ background: theme.node.fill, color: theme.node.muted }}><span style={{ transform: "scale(var(--canvas-live-inverse-scale, 1))" }}>{loading ? <LoaderCircle className="size-5 animate-spin" /> : <ImageIcon className="size-5" />}</span></div>}
            </div>
        </BatchFrame>
    );
}

function useNodeResourceUrl(node: CanvasNodeData, eager: boolean) {
    const storageKey = node.metadata?.storageKey || "";
    const rawContent = node.metadata?.content || "";
    const content = node.type === CanvasNodeType.Video && node.metadata?.importSource?.provider === "libtv"
        ? buildLibTVVideoSourceUrl(rawContent)
        : rawContent;
    // `previewContent` is intentionally passive-only.  When a media node is
    // activated, VideoPlayer/Audio must receive the playable asset, never the
    // LibTV OSS snapshot URL stored for the thumbnail.
    const fallback = node.type === CanvasNodeType.Video || node.type === CanvasNodeType.Audio
        ? content
        : node.metadata?.previewContent
            || (node.type === CanvasNodeType.Image && node.metadata?.importSource?.provider === "libtv" ? buildLibTVImagePreviewUrl(content) : content);
    const resourceId = resourceIdFromStorageKey(storageKey);
    const isRemoteResource = Boolean(resourceId);
    // 远程资源接口受登录/桌面令牌保护，原生 `<img>` 无法附带该令牌。
    // 重登后只能先通过 cacheResourceObjectUrl() 走鉴权下载，再挂载 Blob URL。
    const synchronousUrl = eager && isRemoteResource && node.type === CanvasNodeType.Image ? peekCachedResourceObjectUrl(storageKey) : "";
    // Inline data URLs are already local, but decoding thousands of them is
    // still expensive. Images must wait for the same viewport gate as remote
    // resources; otherwise DOM virtualization does not reduce image work.
    const isLazyVisual = node.type === CanvasNodeType.Image;
    const initialUrl = synchronousUrl || (isRemoteResource || isLazyVisual ? "" : fallback);
    const [url, setUrl] = useState(() => initialUrl);
    const [loading, setLoading] = useState(() => !initialUrl && isRemoteResource && eager);
    const [error, setError] = useState(false);
    const [attempt, setAttempt] = useState(0);
    const reloadRequested = useRef(false);
    const [scopeEpoch, setScopeEpoch] = useState(getActiveUserScopeEpoch);
    useEffect(() => subscribeUserScope((epoch) => setScopeEpoch(epoch.generation)), []);
    const reportImageEvent = useCallback((code: "CANVAS_IMAGE_READ_FAILED" | "CANVAS_IMAGE_DECODE_FAILED" | "CANVAS_IMAGE_RELOAD") => {
        if (node.type !== CanvasNodeType.Image) return;
        const safeNodeId = /^[A-Za-z0-9._:-]{1,96}$/.test(node.id) ? node.id : "unknown";
        recordDiagnosticEvent({
            level: code === "CANVAS_IMAGE_RELOAD" ? "info" : "error",
            category: "runtime", code,
            message: `${code === "CANVAS_IMAGE_DECODE_FAILED" ? "画布图片解码失败" : code === "CANVAS_IMAGE_READ_FAILED" ? "画布图片读取失败" : "重新读取画布图片"} node=${safeNodeId}`,
            taskId: node.metadata?.taskId,
            route: resourceId && /^[A-Za-z0-9_-]{1,96}$/.test(resourceId) ? `/resources/${resourceId}/file` : undefined,
        });
    }, [node.id, node.type, node.metadata?.taskId, resourceId]);
    const fail = useCallback(() => { reportImageEvent("CANVAS_IMAGE_DECODE_FAILED"); setError(true); }, [reportImageEvent]);
    const retry = useCallback(() => { reportImageEvent("CANVAS_IMAGE_RELOAD"); reloadRequested.current = true; setError(false); setAttempt((current) => current + 1); }, [reportImageEvent]);

    useEffect(() => {
        let cancelled = false;
        setError(false);
        if (!isRemoteResource && isLazyVisual && storageKey) {
            if (!eager) {
                setUrl("");
                setLoading(false);
                return;
            }
            setLoading(true);
            void resolveImageUrl(storageKey, fallback)
                .then((resolved) => {
                    if (!cancelled) setUrl(resolved);
                })
                .catch(() => {
                    if (!cancelled) { setUrl(""); setError(true); reportImageEvent("CANVAS_IMAGE_READ_FAILED"); }
                })
                .finally(() => {
                    if (!cancelled) setLoading(false);
                });
            return () => { cancelled = true; };
        }
        if (!isRemoteResource) {
            setUrl(isLazyVisual && !eager ? "" : fallback);
            setLoading(false);
            return;
        }
        const reload = reloadRequested.current;
        reloadRequested.current = false;
        const cachedSync = reload ? "" : peekCachedResourceObjectUrl(storageKey);
        if (cachedSync) {
            setUrl(cachedSync);
            setLoading(false);
            return;
        }
        setUrl("");
        setLoading(eager);
        // 只有进入视口或被激活的节点才下载远程媒体；缓存层会复用已有 Blob URL 和 in-flight 请求。
        const resolve = eager ? cacheResourceObjectUrl(storageKey, reload) : getCachedResourceObjectUrl(storageKey);
        void resolve.then((cached) => {
            if (!cancelled && cached) setUrl(cached);
            if (!cancelled && eager && !cached) { setError(true); reportImageEvent("CANVAS_IMAGE_READ_FAILED"); }
            // Never hand a protected resource URL to a native <img> after a
            // cache miss. It cannot attach the auth header and would render
            // as a broken image after relogin.
        }).catch(() => {
            if (!cancelled && eager) { setUrl(synchronousUrl); setError(true); reportImageEvent("CANVAS_IMAGE_READ_FAILED"); }
        }).finally(() => {
            if (!cancelled) setLoading(false);
        });
        return () => { cancelled = true; };
    }, [eager, fallback, isLazyVisual, isRemoteResource, storageKey, attempt, scopeEpoch, reportImageEvent]);

    return { url, loading, error, retry, fail };
}

function useNearViewport(ref: RefObject<Element | null>) {
    const [nearViewport, setNearViewport] = useState(false);
    useEffect(() => {
        const element = ref.current;
        if (!element || typeof IntersectionObserver === "undefined") {
            setNearViewport(true);
            return;
        }
        const observer = new IntersectionObserver((entries) => {
            if (entries.some((entry) => entry.isIntersecting)) {
                setNearViewport(true);
                observer.disconnect();
            }
        }, { rootMargin: "600px" });
        observer.observe(element);
        return () => observer.disconnect();
    }, [ref]);
    return nearViewport;
}

export function CanvasNodeImageInfo({ node }: { node: CanvasNodeData }) {
    const width = Math.round(node.metadata?.naturalWidth || node.width);
    const height = Math.round(node.metadata?.naturalHeight || node.height);
    const size = formatBytes(node.metadata?.bytes || 0);
    return <span className="ml-auto max-w-full shrink-0 truncate rounded-[var(--r-sm)] bg-black/55 px-2 py-1 text-[var(--fs-label)] font-medium leading-none text-white backdrop-blur-sm">{width} x {height}{size ? ` · ${size}` : ""}</span>;
}

function BatchPreviewImage({ node }: { node: CanvasNodeData }) {
    const ref = useRef<HTMLDivElement>(null);
    const nearViewport = useNearViewport(ref);
    const { url } = useNodeResourceUrl(node, nearViewport);
    return <div ref={ref} className="h-full w-full overflow-hidden rounded-[inherit]">{url ? <img src={url} alt={`子图预览：${node.title}`} className="h-full w-full object-contain" draggable={false} /> : null}</div>;
}

function BatchFrame({ batchCount, batchPreviewNodes, batchExpanded, batchOpening, batchRecovering, theme, onToggleBatch, children }: { batchCount: number; batchPreviewNodes?: CanvasNodeData[]; batchExpanded: boolean; batchOpening: boolean; batchRecovering: boolean; theme: CanvasTheme; onToggleBatch?: () => void; children: ReactNode }) {
    const isBatchRoot = batchCount > 1;
    return (
        <div className="group/batch relative h-full w-full overflow-visible" onDoubleClick={isBatchRoot ? (event) => { event.stopPropagation(); onToggleBatch?.(); } : undefined}>
            {isBatchRoot ? (
                <div className="pointer-events-none absolute inset-0 overflow-visible">
                    {Array.from({ length: Math.min(batchCount - 1, 5) }).map((_, index) => (
                        <div
                            key={index}
                            className="absolute rounded-[var(--r-lg)] transition-all duration-300 group-hover/batch:translate-x-2"
                            style={{
                                inset: 0,
                                background: theme.node.panel,
                                boxShadow: `inset 0 0 0 1px ${theme.node.stroke}`,
                                opacity: batchExpanded && !batchOpening ? 0.34 : 1,
                                transform: batchOpening || batchRecovering ? `translate(${54 + index * 22}px, ${20 + index * 12}px) rotate(${8 + index * 5}deg) scale(.98)` : `translate(${34 + index * 18}px, ${14 + index * 10}px) rotate(${6 + index * 4}deg)`,
                                zIndex: -index - 1,
                            }}
                        >
                            {batchPreviewNodes?.[index] ? <BatchPreviewImage node={batchPreviewNodes[index]} /> : null}
                        </div>
                    ))}
                </div>
            ) : null}
            {children}
        </div>
    );
}
