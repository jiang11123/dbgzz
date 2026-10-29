import { lazy, Suspense, type MutableRefObject } from "react";

import { AssetPickerModal, type InsertAssetPayload } from "@/components/canvas/asset-picker-modal";
import { AiArtCritiqueModal } from "@/components/canvas/art-critique/ai-art-critique-modal";
import type { ArtCritiqueNodeState } from "@/lib/art-critique/contracts";
import { CanvasCharacterReferenceModal } from "@/components/canvas/canvas-character-reference-modal";
import type { CapturedUserScope } from "@/lib/user-scope-guard";
import type { uploadImage } from "@/services/image-storage";
import type { DirectorScene, DirectorSceneOutput } from "@/types/director";
import { CanvasGenerationHistoryPicker } from "@/components/canvas/canvas-generation-history-picker";
import { CanvasNodeInfoModal } from "@/components/canvas/canvas-node-toolbar";
import { CanvasNodeSearchModal } from "@/components/canvas/canvas-node-search-modal";
import { CanvasPanoramaConfigModal, type PanoramaGenerateConfig } from "@/components/canvas/canvas-panorama-config-modal";
import { CanvasProjectAssetModal } from "@/components/canvas/canvas-project-asset-modal";
import { CanvasScriptEditor } from "@/components/canvas/canvas-script-node";
import { CanvasStylePickerModal } from "@/components/canvas/canvas-style-picker-modal";
import { CanvasSubtitleDialog } from "@/components/canvas/canvas-subtitle-dialog";
import { CanvasTextEditorModal } from "@/components/canvas/canvas-text-editor-modal";
import { CanvasTimelineDialog } from "@/components/canvas/canvas-timeline-dialog";
import { CanvasVersionCompareModal } from "@/components/canvas/canvas-version-compare-modal";
import { CanvasVideoFrameDialog } from "@/components/canvas/canvas-video-frame-dialog";
import type { CanvasImageUpscaleParams } from "@/components/canvas/canvas-node-upscale-dialog";
import type { CanvasVideoFrameParams } from "@/components/canvas/canvas-video-frame-dialog";
import { WorkspaceState } from "@/components/layout/workspace-state";
import type { CanvasDrawingEngine } from "@/lib/canvas/canvas-drawing-engine";
import type { CanvasStylePreset } from "@/lib/canvas/canvas-style-system";
import { canvasThemes } from "@/lib/canvas-theme";
import type { ProjectDetail } from "@/services/api/projects";
import type { GenerationTask, TaskLog } from "@/services/api/task-center";
import type { AiConfig } from "@/stores/use-config-store";
import {
    type CanvasConnection,
    type CanvasNodeData,
    type CanvasNodeMetadata,
    type StoryboardColumn,
    type StoryboardRow,
    type StoryboardVideoInputMode,
    type ViewportTransform,
} from "@/types/canvas";
import type { SrtEntry, TimelineDirectMedia, TimelineProject } from "@/types/timeline";

import { LibTVImportDialog } from "./components/libtv-import-dialog";
import { TapNowImportDialog } from "./components/tapnow-import-dialog";
import { CanvasProjectMediaDialogs } from "./canvas-project-media-dialogs";
import { CanvasProjectStatusDialogs } from "./canvas-project-status-dialogs";

const CanvasDirectorWorkbench = lazy(() => import("@/components/canvas/director/canvas-director-workbench").then((module) => ({ default: module.CanvasDirectorWorkbench })));
const CanvasDrawingEditorModal = lazy(() => import("@/components/canvas/canvas-drawing-editor-modal").then((module) => ({ default: module.CanvasDrawingEditorModal })));

type CanvasTheme = (typeof canvasThemes)[keyof typeof canvasThemes];

export type CanvasProjectEditorDialogsProps = {
    projectId: string;
    theme: CanvasTheme;
    config: AiConfig;
    nodes: CanvasNodeData[];
    viewport: ViewportTransform;
    viewportSize: { width: number; height: number };
    search: {
        open: boolean;
        onClose: () => void;
        onFocus: (nodeId: string) => void;
    };
    generationHistory: {
        open: boolean;
        onClose: () => void;
        onSelect: (task: GenerationTask) => void;
    };
    imports: {
        libTVOpen: boolean;
        tapNowOpen: boolean;
        onCloseLibTV: () => void;
        onCloseTapNow: () => void;
        onApplyLibTV: (nodes: CanvasNodeData[], connections: CanvasConnection[]) => Promise<void>;
        onApplyTapNow: (nodes: CanvasNodeData[], connections: CanvasConnection[]) => Promise<void>;
    };
    style: {
        open: boolean;
        value?: string;
        applying: boolean;
        onClose: () => void;
        onSelect: (preset: CanvasStylePreset) => void;
    };
    info: {
        node: CanvasNodeData | null;
        onClose: () => void;
        onMetadataChange: (nodeId: string, metadata: Partial<CanvasNodeMetadata>) => void;
    };
    subtitle: {
        node: CanvasNodeData | null;
        onClose: () => void;
        onSave: (nodeId: string, patch: Partial<CanvasNodeMetadata>) => void;
    };
    frame: {
        node: CanvasNodeData | null;
        onClose: () => void;
        onConfirm: (params: CanvasVideoFrameParams) => void;
    };
    timeline: {
        node: CanvasNodeData | null;
        timeline: TimelineProject | null;
        onClose: () => void;
        onOpenSubtitleDialog: (nodeId: string) => void;
        onSave: (next: TimelineProject) => void | Promise<void>;
        onSaveSubtitles: (nodeId: string, entries: SrtEntry[]) => void;
        onOpenAssetLibrary: () => void;
        onOpenProjectAssets: () => void;
        onUploadLocalFiles: (files: File[]) => Promise<TimelineDirectMedia[]>;
        addNodeToTimelineRef: MutableRefObject<((node: CanvasNodeData) => void) | null>;
        addMediaToTimelineRef: MutableRefObject<((media: TimelineDirectMedia) => void) | null>;
        onCreateAssembledNode: (blob: Blob, title: string) => Promise<CanvasNodeData | null>;
    };
    character: {
        node: CanvasNodeData | null;
        onClose: () => void;
    };
    text: {
        node: CanvasNodeData | null;
        onClose: () => void;
        onSave: (nodeId: string, title: string, content: string, richText: Record<string, unknown>) => void;
    };
    drawing: {
        node: CanvasNodeData | null;
        onClose: () => void;
        onSaved: (nodeId: string, summary: { engine: CanvasDrawingEngine; revision: number; updatedAt: string; shapeCount: number; pageCount: number }) => void;
    };
    artCritique: {
        node: CanvasNodeData | null;
        upstreamNodes: CanvasNodeData[];
        startRequestId?: string;
        restartRequested?: boolean;
        onRunningChange: (running: boolean) => void;
        onClose: () => void;
        onUpdateState: (nodeId: string, state: ArtCritiqueNodeState) => void;
    };
    panorama: {
        nodeId: string | null;
        onCancel: () => void;
        onConfirm: (composedPrompt: string, config: PanoramaGenerateConfig) => void;
        onCopyPrompt: (prompt: string) => void;
    };
    script: {
        node: CanvasNodeData | null;
        onClose: () => void;
        onUpdateRows: (rows: StoryboardRow[]) => void;
        onVisibleColumnsChange: (columns: StoryboardColumn[]) => void;
        onGenerateImages: (rowIds: string[]) => void;
        onGenerateVideos: (rowIds: string[]) => void;
        onVideoInputModeChange: (mode: StoryboardVideoInputMode) => void;
    };
    director: {
        nodeId: string | null;
        scene: DirectorScene | null;
        imageNodes: CanvasNodeData[];
        onboardingScope: string;
        onClose: () => void;
        onChange: (scene: DirectorScene) => void;
        onApply: (output: DirectorSceneOutput) => Promise<void | { confirmed?: boolean }>;
        onShouldCaptureCover?: (scene: DirectorScene, shotId: string) => boolean;
        onCaptureCover?: (input: { scene: DirectorScene; shotId: string; beauty: Blob }) => Promise<void>;
        onDeleteImageNode: (nodeId: string) => void;
        onAddCanvasImage: (image: Awaited<ReturnType<typeof uploadImage>>, title: string, signal: AbortSignal, expectedScope: CapturedUserScope) => Promise<{ assetId?: string; persisted?: boolean } | void>;
        onFlush: () => void | Promise<void>;
    };
    versionCompare: {
        open: boolean;
        versions: CanvasNodeData[];
        onClose: () => void;
        onSetPrimary: (nodeId: string) => void;
        onFocus: (nodeId: string) => void;
    };
    media: {
        upscaleNode: CanvasNodeData | null;
        onCloseUpscale: () => void;
        onUpscale: (node: CanvasNodeData, params: CanvasImageUpscaleParams) => void;
    };
    status: {
        task: GenerationTask | null;
        taskLogs: TaskLog[];
        taskLoading: boolean;
        taskError?: boolean;
        onCloseTask: () => void;
        onCancelTask?: (task: GenerationTask) => void;
        onRetrieveTask?: (task: GenerationTask) => void;
        retrievingTaskId?: string | null;
        previewNode: CanvasNodeData | null;
        onClosePreview: () => void;
        clearConfirmOpen: boolean;
        onCancelClear: () => void;
        onConfirmClear: () => void;
    };
    assets: {
        pickerOpen: boolean;
        multiple: boolean;
        onInsertLibrary: (payloads: InsertAssetPayload[], expectedScope: CapturedUserScope) => void | Promise<void>;
        onClosePicker: () => void;
        projectOpen: boolean;
        detail?: ProjectDetail;
        initialCategory?: string;
        initialFolderId?: string;
        onCloseProject: () => void;
        onInsertProject: (payloads: InsertAssetPayload[], expectedScope: CapturedUserScope) => void | Promise<void>;
        onInsertFolder?: (folderId: string, expectedScope: CapturedUserScope) => Promise<void> | void;
    };
};

export function CanvasProjectEditorDialogs({
    projectId,
    theme,
    config,
    nodes,
    viewport,
    viewportSize,
    search,
    generationHistory,
    imports,
    style,
    info,
    subtitle,
    frame,
    timeline,
    character,
    text,
    drawing,
    artCritique,
    panorama,
    script,
    director,
    versionCompare,
    media,
    status,
    assets,
}: CanvasProjectEditorDialogsProps) {
    return (
        <>
            <CanvasNodeSearchModal open={search.open} nodes={nodes} onClose={search.onClose} onFocus={search.onFocus} />
            <CanvasGenerationHistoryPicker projectId={projectId} open={generationHistory.open} onClose={generationHistory.onClose} onSelect={generationHistory.onSelect} />
            <LibTVImportDialog open={imports.libTVOpen} projectId={projectId} viewport={viewport} viewportSize={viewportSize} onClose={imports.onCloseLibTV} onApply={imports.onApplyLibTV} />
            <TapNowImportDialog open={imports.tapNowOpen} projectId={projectId} viewport={viewport} viewportSize={viewportSize} onClose={imports.onCloseTapNow} onApply={imports.onApplyTapNow} />
            <CanvasStylePickerModal open={style.open} value={style.value} applying={style.applying} onClose={style.onClose} onSelect={style.onSelect} />
            <CanvasNodeInfoModal node={info.node} open={Boolean(info.node)} onClose={info.onClose} onMetadataChange={info.onMetadataChange} />
            {subtitle.node ? <CanvasSubtitleDialog node={subtitle.node} open={Boolean(subtitle.node)} projectId={projectId} config={config} onClose={subtitle.onClose} onSave={subtitle.onSave} /> : null}
            {frame.node ? <CanvasVideoFrameDialog node={frame.node} open={Boolean(frame.node)} onClose={frame.onClose} onConfirm={frame.onConfirm} /> : null}
            {timeline.node ? (
                <CanvasTimelineDialog
                    node={timeline.node}
                    open={Boolean(timeline.node)}
                    nodes={nodes}
                    timeline={timeline.timeline}
                    onClose={timeline.onClose}
                    onOpenSubtitleDialog={timeline.onOpenSubtitleDialog}
                    onSave={timeline.onSave}
                    onSaveSubtitles={timeline.onSaveSubtitles}
                    onOpenAssetLibrary={timeline.onOpenAssetLibrary}
                    onOpenProjectAssets={timeline.onOpenProjectAssets}
                    onUploadLocalFiles={timeline.onUploadLocalFiles}
                    addNodeToTimelineRef={timeline.addNodeToTimelineRef}
                    addMediaToTimelineRef={timeline.addMediaToTimelineRef}
                    onCreateAssembledNode={timeline.onCreateAssembledNode}
                />
            ) : null}
            <CanvasCharacterReferenceModal node={character.node} open={Boolean(character.node)} onClose={character.onClose} />
            <CanvasTextEditorModal node={text.node} open={Boolean(text.node)} onClose={text.onClose} onSave={text.onSave} />
            {drawing.node ? (
                <Suspense
                    fallback={
                        <div className="fixed inset-0 z-[var(--z-toast)] grid place-items-center px-5" style={{ background: theme.canvas.background, color: theme.node.text }}>
                            <WorkspaceState icon="loading" title="正在加载绘图编辑器" description="正在准备绘图画布。" />
                        </div>
                    }
                >
                    <CanvasDrawingEditorModal node={drawing.node} projectId={projectId} open={Boolean(drawing.node)} onClose={drawing.onClose} onSaved={drawing.onSaved} />
                </Suspense>
            ) : null}
            <AiArtCritiqueModal
                startRequestId={artCritique.startRequestId}
                restartRequested={artCritique.restartRequested}
                onRunningChange={artCritique.onRunningChange}
                node={artCritique.node}
                upstreamNodes={artCritique.upstreamNodes}
                open={Boolean(artCritique.node)}
                onClose={artCritique.onClose}
                onUpdateState={artCritique.onUpdateState}
            />
            <CanvasPanoramaConfigModal
                open={Boolean(panorama.nodeId)}
                onCancel={panorama.onCancel}
                onConfirm={panorama.onConfirm}
                onCopyPrompt={panorama.onCopyPrompt}
                previewImageUrl={panorama.nodeId ? nodes.find((node) => node.id === panorama.nodeId)?.metadata?.content : undefined}
                nodes={nodes}
            />
            <CanvasScriptEditor
                node={script.node}
                nodes={nodes}
                open={Boolean(script.node)}
                onClose={script.onClose}
                onUpdateRows={script.onUpdateRows}
                onVisibleColumnsChange={script.onVisibleColumnsChange}
                onGenerateImages={script.onGenerateImages}
                onGenerateVideos={script.onGenerateVideos}
                onVideoInputModeChange={script.onVideoInputModeChange}
            />
            {director.nodeId && director.scene ? (
                <Suspense
                    fallback={
                        <div className="fixed inset-0 z-[var(--z-toast)] grid place-items-center px-5" style={{ background: theme.canvas.background, color: theme.node.text }}>
                            <WorkspaceState icon="loading" title="正在加载 3D 导演台" description="准备场景、镜头与空间控制。" />
                        </div>
                    }
                >
                    <CanvasDirectorWorkbench
                        open
                        scene={director.scene}
                        projectId={projectId}
                        imageNodes={director.imageNodes}
                        onClose={director.onClose}
                        onChange={director.onChange}
                        onApply={director.onApply}
                        onShouldCaptureCover={director.onShouldCaptureCover}
                        onCaptureCover={director.onCaptureCover}
                        onDeleteImageNode={director.onDeleteImageNode}
                        onAddCanvasImage={director.onAddCanvasImage}
                        onFlush={director.onFlush}
                        onboardingScope={director.onboardingScope}
                    />
                </Suspense>
            ) : null}
            <CanvasVersionCompareModal open={versionCompare.open} versions={versionCompare.versions} onClose={versionCompare.onClose} onSetPrimary={versionCompare.onSetPrimary} onFocus={versionCompare.onFocus} />
            <CanvasProjectMediaDialogs upscaleNode={media.upscaleNode} onCloseUpscale={media.onCloseUpscale} onUpscale={media.onUpscale} config={config} />
            <CanvasProjectStatusDialogs
                theme={theme}
                task={status.task}
                taskLogs={status.taskLogs}
                taskLoading={status.taskLoading}
                taskError={status.taskError}
                onCloseTask={status.onCloseTask}
                onCancelTask={status.onCancelTask}
                onRetrieveTask={status.onRetrieveTask}
                retrievingTaskId={status.retrievingTaskId}
                previewNode={status.previewNode}
                onClosePreview={status.onClosePreview}
                clearConfirmOpen={status.clearConfirmOpen}
                onCancelClear={status.onCancelClear}
                onConfirmClear={status.onConfirmClear}
            />
            <AssetPickerModal open={assets.pickerOpen} multiple={assets.multiple} onInsert={assets.onInsertLibrary} onClose={assets.onClosePicker} />
            <CanvasProjectAssetModal
                open={assets.projectOpen}
                detail={assets.detail}
                initialCategory={assets.initialCategory}
                initialFolderId={assets.initialFolderId}
                onClose={assets.onCloseProject}
                onInsert={assets.onInsertProject}
                onInsertFolder={assets.onInsertFolder}
            />
        </>
    );
}

export type { PanoramaGenerateConfig, CanvasImageUpscaleParams, CanvasVideoFrameParams };
