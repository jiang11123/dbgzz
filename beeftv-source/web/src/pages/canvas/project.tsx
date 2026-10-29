import { localAssetToInsertPayload } from "@/components/canvas/asset-picker-modal";
import { isCanvasNodeGenerating } from "@/lib/canvas/canvas-node-task-state";
import { CanvasAssistantSidebar } from "./canvas-assistant-sidebar";
import { useCanvasAssistantContinuation } from "./use-canvas-assistant-continuation";
import { highlightAssistantNodes } from "./canvas-assistant-highlight";
import { resolveCanvasRightPanel, useCanvasAssistant, useCanvasAssistantDockable } from "./use-canvas-assistant";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, MouseEvent as ReactMouseEvent, SetStateAction } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { appHref } from "@/lib/app-routing";
import { isLocalWorkspaceMode } from "@/services/workspace-mode";
import { queryGenerationTask, type GenerationTask } from "@/services/api/task-center";
import { generationErrorMessage } from "@/lib/generation-error";
import { useConfigStore, useEffectiveConfig } from "@/stores/use-config-store";
import { uploadMediaFile } from "@/services/file-storage";
import { getActiveUserScope, scopedLocalStorage } from "@/lib/user-scope";
import { assertUserScope, captureUserScope, userScopeMatches, type CapturedUserScope } from "@/lib/user-scope-guard";
import { findWorkspaceAssetIdByStorageKey } from "@/lib/canvas/director/director-library-persist";
import { resourceFileUrl, resourceIdFromStorageKey, syncResourceToArkPrivateAsset } from "@/services/api/resources";
import { uploadImage } from "@/services/image-storage";
import { imageMetadata } from "@/lib/canvas/canvas-generation-task-sync";
import { isCanvasImageSourceNode } from "@/lib/canvas/canvas-image-source";
import { canOpenCanvasNodePromptPanel, isCanvasMediaResultNode } from "@/lib/canvas/canvas-node-semantics";
import copyToClipboard from "copy-to-clipboard";
import { nanoid } from "nanoid";
import { DEFAULT_CANVAS_BACKGROUND_MODE, normalizeCanvasAppearance, resolveCanvasAppearance, writeCanvasAppearanceDefault, type CanvasAppearance } from "@/lib/canvas/canvas-appearance";
import { canvasThemes, type CanvasBackgroundMode } from "@/lib/canvas-theme";
import { persistCanvasMediaPerformanceMode, readCanvasMediaPerformanceMode } from "@/lib/canvas/canvas-performance-mode";
import { summarizeCanvasContext } from "@/lib/canvas/canvas-context-summary";
import { DEFAULT_DRAWING_ENGINE } from "@/lib/canvas/canvas-drawing-engine";
import { useAssetStore } from "@/stores/use-asset-store";
import { usePersonalAssetLibrary } from "@/hooks/use-personal-asset-library";
import { flushCanvasStorePersistence, useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { ensureCanvasNodeAsset } from "@/services/project-asset-sync";
import { useCanvasThemeStore, useCanvasThemeScope } from "@/stores/canvas/use-canvas-theme-store";
import { useUserStore } from "@/stores/use-user-store";
import { App, Button } from "antd";
import { ArrowLeftRight } from "lucide-react";
import { AppModal } from "@/components/ui/product/app-modal";
import { CanvasDeleteConfirmation } from "@/components/canvas/canvas-delete-confirmation";
import { CanvasConfigComposer } from "@/components/canvas/canvas-config-composer";
import { CanvasConfigNodePanel } from "@/components/canvas/canvas-config-node-panel";
import { CanvasActiveTaskPanel } from "@/components/canvas/canvas-active-task-panel";
import { CanvasAssetTray } from "@/components/canvas/canvas-asset-tray";
import { CanvasProjectSidebar } from "@/components/canvas/canvas-project-sidebar";
import { CanvasCharacterReferenceNodeContent } from "@/components/canvas/canvas-character-reference-node";
import { CanvasNodeToolbar } from "@/components/canvas/canvas-node-toolbar";
import { useCanvasUpscaleBatch } from "./use-canvas-upscale-batch";
import { createDefaultUpscaleSettings } from "@/lib/canvas/canvas-upscale";
import { findAvailableGenerationGroupPosition } from "@/lib/canvas/canvas-generation-layout";
import { CanvasVideoInlineTrimOverlay } from "@/components/canvas/canvas-video-inline-trim";
import { syncNodeSubtitlesToTimeline } from "@/lib/timeline/timeline-build";
import { CanvasNodeAnglePanel } from "@/components/canvas/canvas-node-angle-dialog";
import { CanvasNodeLightingPanel } from "@/components/canvas/canvas-node-lighting-dialog";
import { CanvasFileDropOverlay } from "@/components/canvas/canvas-file-drop-overlay";
import { InfiniteCanvas } from "@/components/canvas/infinite-canvas";
import { Minimap } from "@/components/canvas/canvas-mini-map";
import { CanvasNodePromptPanel } from "@/components/canvas/canvas-node-prompt-panel";
import { CanvasToolbar } from "@/components/canvas/canvas-toolbar";
import { useCanvasCreateCommands } from "@/components/canvas/use-canvas-create-commands";
import { CanvasZoomControls } from "@/components/canvas/canvas-zoom-controls";
import { CanvasScriptNodeContent } from "@/components/canvas/canvas-script-node";
import { CanvasBatchTableNodeContent } from "@/components/canvas/canvas-batch-table-node";
import { STORYBOARD_HEADER_HEIGHT, STORYBOARD_ROW_HEIGHT, storyboardMinNodeHeight, storyboardTableHeight } from "@/lib/canvas/canvas-storyboard-layout";
import { CanvasDirectorNodePanel } from "@/components/canvas/director/canvas-director-node-panel";
import { useFocusMode } from "@/hooks/use-focus-mode";
import { connectCanvasTextMention } from "@/lib/canvas/canvas-text-mention";
import { writeCanvasNodePrompt } from "@/lib/canvas/canvas-node-prompt";
import {
    applyCanvasConnectionPromptSync,
    buildCanvasAgentMentionReferences,
    buildCanvasNodeMentionReferenceMap,
    buildCanvasResourceReferences,
    getContextResourceNodes,
    reorderCanvasResourceConnections,
    replaceCanvasReferenceMentions,
    type CanvasResourceReference,
} from "@/lib/canvas/canvas-resource-references";
import { CanvasConnectionCreateMenu, CanvasNodePanelOverlay, type PendingConnectionCreate } from "@/components/canvas/canvas-workspace-overlays";
import { CanvasOverlayLayerContainer, CanvasOverlayLayerProvider } from "@/components/canvas/canvas-overlay-layer";
import { CanvasLeaferGraphicsLayer } from "@/components/canvas/canvas-leafer-graphics-layer";
import { CanvasFreeformEmptyState, CanvasLinkedProjectEmptyState, CanvasShortDramaEmptyState, CanvasShortDramaGuide, CanvasStoryInputNodeContent, CanvasStylePlaceholderNodeContent } from "@/components/canvas/canvas-short-drama-entry";
import { resolveCanvasEmptyStateKind } from "@/lib/canvas/canvas-starter";
import { createCanvasNode, getInputSummary } from "@/lib/canvas/canvas-project-domain";
import { connectDirectorReferenceNodes } from "@/lib/canvas/director/director-reference-assets";
import { canvasWorkspaceProjectId, listCanvasWorkspaceProjectCanvases } from "@/lib/canvas/canvas-workspace-project";
import { deleteWorkspaceCanvasProjects } from "@/services/workspace-project-repository";
import { createLibTvAudioFixture, createLibTvEmptyTextFixture, createLibTvGeneratingFixture, createLibTvReadonlyDenseFixture, createLibTvStoryboardFixture, createLibTvTextFixture, createLibTvVideoConversionFixture, createLibTvVideoFixture, createLibTvVideoMergeFixture, createLibTvVideoSubtitleFixture } from "@/lib/canvas/canvas-libtv-fixture";
import { libtvOriginalEdgeEndpoints } from "@/lib/canvas/libtv-original-edges";
import { stampCanvasNodeChanges } from "@/lib/canvas/canvas-node-timestamps";
import { batchSourceRestriction } from "@/lib/canvas/canvas-batch-connection";
import { deriveStoryboardPipelineProgress } from "@/lib/canvas/canvas-storyboard-progress";
import { CanvasSyncStatus } from "./canvas-sync-status";
import { CanvasVersionHistory, useCanvasVersionHistory } from "./canvas-version-history";
import { CanvasVersionPreview } from "./canvas-version-preview";
import { CanvasTopBar } from "./canvas-project-top-bar";
import { CanvasFocusModeBar } from "@/components/canvas/canvas-focus-mode-bar";
import { CanvasProjectContextMenu } from "./canvas-project-context-menu";
import { CanvasProjectEditorDialogs } from "./canvas-project-editor-dialogs";
import { CanvasProjectSelectionToolbar } from "./canvas-project-selection-toolbar";
import { CanvasWorkflowWorkspace, type CanvasWorkflowsHandle } from "./canvas-workflow-workspace";
import { useCanvasWorkflowInstances } from "./use-canvas-workflow-instances";
import { ReusableWorkflowNode } from "@/components/canvas/nodes/reusable-workflow-node";
import { workflowDropSlot } from "@/lib/canvas/reusable-workflow-instance";
import { isFrameNode } from "@/lib/canvas/canvas-frame";
import { CanvasProjectWorldLayers } from "./canvas-project-world-layers";
import { CanvasNodeActionContext, type CanvasNodeActionContextValue } from "@/components/canvas/canvas-node-action-context";
import { bringCanvasNodeToFront, type CanvasNodeStackOrder } from "@/lib/canvas/canvas-node-stack-order";
import { CanvasNodeGraphContext, type CanvasNodeGraphContextValue } from "@/components/canvas/canvas-node-graph-context";
import { CanvasRefreshShell } from "./canvas-refresh-shell";
import type { CanvasImageEmotionPayload } from "@/components/canvas/canvas-node-emotion-panel";
import { CanvasEmotionWorkspace } from "@/components/canvas/canvas-emotion-workspace";
import { removeCanvasDrawing } from "@/lib/canvas/canvas-drawing-storage";
import { persistCanvasTimeline, refreshLocalCanvasProjectIfChanged } from "@/services/local-workspace-repository";
import { CanvasUploadModal } from "@/components/canvas/canvas-upload-modal";
import { syncLocalCanvasSnapshot } from "@/services/local-workspace-sync";
import { useCanvasConnectionController } from "./use-canvas-connection-controller";
import { useCanvasActiveTasks } from "./use-canvas-active-tasks";
import { useCanvasStyleWorkflow } from "./use-canvas-style-workflow";
import { useCanvasDirector } from "./use-canvas-director";
import { useCanvasHistory } from "./use-canvas-history";
import { useCanvasKeyboard } from "./use-canvas-keyboard";
import { useCanvasMediaTools } from "./use-canvas-media-tools";
import { useCanvasNodeEditor } from "./use-canvas-node-editor";
import { useCanvasNodeOperations } from "./use-canvas-node-operations";
import { useCanvasProjectLifecycle } from "./use-canvas-project-lifecycle";
import { useCanvasRenderModel } from "./use-canvas-render-model";
import { useCanvasSelectionController } from "./use-canvas-selection-controller";
import { useCanvasShortDrama } from "./use-canvas-short-drama";
import { useCanvasUpload } from "./use-canvas-upload";
import { useCanvasTimelineAssetInsert } from "./use-canvas-timeline-asset-insert";
import { useCanvasViewportController } from "./use-canvas-viewport-controller";
import { copyImageToSystemClipboard } from "./canvas-project-clipboard";
import { canvasNodeRetryPlan } from "./canvas-generation-orchestration";
import { linkedFolderPresentation } from "./canvas-resource-handoff-plan";
import { useCanvasAssistantProposal } from "./use-canvas-assistant-proposal";
import { useCanvasConnectedNodeVisibility } from "./use-canvas-connected-node-visibility";
import { useCanvasGenerationOrchestration } from "./use-canvas-generation-orchestration";
import { useCanvasNodeContent } from "./use-canvas-node-content";
import { useCanvasPointerSelectionChrome, useCanvasNodeToolbarHover } from "./use-canvas-pointer-chrome";
import { useCanvasProjectDialogs } from "./use-canvas-project-dialogs";
import { useCanvasResourceHandoff } from "./use-canvas-resource-handoff";
import {
    CanvasNodeType,
    type CanvasAssistantSession,
    type CanvasConnection,
    type CanvasNodeData,
    type CanvasMediaPerformanceMode,
    type StoryboardShotCount,
    type StoryboardShotDuration,
    type CanvasWorkspaceMode,
    type CanvasToolMode,
    type ContextMenuState,
    type Position,
    type ViewportTransform,
} from "@/types/canvas";
import type { ReferenceImage } from "@/types/image";
import { ART_CRITIQUE_NODE_TYPE } from "@/lib/art-critique/contracts";

const EMPTY_RESOURCE_REFERENCES: CanvasResourceReference[] = [];

function isCanvasTextEditingTarget(target: EventTarget | null) {
    return target instanceof Element && Boolean(target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])"));
}

function visibleGenerationBatch(node: CanvasNodeData) {
    const batches = node.metadata?.generationBatches || [];
    for (let index = batches.length - 1; index >= 0; index -= 1) {
        if (batches[index].status === "queued" || batches[index].status === "running") return batches[index];
    }
    return batches.at(-1);
}

export default function CanvasPage() {
    useCanvasThemeScope();
    const [mounted, setMounted] = useState(false);

    useEffect(() => {
        setMounted(true);
    }, []);

    if (!mounted) return <CanvasRefreshShell />;

    return <InfiniteCanvasPage />;
}

function InfiniteCanvasPage() {
    // 命令式确认必须走 App.useApp().modal；静态 Modal.confirm 拿不到主题和 App 上下文。
    const { message, modal } = App.useApp();
    const params = useParams<{ id: string }>();
    const navigate = useNavigate();
    const [searchParams, setSearchParams] = useSearchParams();
    const projectId = params.id || "";
    const readOnly = searchParams.get("readonly") === "1" || searchParams.get("mode") === "readonly";
    const canvasStorageScope = getActiveUserScope();
    const canvasCapturedScope = captureUserScope();
    const containerRef = useRef<HTMLDivElement>(null);
    const didInitialCenterRef = useRef(false);

    const config = useConfigStore((state) => state.config);
    const effectiveConfig = useEffectiveConfig();
    const isAiConfigReady = useConfigStore((state) => state.isAiConfigReady);
    const assets = usePersonalAssetLibrary();
    const assetsHydrated = useAssetStore((state) => state.hydrated);
    const cleanupAssetImages = useAssetStore((state) => state.cleanupImages);
    const colorTheme = useCanvasThemeStore((state) => state.theme);
    const setAppearanceTheme = useCanvasThemeStore((state) => state.setAppearance);
    const theme = canvasThemes[colorTheme];
    const defaultDrawingEngine = DEFAULT_DRAWING_ENGINE;
    const shortDramaEnabled = useUserStore((state) => state.features.shortDramaEnabled);
    const storageMode = useUserStore((state) => state.storageMode);
    const user = useUserStore((state) => state.user);
    const localOnly = isLocalWorkspaceMode() || storageMode === "local" || user?.username === "local" || import.meta.env.VITE_CANVAS_LOCAL_MODE !== "false";
    const importCanvasProject = useCanvasStore((state) => state.importProject);
    const storedCanvasProjects = useCanvasStore((state) => state.projects);
    const workspaceCanvases = useMemo(
        () => listCanvasWorkspaceProjectCanvases(storedCanvasProjects, projectId),
        [projectId, storedCanvasProjects],
    );
    const workspaceProject = workspaceCanvases[0] || null;
    const canvasProjects = useMemo(
        () => workspaceCanvases.map((project, index) => ({
            id: project.id,
            title: project.canvasTitle?.trim() || `画布 ${index + 1}`,
        })),
        [workspaceCanvases],
    );
    const directorOnboardingScope = useUserStore((state) => state.user?.id?.trim() || "");
    const nodesRef = useRef<CanvasNodeData[]>([]);
    const [nodes, setNodesState] = useState<CanvasNodeData[]>([]);
    const setNodes = useCallback<Dispatch<SetStateAction<CanvasNodeData[]>>>((value) => {
        if (typeof value === "function") {
            setNodesState((current) => {
                const next = stampCanvasNodeChanges(current, value(current));
                nodesRef.current = next;
                return next;
            });
            return;
        }
        const next = stampCanvasNodeChanges(nodesRef.current, value);
        nodesRef.current = next;
        setNodesState(next);
    }, []);
    useEffect(() => {
        if (!projectId || !isLocalWorkspaceMode()) return;
        let disposed = false;
        const check = () => {
            if (disposed) return;
            // 应用到本地后由本地工作区同步层通知编辑器（subscribeCanvasRefresh），
            // 这里不再重复写节点状态，避免两套投影互相覆盖。
            void refreshLocalCanvasProjectIfChanged(projectId);
        };
        // 助手回合结束与外部改动画布都要立刻可见：助手回合回调会直接调 check，
        // 这里的定时器只作为外部客户端改动的兜底。
        const timer = window.setInterval(check, 4000);
        return () => { disposed = true; window.clearInterval(timer); };
    }, [projectId, setNodes]);
    useEffect(() => {
        if (!projectId || !isLocalWorkspaceMode() || window.location.protocol !== "http:") return;
        const source = new EventSource(`/api/canvas-projects/${encodeURIComponent(projectId)}/events`);
        const sync = () => void refreshLocalCanvasProjectIfChanged(projectId).then((project) => {
            if (project) { setNodes(project.nodes || []); setConnections(project.connections || []); }
        });
        source.addEventListener("canvas.updated", sync);
        return () => { source.removeEventListener("canvas.updated", sync); source.close(); };
    }, [projectId, setNodes]);
    const [nodeStackOrder, setNodeStackOrder] = useState<CanvasNodeStackOrder>([]);
    const bringNodeToFront = useCallback((nodeId: string) => {
        setNodeStackOrder((current) => bringCanvasNodeToFront(current, nodeId));
    }, []);
    const [connections, setConnections] = useState<CanvasConnection[]>([]);
    const [chatSessions, setChatSessions] = useState<CanvasAssistantSession[]>([]);
    const [activeChatId, setActiveChatId] = useState<string | null>(null);
    const [viewport, setViewport] = useState<ViewportTransform>({ x: 0, y: 0, k: 1 });
    const [size, setSize] = useState({ width: 1200, height: 720 });
    const [selectedNodeIds, setSelectedNodeIds] = useState<Set<string>>(new Set());
    const workflowsRef = useRef<CanvasWorkflowsHandle>(null);
    const [workflowLibraryOpen, setWorkflowLibraryOpen] = useState(false);
    const [selectedConnectionId, setSelectedConnectionId] = useState<string | null>(null);
    // 选中项保存的是节点 id，切到另一个画布后这些 id 并不属于新画布：
    // 不清空会同时污染选中高亮和创作助手请求的归属校验（后端按画布校验选中对象）。
    useEffect(() => {
        setSelectedNodeIds(new Set());
        setSelectedConnectionId(null);
        setWorkflowLibraryOpen(false);
    }, [projectId, canvasStorageScope]);
    const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
    const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
    const [isMiniMapOpen, setIsMiniMapOpen] = useState(() => scopedLocalStorage.getItem("canvas:minimap") === "1");
    const [canvasAppearance, setCanvasAppearance] = useState<CanvasAppearance>({ mode: "follow" });
    const [backgroundMode, setBackgroundMode] = useState<CanvasBackgroundMode>(DEFAULT_CANVAS_BACKGROUND_MODE);
    const [showImageInfo, setShowImageInfo] = useState(false);
    const [snapToGrid, setSnapToGrid] = useState(() => scopedLocalStorage.getItem("canvas:snap-to-grid") === "1");
    const [showConnections, setShowConnections] = useState(() => scopedLocalStorage.getItem("canvas:show-connections") !== "0");
    const [canvasTool, setCanvasTool] = useState<CanvasToolMode>("box-select");
    const [mediaPerformanceMode, setMediaPerformanceMode] = useState<CanvasMediaPerformanceMode>(readCanvasMediaPerformanceMode);
    const [projectLoaded, setProjectLoaded] = useState(false);
    const workspaceMode: CanvasWorkspaceMode = "professional";
    const {
        clearConfirmOpen,
        setClearConfirmOpen,
        generationHistoryOpen,
        setGenerationHistoryOpen,
        tapNowImportOpen,
        setTapNowImportOpen,
        nodeSearchOpen,
        setNodeSearchOpen,
        stylePickerOpen,
        setStylePickerOpen,
        libTVImportOpen,
        setLibTVImportOpen,
        textEditorNodeId,
        setTextEditorNodeId,
        characterReferenceNodeId,
        setCharacterReferenceNodeId,
        drawingNodeId,
        setDrawingNodeId,
        infoNodeId,
        setInfoNodeId,
        subtitleNodeId,
        setSubtitleNodeId,
        timelineNodeId,
        setTimelineNodeId,
        previewNodeId,
        setPreviewNodeId,
        scriptEditorNodeId,
        setScriptEditorNodeId,
        artCritiqueNodeId,
        setArtCritiqueNodeId,
        artCritiqueRunningRef,
        artCritiqueStartRequest,
        directorNodeId,
        setDirectorNodeId,
        versionCompareRootId,
        setVersionCompareRootId,
        clearDeletedNodeIds,
        resetForClearCanvas,
    } = useCanvasProjectDialogs();
    const [toolbarNodeId, setToolbarNodeId] = useState<string | null>(null);
    const [arkPrivateAssetUploadNodeId, setArkPrivateAssetUploadNodeId] = useState<string | null>(null);
    const [nodeImageSettingsOpen, setNodeImageSettingsOpen] = useState(false);
    const [dialogNodeId, setDialogNodeId] = useState<string | null>(null);
    const [scriptScrollTopById, setScriptScrollTopById] = useState<Record<string, number>>({});
    const [titleEditing, setTitleEditing] = useState(false);
    const [titleDraft, setTitleDraft] = useState("");
    const [shortcutRequestNonce, setShortcutRequestNonce] = useState(0);
    const [workspaceView, setWorkspaceView] = useState<"workflow" | "storyboard">("workflow");

    const { tasks: activeTasks } = useCanvasActiveTasks(projectId, projectLoaded);
    const { focusMode, enterFocusMode, exitFocusMode, toggleFocusMode } = useFocusMode();
    const [focusDockRevealed, setFocusDockRevealed] = useState(false);

    useEffect(() => {
        persistCanvasMediaPerformanceMode(mediaPerformanceMode);
    }, [mediaPerformanceMode]);

    useEffect(() => {
        didInitialCenterRef.current = false;
        setNodeStackOrder([]);
    }, [projectId]);

    useEffect(() => {
        const nodeIds = new Set(nodes.map((node) => node.id));
        setNodeStackOrder((current) => {
            const next = current.filter((nodeId) => nodeIds.has(nodeId));
            return next.length === current.length ? current : next;
        });
    }, [nodes]);

    const connectionsRef = useRef(connections);
    const chatSessionsRef = useRef(chatSessions);
    const activeChatIdRef = useRef(activeChatId);
    const selectedNodeIdsRef = useRef(selectedNodeIds);
    const viewportRef = useRef(viewport);

    const resolvedCanvasAppearance = useMemo(() => resolveCanvasAppearance(canvasAppearance, colorTheme), [canvasAppearance, colorTheme]);
    const applyCanvasAppearance = useCallback(
        (next: CanvasAppearance) => {
            const fallback = colorTheme;
            const normalized = normalizeCanvasAppearance(next, fallback);
            setCanvasAppearance(normalized);
            setAppearanceTheme(normalized);
        },
        [colorTheme, setAppearanceTheme],
    );
    const saveCanvasAppearanceDefault = useCallback(
        (next: CanvasAppearance) => {
            writeCanvasAppearanceDefault({ appearance: next, backgroundMode });
            message.success("已保存为当前账号在本机的新建画布默认外观");
        },
        [backgroundMode, message],
    );

    const { adoptExternalSnapshot, getHistoryCleanupContext, historyPausedRef, historyState, redoCanvas, resetHistory, undoCanvas } = useCanvasHistory({
        projectLoaded,
        nodes,
        connections,
        chatSessions,
        activeChatId,
        canvasAppearance,
        backgroundMode,
        showImageInfo,
        setNodes,
        setConnections,
        setChatSessions,
        setActiveChatId,
        applyCanvasAppearance,
        setBackgroundMode,
        setShowImageInfo,
        setSelectedNodeIds,
        setSelectedConnectionId,
        setContextMenu,
    });

    const cleanupCanvasFiles = useCallback(
        (extra?: unknown) => {
            cleanupAssetImages({ extra, ...getHistoryCleanupContext() });
        },
        [cleanupAssetImages, getHistoryCleanupContext],
    );

    const { loadError, retryLoad, addedSkills, clearCanvasFiles, createAndOpenCanvas, currentProject, deleteCurrentProject, renameCurrentProject, reloadLatestCanvasProject, restoreCanvasProjectVersion, saveCanvasProject, forceSaveCanvasProject, updateProject } = useCanvasProjectLifecycle({
        projectId,
        projectLoaded,
        nodes,
        connections,
        chatSessions,
        activeChatId,
        canvasAppearance,
        backgroundMode,
        showImageInfo,
        viewport,
        nodesRef,
        connectionsRef,
        chatSessionsRef,
        activeChatIdRef,
        viewportRef,
        historyPausedRef,
        setNodes,
        setConnections,
        setChatSessions,
        setActiveChatId,
        setCanvasAppearance,
        setBackgroundMode,
        setShowImageInfo,
        setViewport,
        setProjectLoaded,
        resetHistory,
        adoptExternalSnapshot,
        cleanupAssetImages,
        cleanupCanvasFiles,
    });

    const fixtureAppliedRef = useRef<string | null>(null);
    const focusFixtureOnNarrowViewport = useCallback((fixtureNodes: CanvasNodeData[]) => {
        if (typeof window === "undefined" || window.innerWidth >= 768) return;
        const target = fixtureNodes.find((node) => node.type === CanvasNodeType.Video || node.type === CanvasNodeType.Image || node.type === CanvasNodeType.Audio || node.type === CanvasNodeType.Text);
        if (!target) return;
        // Keep the fixture's world coordinates intact, but place its visual
        // bounds inside a narrow viewport so the first actionable control is
        // reachable without requiring a hidden desktop-sized pan.
        const width = Math.max(320, window.innerWidth);
        const height = Math.max(420, window.innerHeight - 56);
        const scale = Math.min(1, Math.max(0.35, Math.min((width - 24) / Math.max(1, target.width), (height - 120) / Math.max(1, target.height))));
        const next = {
            x: (width - target.width * scale) / 2 - target.position.x * scale,
            y: (height - target.height * scale) / 2 - target.position.y * scale,
            k: scale,
        };
        viewportRef.current = next;
        setViewport(next);
    }, [setViewport, viewportRef]);
    useEffect(() => {
        if (!projectLoaded || readOnly || searchParams.get("fixture") !== "libtv-storyboard") return;
        if (fixtureAppliedRef.current === projectId || nodes.some((node) => node.metadata?.fixture === "libtv-storyboard")) return;
        fixtureAppliedRef.current = projectId;
        const fixtureNodes = createLibTvStoryboardFixture();
        const nextNodes = [...nodesRef.current, ...fixtureNodes];
        nodesRef.current = nextNodes;
        setNodes(nextNodes);
        // A saved LibTV storyboard opens in browse mode. Do not carry a stale
        // dialog/selection from the canvas that was used to load the fixture;
        // otherwise the first screenshot is polluted by a text composer.
        setSelectedNodeIds(new Set());
        selectedNodeIdsRef.current = new Set();
        setDialogNodeId(null);
  // Read-only reference mode is intentionally side-effect free: saving here
  // would surface a local-save toast that the public LibTV viewer does not show.
    }, [nodes, projectId, projectLoaded, readOnly, saveCanvasProject, searchParams, setDialogNodeId, setNodes, setSelectedNodeIds, selectedNodeIdsRef]);

    useEffect(() => {
        if (!projectLoaded || readOnly || searchParams.get("fixture") !== "libtv-readonly-dense") return;
        if (fixtureAppliedRef.current === projectId || nodes.some((node) => node.metadata?.fixture === "libtv-readonly-dense")) return;
        fixtureAppliedRef.current = projectId;
        const fixtureNodes = createLibTvReadonlyDenseFixture();
        const nextNodes = [...nodesRef.current, ...fixtureNodes];
        nodesRef.current = nextNodes;
        setNodes(nextNodes);
        const denseChildren = fixtureNodes;
        const nearestChild = (screenX: number, screenY: number) => denseChildren.reduce<{ node: CanvasNodeData | null; distance: number }>((best, node) => {
            const left = 189.2 + node.position.x * 0.1;
            const top = -179.4 + node.position.y * 0.1;
            const right = left + node.width * 0.1;
            const bottom = top + node.height * 0.1;
            const dx = screenX < left ? left - screenX : screenX > right ? screenX - right : 0;
            const dy = screenY < top ? top - screenY : screenY > bottom ? screenY - bottom : 0;
            const distance = Math.hypot(dx, dy);
            return distance < best.distance ? { node, distance } : best;
        }, { node: null, distance: Number.POSITIVE_INFINITY });
        const denseConnections = libtvOriginalEdgeEndpoints.flatMap((edge, index) => {
            const fromMatch = nearestChild(edge.sx, edge.sy);
            const toMatch = nearestChild(edge.ex, edge.ey);
            const fromNode = fromMatch.node;
            const toNode = toMatch.node;
            // Endpoints far outside the captured node rectangles belong to
            // off-screen/private nodes. Do not attach them to an unrelated
            // visible thumbnail merely because it is the nearest one.
            if (!fromNode || !toNode || fromMatch.distance > 1 || toMatch.distance > 1) return [];
            // Preserve parallel edges. The captured LibTV graph contains
            // repeated source/target pairs, and collapsing them changes the
            // visible wire density in the overview.
            return [{ id: `libtv-dense-edge-${index}`, fromNodeId: fromNode.id, toNodeId: toNode.id }];
        });
        connectionsRef.current = denseConnections;
        setConnections(denseConnections);
        selectedNodeIdsRef.current = new Set();
        setSelectedNodeIds(new Set());
        setDialogNodeId(null);
        // Match the public read-only overview captured from LibTV: 10% scale,
        // two-column groups and a small top-left camera offset.
        const denseViewport = { x: 189.2, y: -179.4, k: 0.1 };
        viewportRef.current = denseViewport;
        setViewport(denseViewport);
        // Do not save in the read-only fixture: LibTV's public viewer has no
        // local-save toast or persistence side effect while it is being read.
    }, [nodes, projectId, projectLoaded, readOnly, saveCanvasProject, searchParams, setDialogNodeId, setNodes, setSelectedNodeIds, setViewport, selectedNodeIdsRef, nodesRef, viewportRef]);

    useEffect(() => {
        if (!projectLoaded || readOnly || searchParams.get("fixture") !== "libtv-video-merge") return;
        if (fixtureAppliedRef.current === projectId || nodes.some((node) => node.metadata?.fixture === "libtv-video-merge")) return;
        fixtureAppliedRef.current = projectId;
        const fixtureNodes = createLibTvVideoMergeFixture(searchParams.get("fixtureMedia") || undefined);
        const nextNodes = [...nodesRef.current, ...fixtureNodes];
        nodesRef.current = nextNodes;
        setNodes(nextNodes);
        const selectedFixtureNodes = new Set(fixtureNodes.map((node) => node.id));
        selectedNodeIdsRef.current = selectedFixtureNodes;
        setSelectedNodeIds(selectedFixtureNodes);
        focusFixtureOnNarrowViewport(fixtureNodes);
        void saveCanvasProject({ requireRemote: false });
    }, [focusFixtureOnNarrowViewport, nodes, projectId, projectLoaded, readOnly, saveCanvasProject, searchParams, setNodes, setSelectedNodeIds, selectedNodeIdsRef]);

    useEffect(() => {
        if (!projectLoaded || readOnly || !["libtv-video", "libtv-video-subtitle"].includes(searchParams.get("fixture") || "")) return;
        if (fixtureAppliedRef.current === projectId || nodes.some((node) => node.metadata?.fixture === "libtv-video" || node.metadata?.fixture === "libtv-video-subtitle")) return;
        fixtureAppliedRef.current = projectId;
        const fixtureNodes = searchParams.get("fixture") === "libtv-video-subtitle" ? createLibTvVideoSubtitleFixture(searchParams.get("fixtureMedia") || undefined) : createLibTvVideoFixture(searchParams.get("fixtureMedia") || undefined);
        const nextNodes = [...nodesRef.current, ...fixtureNodes];
        nodesRef.current = nextNodes;
        setNodes(nextNodes);
        focusFixtureOnNarrowViewport(fixtureNodes);
        void saveCanvasProject({ requireRemote: false });
    }, [focusFixtureOnNarrowViewport, nodes, projectId, projectLoaded, readOnly, saveCanvasProject, searchParams, setNodes]);

    useEffect(() => {
        if (!projectLoaded || readOnly || searchParams.get("fixture") !== "libtv-video-conversion") return;
        if (fixtureAppliedRef.current === projectId || nodes.some((node) => node.metadata?.fixture === "libtv-video-conversion")) return;
        fixtureAppliedRef.current = projectId;
        const fixture = createLibTvVideoConversionFixture(searchParams.get("fixtureMedia") || undefined);
        const nextNodes = [...nodesRef.current, ...fixture.nodes];
        nodesRef.current = nextNodes;
        setNodes(nextNodes);
        setConnections((current) => [...current, fixture.connection]);
        focusFixtureOnNarrowViewport(fixture.nodes);
        void saveCanvasProject({ requireRemote: false });
    }, [connectionsRef, focusFixtureOnNarrowViewport, nodes, nodesRef, projectId, projectLoaded, readOnly, saveCanvasProject, searchParams, setConnections, setNodes]);

    useEffect(() => {
        if (!projectLoaded || readOnly || searchParams.get("fixture") !== "libtv-audio") return;
        if (fixtureAppliedRef.current === projectId || nodes.some((node) => node.metadata?.fixture === "libtv-audio")) return;
        fixtureAppliedRef.current = projectId;
        const fixtureNodes = createLibTvAudioFixture();
        const nextNodes = [...nodesRef.current, ...fixtureNodes];
        nodesRef.current = nextNodes;
        setNodes(nextNodes);
        focusFixtureOnNarrowViewport(fixtureNodes);
        void saveCanvasProject({ requireRemote: false });
    }, [focusFixtureOnNarrowViewport, nodes, projectId, projectLoaded, readOnly, saveCanvasProject, searchParams, setNodes]);

    useEffect(() => {
        if (!projectLoaded || readOnly || searchParams.get("fixture") !== "libtv-text") return;
        if (fixtureAppliedRef.current === projectId || nodes.some((node) => node.metadata?.fixture === "libtv-text")) return;
        fixtureAppliedRef.current = projectId;
        const fixtureNodes = createLibTvTextFixture();
        const nextNodes = [...nodesRef.current, ...fixtureNodes];
        nodesRef.current = nextNodes;
        setNodes(nextNodes);
        focusFixtureOnNarrowViewport(fixtureNodes);
        void saveCanvasProject({ requireRemote: false });
    }, [focusFixtureOnNarrowViewport, nodes, projectId, projectLoaded, readOnly, saveCanvasProject, searchParams, setNodes]);

    useEffect(() => {
        if (!projectLoaded || readOnly || searchParams.get("fixture") !== "libtv-text-empty") return;
        if (fixtureAppliedRef.current === projectId || nodes.some((node) => node.metadata?.fixture === "libtv-text-empty")) return;
        fixtureAppliedRef.current = projectId;
        const fixtureNodes = createLibTvEmptyTextFixture();
        const nextNodes = [...nodesRef.current, ...fixtureNodes];
        nodesRef.current = nextNodes;
        setNodes(nextNodes);
        focusFixtureOnNarrowViewport(fixtureNodes);
        // Visual audit fixtures are ephemeral; avoid showing the local-save
        // toast over the LibTV reference screenshot when chrome mode is on.
        if (searchParams.get("libtvChrome") !== "1") void saveCanvasProject({ requireRemote: false });
    }, [focusFixtureOnNarrowViewport, nodes, projectId, projectLoaded, readOnly, saveCanvasProject, searchParams, setNodes]);

    useEffect(() => {
        if (!projectLoaded || readOnly || searchParams.get("fixture") !== "libtv-generating") return;
        if (fixtureAppliedRef.current === projectId || nodes.some((node) => node.metadata?.fixture === "libtv-generating")) return;
        fixtureAppliedRef.current = projectId;
        const fixtureNodes = createLibTvGeneratingFixture();
        const nextNodes = [...nodesRef.current, ...fixtureNodes];
        nodesRef.current = nextNodes;
        setNodes(nextNodes);
        focusFixtureOnNarrowViewport(fixtureNodes);
        void saveCanvasProject({ requireRemote: false });
        // Local runtime normally converts stale loading snapshots to an error
        // immediately after a refresh. The fixture intentionally re-enters the
        // running state after that guard so the visual contract can be audited
        // without pretending a real backend task exists.
        window.setTimeout(() => {
            setNodes((current) => current.map((node) => node.metadata?.fixture === "libtv-generating" ? {
                ...node,
                metadata: {
                    ...node.metadata,
                    status: "loading",
                    taskId: node.metadata.taskId || "libtv-fixture-task-42",
                    taskCreatedAt: node.metadata.taskCreatedAt || new Date(0).toISOString(),
                    taskStatus: "running",
                    taskProgress: 42,
                    taskStage: "正在生成画面",
                    errorDetails: undefined,
                },
            } : node));
        }, 260);
    }, [focusFixtureOnNarrowViewport, nodes, projectId, projectLoaded, readOnly, saveCanvasProject, searchParams, setNodes]);

    const duplicateCurrentProject = useCallback(async () => {
        if (!currentProject) return;
        const now = new Date().toISOString();
        const id = importCanvasProject({
            ...currentProject,
            title: `${currentProject.title || "未命名画布"} 副本`,
            revision: 0,
            remoteContentHash: undefined,
            createdAt: now,
            updatedAt: now,
            nodes: nodesRef.current,
            connections: connectionsRef.current,
            chatSessions: chatSessionsRef.current,
            activeChatId: activeChatIdRef.current,
            viewport: viewportRef.current,
        });
        await flushCanvasStorePersistence();
        navigate(`/canvas/${id}`);
    }, [currentProject, importCanvasProject, navigate]);

    const openCanvasInNewWindow = useCallback((canvasId: string) => {
        window.open(appHref(`/canvas/${canvasId}`), "_blank", "noopener,noreferrer");
    }, []);

    const renameCanvasFromMenu = useCallback(async (canvasId: string, canvasTitle: string) => {
        updateProject(canvasId, { canvasTitle });
        await flushCanvasStorePersistence();
        message.success("画布已重命名");
    }, [message, updateProject]);

    const duplicateCanvasFromMenu = useCallback(async (canvasId: string) => {
        const source = useCanvasStore.getState().openProject(canvasId);
        if (!source) {
            message.error("画布不存在或已被删除");
            return;
        }
        const sourceSnapshot = canvasId === projectId ? {
            ...source,
            nodes: nodesRef.current,
            connections: connectionsRef.current,
            chatSessions: chatSessionsRef.current,
            activeChatId: activeChatIdRef.current,
            viewport: viewportRef.current,
        } : source;
        const fallbackTitle = canvasProjects.find((canvas) => canvas.id === canvasId)?.title || "画布";
        const now = new Date().toISOString();
        importCanvasProject({
            ...sourceSnapshot,
            canvasTitle: `${sourceSnapshot.canvasTitle?.trim() || fallbackTitle} 副本`,
            revision: 0,
            remoteContentHash: undefined,
            createdAt: now,
            updatedAt: now,
        }, canvasWorkspaceProjectId(sourceSnapshot));
        await flushCanvasStorePersistence();
        message.success("画布副本已创建");
    }, [canvasProjects, importCanvasProject, message, projectId]);

    const [deletingCanvas, setDeletingCanvas] = useState<{ id: string; scope: CapturedUserScope } | null>(null);
    const deleteCanvasFromMenu = useCallback((id: string) => setDeletingCanvas({ id, scope: captureUserScope() }), []);

    const versions = useCanvasVersionHistory(projectId, restoreCanvasProjectVersion, currentProject);
    // 画布右侧只有一个栏位：助手和版本记录互斥，谁被打开另一个就让位。
    const assistant = useCanvasAssistant({
        canvasId: projectId,
        onCanvasChanged: (canvasId, changedNodeIds) => {
            if (canvasId !== projectId) return;
            void refreshLocalCanvasProjectIfChanged(canvasId).then(() => highlightAssistantNodes(containerRef.current, changedNodeIds));
        },
    });
    const canvasMainRef = useRef<HTMLElement>(null);
    const assistantDockable = useCanvasAssistantDockable(canvasMainRef);
    const rightPanel = resolveCanvasRightPanel(assistant.open, versions.open);
    const openVersions = () => { workflowsRef.current?.closeLibrary(); assistant.setOpen(false); setVersionCompareRootId(null); versions.show(); };
    const toggleVersions = () => {
        if (!versions.open) { workflowsRef.current?.closeLibrary(); assistant.setOpen(false); }
        setVersionCompareRootId(null);
        versions.toggle();
    };
    const toggleAssistant = useCallback(() => {
        const next = !assistant.open;
        if (next) { workflowsRef.current?.closeLibrary(); versions.close(); }
        assistant.setOpen(next);
    }, [assistant, versions]);
    const openAssistant = useCallback(() => {
        exitFocusMode();
        workflowsRef.current?.closeLibrary();
        versions.close();
        assistant.setOpen(true);
    }, [assistant, exitFocusMode, versions]);
    // 修复素材关联仍遵守当前画布版本，不能替用户确认覆盖云端的新内容。
    const confirmForceSaveCanvas = useCallback(() => {
        modal.confirm({
            title: "修复素材关联并保存？",
            content: "核对画布媒体与素材库的关联，补齐缺失素材后保存。若云端已有新版本，会保留本地草稿并提示加载最新版。",
            okText: "修复并保存",
            cancelText: "取消",
            onOk: () => forceSaveCanvasProject(),
        });
    }, [forceSaveCanvasProject, modal]);

    const applyLibTVImport = useCallback(
        async (importedNodes: CanvasNodeData[], importedConnections: CanvasConnection[]) => {
            const previousNodes = nodesRef.current;
            const previousConnections = connectionsRef.current;
            const nextNodes = [...nodesRef.current, ...importedNodes];
            const nextConnections = [...connectionsRef.current, ...importedConnections];
            nodesRef.current = nextNodes;
            connectionsRef.current = nextConnections;
            setNodes(nextNodes);
            setConnections(nextConnections);
            const saved = await saveCanvasProject({ requireRemote: false });
            if (!saved) {
                nodesRef.current = previousNodes;
                connectionsRef.current = previousConnections;
                setNodes(previousNodes);
                setConnections(previousConnections);
                throw new Error("画布保存失败，已撤销本次 LibTV 导入");
            }
        },
        [saveCanvasProject, setConnections, setNodes],
    );
    const applyTapNowImport = useCallback(
        async (importedNodes: CanvasNodeData[], importedConnections: CanvasConnection[]) => {
            const previousNodes = nodesRef.current;
            const previousConnections = connectionsRef.current;
            const nextNodes = [...nodesRef.current, ...importedNodes];
            const nextConnections = [...connectionsRef.current, ...importedConnections];
            nodesRef.current = nextNodes;
            connectionsRef.current = nextConnections;
            setNodes(nextNodes);
            setConnections(nextConnections);
            const saved = await saveCanvasProject({ requireRemote: false });
            if (!saved) {
                nodesRef.current = previousNodes;
                connectionsRef.current = previousConnections;
                setNodes(previousNodes);
                setConnections(previousConnections);
                throw new Error("画布保存失败，已撤销本次 TapNow 导入");
            }
        },
        [saveCanvasProject, setConnections, setNodes],
    );
    const linkedProjectId = shortDramaEnabled ? currentProject?.projectId || "" : "";
    // 助手只接受属于当前画布的选中项：切画布那一帧仍可能残留旧 id，这里做硬约束，
    // 不让跨画布的 id 进入请求（后端会按画布校验并拒绝整个回合）。
    const assistantSelectedNodeIds = useMemo(() => {
        const available = new Set(nodes.map((node) => node.id));
        return Array.from(selectedNodeIds).filter((id) => available.has(id));
    }, [nodes, selectedNodeIds]);
    // 助手的 @ 菜单覆盖整张画布，而不是只覆盖能当生成输入的资源节点。
    const assistantMentionReferences = useMemo(() => buildCanvasAgentMentionReferences(nodes), [nodes]);
    // 扩展节点（对比/图表/调色）要读自己的上游才能渲染，经 Context 下发；
    // 取上游复用 canvas-resource-references 的实现，别在这里另写一份。必须 memo——
    // 每帧新对象会让所有节点跟着重渲染，错题本里多条崩溃都出在画布高频更新。
    const nodeGraphContext = useMemo<CanvasNodeGraphContextValue>(() => ({ getUpstreamNodes: (nodeId: string) => getContextResourceNodes(nodeId, nodes, connections), getNode: (nodeId: string) => nodes.find(node => node.id === nodeId) }), [connections, nodes]);

    // 旧内置 Agent 的深链参数（?agent=1 / ?conversation=）仍然存在于历史书签里。
    // 画布不再有 Agent 停靠面板，这里只把参数剥离，让旧链接落到正常可用的画布，
    // 画布会话数据本身保留在项目记录中。
    useEffect(() => {
        if (!projectLoaded) return;
        if (!searchParams.has("agent") && !searchParams.has("conversation")) return;
        const next = new URLSearchParams(searchParams);
        next.delete("agent");
        next.delete("conversation");
        setSearchParams(next, { replace: true });
    }, [projectLoaded, searchParams, setSearchParams]);

    // 沉浸专注进入时收起小地图、重置 Dock 唤出态；仅响应「进入」瞬间。
    const prevFocusModeRef = useRef(focusMode);
    useEffect(() => {
        const enteredFocus = focusMode && !prevFocusModeRef.current;
        prevFocusModeRef.current = focusMode;
        if (!enteredFocus) return;
        setIsMiniMapOpen(false);
        setFocusDockRevealed(false);
    }, [focusMode]);

    useEffect(() => {
        if (!dialogNodeId) setNodeImageSettingsOpen(false);
    }, [dialogNodeId]);

    useLayoutEffect(() => {
        nodesRef.current = nodes;
        connectionsRef.current = connections;
        chatSessionsRef.current = chatSessions;
        activeChatIdRef.current = activeChatId;
        selectedNodeIdsRef.current = selectedNodeIds;
        viewportRef.current = viewport;
    }, [activeChatId, chatSessions, nodes, connections, selectedNodeIds, viewport]);

    // 停靠栏挤压画布时补偿一半位移：用户正在看的那块内容留在原处，视野不跳。
    const dockedPanelWidth = !assistantDockable ? 0 : rightPanel === "assistant" ? assistant.width : workflowLibraryOpen && !focusMode && !versions.preview ? 380 : 0;
    const previousDockedPanelWidth = useRef(dockedPanelWidth);
    useEffect(() => {
        const delta = dockedPanelWidth - previousDockedPanelWidth.current;
        previousDockedPanelWidth.current = dockedPanelWidth;
        if (!delta) return;
        const next = { ...viewportRef.current, x: viewportRef.current.x - delta / 2 };
        viewportRef.current = next;
        setViewport(next);
    }, [dockedPanelWidth]);

    useEffect(() => {
        if (!projectLoaded) return;
        const el = containerRef.current;
        if (!el) return;

        const updateSize = () => {
            const rect = el.getBoundingClientRect();
            setSize((current) => (current.width === rect.width && current.height === rect.height ? current : { width: rect.width, height: rect.height }));
            if (!didInitialCenterRef.current) {
                didInitialCenterRef.current = true;
                const current = viewportRef.current;
                if (current.x === 0 && current.y === 0 && current.k === 1) {
                    const centered = { x: rect.width / 2, y: rect.height / 2, k: 1 };
                    viewportRef.current = centered;
                    setViewport(centered);
                }
            }
        };

        updateSize();
        const resizeObserver = new ResizeObserver(updateSize);
        resizeObserver.observe(el);
        return () => resizeObserver.disconnect();
    }, [projectLoaded]);

    const {
        fitCanvasContent,
        fitCanvasSelection,
        focusCanvasImageNode,
        focusCanvasNode,
        getCanvasCenter,
        handleCanvasDoubleClick,
        handleViewportChange,
        handleViewportPreviewChange,
        previewViewport,
        screenToCanvas,
        setZoomScale,
        zoomCanvasIn,
        zoomCanvasOut,
        zoomToActualSize,
    } = useCanvasViewportController({
        containerRef,
        size,
        viewportRef,
        nodesRef,
        selectedNodeIdsRef,
        setViewport,
        setSelectedNodeIds,
        setSelectedConnectionId,
        setContextMenu,
        setDialogNodeId,
        setToolbarNodeId,
    });

    const workflowInstances = useCanvasWorkflowInstances({
        canvasId: projectId, domainProjectId: currentProject?.projectId, readOnly, nodes, nodesRef, setNodes, connectionsRef, setConnections, getCanvasCenter,
        persist: () => saveCanvasProject({ requireRemote: false }),
        focusNode: (node) => {
            const k = Math.min(1, (size.width - 96) / node.width, (size.height - 160) / node.height);
            const next = { x: size.width / 2 - (node.position.x + node.width / 2) * k, y: size.height / 2 - (node.position.y + node.height / 2) * k, k };
            viewportRef.current = next;
            setViewport(next);
            setSelectedNodeIds(new Set([node.id]));
            setDialogNodeId(null);
            setToolbarNodeId(null);
            setShowConnections(true);
        },
        onError: (error) => { void message.error(error); },
    });

    // Pan only the viewport (never the node) when a newly connected target
    // crosses the visible canvas safe area, including under the Agent dock.
    const keepConnectedNodeVisible = useCanvasConnectedNodeVisibility({
        size,
        containerRef,
        viewportRef,
        nodesRef,
        connectionsRef,
        setViewport,
    });

    const {
        applyGenerationTaskResult,
        bindGenerationTask,
        finishGenerationRequest,
        openNodeTaskDetails,
        retrieveTaskResult,
        retrievingTaskId,
        runningNodeId,
        setRunningNodeId,
        setTaskDetail,
        startGenerationRequest,
        taskDetail,
        taskDetailLoading,
        taskDetailError,
        taskDetailLogs,
        handleGenerateNode,
        handleRetryNode,
        cancelCanvasTask,
        insertGenerationHistoryTask,
        enqueueGenerationBatch,
        retryFailedBatchItems,
        stopRemainingBatchItems,
        addBatchReferenceColumn,
        addBatchRow,
        fillRowsFromConnections,
        generateBatchRows,
        moveBatchReferenceCell,
        patchBatchTable,
        removeBatchReferenceColumn,
        removeBatchRow,
        reorderBatchReferenceColumns,
        syncRowsFromConnections,
        updateBatchRow,
        addScriptRow,
        createAndGenerateScriptVideos,
        createScriptActionBoards,
        createScriptImageNodes,
        createScriptVideoNodes,
        generateScriptImages,
        generateScriptRows,
        generateScriptVideos,
        removeScriptRow,
        replaceScriptRows,
        updateScriptRow,
        reconcileImageBatchRootNode,
        retryImageBatchChildren,
        generateImageFromTextNode,
    } = useCanvasGenerationOrchestration({
        projectId,
        linkedProjectId,
        domainProjectId: currentProject?.projectId,
        projectLoaded,
        localOnly,
        addedSkills,
        assets,
        nodes,
        connections,
        nodesRef,
        connectionsRef,
        setNodes,
        setConnections,
        setSelectedNodeIds,
        setSelectedConnectionId,
        setDialogNodeId,
        setGenerationHistoryOpen,
        getCanvasCenter,
    });

    const assistantContinuation = useCanvasAssistantContinuation(assistant, nodes, !readOnly);
    const { runAssistantProposal, assistantProposalFeedback, runningProposalIds } = useCanvasAssistantProposal({
        projectId,
        addedSkills,
        nodesRef,
        connectionsRef,
        handledProposals: assistant.handledProposals,
        markProposalHandled: assistant.markProposalHandled,
        continuationSessionId: assistant.sessionId,
        continuePlan: Boolean(assistant.plan?.items.some(item => item.status !== "done")),
        onContinuationArmed: assistantContinuation.refresh,
        handleGenerateNode,
    });

    const {
        assetPickerOpen,
        uploadModalOpen,
        closeUploadModal,
        handleImportUrl,
        closeAssetPicker,
        createVideoNodeFromBlob,
        createAssetPayloadNodes,
        fileDropActive,
        handleAssetsInsert,
        handleDrop,
        handleFileDragEnter,
        handleFileDragLeave,
        handleFileDragOver,
        handleImageInputChange,
        handleProjectAssetsInsert,
        handleProjectChapterInsert,
        handleUploadFiles,
        handleUploadRequest,
        handleUploadReferenceRequest,
        imageInputRef,
        openAssetsAtPosition,
        pasteAssistantImage,
        pasteSystemClipboard,
        replaceNodeMedia,
        createFileNode,
        startUploadStatus,
        uploadTimelineMedia,
    } = useCanvasUpload({
        canvasId: projectId,
        domainProjectId: linkedProjectId,
        nodesRef,
        connectionsRef,
        selectedNodeIdsRef,
        getCanvasCenter,
        screenToCanvas,
        setNodes,
        setConnections,
        setSelectedNodeIds,
        setSelectedConnectionId,
        setContextMenu,
        setDialogNodeId,
    });
    const replaceCanvasNodeMedia = useCallback((node: CanvasNodeData) => handleUploadRequest(node.id), [handleUploadRequest]);
    const { linkedProjectQuery, refetchLinkedProject, archiveNodesToLinkedFolder, reloadCanvasNodeResource } = useCanvasResourceHandoff({
        projectId,
        linkedProjectId,
        projectLoaded,
        assets,
        assetsHydrated,
        nodesRef,
        searchParams,
        setSearchParams,
        setNodes,
        getCanvasCenter,
        createHandoffNodes: createAssetPayloadNodes,
        applyGenerationTaskResult,
        startGenerationRequest,
        finishGenerationRequest,
    });
    const canvasContext = useMemo(() => summarizeCanvasContext(nodes, selectedNodeIds, linkedProjectQuery.data?.units), [linkedProjectQuery.data?.units, nodes, selectedNodeIds]);
    const directorReferenceTargetRef = useRef<{ projectId: string; nodeId: string | null; scope: string } | null>(null);
    directorReferenceTargetRef.current = { projectId, nodeId: directorNodeId, scope: canvasStorageScope };
    useEffect(() => {
        directorReferenceTargetRef.current = { projectId, nodeId: directorNodeId, scope: canvasStorageScope };
        return () => { directorReferenceTargetRef.current = null; };
    }, [projectId, directorNodeId, canvasStorageScope]);
    const addDirectorReferenceToCanvas = useCallback(async (image: Awaited<ReturnType<typeof uploadImage>>, title: string, signal: AbortSignal, expectedScope: CapturedUserScope = canvasCapturedScope) => {
        const expected = expectedScope;
        const current = () => !signal.aborted && directorReferenceTargetRef.current?.projectId === projectId
            && directorReferenceTargetRef.current?.nodeId === directorNodeId && userScopeMatches(expected)
            && nodesRef.current.some((item) => item.id === directorNodeId);
        if (!current()) throw new DOMException("导演台会话已结束", "AbortError");
        const node = createCanvasNode(CanvasNodeType.Image, getCanvasCenter(), imageMetadata(image));
        node.title = title;
        const linked = connectDirectorReferenceNodes([...nodesRef.current, node], connectionsRef.current, [node.id], directorNodeId || "", () => nanoid(), "replace");
        nodesRef.current = linked.nodes;
        connectionsRef.current = linked.connections;
        setNodes(linked.nodes);
        setConnections(linked.connections);
        setSelectedNodeIds(new Set([node.id]));
        setSelectedConnectionId(null);
        try {
            const result = await ensureCanvasNodeAsset({ canvasId: projectId, domainProjectId: currentProject?.projectId, node, source: "canvas-upload", expectedScope: expected });
            if (!current()) throw new DOMException("导演台会话已结束", "AbortError");
            setNodes((currentNodes) => currentNodes.map((item) => item.id === node.id ? { ...item, metadata: { ...item.metadata, assetId: result.assetId } } : item));
            return { assetId: result.assetId, persisted: result.confirmed };
        } catch (error) {
            if (!current()) throw new DOMException("导演台会话已结束", "AbortError");
            message.warning(error instanceof Error ? `图片已加入画布，但素材同步失败：${error.message}` : "图片已加入画布，但素材同步失败");
            return { assetId: findWorkspaceAssetIdByStorageKey(image.storageKey) };
        }
    }, [canvasCapturedScope.epoch, canvasCapturedScope.userScope, connectionsRef, currentProject?.projectId, directorNodeId, getCanvasCenter, message, nodesRef, projectId, setConnections, setNodes, setSelectedConnectionId, setSelectedNodeIds]);
    const {
        timelineAddNodeRef,
        timelineMediaAddRef,
        assetInsertScope,
        projectAssetScope,
        projectAssetOpen,
        projectAssetInitialCategory,
        projectAssetInitialFolderId,
        projectAssetInsertPosition,
        handleLibraryAssetsInsert,
        handleTimelineProjectAssetsInsert,
        openProjectAssets,
        openCanvasAssetLibrary,
        openTimelineAssetLibrary,
        closeProjectAssets,
    } = useCanvasTimelineAssetInsert({
        linkedProjectId,
        refetchLinkedProject,
        handleAssetsInsert,
        handleProjectAssetsInsert,
        openAssetsAtPosition,
    });

    const {
        prepareUpscaleResource,
        recoverAIUpscale,
        observeAIUpscale,
        angleNodeId,
        lightingNodeId,
        emotionNodeId,
        annotationNodeId,
        createImageReversePromptNodes,
        openPortraitTextureEditor,
        cropImageNode,
        cropNodeId,
        cropVideoNode,
        depthCaptureNode,
        retryDepthCaptureNode,
        recoverDepthCaptureNodes,
        videoCropNodeId,
        closeFrameDialog,
        extractAudioFromVideo,
        extractVideoFrameAt,
        extractVideoFrames,
        extractingVideoFramesNodeId,
        frameDialogNodeId,
        generateAngleNode,
        generateLightingNode,
        openPanoramaConfig,
        createPanoramaViewerWithConfig,
        addPanoramaCaptureNode,
        addDoubaoResultNode,
        panoramaConfigNodeId,
        setPanoramaConfigNodeId,
        generateEmotionNode,
        maskEditImageNode,
        maskEditNodeId,
        mergeSelectedVideos,
        mergeVideosByIds,
        mergeVideoProgress,
        saveAnnotatedImageNode,
        segmentRunningMode,
        inlineTrimNodeId,
        inlineTrimRunning,
        setInlineTrimNodeId,
        openInlineVideoTrim,
        openVideoCrop,
        closeInlineVideoTrim,
        confirmInlineVideoTrim,
        setFrameDialogNodeId,
        setAngleNodeId,
        setLightingNodeId,
        setEmotionNodeId,
        setAnnotationNodeId,
        setCropNodeId,
        setVideoCropNodeId,
        setMaskEditNodeId,
        setUpscaleNodeId,
        splitImageNode,
        upscaleImageNode,
        upscaleNodeId,
    } = useCanvasMediaTools({
        projectId,
        domainProjectId: linkedProjectId,
        nodesRef,
        connectionsRef,
        selectedNodeIdsRef,
        setNodes,
        setConnections,
        setSelectedNodeIds,
        setSelectedConnectionId,
        setDialogNodeId,
        setContextMenu,
        setHoveredNodeId,
        setToolbarNodeId,
        setRunningNodeId,
        startUploadStatus,
        startGenerationRequest,
        finishGenerationRequest,
        bindGenerationTask,
    });

    const bindUpscaleTask = useCallback((task: GenerationTask, nodeId: string) => bindGenerationTask(nodeId, task), [bindGenerationTask]);
    const { startUpscaleBatch } = useCanvasUpscaleBatch({
        projectId, nodesRef, connectionsRef, setNodes, setConnections, setSelectedNodeIds,
        prepareResource: prepareUpscaleResource, observeTask: observeAIUpscale, bindTask: bindUpscaleTask,
    });
    const createUpscaleProcessingNode = useCallback((source: CanvasNodeData) => {
        if (!source.metadata?.content && !source.metadata?.storageKey) {
            if (source.metadata?.workflowOperation?.id.endsWith(".ai-upscale")) void recoverAIUpscale(source).catch(error => message.error(generationErrorMessage(error)));
            else message.warning("请先选择可读取的图片或视频");
            return;
        }
        const selectedSources = selectedNodeIdsRef.current.has(source.id)
            ? nodesRef.current.filter(node => selectedNodeIdsRef.current.has(node.id) && (node.type === CanvasNodeType.Image || node.type === CanvasNodeType.Video) && (node.metadata?.content || node.metadata?.storageKey))
            : [source];
        const settings = createDefaultUpscaleSettings();
        const position = findAvailableGenerationGroupPosition(nodesRef.current, { x: source.position.x + source.width + 120, y: source.position.y }, { width: 420, height: 1000 });
        const processor = createCanvasNode(CanvasNodeType.Upscale, { x: position.x + 210, y: position.y + 120 }, { upscale: settings, status: "idle" });
        const nextConnections = [...connectionsRef.current, ...selectedSources.map(node => ({ id: nanoid(), fromNodeId: node.id, toNodeId: processor.id }))];
        connectionsRef.current = nextConnections;
        setConnections(nextConnections);
        setNodes(current => [...current, processor]);
        setSelectedNodeIds(new Set([processor.id]));
        setDialogNodeId(null);
        setToolbarNodeId(null);
    }, [message, recoverAIUpscale, setConnections, setNodes]);

    useEffect(() => {
        if (!projectLoaded) return;
        const controller = new AbortController();
        recoverDepthCaptureNodes(controller.signal);
        return () => controller.abort();
    }, [projectId, projectLoaded, recoverDepthCaptureNodes]);

    const handleNodesDeleted = useCallback(
        (removedIds: Set<string>, nextNodes: CanvasNodeData[], removedNodes: CanvasNodeData[]) => {
            const clearDeletedId = (current: string | null) => (current && removedIds.has(current) ? null : current);
            setHoveredNodeId(clearDeletedId);
            setToolbarNodeId(clearDeletedId);
            setDialogNodeId(clearDeletedId);
            clearDeletedNodeIds(removedIds);
            setFrameDialogNodeId(clearDeletedId);
            setInlineTrimNodeId(clearDeletedId);
            setCropNodeId(clearDeletedId);
            setMaskEditNodeId(clearDeletedId);
            setAnnotationNodeId(clearDeletedId);
            setUpscaleNodeId(clearDeletedId);
            setAngleNodeId(clearDeletedId);
            setLightingNodeId(clearDeletedId);
            setEmotionNodeId(clearDeletedId);
            setRunningNodeId(clearDeletedId);
            setScriptScrollTopById((current) => Object.fromEntries(Object.entries(current).filter(([id]) => !removedIds.has(id))));
            setContextMenu((current) => (current?.type === "node" && removedIds.has(current.nodeId) ? null : current));
            const removedDrawingIds = removedNodes.flatMap((node) => (node.type === CanvasNodeType.Drawing && node.metadata?.drawingId ? [node.metadata.drawingId] : []));
            if (removedDrawingIds.length) {
                void Promise.all(removedDrawingIds.map((drawingId) => removeCanvasDrawing(projectId, drawingId))).catch(() => message.warning("绘图节点已删除，但本地绘图缓存清理失败"));
            }
            cleanupCanvasFiles({ projectId, nodes: nextNodes, chatSessions });
            // Node operations update the local store synchronously, but the
            // Go repository is the source read by MCP/SSE. Persist the exact
            // post-delete snapshot immediately so a later refresh cannot
            // restore the removed node from a stale backend revision.
            if (isLocalWorkspaceMode()) {
                void syncLocalCanvasSnapshot(projectId, { nodes: nextNodes, connections: connectionsRef.current })
                    .catch((error) => console.error("删除节点后的本地后端同步失败", error));
            }
        },
        [
            chatSessions,
            cleanupCanvasFiles,
            clearDeletedNodeIds,
            message,
            projectId,
            setAngleNodeId,
            setAnnotationNodeId,
            setCropNodeId,
            setEmotionNodeId,
            setFrameDialogNodeId,
            setLightingNodeId,
            setMaskEditNodeId,
            setInlineTrimNodeId,
            setUpscaleNodeId,
            setRunningNodeId,
        ],
    );

    const {
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
    } = useCanvasNodeOperations({
        projectId,
        viewportScale: viewport.k,
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
        onNodesDeleted: handleNodesDeleted,
    });

    // Capability cards can request a starter node while opening a fresh local
    // canvas. Consume the query once so refreshes do not duplicate it.
    useEffect(() => {
        if (!projectLoaded) return;
        const requestedType = searchParams.get("add");
        const nodeType = requestedType === "video" ? CanvasNodeType.Video : requestedType === "image" ? CanvasNodeType.Image : requestedType === "audio" ? CanvasNodeType.Audio : null;
        if (!nodeType) return;
        let frame = 0;
        let focusFrame = 0;
        const insertWhenCanvasIsLaidOut = () => {
            const rect = containerRef.current?.getBoundingClientRect();
            if (!rect || rect.width <= 0 || rect.height <= 0) {
                frame = requestAnimationFrame(insertWhenCanvasIsLaidOut);
                return;
            }
            const shouldCreate = !nodesRef.current.some((node) => node.type === nodeType);
            if (shouldCreate) {
                createNode(nodeType);
                // Starter cards can be wider than a narrow viewport. Fit the
                // newly selected card after the node commit so it stays fully
                // visible instead of being clipped against the top-left edge.
                focusFrame = requestAnimationFrame(() => fitCanvasSelection());
            }
            const next = new URLSearchParams(searchParams);
            next.delete("add");
            setSearchParams(next, { replace: true });
        };
        frame = requestAnimationFrame(insertWhenCanvasIsLaidOut);
        return () => {
            cancelAnimationFrame(frame);
            cancelAnimationFrame(focusFrame);
        };
    }, [containerRef, createNode, fitCanvasSelection, nodesRef, projectLoaded, searchParams, setSearchParams]);

    const handleReplaceNodeReference = useCallback(
        (targetNodeId: string, oldReference: { id: string; nodeId?: string; label?: string; title?: string }, sourceNodeId: string) => {
            const sourceNode = nodesRef.current.find((n) => n.id === sourceNodeId);
            if (!sourceNode || sourceNode.id === oldReference.nodeId) return;

            const previousNodes = nodesRef.current;
            const previousConnections = connectionsRef.current;

            const configNodeId = previousConnections.find((c) => c.fromNodeId === targetNodeId && previousNodes.find((n) => n.id === c.toNodeId)?.type === CanvasNodeType.Config)?.toNodeId;
            const receiverId = configNodeId || targetNodeId;

            let rewired = false;
            const nextConnections = previousConnections.map((c) => {
                if (!rewired && c.fromNodeId === oldReference.nodeId && (c.toNodeId === targetNodeId || c.toNodeId === configNodeId)) {
                    rewired = true;
                    return { ...c, fromNodeId: sourceNodeId };
                }
                return c;
            });

            if (!rewired) {
                nextConnections.push({
                    id: nanoid(),
                    fromNodeId: sourceNodeId,
                    toNodeId: receiverId,
                });
            }

            const nextReferencesMap = buildCanvasNodeMentionReferenceMap(previousNodes, nextConnections, previousNodes);
            const targetNextReferences = nextReferencesMap.get(targetNodeId) || [];
            const newRef = targetNextReferences.find((r) => r.nodeId === sourceNodeId);

            const targetNode = previousNodes.find((n) => n.id === targetNodeId);
            let nextNodes = previousNodes;
            if (targetNode && newRef) {
                const currentPrompt = targetNode.metadata?.composerContent ?? targetNode.metadata?.prompt ?? "";
                const replacementToken = `@${newRef.label}`;
                const updatedPrompt = replaceCanvasReferenceMentions(currentPrompt, oldReference, replacementToken, sourceNode.title ? sourceNode.title : newRef.label);

                nextNodes = previousNodes.map((n) => (n.id === targetNodeId ? writeCanvasNodePrompt(n, updatedPrompt) : n));
            }

            nodesRef.current = nextNodes;
            connectionsRef.current = nextConnections;
            setNodes(nextNodes);
            setConnections(nextConnections);
            message.success(`已将参考图「${oldReference.label || "参考图"}」替换为「${sourceNode.title || "新图片"}」，提示词已同步更新`);
        },
        [connectionsRef, message, nodesRef, setConnections, setNodes],
    );

    const handleReplaceNodeReferenceFiles = useCallback(
        (_targetNodeId: string, oldReference: { id: string; nodeId?: string; label?: string; title?: string }, files: File[]) => {
            const file = files.find((f) => f.type.startsWith("image/"));
            if (!file || !oldReference.nodeId) return;
            void replaceNodeMedia(oldReference.nodeId, file).then((success: boolean) => {
                if (success) {
                    message.success("参考图片已替换");
                }
            });
        },
        [message, replaceNodeMedia],
    );

    const {
        cancelPendingConnectionCreate,
        closeConnectionCreateMenu,
        connectionTargetAnchorRatio,
        connectionTargetNodeId,
        connectionApproach,
        connectionReplaceHover,
        connectingParams,
        createConnectedNode,
        getConnectionCreateDisabledReason,
        handleConnectStart,
        handleConnectDrop,
        handleBatchConnectionTargetClick,
        batchConnectionPreview,
        beginBatchConnectionMode,
        startBatchConnection,
        mouseWorld,
        pendingConnectionCreate,
        setConnecting,
    } = useCanvasConnectionController({
        projectId,
        config: effectiveConfig,
        defaultDrawingEngine,
        nodesRef,
        connectionsRef,
        viewportRef,
        scriptScrollTopById,
        screenToCanvas,
        setNodes,
        setConnections,
        setSelectedNodeIds,
        setSelectedConnectionId,
        setContextMenu,
        setDialogNodeId,
        setDrawingNodeId,
        onConnectedNodeCreated: keepConnectedNodeVisible,
        onReplaceReference: handleReplaceNodeReference,
    });

    const batchSourceNodeIds = useMemo(() => nodes.filter((node) => selectedNodeIds.has(node.id) && !batchSourceRestriction(node)).map((node) => node.id), [nodes, selectedNodeIds]);

    const {
        handleCanvasSelectionStart,
        handleNodeInteractionStart,
        handleNodeDragEnd,
        handleCanvasDeselect,
    } = useCanvasPointerSelectionChrome({
        nodesRef,
        segmentRunningMode,
        setContextMenu,
        setHoveredNodeId,
        setToolbarNodeId,
        setDialogNodeId,
    });

    const handleSelectedNodeClick = useCallback(
        (node: CanvasNodeData) => {
            if (segmentRunningMode === "audio") return;
            if (node.metadata?.workflowSlot || node.metadata?.reusableWorkflow) {
                bringNodeToFront(node.id);
                setDialogNodeId(null);
                setToolbarNodeId(null);
                return;
            }
            // Selection is transient, but the LibTV-style paint order survives
            // deselection so a clicked lower node stays above its neighbours.
            if (!isFrameNode(node)) bringNodeToFront(node.id);
            if (node.type === CanvasNodeType.Drawing) {
                setDialogNodeId(null);
                setDrawingNodeId(node.id);
            } else if (node.type === CanvasNodeType.Script) {
                setDialogNodeId(null);
            } else if (node.type === CanvasNodeType.Text) {
                setDialogNodeId(node.id);
            } else if (isFrameNode(node)) {
                setDialogNodeId(null);
            } else if (node.type === ART_CRITIQUE_NODE_TYPE) {
                setDialogNodeId(null);
                setArtCritiqueNodeId(node.id);
            } else if (node.type === CanvasNodeType.Panorama) {
                // 全景节点是纯查看器，没有可编辑提示词，不弹提示词面板。
                setDialogNodeId(null);
            } else if (node.type === CanvasNodeType.Director) {
                // 导演台仅通过卡片上的“打开导演台”按钮进入，不属于生成节点。
                setDialogNodeId(null);
            } else if (node.type === CanvasNodeType.Image || node.type === CanvasNodeType.Video || node.type === CanvasNodeType.Audio) {
                // Media generators own the composer; results from any origin own the media toolbar.
                if (canOpenCanvasNodePromptPanel(node)) {
                    setToolbarNodeId(null);
                    setDialogNodeId(node.id);
                } else {
                    setDialogNodeId(null);
                    setToolbarNodeId(node.id);
                }
            } else {
                // 选择参考媒体时保留当前工作流配置面板，避免点击图片后配置“返回/消失”。
                // 没有工作流配置面板时，媒体节点仍按原逻辑打开自己的面板。
                setDialogNodeId((current) => {
                    const currentNode = current ? nodesRef.current.find((item) => item.id === current) : undefined;
                    return currentNode?.type === CanvasNodeType.Config ? current : node.id;
                });
            }
        },
        [bringNodeToFront, nodesRef, segmentRunningMode],
    );

    const handleNodeBringToFront = useCallback(
        (nodeId: string) => {
            const node = nodesRef.current.find((item) => item.id === nodeId);
            if (node && !isFrameNode(node)) bringNodeToFront(nodeId);
        },
        [bringNodeToFront, nodesRef],
    );

    const { alignmentGuides, cancelSelectionBox, deselectCanvas, dragPreview, frameDropTargetId, nodeDropTargetId, handleCanvasMouseDown, handleNodeMouseDown, isNodeDragging, nodeDraggingRef, selectionBoundsElementRef, selectionBox } = useCanvasSelectionController({
        containerRef,
        nodesRef,
        viewportRef,
        selectedNodeIdsRef,
        historyPausedRef,
        screenToCanvas,
        setNodes,
        setSelectedNodeIds,
        setSelectedConnectionId,
        cancelPendingConnectionCreate,
        onCanvasSelectionStart: handleCanvasSelectionStart,
        onNodeInteractionStart: handleNodeInteractionStart,
        onNodeBringToFront: handleNodeBringToFront,
        onNodeClick: handleSelectedNodeClick,
        onNodeDragEnd: handleNodeDragEnd,
        onBatchConnectionTarget: handleBatchConnectionTargetClick,
        onLinkedFolderDrop: archiveNodesToLinkedFolder,
        onNodeDrop: workflowInstances.drop,
        onNodeDropTarget: (ids, point) => {
            const source = ids.length === 1 ? nodesRef.current.find(node => node.id === ids[0]) : undefined;
            return source ? workflowDropSlot(nodesRef.current, source, point)?.id : undefined;
        },
        onDeselect: handleCanvasDeselect,
        snapToGrid,
    });

    const {
        keepNodeToolbar,
        hideNodeToolbar,
        handleCanvasNodeHoverStart,
        handleCanvasNodeHoverEnd,
    } = useCanvasNodeToolbarHover({
        nodeDraggingRef,
        nodeImageSettingsOpen,
        setHoveredNodeId,
        setToolbarNodeId,
    });

    const {
        collapsingBatchIds,
        downloadNodeImage,
        handleConfigNodeChange,
        handleFolderStyleChange,
        handleFolderThemeChange,
        handleFontSizeChange,
        handleNodeContentChange,
        handleNodePromptChange,
        handleNodeResize,
        handleNodeTitleChange,
        openingBatchIds,
        saveNodeAsset,
        setBatchPrimary,
        toggleBatchExpanded,
        toggleFrameCollapsed,
        toggleNodeFreeResize,
    } = useCanvasNodeEditor({
        canvasId: projectId,
        canvasTitle: currentProject?.title || "未命名画布",
        domainProjectId: linkedProjectId,
        nodesRef,
        setNodes,
        setSelectedNodeIds,
        setSelectedConnectionId,
        setDialogNodeId,
        setToolbarNodeId,
        setHoveredNodeId,
    });

    const handleRemoveNodeReference = useCallback(
        (targetNodeId: string, reference: CanvasResourceReference) => {
            const referenceNodeId = reference.nodeId;
            if (!referenceNodeId) return;
            // 生成节点可能通过配置节点接收参考，只移除参考来源边，保留目标到配置节点的主链。
            const previousNodes = nodesRef.current;
            const previousConnections = connectionsRef.current;
            const configNodeId = previousConnections.find((connection) => {
                if (connection.fromNodeId !== targetNodeId) return false;
                return previousNodes.find((node) => node.id === connection.toNodeId)?.type === CanvasNodeType.Config;
            })?.toNodeId;
            const removedConnectionIds = new Set(previousConnections.filter((connection) => connection.fromNodeId === referenceNodeId && (connection.toNodeId === targetNodeId || connection.toNodeId === configNodeId)).map((connection) => connection.id));
            if (!removedConnectionIds.size) return;
            const nextConnections = previousConnections.filter((connection) => !removedConnectionIds.has(connection.id));
            const promptSyncedNodes = applyCanvasConnectionPromptSync(previousNodes, previousConnections, previousNodes, nextConnections);
            const targetNode = promptSyncedNodes.find((node) => node.id === targetNodeId);
            const referenceAssetNodeIds = targetNode?.metadata?.referenceAssetNodeIds;
            const nextNodes = targetNode?.metadata?.workflowKind === "shot" && referenceAssetNodeIds?.includes(referenceNodeId)
                ? promptSyncedNodes.map((node) => node.id === targetNodeId ? { ...node, metadata: { ...node.metadata, referenceAssetNodeIds: referenceAssetNodeIds.filter((id) => id !== referenceNodeId) } } : node)
                : promptSyncedNodes;
            if (nextNodes !== previousNodes) {
                nodesRef.current = nextNodes;
                setNodes(nextNodes);
            }
            connectionsRef.current = nextConnections;
            setConnections(nextConnections);
            setSelectedConnectionId((current) => (current && removedConnectionIds.has(current) ? null : current));
        },
        [connectionsRef, nodesRef, setConnections, setNodes, setSelectedConnectionId],
    );

    const handleReorderNodeReferences = useCallback(
        (targetNodeId: string, orderedNodeIds: string[]) => {
            const previousNodes = nodesRef.current;
            const previousConnections = connectionsRef.current;
            const nextConnections = reorderCanvasResourceConnections(targetNodeId, orderedNodeIds, previousNodes, previousConnections);
            if (nextConnections === previousConnections) return;
            const nextNodes = applyCanvasConnectionPromptSync(previousNodes, previousConnections, previousNodes, nextConnections);
            if (nextNodes !== previousNodes) {
                nodesRef.current = nextNodes;
                setNodes(nextNodes);
            }
            connectionsRef.current = nextConnections;
            setConnections(nextConnections);
        },
        [connectionsRef, nodesRef, setConnections, setNodes],
    );

    const handleProjectFolderInsert = useCallback(
        (folderId: string, expectedScope: CapturedUserScope) => {
            assertUserScope(expectedScope);
            const folder = linkedProjectQuery.data?.assetFolders.find((item) => item.id === folderId);
            if (!folder || !linkedProjectId) throw new Error("素材文件夹已不存在，请刷新后重试");
            const { style, theme } = linkedFolderPresentation(folder);
            createFolder(projectAssetInsertPosition, { id: folder.id, projectId: linkedProjectId, title: folder.name, style, theme, createdAt: folder.createdAt });
        },
        [createFolder, linkedProjectId, linkedProjectQuery.data?.assetFolders, projectAssetInsertPosition],
    );

    const handleFrameToggle = useCallback(
        (nodeId: string) => {
            const node = nodesRef.current.find((item) => item.id === nodeId);
            const linkedFolderId = node?.metadata?.folder?.assetFolderId;
            if (linkedFolderId) {
                openProjectAssets("all", node ? { x: node.position.x + node.width + 40, y: node.position.y } : undefined, "canvas", linkedFolderId);
                return;
            }
            toggleFrameCollapsed(nodeId);
        },
        [nodesRef, openProjectAssets, toggleFrameCollapsed],
    );

    const linkedFolderPreviewNodesById = useMemo(() => {
        const result = new Map<string, CanvasNodeData[]>();
        const localById = new Map(assets.map((asset) => [asset.id, asset]));
        for (const asset of linkedProjectQuery.data?.assets || []) {
            if (!asset.folderId) continue;
            const local = localById.get(asset.id);
            const characterCover = asset.character?.representations.find((item) => item.role === "turnaround_sheet") || asset.character?.representations.find((item) => item.role === "primary") || asset.character?.representations[0];
            const type = asset.category === "character" || asset.mediaType === "image" ? CanvasNodeType.Image : asset.mediaType === "video" ? CanvasNodeType.Video : asset.mediaType === "audio" ? CanvasNodeType.Audio : CanvasNodeType.Text;
            const remoteResourceId = resourceIdFromStorageKey(asset.storageKey);
            const content = characterCover
                ? resourceFileUrl(characterCover.resourceId)
                : local?.kind === "image"
                  ? local.data.dataUrl || local.coverUrl
                  : local?.kind === "video" || local?.kind === "audio"
                    ? local.data.url
                    : local?.kind === "text"
                      ? local.data.content
                      : remoteResourceId
                        ? resourceFileUrl(remoteResourceId)
                        : asset.previewText || "";
            const preview: CanvasNodeData = { id: asset.id, type, title: asset.title, position: { x: 0, y: 0 }, width: 240, height: 160, metadata: { assetId: asset.id, content } };
            const current = result.get(asset.folderId) || [];
            current.push(preview);
            result.set(asset.folderId, current);
        }
        return result;
    }, [assets, linkedProjectQuery.data?.assets]);

    const {
        activeDirectorScene,
        activeNodeId,
        activeScriptNode,
        activeStylePresetId,
        angleNode,
        lightingNode,
        emotionNode,
        batchChildCountById,
        batchMotionById,
        canvasImageNodes,
        configInputsById,
        connectionLayerBounds,
        contextMenuNode,
        displayConnections,
        frameChildrenById,
        infoNode,
        maskEditNode,
        mentionReferencesByNodeId,
        nodeById,
        previewNode,
        reduceMediaEffects,
        relatedHighlight,
        resourceReferenceByNodeId,
        selectedNodeBounds,
        selectedVideoNodes,
        skillMentionReferences,
        toolbarNode,
        upscaleNode,
        versionCompareNodes,
        visibleNodes,
    } = useCanvasRenderModel({
        nodes,
        connections,
        assets,
        viewport,
        viewportSize: size,
        mediaPerformanceMode,
        selectedNodeIds,
        hoveredNodeId,
        dragPreview,
        collapsingBatchIds,
        addedSkills,
        directorScenes: currentProject?.directorScenes,
        infoNodeId,
        maskEditNodeId,
        annotationNodeId,
        splitNodeId: null,
        upscaleNodeId,
        angleNodeId,
        lightingNodeId,
        emotionNodeId,
        previewNodeId,
        contextMenu,
        versionCompareRootId,
        directorNodeId,
        scriptEditorNodeId,
        dialogNodeId,
    });
    const renderedConnections = showConnections ? displayConnections : [];
    const dialogNodeCandidate = dialogNodeId ? nodeById.get(dialogNodeId) || null : null;
    const dialogNode = canOpenCanvasNodePromptPanel(dialogNodeCandidate) ? dialogNodeCandidate : null;
    // dragPreview is published on the same pointer-down frame as isNodeDragging.
    // Treat either signal as moving so floating editors disappear before the
    // first preview transform is painted and never affect drag layout.
    const isCanvasNodeMoving = isNodeDragging || Boolean(dragPreview?.nodeIds.size);
    const subtitleNode = subtitleNodeId ? nodeById.get(subtitleNodeId) || null : null;
    const timelineNode = timelineNodeId ? nodeById.get(timelineNodeId) || null : null;
    const frameNode = frameDialogNodeId ? nodeById.get(frameDialogNodeId) || null : null;
    const inlineTrimNode = inlineTrimNodeId ? nodeById.get(inlineTrimNodeId) || null : null;
    const textEditorNode = textEditorNodeId ? nodeById.get(textEditorNodeId) || null : null;
    const characterReferenceNode = characterReferenceNodeId ? nodeById.get(characterReferenceNodeId) || null : null;
    const drawingNode = drawingNodeId ? nodeById.get(drawingNodeId) || null : null;
    const artCritiqueNode = artCritiqueNodeId ? nodeById.get(artCritiqueNodeId) || null : null;
    const artCritiqueInputs = artCritiqueNode
        ? connections
              .filter((connection) => connection.toNodeId === artCritiqueNode.id)
              .sort((left, right) => left.id.localeCompare(right.id))
              .map((connection) => nodeById.get(connection.fromNodeId))
              .filter((node): node is CanvasNodeData => Boolean(node))
        : [];
    const pendingConnectionSourceNode = pendingConnectionCreate?.connection.handleType === "source" ? nodeById.get(pendingConnectionCreate.connection.nodeId) : null;
    const canCreateDrawingFromConnection = !pendingConnectionCreate?.batchSourceNodeIds?.length && pendingConnectionSourceNode?.type === CanvasNodeType.Image && Boolean(pendingConnectionSourceNode.metadata?.content);

    const openTextNodeEditor = useCallback((node: CanvasNodeData) => {
        if (node.type !== CanvasNodeType.Text) return;
        setSelectedNodeIds(new Set([node.id]));
        setSelectedConnectionId(null);
        setContextMenu(null);
        setDialogNodeId(null);
        setToolbarNodeId(null);
        if (node.metadata?.workflowKind === "character" && node.metadata.characterAssetId) {
            setCharacterReferenceNodeId(node.id);
            return;
        }
        setTextEditorNodeId(node.id);
    }, []);

    const openDrawingNode = useCallback((node: CanvasNodeData) => {
        if (node.type !== CanvasNodeType.Drawing) return;
        setSelectedNodeIds(new Set([node.id]));
        setSelectedConnectionId(null);
        setContextMenu(null);
        setDialogNodeId(null);
        setToolbarNodeId(null);
        setDrawingNodeId(node.id);
    }, []);

    const openArtCritique = useCallback((node: CanvasNodeData) => {
        if (node.type !== ART_CRITIQUE_NODE_TYPE) return;
        setSelectedNodeIds(new Set([node.id]));
        setSelectedConnectionId(null);
        setContextMenu(null);
        setDialogNodeId(null);
        setToolbarNodeId(null);
        setArtCritiqueNodeId(node.id);
    }, []);
    const duplicateNodeFromContent = useCallback((node: CanvasNodeData) => duplicateNode(node.id), [duplicateNode]);
    const deleteNodeFromContent = useCallback((node: CanvasNodeData) => deleteNodes(new Set([node.id])), [deleteNodes]);
    const { updateNodeFromContent, updateMediaNodeFromContent, updateNodeMetadataFromContent } = useCanvasNodeContent({
        nodesRef,
        setNodesState,
    });
    const canvasNodeActions = useMemo<CanvasNodeActionContextValue>(
        () => ({
            upload: replaceCanvasNodeMedia,
            download: downloadNodeImage,
            duplicate: duplicateNodeFromContent,
            deleteNode: deleteNodeFromContent,
            updateMetadata: updateNodeMetadataFromContent,
            updateNode: updateNodeFromContent,
            updateMediaNode: updateMediaNodeFromContent,
            openArtCritique,
            addPanoramaCaptureNode,
            addDoubaoResultNode,
            startUpscaleBatch,
            recoverUpscaleResult: recoverAIUpscale,
        }),
        [addDoubaoResultNode, addPanoramaCaptureNode, deleteNodeFromContent, downloadNodeImage, duplicateNodeFromContent, openArtCritique, replaceCanvasNodeMedia, updateMediaNodeFromContent, updateNodeFromContent, updateNodeMetadataFromContent, startUpscaleBatch, recoverAIUpscale],
    );
    const { selectCanvasStyle, applyCanvasStyleAsync, styleApplying } = useCanvasStyleWorkflow({
        canvasId: projectId,
        domainProjectId: currentProject?.projectId,
        nodesRef,
        selectedNodeIdsRef,
        getCanvasCenter,
        setNodes,
        setSelectedNodeIds,
        setSelectedConnectionId,
        setDialogNodeId,
        setStylePickerOpen,
    });

    const { applyDirectorOutput, captureDirectorCover, createDirectorShot, openDirectorWorkbench, saveDirectorScene, shouldCaptureCover } = useCanvasDirector({
        projectId,
        domainProjectId: currentProject?.projectId,
        directorNodeId,
        directorScenes: currentProject?.directorScenes || [],
        nodesRef,
        connectionsRef,
        getCanvasCenter,
        setNodes,
        setConnections,
        setSelectedNodeIds,
        setSelectedConnectionId,
        setDirectorNodeId,
        updateProject,
    });

    useEffect(() => {
        const starter = searchParams.get("start");
        if (!projectLoaded || (starter !== "director" && starter !== "agent")) return;

        let frame = 0;
        const startWhenCanvasIsLaidOut = () => {
            const rect = containerRef.current?.getBoundingClientRect();
            if (!rect || rect.width <= 0 || rect.height <= 0) {
                frame = requestAnimationFrame(startWhenCanvasIsLaidOut);
                return;
            }

            if (starter === "director" && !nodesRef.current.some((node) => node.type === CanvasNodeType.Director)) {
                createDirectorShot();
            } else if (starter === "agent") {
                openAssistant();
            }

            const next = new URLSearchParams(searchParams);
            next.delete("start");
            setSearchParams(next, { replace: true });
        };
        frame = requestAnimationFrame(startWhenCanvasIsLaidOut);
        return () => cancelAnimationFrame(frame);
    }, [containerRef, createDirectorShot, nodesRef, openAssistant, projectLoaded, searchParams, setSearchParams]);

    const {
        activateStep: activateShortDramaStep,
        createPipeline: createShortDramaPipeline,
        guideCollapsed: shortDramaGuideCollapsed,
        openStoryInput,
        progress: shortDramaProgress,
        setGuideCollapsed: setShortDramaGuideCollapsed,
        skipGuide: skipShortDramaGuide,
    } = useCanvasShortDrama({
        nodes,
        connections,
        nodesRef,
        connectionsRef,
        selectedNodeIdsRef,
        getCanvasCenter,
        setNodes,
        setConnections,
        setSelectedNodeIds,
        setSelectedConnectionId,
        setStylePickerOpen,
        fitCanvasSelection,
        focusCanvasNode,
        openTextEditor: openTextNodeEditor,
    });

    const shortDramaGuide = shortDramaEnabled && !currentProject?.projectId && shortDramaProgress.active ? { progress: shortDramaProgress, collapsed: shortDramaGuideCollapsed, onToggle: () => setShortDramaGuideCollapsed((value) => !value) } : undefined;

    const clearCanvas = useCallback(() => {
        const drawingIds = nodesRef.current.flatMap((node) => (node.type === CanvasNodeType.Drawing && node.metadata?.drawingId ? [node.metadata.drawingId] : []));
        if (drawingIds.length) {
            void Promise.all(drawingIds.map((drawingId) => removeCanvasDrawing(projectId, drawingId))).catch(() => message.warning("画布已清空，但部分本地绘图缓存清理失败"));
        }
        setNodes([]);
        setConnections([]);
        resetForClearCanvas();
        setCropNodeId(null);
        setMaskEditNodeId(null);
        setAnnotationNodeId(null);
        setAngleNodeId(null);
        setLightingNodeId(null);
        setEmotionNodeId(null);
        setRunningNodeId(null);
        deselectCanvas();
        clearCanvasFiles();
    }, [clearCanvasFiles, deselectCanvas, message, nodesRef, projectId, resetForClearCanvas, setEmotionNodeId]);

    useCanvasKeyboard({
        enabled: projectLoaded && !versions.preview && !directorNodeId,
        onToggleAssistant: focusMode ? undefined : toggleAssistant,
        nodesRef,
        selectedNodeIdsRef,
        selectedConnectionId,
        setSelectedNodeIds,
        setSelectedConnectionId,
        setContextMenu,
        setShortcutRequestNonce,
        setInfoNodeId,
        setCropNodeId,
        setMaskEditNodeId,
        setAnnotationNodeId,
        saveCanvasProject,
        zoomToActualSize,
        fitCanvasContent,
        fitCanvasSelection,
        undoCanvas,
        redoCanvas,
        cancelSelectionBox,
        copySelectedNodes,
        pasteCopiedNodes,
        restoreCopiedNodesFromText,
        shouldPreferCopiedNodes,
        pasteSystemClipboard,
        deleteNodes,
        deleteConnection,
        deselectCanvas,
        zoomCanvasIn,
        zoomCanvasOut,
        autoArrangeCanvasNodes,
        focusMode,
        exitFocusMode,
        toggleFocusMode,
        onOpenSearch: () => setNodeSearchOpen(true),
        beginBatchConnection: () => beginBatchConnectionMode(Array.from(selectedNodeIdsRef.current)),
    });

    const handleAssistantSessionsChange = useCallback((sessions: CanvasAssistantSession[], activeId: string | null) => {
        chatSessionsRef.current = sessions;
        activeChatIdRef.current = activeId;
        setChatSessions(sessions);
        setActiveChatId(activeId);
    }, []);

    const startTitleEditing = useCallback(() => {
        setTitleDraft(workspaceProject?.title || "未命名工作区");
        setTitleEditing(true);
    }, [workspaceProject?.title]);

    const finishTitleEditing = useCallback(() => {
        const nextTitle = titleDraft.trim();
        if (nextTitle) renameCurrentProject(nextTitle);
        setTitleEditing(false);
    }, [renameCurrentProject, titleDraft]);

    const pasteAtPosition = useCallback(
        (position: Position) => {
            if (shouldPreferCopiedNodes() && pasteCopiedNodes(position)) return;
            void (async () => {
                try {
                    // 标记写入成功时仍优先系统图片，兼容截图和从外部应用复制的媒体。
                    const handled = await pasteSystemClipboard(position);
                    if (!handled) pasteCopiedNodes(position);
                } catch {
                    if (!pasteCopiedNodes(position)) message.warning("无法读取剪贴板内容");
                }
            })();
        },
        [message, pasteCopiedNodes, pasteSystemClipboard, shouldPreferCopiedNodes],
    );

    const copyingNodeContentRef = useRef(false);
    const copyNodeContentToClipboard = useCallback(
        async (node: CanvasNodeData | null) => {
            if (copyingNodeContentRef.current) return;
            copyingNodeContentRef.current = true;
            releaseCopiedNodesPastePriority();
            const content = node?.metadata?.content?.trim();
            const resourceId = resourceIdFromStorageKey(node?.metadata?.storageKey);
            const copySource = content || (node?.type === CanvasNodeType.Image && resourceId ? resourceFileUrl(resourceId) : "");
            if (!node || !copySource) {
                copyingNodeContentRef.current = false;
                message.warning("没有可复制的内容");
                return;
            }

            try {
                if (node.type === CanvasNodeType.Image) {
                    try {
                        await copyImageToSystemClipboard(copySource, node.metadata?.storageKey);
                        message.success("图片已复制到剪贴板");
                        return;
                    } catch (imageErr) {
                        const fallbackUrl = new URL(copySource, window.location.href).toString();
                        if (navigator.clipboard?.writeText) {
                            await navigator.clipboard.writeText(fallbackUrl).catch(() => undefined);
                            message.info("由于浏览器未获得焦点，已为您复制图片地址");
                            return;
                        }
                        if (await copyToClipboard(fallbackUrl)) {
                            message.info("由于浏览器未获得焦点，已为您复制图片地址");
                            return;
                        }
                        throw imageErr;
                    }
                }

                if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(copySource);
                else if (!copyToClipboard(copySource)) throw new Error("当前浏览器不支持写入剪贴板");
                message.success(node.type === CanvasNodeType.Text ? "文本已复制" : "内容链接已复制");
            } catch (error) {
                message.error(error instanceof Error ? error.message : "复制失败，请检查浏览器剪贴板权限");
            } finally {
                copyingNodeContentRef.current = false;
            }
        },
        [message, releaseCopiedNodesPastePriority],
    );

    const copyNodeMediaUrlToClipboard = useCallback(
        async (node: CanvasNodeData | null) => {
            releaseCopiedNodesPastePriority();
            try {
                const storageKey = node?.metadata?.storageKey;
                const content = node?.metadata?.content?.trim();
                const resourceId = resourceIdFromStorageKey(storageKey);
                const mediaPath = content && !content.startsWith("data:") && !content.startsWith("blob:") ? content : resourceId ? resourceFileUrl(resourceId) : "";
                const mediaURL = mediaPath ? new URL(mediaPath, window.location.href).toString() : "";
                if (!mediaURL) throw new Error("当前媒体只有本地内容，没有可复制的地址");
                if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(mediaURL);
                else if (!(await copyToClipboard(mediaURL))) throw new Error("当前浏览器不支持写入剪贴板");
                message.success(node?.type === CanvasNodeType.Video ? "视频地址已复制" : "图片地址已复制");
            } catch (error) {
                message.error(error instanceof Error ? error.message : "媒体地址复制失败");
            }
        },
        [message, releaseCopiedNodesPastePriority],
    );

    const uploadNodeImageToArkPrivateAsset = useCallback(
        async (node: CanvasNodeData) => {
            if (node.type !== CanvasNodeType.Image || !node.metadata?.content) {
                message.warning("请选择一张可用图片后再上传");
                return;
            }
            if (arkPrivateAssetUploadNodeId === node.id) return;
            const feedbackKey = `ark-private-asset-${node.id}`;
            setArkPrivateAssetUploadNodeId(node.id);
            message.loading({ key: feedbackKey, content: "正在保存并上传到方舟素材库...", duration: 0 });
            try {
                let resourceID = resourceIdFromStorageKey(node.metadata.storageKey);
                let persistedNode = node;
                if (!resourceID) {
                    const uploaded = await uploadImage(node.metadata.content);
                    resourceID = resourceIdFromStorageKey(uploaded.storageKey);
                    if (!resourceID) throw new Error(localOnly ? "图片未能保存到本地素材库，请重试" : "图片未能保存到系统素材库，请检查对象存储配置后重试");
                    handleConfigNodeChange(node.id, imageMetadata(uploaded));
                    persistedNode = { ...node, metadata: { ...node.metadata, ...imageMetadata(uploaded) } };
                }
                const asset = await ensureCanvasNodeAsset({ canvasId: projectId, domainProjectId: currentProject?.projectId, node: persistedNode, source: "canvas-manual" });
                handleConfigNodeChange(node.id, { assetId: asset.assetId });
                await syncResourceToArkPrivateAsset(resourceID);
                message.success({ key: feedbackKey, content: "已同步到方舟素材库，Seedance 将自动复用该素材", duration: 4 });
            } catch (error) {
                message.error({ key: feedbackKey, content: error instanceof Error ? error.message : "上传到方舟素材库失败", duration: 5 });
            } finally {
                setArkPrivateAssetUploadNodeId((current) => (current === node.id ? null : current));
            }
        },
        [arkPrivateAssetUploadNodeId, currentProject?.projectId, handleConfigNodeChange, localOnly, message, projectId],
    );

    const confirmUploadNodeImageToArkPrivateAsset = useCallback(
        (node: CanvasNodeData) => {
            modal.confirm({
                title: "上传到方舟素材库",
                content: "仅可上传你拥有肖像、版权或其他合法使用权的图片。方舟审核通过后，Seedance 会使用受控素材标识生成视频。",
                okText: "确认拥有使用权并上传",
                cancelText: "取消",
                onOk: () => uploadNodeImageToArkPrivateAsset(node),
            });
        },
        [modal, uploadNodeImageToArkPrivateAsset],
    );

    const handleCanvasContextMenu = useCallback(
        (event: ReactMouseEvent) => {
            const target = event.target instanceof Element ? event.target : null;
            if (target?.closest("[data-node-id],[data-connection-id]")) return;

            event.preventDefault();
            event.stopPropagation();
            if (target?.closest("[data-canvas-no-zoom],.ant-modal,.ant-popover,.ant-dropdown")) {
                setContextMenu(null);
                return;
            }

            closeConnectionCreateMenu();
            setContextMenu({ type: "canvas", x: event.clientX, y: event.clientY, position: screenToCanvas(event.clientX, event.clientY) });
        },
        [closeConnectionCreateMenu, screenToCanvas],
    );

    const handleNodeContextMenu = useCallback(
        (event: ReactMouseEvent, id: string) => {
            if (isCanvasTextEditingTarget(event.target)) return;
            event.preventDefault();
            event.stopPropagation();
            setSelectedNodeIds((current) => {
                if (current.has(id) && current.size > 1) return current;
                return new Set([id]);
            });
            setSelectedConnectionId(null);
            closeConnectionCreateMenu();
            setToolbarNodeId(null);
            setDialogNodeId(null);
            setContextMenu({ type: "node", x: event.clientX, y: event.clientY, nodeId: id });
        },
        [closeConnectionCreateMenu],
    );

    const renderCanvasNodePanel = useCallback(
        (panelNode: CanvasNodeData) => {
            if (panelNode.type === CanvasNodeType.Script || panelNode.type === CanvasNodeType.Drawing) return null;
            return panelNode.type === CanvasNodeType.Config ? (
                <CanvasConfigComposer
                    model={panelNode.metadata?.model || config.videoModel}
                    value={panelNode.metadata?.composerContent ?? panelNode.metadata?.prompt ?? ""}
                    inputs={configInputsById.get(panelNode.id) || []}
                    skillReferences={skillMentionReferences}
                    generationMode={panelNode.metadata?.generationMode}
                    metadata={panelNode.metadata}
                    workspaceMode={workspaceMode}
                    onChange={(composerContent) => handleConfigNodeChange(panelNode.id, { composerContent })}
                    onMetadataChange={(patch) => handleConfigNodeChange(panelNode.id, patch)}
                    onClose={() => setDialogNodeId(null)}
                />
            ) : (
                <CanvasNodePromptPanel
                    projectId={projectId}
                    node={panelNode}
                    isRunning={isCanvasNodeGenerating(panelNode, runningNodeId)}
                    mentionReferences={[
                        ...(mentionReferencesByNodeId.get(panelNode.id) || EMPTY_RESOURCE_REFERENCES),
                        ...buildCanvasResourceReferences(nodesRef.current, connectionsRef.current).filter((reference) => reference.kind === "text" && reference.nodeId !== panelNode.id && !(mentionReferencesByNodeId.get(panelNode.id) || []).some((active) => active.nodeId === reference.nodeId)),
                    ]}
                    onAddReference={(nodeId, reference) => {
                        if (reference.active || reference.assetId || reference.kind === "skill") return reference;
                        if (reference.kind !== "text" || !reference.nodeId || reference.nodeId === nodeId) return undefined;
                        try {
                            const linked = connectCanvasTextMention(nodesRef.current, connectionsRef.current, nodeId, reference.nodeId, nanoid());
                            nodesRef.current = linked.nodes;
                            connectionsRef.current = linked.connections;
                            setNodes(linked.nodes);
                            setConnections(linked.connections);
                            return linked.reference;
                        } catch (cause) {
                            message.warning(cause instanceof Error ? cause.message : "文本引用失败");
                            return undefined;
                        }
                    }}
                    onPromptChange={handleNodePromptChange}
                    onConfigChange={handleConfigNodeChange}
                    onGenerate={handleGenerateNode}
                    onRemoveReference={handleRemoveNodeReference}
                    onReorderReferences={handleReorderNodeReferences}
                    onReplaceReference={handleReplaceNodeReference}
                    onReplaceReferenceFiles={handleReplaceNodeReferenceFiles}
                    onClose={() => setDialogNodeId(null)}
                    onNodeMouseDown={handleNodeMouseDown}
                    workspaceMode={workspaceMode}
                    onImageSettingsOpenChange={(open) => {
                        setNodeImageSettingsOpen(open);
                        if (open) setToolbarNodeId(null);
                    }}
                />
            );
        },
        [
            configInputsById,
            handleConfigNodeChange,
            handleGenerateNode,
            handleNodePromptChange,
            handleRemoveNodeReference,
            handleReorderNodeReferences,
            handleReplaceNodeReference,
            handleReplaceNodeReferenceFiles,
            mentionReferencesByNodeId,
            message,
            projectId,
            runningNodeId,
            skillMentionReferences,
            workspaceMode,
        ],
    );

    const renderCanvasNodeContent = useCallback(
        (contentNode: CanvasNodeData) => {
            if (contentNode.metadata?.reusableWorkflow || contentNode.metadata?.workflowSlot) {
                return <ReusableWorkflowNode node={contentNode} nodes={nodesRef.current} readOnly={readOnly} onResultDrag={handleNodeMouseDown} onUpdate={workflowInstances.update} dropTarget={nodeDropTargetId === contentNode.id} onAction={workflowInstances.action} onValue={workflowInstances.setValue} onUploadBusy={workflowInstances.uploadBusy} onError={error => { void message.error(error); }} />;
            }
            if (contentNode.metadata?.workflowKind === "character" && contentNode.metadata.characterAssetId) {
                return <CanvasCharacterReferenceNodeContent node={contentNode} />;
            }
            if (contentNode.metadata?.workflowKind === "styleboard" && !contentNode.metadata.content) {
                return <CanvasStylePlaceholderNodeContent onChoose={() => setStylePickerOpen(true)} />;
            }
            if (contentNode.metadata?.workflowKind === "story_input") {
                return <CanvasStoryInputNodeContent node={contentNode} onEdit={() => openStoryInput(contentNode.id)} />;
            }
            if (contentNode.type === CanvasNodeType.BatchTable) {
                return (
                    <CanvasBatchTableNodeContent
                        node={contentNode}
                        nodes={nodesRef.current}
                        connections={connections}
                        batch={visibleGenerationBatch(contentNode)}
                        theme={theme}
                        onPatchTable={(patch) => patchBatchTable(contentNode.id, patch)}
                        onAddRow={() => addBatchRow(contentNode.id)}
                        onRemoveRow={(rowId) => removeBatchRow(contentNode.id, rowId)}
                        onUpdateRow={(rowId, patch) => updateBatchRow(contentNode.id, rowId, patch)}
                        onFillRows={() => fillRowsFromConnections(contentNode.id)}
                        onGenerate={(rowIds) => void generateBatchRows(contentNode.id, rowIds)}
                        onRetryItem={(batchId, itemId) => retryFailedBatchItems(contentNode.id, batchId, itemId)}
                        onAddReferenceColumn={() => addBatchReferenceColumn(contentNode.id)}
                        onRemoveReferenceColumn={() => removeBatchReferenceColumn(contentNode.id)}
                        onFocusOutput={(nodeId) => focusCanvasImageNode(nodeId)}
                        onReorderReferenceColumns={(fromColumnId, toColumnId) => reorderBatchReferenceColumns(contentNode.id, fromColumnId, toColumnId)}
                        onMoveReferenceCell={(sourceRowId, sourceColumnIndex, targetRowId, targetColumnIndex) => moveBatchReferenceCell(contentNode.id, sourceRowId, sourceColumnIndex, targetRowId, targetColumnIndex)}
                        onUploadReference={(rowId, columnIndex, file) => {
                            const row = contentNode.metadata?.batchTable?.rows.find((item) => item.id === rowId);
                            const existingId = row?.inputNodeIds[columnIndex];
                            if (existingId) {
                                void replaceNodeMedia(existingId, file);
                                return;
                            }
                            void createFileNode(file, { x: contentNode.position.x - 180, y: contentNode.position.y + columnIndex * 90 }).then((insertedId) => {
                                if (!insertedId) return;
                                const currentRow = nodesRef.current.find((item) => item.id === contentNode.id)?.metadata?.batchTable?.rows.find((item) => item.id === rowId);
                                const ids = [...(currentRow?.inputNodeIds || [])];
                                while (ids.length <= columnIndex) ids.push("");
                                ids[columnIndex] = insertedId;
                                updateBatchRow(contentNode.id, rowId, { inputNodeIds: ids });
                            });
                        }}
                        onConnectStart={(event, handleId) => handleConnectStart(event, contentNode.id, "target", handleId)}
                        onConnectDrop={(event, handleId) => handleConnectDrop(event, contentNode.id, handleId)}
                    />
                );
            }
            if (contentNode.type === CanvasNodeType.Script) {
                const pipeline = deriveStoryboardPipelineProgress(contentNode, nodesRef.current, connectionsRef.current);
                return (
                    <CanvasScriptNodeContent
                        node={contentNode}
                        nodes={nodesRef.current}
                        batch={visibleGenerationBatch(contentNode)}
                        pipeline={pipeline}
                        scale={viewport.k}
                        mentionReferences={mentionReferencesByNodeId.get(contentNode.id) || EMPTY_RESOURCE_REFERENCES}
                        onOpen={() => setScriptEditorNodeId(contentNode.id)}
                        onCreateImageNodes={() => createScriptImageNodes(contentNode.id)}
                        onCreateVideoNodes={() => createScriptVideoNodes(contentNode.id)}
                        onGenerateImages={(rowIds) => void generateScriptImages(contentNode.id, rowIds)}
                        onGenerateVideos={(rowIds) => (contentNode.metadata?.storyboardVideoInputMode === "keyframe" ? void generateScriptVideos(contentNode.id, rowIds) : void createAndGenerateScriptVideos(contentNode.id, rowIds))}
                        onVideoInputModeChange={(storyboardVideoInputMode) => handleConfigNodeChange(contentNode.id, { storyboardVideoInputMode })}
                        onMergeVideos={() => void mergeVideosByIds(pipeline.successfulVideoNodeIds)}
                        onCreateActionBoards={() => void createScriptActionBoards(contentNode.id)}
                        onRetryBatch={(batchId) => retryFailedBatchItems(contentNode.id, batchId)}
                        onRetryBatchItem={(batchId, itemId) => retryFailedBatchItems(contentNode.id, batchId, itemId)}
                        onStopBatch={(batchId) => stopRemainingBatchItems(contentNode.id, batchId)}
                        onAddRow={() => addScriptRow(contentNode.id)}
                        onRemoveRow={(rowId) => removeScriptRow(contentNode.id, rowId)}
                        onUpdateRow={(rowId, patch) => updateScriptRow(contentNode.id, rowId, patch)}
                        onPromptChange={(composerContent) => handleConfigNodeChange(contentNode.id, { composerContent })}
                        onGenerateScript={(prompt) => void generateScriptRows(contentNode.id, prompt)}
                        onModelChange={(model) => handleConfigNodeChange(contentNode.id, { model })}
                        onShotDurationChange={(duration: StoryboardShotDuration) => handleConfigNodeChange(contentNode.id, { storyboardShotDuration: duration })}
                        onShotCountChange={(count: StoryboardShotCount) => handleConfigNodeChange(contentNode.id, { storyboardShotCount: count })}
                        workspaceMode={workspaceMode}
                        onComposerHeightChange={(height) => {
                            if (contentNode.metadata?.storyboardComposerHeight === height) return;
                            handleConfigNodeChange(contentNode.id, { storyboardComposerHeight: height });
                            const minHeight = storyboardMinNodeHeight(height);
                            if (contentNode.height < minHeight) handleNodeResize(contentNode.id, contentNode.width, minHeight);
                        }}
                        onConnectStart={(event, rowId, handleType) => handleConnectStart(event, contentNode.id, handleType, rowId === "context" ? "storyboard:context" : `row:${rowId}`)}
                        onScrollTopChange={(scrollTop) => setScriptScrollTopById((current) => (current[contentNode.id] === scrollTop ? current : { ...current, [contentNode.id]: scrollTop }))}
                    />
                );
            }
            if (contentNode.type === CanvasNodeType.Director || contentNode.metadata?.directorSceneId) {
                return (
                    <CanvasDirectorNodePanel
                        node={contentNode}
                        scene={currentProject?.directorScenes?.find((scene) => scene.id === contentNode.metadata?.directorSceneId) || null}
                        readNodeContent={(nodeId) => (nodeId ? nodesRef.current.find((item) => item.id === nodeId)?.metadata?.content : undefined)}
                        readNodeStorageKey={(nodeId) => (nodeId ? nodesRef.current.find((item) => item.id === nodeId)?.metadata?.storageKey : undefined)}
                        professional={workspaceMode === "professional"}
                        onOpen={() => openDirectorWorkbench(contentNode.id)}
                    />
                );
            }
            return (
                <CanvasConfigNodePanel
                    node={contentNode}
                    isRunning={isCanvasNodeGenerating(contentNode, runningNodeId)}
                    inputSummary={getInputSummary(configInputsById.get(contentNode.id) || [])}
                    onConfigChange={handleConfigNodeChange}
                    onComposerToggle={() => setDialogNodeId((current) => (current === contentNode.id ? null : contentNode.id))}
                    onGenerate={(nodeId) => {
                        const target = nodesRef.current.find((item) => item.id === nodeId);
                        void handleGenerateNode(nodeId, target?.metadata?.generationMode || "image", target?.metadata?.composerContent ?? target?.metadata?.prompt ?? "");
                    }}
                    workspaceMode={workspaceMode}
                />
            );
        },
        [
            addBatchReferenceColumn,
            workflowInstances,
            nodeDropTargetId,
            handleNodeMouseDown,
            readOnly,
            message,
            addBatchRow,
            addScriptRow,
            configInputsById,
            connections,
            createAndGenerateScriptVideos,
            createScriptActionBoards,
            createScriptImageNodes,
            createScriptVideoNodes,
            currentProject?.directorScenes,
            fillRowsFromConnections,
            focusCanvasImageNode,
            generateBatchRows,
            generateScriptImages,
            generateScriptRows,
            generateScriptVideos,
            handleConfigNodeChange,
            handleConnectDrop,
            handleConnectStart,
            handleGenerateNode,
            handleRemoveNodeReference,
            handleNodeResize,
            handleUploadReferenceRequest,
            mentionReferencesByNodeId,
            mergeVideosByIds,
            openDirectorWorkbench,
            openStoryInput,
            patchBatchTable,
            removeBatchReferenceColumn,
            removeBatchRow,
            removeScriptRow,
            retryFailedBatchItems,
            runningNodeId,
            stopRemainingBatchItems,
            theme,
            updateBatchRow,
            updateScriptRow,
            viewport.k,
            workspaceMode,
        ],
    );

    const retryCanvasNode = useCallback(
        (node: CanvasNodeData) => {
            if (node.metadata?.workflowOperation?.id.endsWith(".ai-upscale")) {
                const processor = nodesRef.current.find(item => item.id === node.metadata?.generatedFromProcessingNodeId);
                if (node.metadata.taskId) void recoverAIUpscale(node).catch(error => message.error(generationErrorMessage(error)));
                else if (processor) void startUpscaleBatch(processor).catch(error => message.error(generationErrorMessage(error)));
                else message.info("请在超分处理节点中查询原批次，暂勿重复提交");
                return;
            }
            const plan = canvasNodeRetryPlan(node, nodesRef.current);
            if (plan.kind === "history") {
                setGenerationHistoryOpen(true);
                return;
            }
            if (plan.kind === "depth") {
                void retryDepthCaptureNode(node);
                return;
            }
            if (plan.kind === "script-empty") {
                message.warning("分镜脚本缺少剧情内容，无法重试");
                return;
            }
            if (plan.kind === "script") {
                void generateScriptRows(node.id, plan.prompt);
                return;
            }
            if (plan.kind === "image-batch-empty") {
                message.info("当前批次没有需要重试的失败图片");
                return;
            }
            if (plan.kind === "image-batch-root") {
                message.info(`正在重试 ${plan.children.length} 个失败图片`);
                retryImageBatchChildren(node.id, plan.children);
                return;
            }
            if (plan.kind === "image-batch-child") {
                void handleRetryNode(node).finally(() => reconcileImageBatchRootNode(plan.rootId));
                return;
            }
            void handleRetryNode(node);
        },
        [generateScriptRows, handleRetryNode, message, nodesRef, reconcileImageBatchRootNode, retryDepthCaptureNode, retryImageBatchChildren, setGenerationHistoryOpen, recoverAIUpscale, startUpscaleBatch],
    );

    // 改动卡片的「在画布上查看」：选中这些节点并把视野带过去，再点亮一下。
    const locateAssistantNodes = useCallback(
        (nodeIds: string[]) => {
            const available = new Set(nodesRef.current.map((node) => node.id));
            const targets = nodeIds.filter((id) => available.has(id));
            if (!targets.length) {
                message.info("这些节点已经不在画布上了");
                return;
            }
            const selection = new Set(targets);
            selectedNodeIdsRef.current = selection;
            setSelectedNodeIds(selection);
            setSelectedConnectionId(null);
            fitCanvasSelection();
            highlightAssistantNodes(containerRef.current, targets);
        },
        [fitCanvasSelection, message, nodesRef, selectedNodeIdsRef, setSelectedConnectionId, setSelectedNodeIds],
    );

    const openCanvasNodeTaskDetails = useCallback(
        (node: CanvasNodeData) => {
            void openNodeTaskDetails(node);
        },
        [openNodeTaskDetails],
    );
    const activeTasksRef = useRef(activeTasks);
    activeTasksRef.current = activeTasks;
    const handleCancelNodeTask = useCallback(
        async (node: CanvasNodeData) => {
            const taskId = node.metadata?.taskId;
            if (!taskId) return;
            const scope = captureUserScope();
            try {
                const task = activeTasksRef.current.find((item) => item.id === taskId) ?? (await queryGenerationTask(taskId));
                assertUserScope(scope);
                cancelCanvasTask(task);
            } catch (error) {
                message.error(error instanceof Error ? error.message : "读取任务失败");
            }
        },
        [cancelCanvasTask, message],
    );
    const handleConnectionSelect = useCallback(
        (connectionId: string) => {
            setSelectedConnectionId(connectionId);
            selectedNodeIdsRef.current = new Set();
            setSelectedNodeIds(new Set());
            setContextMenu(null);
        },
        [selectedNodeIdsRef, setContextMenu, setSelectedConnectionId, setSelectedNodeIds],
    );
    const handleConnectionContextMenu = useCallback(
        (event: ReactMouseEvent<SVGPathElement>, connectionId: string) => {
            setSelectedConnectionId(connectionId);
            selectedNodeIdsRef.current = new Set();
            setSelectedNodeIds(new Set());
            closeConnectionCreateMenu();
            setContextMenu({ type: "connection", x: event.clientX, y: event.clientY, connectionId });
        },
        [closeConnectionCreateMenu, selectedNodeIdsRef, setContextMenu, setSelectedConnectionId, setSelectedNodeIds],
    );
    const handleCancelImageCrop = useCallback(() => setCropNodeId(null), [setCropNodeId]);
    const handleConfirmImageCrop = useCallback((node: CanvasNodeData, crop: Parameters<typeof cropImageNode>[1]) => cropImageNode(node, crop), [cropImageNode]);
    const handleCancelAnnotation = useCallback(() => setAnnotationNodeId(null), [setAnnotationNodeId]);
    const handleConfirmAnnotation = useCallback(
        async (node: CanvasNodeData, dataUrl: string) => {
            await saveAnnotatedImageNode(node, dataUrl);
            setAnnotationNodeId(null);
        },
        [saveAnnotatedImageNode, setAnnotationNodeId],
    );
    const handleCancelMaskEdit = useCallback(() => setMaskEditNodeId(null), [setMaskEditNodeId]);
    const handleConfirmMaskEdit = useCallback((node: CanvasNodeData, payload: Parameters<typeof maskEditImageNode>[1]) => maskEditImageNode(node, payload), [maskEditImageNode]);
    const handleCancelVideoCrop = useCallback(() => setVideoCropNodeId(null), [setVideoCropNodeId]);
    const handleConfirmVideoCrop = useCallback(
        (node: CanvasNodeData, crop: Parameters<typeof cropVideoNode>[1], sourceDimensions: Parameters<typeof cropVideoNode>[2]) => cropVideoNode(node, crop, sourceDimensions),
        [cropVideoNode],
    );
    const openCanvasNodeVersions = useCallback((node: CanvasNodeData) => setVersionCompareRootId(node.metadata?.versionOfNodeId || node.id), []);
    const viewCanvasNodeImage = useCallback((node: CanvasNodeData) => setPreviewNodeId(node.id), []);
    const locateProjectStyleNode = useCallback(() => {
        const styleNode = nodesRef.current.find((node) => node.type === CanvasNodeType.Text && node.metadata?.workflowKind === "styleboard");
        if (!styleNode) {
            message.info("项目画风节点正在同步，请稍后再试");
            return;
        }
        focusCanvasNode(styleNode.id);
    }, [focusCanvasNode, message, nodesRef]);
    const openFrameAnalysisOrCreate = useCallback(() => {
        const selectedVideo = nodesRef.current.find((node) => selectedNodeIds.has(node.id) && node.type === CanvasNodeType.Video);
        if (selectedVideo) {
            setFrameDialogNodeId(selectedVideo.id);
            return;
        }
        message.info("请先选中一个视频节点，再打开逐帧拉片");
    }, [message, nodesRef, selectedNodeIds, setFrameDialogNodeId]);
    const freeformCreateCommands = useCanvasCreateCommands({
        workspaceMode,
        isProjectLinked: Boolean(shortDramaEnabled && currentProject?.projectId),
        handlers: {
            onAddText: () => createNode(CanvasNodeType.Text),
            onAddImage: () => createNode(CanvasNodeType.Image),
            onAddVideo: () => createNode(CanvasNodeType.Video),
            onAddAudio: () => createNode(CanvasNodeType.Audio),
            onAddScript: () => createNode(CanvasNodeType.Script),
            onAddFrame: openFrameAnalysisOrCreate,
            onAddFolder: createFolder,
            onAddDrawing: () => createNode(CanvasNodeType.Drawing),
            onAddWorkflow: () => createNode(CanvasNodeType.Config),
            onAddExtensionNode: (type) => createNode(type),
            onAddDoubaoAccountNode: (mode) => createNode(CanvasNodeType.DoubaoAccount, undefined, undefined, { doubaoAccountNode: { schemaVersion: 1, mode, prompt: "", status: "idle" } }),
            onChooseStyle: () => setStylePickerOpen(true),
            onOpenDirector: () => createDirectorShot(),
            onUpload: () => handleUploadRequest(),
            onOpenMyAssets: () => openCanvasAssetLibrary(),
            onOpenProjectCharacters: () => openProjectAssets("character"),
            onOpenGenerationHistory: () => setGenerationHistoryOpen(true),
        },
    });
    const emptyStateKind = resolveCanvasEmptyStateKind({
        nodeCount: nodes.length,
        shortDramaEnabled,
        isProjectLinked: Boolean(currentProject?.projectId),
        starterMode: currentProject?.starterMode,
    });
    const emptyCanvasState =
        emptyStateKind === "freeform" ? (
            <CanvasFreeformEmptyState commands={freeformCreateCommands} onOpenAssistant={openAssistant} />
        ) : emptyStateKind === "linked" ? (
            <CanvasLinkedProjectEmptyState
                projectName={linkedProjectQuery.data?.project.name || workspaceProject?.title || "项目画布"}
                hasChapter={Boolean(linkedProjectQuery.data?.units.length)}
                onAddFirstChapter={() => {
                    const first = linkedProjectQuery.data?.units.slice().sort((left, right) => left.position - right.position)[0];
                    if (first) void handleProjectChapterInsert({ id: first.id, projectId: linkedProjectId, title: first.title, position: first.position });
                }}
                onOpenAssets={() => openProjectAssets()}
                onAddText={() => createNode(CanvasNodeType.Text)}
            />
        ) : emptyStateKind === "guided" ? (
            <CanvasShortDramaEmptyState
                onCreatePipeline={createShortDramaPipeline}
                onStartFreeform={() => updateProject(projectId, { starterMode: "freeform" })}
                onUpload={() => handleUploadRequest()}
                onAddText={() => createNode(CanvasNodeType.Text)}
                onAddScript={() => createNode(CanvasNodeType.Script)}
            />
        ) : null;
    if (!projectLoaded && loadError)
        return (
            <main className="flex h-full flex-col items-center justify-center gap-4">
                <p role="alert">{loadError}</p>
                <Button onClick={retryLoad}>重新加载</Button>
                <Link to="/canvas">返回画布库</Link>
            </main>
        );
    if (!projectLoaded) return <CanvasRefreshShell />;

    return (
        <>
            {deletingCanvas ? <CanvasDeleteConfirmation scope={deletingCanvas.scope} title="删除画布？"
                description={`将删除「${canvasProjects.find((canvas) => canvas.id === deletingCanvas.id)?.title || "该画布"}」，里面的节点和连线也会一起移除。`}
                onCancel={() => setDeletingCanvas(null)} onConfirm={async (assertCurrent) => {
                    if (deletingCanvas.id === projectId) await deleteCurrentProject();
                    else await deleteWorkspaceCanvasProjects([deletingCanvas.id]);
                    assertCurrent();
                    message.success("画布已删除");
                }} /> : null}
            <a
                href="#canvas-main"
                onClick={(event) => {
                    event.preventDefault();
                    canvasMainRef.current?.focus();
                }}
                className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-[var(--z-toast)] focus:rounded-md focus:border focus:bg-background focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:shadow-lg"
            >
                跳转到画布主内容
            </a>
            <main ref={canvasMainRef} id="canvas-main" data-canvas-readonly={readOnly ? "true" : "false"} data-libtv-readonly-dense={searchParams.get("fixture") === "libtv-readonly-dense" ? "true" : "false"} tabIndex={-1} className="flex h-full min-h-0 overflow-hidden outline-none" style={{ background: resolvedCanvasAppearance.background, color: theme.node.text }}>
                {!focusMode && !versions.preview && shortDramaEnabled && currentProject?.projectId ? (
                    <CanvasProjectSidebar projectId={currentProject.projectId} detail={linkedProjectQuery.data} onAddChapter={handleProjectChapterInsert} onLocateStyle={locateProjectStyleNode} onOpenAssets={() => openProjectAssets()} />
                ) : null}
                <CanvasOverlayLayerProvider>
                    <div className="canvas-editor-shell relative flex min-w-0 flex-1" data-canvas-editor-panel-open={dialogNode || textEditorNodeId ? "true" : "false"} data-canvas-toolbar-node={toolbarNode?.id || undefined}>
                    <section data-canvas-editor inert={Boolean(versions.preview)} style={{ visibility: versions.preview ? "hidden" : undefined, opacity: versions.preview ? 0 : undefined }} className="relative min-w-0 flex-1 flex flex-col min-h-0 overflow-hidden">
                        {!focusMode ? (
                            <CanvasTopBar
                                workspaceView={workspaceView}
                                onWorkspaceViewChange={(view) => {
                                    if (view === "storyboard") {
                                        const script = nodesRef.current.find((node) => node.type === CanvasNodeType.Script);
                                        if (script) {
                                            setWorkspaceView(view);
                                            setScriptEditorNodeId(script.id);
                                            focusCanvasNode(script.id);
                                        } else {
                                            message.info("当前画布还没有脚本节点，请先从添加节点中创建脚本");
                                        }
                                    } else {
                                        setWorkspaceView(view);
                                        setScriptEditorNodeId(null);
                                    }
                                }}
                                syncStatus={<CanvasSyncStatus projectId={projectId} onLoadLatest={reloadLatestCanvasProject} onOpenVersions={openVersions} />}
                                readOnly={readOnly}
                                onDuplicateProject={duplicateCurrentProject}
                                versionsOpen={versions.open}
                                onToggleVersions={toggleVersions}
                                onOpenWorkflows={readOnly ? undefined : () => workflowsRef.current?.toggleLibrary()}
                                workflowsOpen={workflowLibraryOpen}
                                assistantOpen={rightPanel === "assistant"}
                                onToggleAssistant={toggleAssistant}
                                // LibTV 的画布工作区使用“未命名工作区”作为首屏默认标题；
                                // 项目库仍保留“未命名项目”，因此只在画布顶栏做显示层映射。
                                title={workspaceProject?.title === "未命名项目" || !workspaceProject?.title ? "未命名工作区" : workspaceProject.title}
                                titleDraft={titleDraft}
                                isTitleEditing={titleEditing}
                                onTitleDraftChange={setTitleDraft}
                                onStartTitleEditing={startTitleEditing}
                                onFinishTitleEditing={finishTitleEditing}
                                onCancelTitleEditing={() => setTitleEditing(false)}
                                canUndo={historyState.canUndo}
                                canRedo={historyState.canRedo}
                                onCreateCanvas={createAndOpenCanvas}
                                projectCanvases={canvasProjects}
                                currentCanvasId={projectId}
                                onSwitchCanvas={(id) => navigate(`/canvas/${id}`)}
                                onOpenCanvasInNewWindow={openCanvasInNewWindow}
                                onRenameCanvas={renameCanvasFromMenu}
                                onDuplicateCanvas={duplicateCanvasFromMenu}
                                onDeleteCanvas={deleteCanvasFromMenu}
                                onDeleteProject={() => deleteCanvasFromMenu(projectId)}
                                onSave={() => void saveCanvasProject()}
                                onForceSave={confirmForceSaveCanvas}
                                localOnly={localOnly}
                                libtvChrome={searchParams.get("libtvChrome") === "1"}
                                libtvReadonlyChrome={searchParams.get("fixture") === "libtv-readonly-dense"}
                                onImportImage={() => handleUploadRequest()}
                                onImportLibTV={() => setLibTVImportOpen(true)}
                                onImportTapNow={() => setTapNowImportOpen(true)}
                                onUndo={undoCanvas}
                                onRedo={redoCanvas}
                                mediaPerformanceMode={mediaPerformanceMode}
                                onMediaPerformanceModeChange={setMediaPerformanceMode}
                                onOpenSearch={() => setNodeSearchOpen(true)}
                                projectContext={
                                    shortDramaEnabled && currentProject?.projectId
                                        ? {
                                              ...canvasContext,
                                              projectId: currentProject.projectId,
                                              projectName: linkedProjectQuery.data?.project.name || workspaceProject?.title || currentProject.title,
                                          }
                                        : undefined
                                }
                                onEnterFocusMode={enterFocusMode}
                                shortDramaGuide={shortDramaGuide}
                            />
                        ) : null}

                        {!focusMode && shortDramaGuide ? (
                            <CanvasShortDramaGuide progress={shortDramaGuide.progress} collapsed={shortDramaGuide.collapsed} onToggle={shortDramaGuide.onToggle} onSkip={skipShortDramaGuide} onStepClick={activateShortDramaStep} />
                        ) : null}

                        <div className="relative flex min-h-0 min-w-0 flex-1">
                            <div className="relative min-w-0 flex-1 overflow-hidden">
                                <InfiniteCanvas
                                    interactive={!versions.preview && !readOnly}
                                    containerRef={containerRef}
                                    viewport={viewport}
                                    appearance={canvasAppearance}
                                    backgroundMode={backgroundMode}
                                    graphicsLayer={
                                        <CanvasLeaferGraphicsLayer
                                            containerRef={containerRef}
                                            viewport={viewport}
                                            theme={theme}
                                            scriptScrollTopById={scriptScrollTopById}
                                            connectingParams={connectingParams}
                                            batchConnectionPreview={batchConnectionPreview}
                                            mouseWorld={mouseWorld}
                                            connectionTargetNodeId={connectionTargetNodeId}
                                            connectionTargetAnchorRatio={connectionTargetAnchorRatio}
                                            nodeById={nodeById}
                                            selectionBox={selectionBox}
                                            selectedNodeBounds={selectedNodeBounds}
                                            alignmentGuides={alignmentGuides}
                                        />
                                    }
                                    onViewportChange={handleViewportChange}
                                    onViewportPreviewChange={handleViewportPreviewChange}
                                    onCanvasMouseDown={handleCanvasMouseDown}
                                    boxSelectEnabled={canvasTool === "box-select"}
                                    onCanvasDoubleClick={handleCanvasDoubleClick}
                                    onCanvasDeselect={deselectCanvas}
                                    onContextMenu={handleCanvasContextMenu}
                                    onDrop={handleDrop}
                                    onFileDragEnter={handleFileDragEnter}
                                    onFileDragLeave={handleFileDragLeave}
                                    onFileDragOver={handleFileDragOver}
                                >
                                    <CanvasNodeActionContext.Provider value={canvasNodeActions}>
                                        <CanvasNodeGraphContext.Provider value={nodeGraphContext}>
                                            <CanvasProjectWorldLayers
                                                containerRef={containerRef}
                                                connectionApproach={connectionApproach}
                                                projectId={projectId}
                                                viewportScale={viewport.k}
                                                connectionLayerBounds={connectionLayerBounds}
                                                displayConnections={renderedConnections}
                                                selectedConnectionId={selectedConnectionId}
                                                relatedConnectionIds={relatedHighlight.connectionIds}
                                                scriptScrollTopById={scriptScrollTopById}
                                                connectingParams={connectingParams}
                                                mouseWorld={mouseWorld}
                                                connectionTargetNodeId={connectionTargetNodeId}
                                                nodeById={nodeById}
                                                visibleNodes={visibleNodes}
                                                nodeStackOrder={nodeStackOrder}
                                                frameChildrenById={frameChildrenById}
                                                linkedFolderPreviewNodesById={linkedFolderPreviewNodesById}
                                                dragPreview={dragPreview}
                                                selectedNodeIds={selectedNodeIds}
                                                frameDropTargetId={frameDropTargetId}
                                                relatedNodeIds={relatedHighlight.nodeIds}
                                                activeNodeId={activeNodeId}
                                                selectionBox={selectionBox}
                                                batchChildCountById={batchChildCountById}
                                                collapsingBatchIds={collapsingBatchIds}
                                                openingBatchIds={openingBatchIds}
                                                batchMotionById={batchMotionById}
                                                showImageInfo={showImageInfo}
                                                reduceMediaEffects={reduceMediaEffects}
                                                resourceReferenceByNodeId={resourceReferenceByNodeId}
                                                mentionReferencesByNodeId={mentionReferencesByNodeId}
                                                mediaEffectsDisabledNodeId={emotionNodeId}
                                                selectedNodeBounds={selectedNodeBounds}
                                                batchSourceNodeIds={batchSourceNodeIds}
                                                batchConnectionPreview={batchConnectionPreview}
                                                selectionBoundsElementRef={selectionBoundsElementRef}
                                                renderCanvasNodeContent={renderCanvasNodeContent}
                                                onConnectionSelect={handleConnectionSelect}
                                                onConnectionContextMenu={handleConnectionContextMenu}
                                                onNodeMouseDown={handleNodeMouseDown}
                                                onNodeHoverStart={handleCanvasNodeHoverStart}
                                                onNodeHoverEnd={handleCanvasNodeHoverEnd}
                                                onConnectStart={handleConnectStart}
                                                onNodeResize={handleNodeResize}
                                                onToggleFrame={handleFrameToggle}
                                                onFolderStyleChange={handleFolderStyleChange}
                                                onFolderThemeChange={handleFolderThemeChange}
                                                onNodeTitleChange={handleNodeTitleChange}
                                                onNodeContextMenu={handleNodeContextMenu}
                                                onNodeContentChange={handleNodeContentChange}
                                                onToggleBatch={toggleBatchExpanded}
                                                onSetBatchPrimary={setBatchPrimary}
                                                onRetry={retryCanvasNode}
                                                onReloadResource={reloadCanvasNodeResource}
                                                onOpenTaskDetails={openCanvasNodeTaskDetails}
                                                onCancelTask={handleCancelNodeTask}
                                                onOpenVersions={openCanvasNodeVersions}
                                                onViewImage={viewCanvasNodeImage}
                                                onReplaceMedia={replaceCanvasNodeMedia}
                                                onOpenTextEditor={openTextNodeEditor}
                                                onOpenDrawing={openDrawingNode}
                                                onStartBatchConnection={startBatchConnection}
                                                imageCropNodeId={cropNodeId}
                                                onCancelImageCrop={handleCancelImageCrop}
                                                onConfirmImageCrop={handleConfirmImageCrop}
                                                annotationNodeId={annotationNodeId}
                                                onCancelAnnotation={handleCancelAnnotation}
                                                onConfirmAnnotation={handleConfirmAnnotation}
                                                maskEditNodeId={maskEditNodeId}
                                                maskEditConfig={maskEditNode ? { ...effectiveConfig, model: maskEditNode.metadata?.model || effectiveConfig.model, imageModel: maskEditNode.metadata?.model || effectiveConfig.imageModel, size: maskEditNode.metadata?.size || effectiveConfig.size, quality: maskEditNode.metadata?.quality || effectiveConfig.quality, count: String(maskEditNode.metadata?.count || effectiveConfig.count) } : effectiveConfig}
                                                onCancelMaskEdit={handleCancelMaskEdit}
                                                onConfirmMaskEdit={handleConfirmMaskEdit}
                                                videoCropNodeId={videoCropNodeId}
                                                onCancelVideoCrop={handleCancelVideoCrop}
                                                onConfirmVideoCrop={handleConfirmVideoCrop}
                                            />
                                        </CanvasNodeGraphContext.Provider>
                                    </CanvasNodeActionContext.Provider>
                                </InfiniteCanvas>

                                <CanvasActiveTaskPanel tasks={activeTasks} onCancelTask={cancelCanvasTask} topInset={focusMode ? "var(--space-3)" : "var(--canvas-topbar-offset)"} />

                                {focusMode ? (
                                    <CanvasFocusModeBar
                                        syncStatus={<CanvasSyncStatus projectId={projectId} onLoadLatest={reloadLatestCanvasProject} onOpenVersions={openVersions} />}
                                        versionsOpen={versions.open}
                                        onToggleVersions={toggleVersions}
                                        dockRevealed={focusDockRevealed}
                                        zoomPercent={viewport.k}
                                        onToggleDock={() => setFocusDockRevealed((value) => !value)}
                                        onExit={exitFocusMode}
                                        onZoomIn={zoomCanvasIn}
                                        onZoomOut={zoomCanvasOut}
                                        onFit={fitCanvasContent}
                                    />
                                ) : null}

                                <CanvasFileDropOverlay active={fileDropActive} theme={theme} />

                                {!readOnly ? emptyCanvasState : null}

                                {!readOnly && searchParams.get("fixture") !== "libtv-readonly-dense" && (!focusMode || focusDockRevealed) ? (
                                    <CanvasToolbar
                                        selectedCount={selectedNodeIds.size}
                                        libtvChrome={searchParams.get("libtvChrome") === "1"}
                                        workspaceMode={workspaceMode}
                                        canvasTool={canvasTool}
                                        onToolChange={setCanvasTool}
                                        isProjectLinked={Boolean(shortDramaEnabled && currentProject?.projectId)}
                                        canUndo={historyState.canUndo}
                                        canRedo={historyState.canRedo}
                                        appearance={canvasAppearance}
                                        backgroundMode={backgroundMode}
                                        showImageInfo={showImageInfo}
                                        onAddImage={() => createNode(CanvasNodeType.Image)}
                                        onAddVideo={() => createNode(CanvasNodeType.Video)}
                                        onAddAudio={() => createNode(CanvasNodeType.Audio)}
                                        onAddText={() => createNode(CanvasNodeType.Text)}
                                        onChooseStyle={() => setStylePickerOpen(true)}
                                        onAddScript={() => createNode(CanvasNodeType.Script)}
                                        onAddFrame={openFrameAnalysisOrCreate}
                                        onAddFolder={createFolder}
                                        onAddDrawing={() => createNode(CanvasNodeType.Drawing)}
                                        onAddExtensionNode={(type) => createNode(type)}
                                        onAddDoubaoAccountNode={(mode) => createNode(CanvasNodeType.DoubaoAccount, undefined, undefined, { doubaoAccountNode: { schemaVersion: 1, mode, prompt: "", status: "idle" } })}
                                        onAddWorkflow={() => createNode(CanvasNodeType.Config)}
                                        onOpenDirector={() => createDirectorShot()}
                                        onUndo={undoCanvas}
                                        onRedo={redoCanvas}
                                        onUpload={() => handleUploadRequest()}
                                        onDelete={() => deleteNodes(new Set(selectedNodeIds))}
                                        onClear={() => setClearConfirmOpen(true)}
                                        onDeselect={deselectCanvas}
                                        onAppearanceChange={applyCanvasAppearance}
                                        onSaveAppearanceDefault={saveCanvasAppearanceDefault}
                                        onBackgroundModeChange={setBackgroundMode}
                                        snapToGrid={snapToGrid}
                                        onSnapToGridChange={(enabled) => {
                                            setSnapToGrid(enabled);
                                            scopedLocalStorage.setItem("canvas:snap-to-grid", enabled ? "1" : "0");
                                        }}
                                        showConnections={showConnections}
                                        onShowConnectionsChange={(visible) => {
                                            setShowConnections(visible);
                                            scopedLocalStorage.setItem("canvas:show-connections", visible ? "1" : "0");
                                        }}
                                        onShowImageInfoChange={setShowImageInfo}
                                        onOpenMyAssets={() => {
                                            openCanvasAssetLibrary();
                                        }}
                                        onOpenProjectCharacters={() => openProjectAssets("character")}
                                        onOpenGenerationHistory={() => setGenerationHistoryOpen(true)}
                                        shortcutRequestNonce={shortcutRequestNonce}
                                    />
                                ) : null}
                            </div>

                        </div>

                        {angleNode?.metadata?.content ? (
                            <CanvasNodePanelOverlay
                                node={angleNode}
                                viewport={viewport}
                                containerRef={containerRef}
                                panelWidth={640}
                                panelHeight={540}
                                allowOverflow
                                dragOffset={dragPreview?.nodeIds.has(angleNode.id) ? { x: dragPreview.x, y: dragPreview.y } : null}
                                isDragging={isNodeDragging && Boolean(dragPreview?.nodeIds.has(angleNode.id))}
                            >
                                <CanvasNodeAnglePanel
                                    dataUrl={angleNode.metadata.content}
                                    onClose={() => setAngleNodeId(null)}
                                    onConfirm={(params) => {
                                        void generateAngleNode(angleNode, params);
                                    }}
                                />
                            </CanvasNodePanelOverlay>
                        ) : null}

                        {lightingNode?.metadata?.content ? (
                            <AppModal flush open centered title={null} closable={false} footer={null} width={720} onCancel={() => setLightingNodeId(null)}>
                                <CanvasNodeLightingPanel
                                    dataUrl={lightingNode.metadata.content}
                                    onClose={() => setLightingNodeId(null)}
                                    onConfirm={(options, prompt) => {
                                        generateLightingNode(lightingNode, options, prompt);
                                    }}
                                />
                            </AppModal>
                        ) : null}

                        {emotionNode?.metadata?.content && !isCanvasNodeMoving ? (
                            <CanvasEmotionWorkspace
                                node={emotionNode}
                                viewport={viewport}
                                containerRef={containerRef}
                                dragOffset={dragPreview?.nodeIds.has(emotionNode.id) ? { x: dragPreview.x, y: dragPreview.y } : null}
                                isDragging={isNodeDragging && Boolean(dragPreview?.nodeIds.has(emotionNode.id))}
                                onClose={() => setEmotionNodeId(null)}
                                onConfirm={(payload: CanvasImageEmotionPayload) => {
                                    void generateEmotionNode(emotionNode, payload);
                                }}
                            />
                        ) : null}

                        {dialogNode &&
                        !maskEditNodeId &&
                        !isCanvasImageSourceNode(dialogNode) &&
                        !dialogNode.metadata?.fileUpload &&
                        dialogNode.type !== CanvasNodeType.Script &&
                        dialogNode.type !== CanvasNodeType.BatchTable &&
                        dialogNode.type !== CanvasNodeType.Drawing &&
                        dialogNode.type !== CanvasNodeType.Panorama &&
                        !selectionBox &&
                        !isCanvasNodeMoving ? (
                            <CanvasNodePanelOverlay
                                node={dialogNode}
                                viewport={viewport}
                                containerRef={containerRef}
                                panelHeight={dialogNode.type === CanvasNodeType.Text ? 148 : undefined}
                                allowOverflow={dialogNode.type !== CanvasNodeType.Config}
                                // Media composers follow the LibTV layout: keep the prompt
                                // panel attached below the node instead of flipping above it
                                // when the node is near the bottom of the canvas.
                                keepBelowNode={dialogNode.type === CanvasNodeType.Image || dialogNode.type === CanvasNodeType.Video || dialogNode.type === CanvasNodeType.Audio}
                                dragOffset={dragPreview?.nodeIds.has(dialogNode.id) ? { x: dragPreview.x, y: dragPreview.y } : null}
                                isDragging={isNodeDragging && Boolean(dragPreview?.nodeIds.has(dialogNode.id))}
                            >
                                {renderCanvasNodePanel(dialogNode)}
                            </CanvasNodePanelOverlay>
                        ) : null}

                        {pendingConnectionCreate ? (
                            <CanvasConnectionCreateMenu
                                pending={pendingConnectionCreate}
                                viewport={viewport}
                                viewportSize={size}
                                containerRef={containerRef}
                                canCreateDrawing={canCreateDrawingFromConnection}
                                getDisabledReason={(type, provider, doubaoMode) => getConnectionCreateDisabledReason(type, pendingConnectionCreate, provider, doubaoMode)}
                                onCreate={(type, provider, doubaoMode) => void createConnectedNode(type, pendingConnectionCreate, provider, doubaoMode)}
                                onClose={cancelPendingConnectionCreate}
                            />
                        ) : null}

                        {connectionReplaceHover ? (
                            <div
                                className="pointer-events-none fixed z-[var(--z-dialog-popover)] flex select-none items-center gap-1.5 rounded-full border border-white/15 bg-black/60 px-2.5 py-1 text-[11px] font-medium text-white/90 shadow-[0_8px_24px_rgba(0,0,0,0.4)] backdrop-blur-md transition-all"
                                style={{
                                    left: connectionReplaceHover.clientX + 14,
                                    top: connectionReplaceHover.clientY + 14,
                                    transform: "translateY(-50%)",
                                }}
                            >
                                <ArrowLeftRight className="size-3 text-blue-400" />
                                <span>松开替换</span>
                                <span className="rounded bg-white/15 px-1.5 py-0.5 text-[10px] font-semibold text-blue-200">@{connectionReplaceHover.referenceLabel}</span>
                            </div>
                        ) : null}

                        {selectedNodeBounds && !selectionBox && !isCanvasNodeMoving ? (
                            <CanvasProjectSelectionToolbar
                                anchorRef={selectionBoundsElementRef}
                                containerRef={containerRef}
                                count={selectedNodeBounds.count}
                                selectedVideoCount={selectedVideoNodes.length}
                                mergingVideos={Boolean(mergeVideoProgress)}
                                onAlign={alignSelectedNodes}
                                onArrange={arrangeSelectedNodes}
                                onCreateStoryboard={createStoryboardGroup}
                                onCreateReferenceGroup={createReferenceGroup}
                                onBatchConnect={() => beginBatchConnectionMode(Array.from(selectedNodeIds))}
                                onMergeVideos={() => void mergeSelectedVideos()}
                                onAskAssistant={openAssistant}
                                onSaveWorkflow={readOnly ? undefined : () => workflowsRef.current?.saveSelection()}
                            />
                        ) : null}

                        <CanvasNodeToolbar
                            node={isCanvasNodeMoving || nodeImageSettingsOpen || annotationNodeId || maskEditNodeId || emotionNodeId || angleNodeId || (dialogNode && !isCanvasMediaResultNode(dialogNode)) || textEditorNodeId ? null : toolbarNode}
                            workspaceMode={workspaceMode}
                            viewport={viewport}
                            containerRef={containerRef}
                            onKeep={keepNodeToolbar}
                            onLeave={hideNodeToolbar}
                            onInfo={(node) => (node.metadata?.workflowKind === "character" && node.metadata.characterAssetId ? openTextNodeEditor(node) : setInfoNodeId(node.id))}
                            onEditText={openTextNodeEditor}
                            onDecreaseFont={(node) => handleFontSizeChange(node.id, Math.max(10, (node.metadata?.fontSize || 14) - 2))}
                            onIncreaseFont={(node) => handleFontSizeChange(node.id, Math.min(32, (node.metadata?.fontSize || 14) + 2))}
                            onToggleDialog={(node) => setDialogNodeId((current) => (current === node.id ? null : node.id))}
                            onGenerateImage={generateImageFromTextNode}
                            onUpload={(node) => handleUploadRequest(node.id)}
                            onDownload={downloadNodeImage}
                            onSaveAsset={(node) => void saveNodeAsset(node)}
                            onAnnotate={(node) => setAnnotationNodeId(node.id)}
                            onMaskEdit={(node) => {
                                setDialogNodeId(null);
                                setMaskEditNodeId(node.id);
                            }}
                            onEmotion={(node) => {
                                setDialogNodeId(null);
                                setEmotionNodeId((current) => (current === node.id ? null : node.id));
                            }}
                            onPortraitTexture={openPortraitTextureEditor}
                            onCrop={(node) => node.type === CanvasNodeType.Video ? openVideoCrop(node) : setCropNodeId(node.id)}
                            onSplit={(node, params) => void splitImageNode(node, params)}
                            onUpscale={(node) => setUpscaleNodeId(node.id)}
                            onSuperResolve={createUpscaleProcessingNode}
                            onAngle={(node) => {
                                setDialogNodeId(null);
                                setAngleNodeId((current) => (current === node.id ? null : node.id));
                            }}
                            onLighting={(node) => {
                                setDialogNodeId(null);
                                setLightingNodeId((current) => (current === node.id ? null : node.id));
                            }}
                            onPanorama={openPanoramaConfig}
                            onViewImage={(node) => setPreviewNodeId(node.id)}
                            onExtractVideoFrames={extractVideoFrameAt}
                            onExtractAudioFromVideo={(node) => void extractAudioFromVideo(node)}
                            // 视频剪辑使用视频节点下方的内嵌时间轴，不再打开旧的片段重拍弹窗。
                            onTrimVideoSegments={openInlineVideoTrim}
                            onDepthCapture={(node) => void depthCaptureNode(node)}
                            onSubtitles={(node) => setSubtitleNodeId(node.id)}
                            onTimeline={(node) => setTimelineNodeId(node.id)}
                            extractingVideoFrames={toolbarNode?.id === extractingVideoFramesNodeId}
                            extractingAudio={segmentRunningMode === "audio"}
                            trimmingVideo={inlineTrimRunning}
                            onReversePrompt={createImageReversePromptNodes}
                            onRetry={retryCanvasNode}
                            onToggleFreeResize={(node) => toggleNodeFreeResize(node.id)}
                            onToggleLocked={(node) => toggleNodeLocked(node.id)}
                            onDelete={(node) => deleteNodes(new Set([node.id]))}
                        />

{isMiniMapOpen && !focusMode ? <Minimap nodes={nodes} viewport={viewport} viewportSize={size} canvasContainerRef={containerRef} onViewportPreviewChange={previewViewport} onViewportChange={handleViewportChange} /> : null}

                        {!focusMode ? (
                            <CanvasOverlayLayerContainer
                                overlayId="asset-tray"
                                fallbackZIndex="var(--z-panel)"
                                className={`canvas-libtv-overlay-toolbar absolute bottom-[calc(var(--canvas-inset-y)+var(--space-16))] left-[var(--canvas-inset-x)] flex items-end gap-2 lg:bottom-[var(--canvas-inset-y)] ${searchParams.get("fixture") === "libtv-readonly-dense" ? "canvas-libtv-readonly-dock" : ""}`}
                                onMouseDown={(event) => event.stopPropagation()}
                                onPointerDown={(event) => event.stopPropagation()}
                                onWheel={(event) => event.stopPropagation()}
                            >
                                <CanvasAssetTray
                                    libraryAssets={assets.filter((asset): asset is Extract<typeof asset, { kind: "image" | "video" | "audio" | "text" }> => ["image", "video", "audio", "text"].includes(asset.kind))}
                                    canvasImages={canvasImageNodes}
                                    showLibrary={!currentProject?.projectId}
                                    activeNodeId={selectedNodeIds.size === 1 ? Array.from(selectedNodeIds)[0] : null}
                                    onInsertAsset={(asset) => void handleAssetsInsert([localAssetToInsertPayload(asset)], canvasCapturedScope)}
                                    onFocusCanvasImage={focusCanvasImageNode}
                                />
                                <CanvasZoomControls
                                    scale={viewport.k}
                                    libtvChrome={searchParams.get("libtvChrome") === "1"}
                                    containerRef={containerRef}
                                    onScaleChange={setZoomScale}
                                    onFitContent={fitCanvasContent}
                                    onAutoArrange={autoArrangeCanvasNodes}
                                    snapToGrid={snapToGrid}
                                    onSnapToGridChange={(enabled) => {
                                        setSnapToGrid(enabled);
                                        scopedLocalStorage.setItem("canvas:snap-to-grid", enabled ? "1" : "0");
                                    }}
                                    showConnections={showConnections}
                                    onToggleConnections={() => setShowConnections((value) => {
                                        const next = !value;
                                        scopedLocalStorage.setItem("canvas:show-connections", next ? "1" : "0");
                                        return next;
                                    })}
                                    isMiniMapOpen={isMiniMapOpen}
                                    onToggleMiniMap={() => setIsMiniMapOpen((value) => {
                                        const next = !value;
                                        scopedLocalStorage.setItem("canvas:minimap", next ? "1" : "0");
                                        return next;
                                    })}
                                />
                            </CanvasOverlayLayerContainer>
                        ) : null}

                        {inlineTrimNode ? (
                            <CanvasVideoInlineTrimOverlay
                                node={inlineTrimNode}
                                viewport={viewport}
                                containerRef={containerRef}
                                dragOffset={dragPreview?.nodeIds.has(inlineTrimNode.id) ? { x: dragPreview.x, y: dragPreview.y } : null}
                                isDragging={isNodeDragging && Boolean(dragPreview?.nodeIds.has(inlineTrimNode.id))}
                                busy={inlineTrimRunning}
                                onCancel={closeInlineVideoTrim}
                                onConfirm={(range) => void confirmInlineVideoTrim(inlineTrimNode, range)}
                            />
                        ) : null}

                        <CanvasProjectContextMenu
                            menu={contextMenu}
                            node={contextMenuNode}
                            workspaceMode={workspaceMode}
                            isProjectLinked={Boolean(currentProject?.projectId)}
                            canUndo={historyState.canUndo}
                            canRedo={historyState.canRedo}
                            canPaste={hasCopiedNodes || Boolean(navigator.clipboard)}
                            selectedCount={selectedNodeIds.size}
                            screenToCanvas={screenToCanvas}
                            onClose={() => setContextMenu(null)}
                            onAddNode={(type, position) => createNode(type, position)}
                            onAddDoubaoAccountNode={(mode, position) => createNode(CanvasNodeType.DoubaoAccount, position, undefined, { doubaoAccountNode: { schemaVersion: 1, mode, prompt: "", status: "idle" } })}
                            onAddFolder={createFolder}
                            onChooseStyle={() => setStylePickerOpen(true)}
                            onOpenDirector={(position) => createDirectorShot(position)}
                            onUpload={(nodeId, position) => handleUploadRequest(nodeId, position)}
                            onOpenAssets={openCanvasAssetLibrary}
                            onOpenProjectCharacters={(position) => openProjectAssets("character", position)}
                            onOpenGenerationHistory={() => setGenerationHistoryOpen(true)}
                            onUndo={undoCanvas}
                            onRedo={redoCanvas}
                            onPaste={pasteAtPosition}
                            onCopyNode={(nodeId) => copyNodesToClipboard(new Set([nodeId]))}
                            onCreateGenerationCopy={(nodeId) => duplicateNode(nodeId, "copy")}
                            onDuplicate={duplicateNode}
                            onDeleteNode={(nodeId) => deleteNodes(new Set([nodeId]))}
                            onDeleteConnection={deleteConnection}
                            onSaveAsset={(node) => {
                                void saveNodeAsset(node);
                            }}
                            onViewMedia={(node) => setPreviewNodeId(node.id)}
                            onEditText={openTextNodeEditor}
                            onOpenDrawing={openDrawingNode}
                            onGenerateImage={generateImageFromTextNode}
                            onCopyContent={(node) => {
                                void copyNodeContentToClipboard(node);
                            }}
                            onCopyMediaUrl={(node) => {
                                void copyNodeMediaUrlToClipboard(node);
                            }}
                            onUploadToArkPrivateAsset={confirmUploadNodeImageToArkPrivateAsset}
                            onSetAssetCategory={(nodeId, assetCategory) => handleConfigNodeChange(nodeId, { assetCategory })}
                            onToggleFrame={(node) => handleFrameToggle(node.id)}
                            onSpreadSelection={spreadSelectedNodes}
                            onCopySelection={copySelectedNodes}
                            onDeleteSelection={() => deleteNodes(selectedNodeIds)}
                        />

                        <CanvasUploadModal open={uploadModalOpen} onClose={closeUploadModal} onUpload={handleUploadFiles} onImportUrl={handleImportUrl} />
                        <input ref={imageInputRef} type="file" accept="image/*,video/*,.mp4,.mov,.m4v,audio/mpeg,audio/wav,audio/x-wav,.mp3,.wav,.txt,.md,.markdown" multiple className="hidden" onChange={handleImageInputChange} />

                        <CanvasProjectEditorDialogs
                            projectId={projectId}
                            theme={theme}
                            config={effectiveConfig}
                            nodes={nodes}
                            viewport={viewport}
                            viewportSize={size}
                            search={{
                                open: nodeSearchOpen,
                                onClose: () => setNodeSearchOpen(false),
                                onFocus: (nodeId) => {
                                    const target = nodeById.get(nodeId);
                                    const parent = target?.parentId ? nodeById.get(target.parentId) : null;
                                    if (parent?.metadata?.frame?.collapsed) toggleFrameCollapsed(parent.id);
                                    const batchRoot = target?.metadata?.batchRootId ? nodeById.get(target.metadata.batchRootId) : null;
                                    if (batchRoot && !batchRoot.metadata?.imageBatchExpanded) toggleBatchExpanded(batchRoot.id);
                                    const selection = new Set([nodeId]);
                                    selectedNodeIdsRef.current = selection;
                                    setSelectedNodeIds(selection);
                                    setSelectedConnectionId(null);
                                    focusCanvasNode(nodeId);
                                },
                            }}
                            generationHistory={{
                                open: generationHistoryOpen,
                                onClose: () => setGenerationHistoryOpen(false),
                                onSelect: (task) => void insertGenerationHistoryTask(task),
                            }}
                            imports={{
                                libTVOpen: libTVImportOpen,
                                tapNowOpen: tapNowImportOpen,
                                onCloseLibTV: () => setLibTVImportOpen(false),
                                onCloseTapNow: () => setTapNowImportOpen(false),
                                onApplyLibTV: applyLibTVImport,
                                onApplyTapNow: applyTapNowImport,
                            }}
                            style={{
                                open: stylePickerOpen,
                                value: activeStylePresetId,
                                applying: styleApplying,
                                onClose: () => setStylePickerOpen(false),
                                onSelect: selectCanvasStyle,
                            }}
                            info={{
                                node: infoNode,
                                onClose: () => setInfoNodeId(null),
                                onMetadataChange: handleConfigNodeChange,
                            }}
                            subtitle={{
                                node: subtitleNode,
                                onClose: () => setSubtitleNodeId(null),
                                onSave: (nodeId, patch) => {
                                    handleConfigNodeChange(nodeId, patch);
                                    const currentTimeline = currentProject?.timeline;
                                    if (currentTimeline) {
                                        const next = syncNodeSubtitlesToTimeline(currentTimeline, nodeId, patch.subtitleEntries || []);
                                        if (next !== currentTimeline) updateProject(projectId, { timeline: next });
                                    }
                                },
                            }}
                            frame={{
                                node: frameNode,
                                onClose: closeFrameDialog,
                                onConfirm: (params) => {
                                    if (frameNode) void extractVideoFrames(frameNode, params);
                                },
                            }}
                            timeline={{
                                node: timelineNode,
                                timeline: currentProject?.timeline || null,
                                onClose: () => setTimelineNodeId(null),
                                onOpenSubtitleDialog: (subNodeId) => {
                                    setTimelineNodeId(null);
                                    setSubtitleNodeId(subNodeId);
                                },
                                onSave: (next) => persistCanvasTimeline(projectId, next),
                                onSaveSubtitles: (subNodeId, entries) =>
                                    handleConfigNodeChange(subNodeId, {
                                        subtitleEntries: entries,
                                        ...(entries.length ? {} : { subtitleHighlights: [] }),
                                        subtitleUpdatedAt: new Date().toISOString(),
                                    }),
                                onOpenAssetLibrary: openTimelineAssetLibrary,
                                onOpenProjectAssets: () => openProjectAssets("all", undefined, "timeline"),
                                onUploadLocalFiles: uploadTimelineMedia,
                                addNodeToTimelineRef: timelineAddNodeRef,
                                addMediaToTimelineRef: timelineMediaAddRef,
                                onCreateAssembledNode: createVideoNodeFromBlob,
                            }}
                            character={{
                                node: characterReferenceNode,
                                onClose: () => setCharacterReferenceNodeId(null),
                            }}
                            text={{
                                node: textEditorNode,
                                onClose: () => setTextEditorNodeId(null),
                                onSave: (nodeId, title, content, richText) => {
                                    setNodes((current) => current.map((node) => (node.id === nodeId ? { ...node, title, metadata: { ...node.metadata, content, richText } } : node)));
                                },
                            }}
                            drawing={{
                                node: drawingNode,
                                onClose: () => setDrawingNodeId(null),
                                onSaved: (nodeId, summary) => {
                                    setNodes((current) =>
                                        current.map((node) =>
                                            node.id === nodeId
                                                ? {
                                                      ...node,
                                                      metadata: {
                                                          ...node.metadata,
                                                          drawingEngine: summary.engine,
                                                          drawingRevision: summary.revision,
                                                          drawingUpdatedAt: summary.updatedAt,
                                                          drawingShapeCount: summary.shapeCount,
                                                          drawingPageCount: summary.pageCount,
                                                      },
                                                  }
                                                : node,
                                        ),
                                    );
                                    message.success("绘图已保存");
                                },
                            }}
                            artCritique={{
                                node: artCritiqueNode,
                                upstreamNodes: artCritiqueInputs,
                                startRequestId: artCritiqueStartRequest && artCritiqueStartRequest.nodeId === artCritiqueNode?.id ? artCritiqueStartRequest.id : undefined,
                                restartRequested: Boolean(artCritiqueStartRequest?.nodeId === artCritiqueNode?.id && artCritiqueStartRequest?.restart),
                                onRunningChange: (running) => {
                                    artCritiqueRunningRef.current = running;
                                },
                                onClose: () => setArtCritiqueNodeId(null),
                                onUpdateState: (nodeId, state) => handleConfigNodeChange(nodeId, { artCritique: state }),
                            }}
                            panorama={{
                                nodeId: panoramaConfigNodeId,
                                onCancel: () => setPanoramaConfigNodeId(null),
                                onConfirm: (composedPrompt, config) => {
                                    const node = nodes.find((item) => item.id === panoramaConfigNodeId);
                                    if (node) {
                                        createPanoramaViewerWithConfig(node, composedPrompt, config);
                                    }
                                },
                                onCopyPrompt: (prompt) => {
                                    void navigator.clipboard?.writeText(prompt).then(() => message.success("已复制全景提示词"));
                                },
                            }}
                            script={{
                                node: activeScriptNode,
                                onClose: () => setScriptEditorNodeId(null),
                                onUpdateRows: (rows) => {
                                    if (activeScriptNode) replaceScriptRows(activeScriptNode.id, rows);
                                },
                                onVisibleColumnsChange: (visibleColumns) => {
                                    if (!activeScriptNode || !visibleColumns.length) return;
                                    setNodes((prev) =>
                                        prev.map((node) =>
                                            node.id === activeScriptNode.id
                                                ? { ...node, metadata: { ...node.metadata, storyboardVisibleColumnsCustomized: true, storyboard: { rows: node.metadata?.storyboard?.rows || [], visibleColumns, referenceNodeIds: node.metadata?.storyboard?.referenceNodeIds || [] } } }
                                                : node,
                                        ),
                                    );
                                },
                                onGenerateImages: (rowIds) => {
                                    if (activeScriptNode) void generateScriptImages(activeScriptNode.id, rowIds);
                                },
                                onGenerateVideos: (rowIds) => {
                                    if (!activeScriptNode) return;
                                    if (activeScriptNode.metadata?.storyboardVideoInputMode === "keyframe") void generateScriptVideos(activeScriptNode.id, rowIds);
                                    else void createAndGenerateScriptVideos(activeScriptNode.id, rowIds);
                                },
                                onVideoInputModeChange: (storyboardVideoInputMode) => {
                                    if (activeScriptNode) handleConfigNodeChange(activeScriptNode.id, { storyboardVideoInputMode });
                                },
                            }}
                            director={{
                                nodeId: directorNodeId,
                                scene: activeDirectorScene,
                                imageNodes: nodes.filter((node) => node.type === CanvasNodeType.Image && Boolean(node.metadata?.content)),
                                onboardingScope: directorOnboardingScope,
                                onClose: () => setDirectorNodeId(null),
                                onChange: saveDirectorScene,
                                onApply: applyDirectorOutput,
                                onShouldCaptureCover: shouldCaptureCover,
                                onCaptureCover: captureDirectorCover,
                                onDeleteImageNode: (nodeId) => deleteNodes(new Set([nodeId])),
                                onAddCanvasImage: addDirectorReferenceToCanvas,
                                onFlush: () => flushCanvasStorePersistence(),
                            }}
                            versionCompare={{
                                open: Boolean(versionCompareRootId),
                                versions: versionCompareNodes,
                                onClose: () => setVersionCompareRootId(null),
                                onSetPrimary: setPrimaryVersion,
                                onFocus: (nodeId) => {
                                    setVersionCompareRootId(null);
                                    focusCanvasNode(nodeId);
                                },
                            }}
                            media={{
                                upscaleNode,
                                onCloseUpscale: () => setUpscaleNodeId(null),
                                onUpscale: (node, params) => void upscaleImageNode(node, params),
                            }}
                            status={{
                                task: taskDetail,
                                taskLogs: taskDetailLogs,
                                taskLoading: taskDetailLoading,
                                taskError: taskDetailError,
                                onCloseTask: () => setTaskDetail(null),
                                onCancelTask: cancelCanvasTask,
                                onRetrieveTask: (task) => void retrieveTaskResult(task),
                                retrievingTaskId,
                                previewNode,
                                onClosePreview: () => setPreviewNodeId(null),
                                clearConfirmOpen,
                                onCancelClear: () => setClearConfirmOpen(false),
                                onConfirmClear: clearCanvas,
                            }}
                            assets={{
                                pickerOpen: assetPickerOpen,
                                multiple: assetInsertScope === "canvas",
                                onInsertLibrary: handleLibraryAssetsInsert,
                                onClosePicker: closeAssetPicker,
                                projectOpen: projectAssetOpen,
                                detail: linkedProjectQuery.data,
                                initialCategory: projectAssetInitialCategory,
                                initialFolderId: projectAssetInitialFolderId,
                                onCloseProject: closeProjectAssets,
                                onInsertProject: handleTimelineProjectAssetsInsert,
                                onInsertFolder: projectAssetScope === "canvas" ? handleProjectFolderInsert : undefined,
                            }}
                        />
                    </section>
                    {versions.preview ? <CanvasVersionPreview key={versions.preview.key} preview={versions.preview} busy={versions.restoring || versions.confirming} onReturn={versions.returnToCurrent} onShowVersions={versions.show} /> : null}
                    </div>
                </CanvasOverlayLayerProvider>
                {rightPanel === "assistant" && !focusMode && !versions.preview ? (
                    <CanvasAssistantSidebar
                        proposalFeedback={assistantProposalFeedback}
                        runningProposalIds={runningProposalIds}
                        assistant={assistant}
                        continuation={assistantContinuation}
                        nodes={nodes}
                        canvasTitle={workspaceProject?.title === "未命名项目" || !workspaceProject?.title ? "未命名工作区" : workspaceProject.title}
                        dockable={assistantDockable}
                        readOnly={readOnly}
                        selectedNodeIds={assistantSelectedNodeIds}
                        references={assistantMentionReferences}
                        onLocateNodes={locateAssistantNodes}
                        onRunProposal={runAssistantProposal}
                        onOpenModelSettings={() => navigate("/settings?section=channels")}
                    />
                ) : null}
                <CanvasVersionHistory history={versions} />
                <CanvasWorkflowWorkspace
                    key={`${canvasStorageScope}:${projectId}`}
                    ref={workflowsRef}
                    nodes={nodes}
                    connections={connections}
                    selection={selectedNodeIds}
                    readOnly={readOnly}
                    dockable={assistantDockable}
                    visible={!focusMode && !versions.preview}
                    onOpenChange={open => { setWorkflowLibraryOpen(open); if (open) { assistant.setOpen(false); versions.close(); } }}
                    onInstantiate={workflowInstances.add}
                />
            </main>
        </>
    );
}
