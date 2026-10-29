import type { CanvasColorGrade } from "@/lib/canvas/canvas-color-grade";
import type { WorkflowDefinition, WorkflowMediaType, WorkflowNodeRole, WorkflowRun, WorkflowValue } from "@/services/api/canvas-workflows";
import type { MediaConversionNodeState } from "@/lib/media-conversion/contracts";
import type { CanvasUpscaleSettings, CanvasUpscaleBatch } from "@/lib/canvas/canvas-upscale";
import type { AssetCategory } from "@/lib/asset-category";
import type { PortraitTextureSettings } from "@/lib/canvas/canvas-portrait-texture";
import type { StyleExecutionPlan } from "@/lib/canvas/style-profile";
import type { ArtCritiqueNodeState } from "@/lib/art-critique/contracts";
import type { CameraControlOptions } from "@/lib/canvas/camera-prompt-library";
import type { SrtEntry, SubtitleHighlight, SubtitleStyle } from "@/types/timeline";

export type Position = {
    x: number;
    y: number;
};

export type ViewportTransform = {
    x: number;
    y: number;
    k: number;
};

export enum CanvasNodeType {
    Image = "image",
    Text = "text",
    Drawing = "drawing",
    Script = "script",
    Skill = "skill",
    Config = "config",
    Video = "video",
    Audio = "audio",
    Frame = "frame",
    Workflow = "reusable-workflow",
    WorkflowControl = "workflow-control",
    Markdown = "markdown",
    Svg = "svg",
    Html = "html",
    Panorama = "panorama",
    Compare = "compare",
    Chart = "chart",
    ColorGrade = "colorgrade",
    MediaConversion = "media-conversion",
    Upscale = "upscale",
    BatchTable = "batch-table",
    Director = "director",
    DoubaoAccount = "doubao-account",
}

/** Runtime IDs contributed by plugins share the persisted node type field. */
export type PluginCanvasNodeType = string & { readonly __pluginCanvasNodeType?: unique symbol };
export type CanvasNodeTypeId = CanvasNodeType | PluginCanvasNodeType;

export function isBuiltinCanvasNodeType(type: CanvasNodeTypeId): type is CanvasNodeType {
    return Object.values(CanvasNodeType).includes(type as CanvasNodeType);
}

export type CanvasNodeStatus = "idle" | "success" | "loading" | "error";
export type CanvasMediaNodeRole = "generator" | "result";
export type CanvasMediaResultOrigin = "upload" | "library" | "generated" | "derived" | "imported" | "unknown";
export type CanvasMediaPerformanceMode = "auto" | "quality" | "performance";
export type CanvasWorkspaceMode = "simple" | "professional";
export type CanvasToolMode = "move" | "box-select";
export type CanvasFolderStyle = "glass" | "stacked" | "midnight" | "paper" | "cinema" | "compact";
export type CanvasFolderTheme = "aurora" | "obsidian" | "ember" | "pearl";
export type StoryboardShotDuration = "auto" | "5" | "10" | "15" | "30";
export type StoryboardShotCount = "auto" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "10";
export type StoryboardVideoInputMode = "direct" | "keyframe";
export type CanvasGenerationMode = "text" | "image" | "video" | "audio";
export type CanvasGenerationBatchMode = "storyboard_image" | "storyboard_video" | "action_board" | "batch_image";
export type CanvasGenerationBatchStatus = "queued" | "running" | "partial_failed" | "completed" | "cancelled";
export type CanvasGenerationBatchItemStatus = "waiting" | "submitting" | "queued" | "running" | "succeeded" | "failed" | "cancelled";
export type CanvasImageGenerationType = "generation" | "edit";
export type CanvasWorkflowKind = "free" | "script" | "story_input" | "character" | "scene" | "storyboard" | "shot" | "final" | "styleboard" | "reference_set" | "reference_video" | "action_board" | "video_retake";
export type CanvasVideoEditOperation = "text_to_video" | "image_to_video" | "reference_to_video" | "extend" | "inpaint" | "replace_element" | "camera_motion" | "style_transfer" | "audio_to_video" | "compare_versions" | "concat";
export type CanvasSkillCategory = "writing" | "storyboard" | "image" | "video" | "utility";
export type CanvasSkillOutputMode = "text" | "json" | "image_prompt" | "workflow";
export type StoryboardColumn =
    | "shotNumber"
    | "durationSeconds"
    | "plotDescription"
    | "dialogue"
    | "narrativeIntent"
    | "viewerPOV"
    | "performanceBlocking"
    | "shotSize"
    | "emotion"
    | "lightingAndAtmosphere"
    | "audioEffects"
    | "camera"
    | "motion"
    | "timeBeats"
    | "imageGenerationPrompt"
    | "videoMotionPrompt"
    | "assets"
    | "continuityOut"
    | "negativePrompt";

export type StoryboardAssetRole = "character" | "environment" | "wardrobe" | "prop" | "weapon" | "style" | "motion" | "audio";

export type StoryboardAssetBinding = {
    nodeId: string;
    role: StoryboardAssetRole;
    priority: number;
};

export type StoryboardCharacterReference = {
    characterName: string;
    characterAssetId?: string;
    characterVersionId?: string;
    characterDescription?: string;
    characterImageNodeId?: string;
};

export type StoryboardRow = {
    id: string;
    shotNumber: number;
    durationSeconds: number;
    plotDescription: string;
    dialogue: string;
    characters: StoryboardCharacterReference[];
    narrativeIntent: string;
    viewerPOV: string;
    performanceBlocking: string;
    shotSize: string;
    emotion: string;
    lightingAndAtmosphere: string;
    audioEffects: string;
    camera: string;
    motion: string;
    timeBeats: string;
    imageGenerationPrompt: string;
    videoMotionPrompt: string;
    imagePromptTemplateVariables?: Record<string, string>;
    videoPromptTemplateVariables?: Record<string, string>;
    mustHave: string[];
    optionalDetails: string[];
    continuityOut: string;
    negativePrompt: string;
    assetBindings: StoryboardAssetBinding[];
    imageNodeId?: string;
    videoNodeId?: string;
    status?: CanvasNodeStatus;
    errorDetails?: string;
};

export type StoryboardData = {
    rows: StoryboardRow[];
    visibleColumns: StoryboardColumn[];
    referenceNodeIds: string[];
};

export type CanvasGenerationBatchItem = {
    id: string;
    rowId: string;
    nodeId: string;
    taskId?: string;
    status: CanvasGenerationBatchItemStatus;
    retryCount: number;
    errorDetails?: string;
    submissionUncertain?: boolean;
};

export type CanvasGenerationBatch = {
    id: string;
    projectId: string;
    sourceNodeId: string;
    mode: CanvasGenerationBatchMode;
    status: CanvasGenerationBatchStatus;
    items: CanvasGenerationBatchItem[];
    concurrency?: number;
    createdAt: string;
    updatedAt: string;
};

export type CanvasBatchOperation = "try_on" | "creative";
export type CanvasBatchRow = { id: string; enabled: boolean; inputNodeIds: string[]; prompt: string; outputNodeId?: string };
export type CanvasBatchReferenceColumn = { id: string; label: string };
export type CanvasBatchTableData = { operation: CanvasBatchOperation; concurrency: number; globalPrompt?: string; referenceColumns?: CanvasBatchReferenceColumn[]; rows: CanvasBatchRow[] };

export type CanvasSkillSnapshot = {
    id: string;
    name: string;
    description: string;
    category: CanvasSkillCategory;
    template: string;
    outputMode: CanvasSkillOutputMode;
    outputContract: string;
    version: number;
    tags: string[];
};

export type CanvasNodeMetadata = {
    /** 豆包 3.0：画布豆包账号节点的自执行状态（账号绑定、任务模式、运行结果）。 */
    doubaoAccountNode?: DoubaoAccountNodeState;
    /** Deterministic canvas processing recipe, without runtime state or credentials. */
    workflowOperation?: { id: string; version: number; config: Record<string, string | number | boolean>; inputs: Array<{ nodeId: string; port: string; order?: number }> };
    reusableWorkflow?: {
        layoutVersion?: number;
        templateId: string;
        templateRevision?: number;
        definition: WorkflowDefinition;
        run?: WorkflowRun;
        intent?: { clientOperationId: string; inputs: Record<string, WorkflowValue> };
        error?: string;
        inputsChanged?: boolean;
        runApplied?: boolean;
    };
    workflowSlot?: { instanceId: string; nodeId: string; role: WorkflowNodeRole; mediaType: WorkflowMediaType; status?: string; error?: string };
    /** Media interaction role. `generator` owns generation controls; `result` is an inspect/process object. */
    nodeRole?: CanvasMediaNodeRole;
    /** How a media result entered the canvas. Only meaningful when nodeRole is `result`. */
    resultOrigin?: CanvasMediaResultOrigin;
    /** Generator or processing node that produced this result. */
    generatedFromNodeId?: string;
    /** Namespaced extension ownership for nodes contributed by a unified plugin. */
    pluginId?: string;
    pluginNodeId?: string;
    pluginData?: Record<string, unknown>;
    importSource?:
        | {
              provider: "libtv";
              projectUuid: string;
              nodeKey: string;
              batchId: string;
              sourceType?: string;
              styleAssetUuid?: string;
              styleVersionUuid?: string;
              styleName?: string;
          }
        | {
              provider: "tapnow";
              shareId: string;
              nodeId: string;
              batchId: string;
              sourceType?: string;
          };
    content?: string;
    previewContent?: string;
    videoPreview?: {
        content: string;
        storageKey?: string;
        width?: number;
        height?: number;
        bytes?: number;
        mimeType?: string;
        /** Poster capture contract version. Missing versions are regenerated lazily. */
        captureVersion?: number;
        /** Media identity used to prevent a poster surviving a source replacement. */
        sourceKey?: string;
        capturedAtMs?: number;
    };
    richText?: Record<string, unknown>;
    composerContent?: string;
    prompt?: string;
    promptTemplateOperation?: string;
    promptTemplateVariables?: Record<string, string>;
    status?: CanvasNodeStatus;
    /** Local media operations use this while a derived node is being prepared. */
    processingLabel?: string;
    /** 浏览器文件上传，与模型生成任务状态独立。 */
    fileUpload?: "uploading" | "error";
    fileUploadProgress?: number;
    locked?: boolean;
    errorDetails?: string;
    generationErrorCode?: string;
    outputParameterWarning?: string;
    resourceReloadAvailable?: boolean;
    failedPromptFingerprint?: string;
    failedInputFingerprint?: string;
    lastGenerationRequestFingerprint?: string;
    fontSize?: number;
    generationMode?: CanvasGenerationMode;
    generationType?: CanvasImageGenerationType;
    model?: string;
    workflowProvider?: "model" | "runninghub";
    runningHubWorkflowId?: string;
    runningHubWorkflowKind?: "workflow" | "app";
    /** 当前画布节点覆盖的工作流动态字段，键为 source:* 或 field:nodeId:fieldName。 */
    workflowParameters?: Record<string, unknown>;
    size?: string;
    quality?: string;
    transparentBackground?: string;
    imageLayer?: Record<string, unknown>;
    seedreamMode?: string;
    seedreamMaxImages?: string;
    seedreamOutputFormat?: string;
    seedreamOptimize?: string;
    seedreamWatermark?: string;
    count?: number;
    textCount?: number;
    seconds?: string;
    vquality?: string;
    generateAudio?: string;
    watermark?: string;
    audioVoice?: string;
    audioFormat?: string;
    audioSpeed?: string;
    /** 原版 LibTV 音频节点的音高/音量控制；以字符串保存以兼容工作流字段。 */
    audioPitch?: string;
    audioVolume?: string;
    audioInstructions?: string;
    references?: string[];
    naturalWidth?: number;
    naturalHeight?: number;
    freeResize?: boolean;
    isBatchRoot?: boolean;
    batchRootId?: string;
    batchChildIds?: string[];
    /** Original output targets for this generation; independent of the editable batch layout. */
    generationOutputNodeIds?: string[];
    batchFailedCount?: number;
    batchUsesReferenceImages?: boolean;
    primaryImageId?: string;
    imageBatchExpanded?: boolean;
    storageKey?: string;
    mimeType?: string;
    bytes?: number;
    durationMs?: number;
    /** Whether the video file contains an audio track when this is known. */
    hasAudio?: boolean;
    assetId?: string;
    assetTags?: string[];
    assetCategory?: AssetCategory;
    workflowKind?: CanvasWorkflowKind;
    workflowTitle?: string;
    workflowDescription?: string;
    /** 本地视觉回归夹具标记，不参与生成或远程同步语义。 */
    fixture?: string;
    stylePresetId?: string;
    styleProfileJson?: string;
    styleExecutionPlan?: StyleExecutionPlan;
    skillIds?: string[];
    skillVersions?: Array<{ skillId: string; versionId: string; version: string }>;
    skillFiles?: Array<{ skillId: string; path: string; sha256?: string }>;
    chapterId?: string;
    chapterTitle?: string;
    shotIndex?: number;
    sceneId?: string;
    characterIds?: string[];
    referenceSetId?: string;
    referenceAssetNodeIds?: string[];
    assetBindings?: StoryboardAssetBinding[];
    characterName?: string;
    characterPrompt?: string;
    characterAliases?: string[];
    characterDefinition?: Record<string, unknown>;
    characterAssetId?: string;
    characterVersionId?: string;
    characterVersionPolicy?: "current" | "pinned";
    characterVisualStatus?: string;
    characterVoiceStatus?: string;
    characterVoiceName?: string;
    characterVoiceProfile?: {
        name: string;
        provider: string;
        language: string;
        timbre: string;
    };
    characterVoiceInstructions?: string;
    characterCoverUrl?: string;
    characterView?: "front" | "side" | "back" | "multi";
    characterViewNodeIds?: {
        front?: string;
        side?: string;
        back?: string;
    };
    actionBoardRows?: number;
    actionBoardColumns?: number;
    taskId?: string;
    taskType?: string;
    taskClientOperationId?: string;
    taskOutputIndex?: number;
    generationSubmissionState?: "submitting" | "unknown" | "accepted" | "rejected";
    taskClientOperationInput?: string;
    taskClientOperationTerminal?: boolean;
    retryOf?: string;
    attemptGroupId?: string;
    taskStatus?: "queued" | "running" | "succeeded" | "failed" | "cancelled" | string;
    taskProgress?: number;
    taskStage?: string;
    taskProvider?: string;
    taskStartedAt?: string;
    taskCompletedAt?: string;
    taskDurationMs?: number;
    taskErrorCode?: string;
    generationErrorSummary?: string;
    taskFailureDiagnostics?: import("@/lib/generation-error").GenerationFailureDiagnostics;
    taskProviderRequestId?: string;
    taskOfficialStatus?: "pending" | "processing" | "completed" | "failed" | "cancelled";
    taskReceiptRecorded?: boolean;
    taskCreatedAt?: string;
    taskUpdatedAt?: string;
    generationEffectKeys?: string[];
    agentGenerationContinuation?: {
        id: string;
        taskId: string;
        conversationId?: string;
        messageId?: string;
        source?: "online" | "local";
        status: "pending" | "completed" | "failed";
        effectKey?: string;
    };
    sessionId?: string;
    videoEditOperation?: CanvasVideoEditOperation;
    videoMergeSourceNodeIds?: string[];
    depthSourceNodeId?: string;
    arkPrivateAssetUpload?: string;
    videoCameraMoveId?: string;
    videoCameraMovePrompt?: string;
    videoStartFrameNodeId?: string;
    videoEndFrameNodeId?: string;
    videoMiddleFrameNodeId?: string;
    videoMiddleFrameTime?: number;
    videoH3Options?: import("@/lib/h3-video").H3VideoOptions;
    /** 选了豆包账号视频模型时，豆包页面里的视频模型（Seedance 2.5 / 2.0 / 2.0 Fast / 2.0 Mini）。 */
    doubaoVideoModel?: string;
    /** 选了豆包账号图片模型时，豆包页面里的图片模型（Seedream 4.5 / 4.0 / 3.0）。 */
    doubaoImageModel?: string;
    videoReferenceOrder?: string[];
    videoFrameSourceNodeId?: string;
    videoFrameTimeMs?: number;
    /** Traceability for media operations created from an existing video node. */
    videoSegmentSourceNodeId?: string;
    videoSegmentStartMs?: number;
    videoSegmentEndMs?: number;
    videoSegmentIndex?: number;
    videoSegmentAction?: "extract" | "create-generation-nodes";
    videoTrimStartMs?: number;
    videoTrimEndMs?: number;
    videoTrimSourceNodeId?: string;
    videoTrimSource?: {
        content?: string;
        storageKey?: string;
        durationMs?: number;
        naturalWidth?: number;
        naturalHeight?: number;
        bytes?: number;
        mimeType?: string;
        hasAudio?: boolean;
    };
    videoCrop?: { x: number; y: number; width: number; height: number };
    videoCropSourceNodeId?: string;
    videoRetakeSourceNodeId?: string;
    videoRetakeCount?: number;
    videoRetakeMax?: number;
    videoRetakeSegments?: Array<{ startMs: number; endMs: number }>;
    videoRetakeReferenceMode?: "reference" | "mark" | "character";
    videoRetakeWebSearch?: boolean;
    videoRetakeAutoValidate?: boolean;
    videoRetakeAutoLink?: boolean;
    audioExtractSourceNodeId?: string;
    audioExtractStartMs?: number;
    audioExtractEndMs?: number;
    videoAudioSourceNodeId?: string;
    videoHasAudio?: boolean;
    mediaOperationError?: string;
    versionOfNodeId?: string;
    versionLabel?: string;
    versionPrimary?: boolean;
    copiedFromNodeId?: string;
    generationResultPlacement?: "replace-node" | "new-version";
    directorSceneId?: string;
    directorShotId?: string;
    directorPreviewNodeId?: string;
    directorCoverStorageKey?: string;
    directorCoverUrl?: string;
    directorCoverSceneUpdatedAt?: string;
    directorDepthNodeId?: string;
    directorNormalNodeId?: string;
    directorClayVideoNodeId?: string;
    subtitleEntries?: SrtEntry[];
    subtitleHighlights?: SubtitleHighlight[];
    subtitleStyle?: SubtitleStyle;
    subtitleUpdatedAt?: string;
    skillId?: string;
    skillVersion?: number;
    skillSnapshot?: CanvasSkillSnapshot;
    /** 图表节点的图形类型，缺省柱状图。落盘字段——新增扩展节点的自有字段都要在这里声明。 */
    chartKind?: "bar" | "line";
    /** 调色节点的参数；缺省视为未调色。 */
    colorGrade?: CanvasColorGrade;
    mediaConversion?: MediaConversionNodeState;
    upscale?: CanvasUpscaleSettings;
    upscaleBatch?: CanvasUpscaleBatch;
    generatedFromProcessingNodeId?: string;
    /** 用户手动拉伸过尺寸；图片按真实比例自动适配时避让它。 */
    manualSize?: boolean;
    storyboard?: StoryboardData;
    storyboardVisibleColumnsCustomized?: boolean;
    storyboardShotDuration?: StoryboardShotDuration;
    storyboardShotCount?: StoryboardShotCount;
    storyboardVideoInputMode?: StoryboardVideoInputMode;
    storyboardComposerHeight?: number;
    generationBatches?: CanvasGenerationBatch[];
    batchTable?: CanvasBatchTableData;
    batchSourceNodeId?: string;
    batchRowId?: string;
    batchOperation?: CanvasBatchOperation;
    batchInputNodeIds?: string[];
    frame?: {
        collapsed: boolean;
        expandedWidth: number;
        expandedHeight: number;
    };
    folder?: {
        style: CanvasFolderStyle;
        theme?: CanvasFolderTheme;
        createdAt: string;
        // 自定义主题资源覆盖预置主题；目录内容永远从 childNodes 读取。
        themeCover?: string;
        assetFolderId?: string;
        projectId?: string;
    };
    drawingId?: string;
    drawingEngine?: "excalidraw";
    drawingRevision?: number;
    drawingUpdatedAt?: string;
    drawingPreviewStorageKey?: string;
    drawingPreviewUrl?: string;
    drawingShapeCount?: number;
    drawingPageCount?: number;
    emotionEdit?: {
        sourceNodeId: string;
        characterName: string;
        presetId: string;
        intimacy: number;
        arousal: number;
        label: string;
        faceBox: {
            id: string;
            x: number;
            y: number;
            width: number;
            height: number;
            confidence?: number;
            source: "detected" | "manual";
        };
        editRegion?: {
            x: number;
            y: number;
            width: number;
            height: number;
        };
        sourceWidth?: number;
        sourceHeight?: number;
        providerSize?: string;
        maskStorageKey?: string;
        editMode?: "provider-mask" | "local-composite";
    };
    portraitTexture?: PortraitTextureSettings;
    /** AI 审美批改节点只保存当前报告和输入指纹，不保存图片二进制。 */
    artCritique?: ArtCritiqueNodeState;
    /** 摄像机控制选项，启用后生成时自动追加摄影机/镜头/焦距/光圈提示词。 */
    cameraControl?: CameraControlOptions;
    /** 全景节点配置：投影方式、生成方式和比例兜底开关。 */
    panoramaConfig?: {
        projection: "spherical" | "cylindrical";
        sourceMode: "ai" | "image";
        smartBase: boolean;
        directImageUrl?: string | null;
    };
};

export type CanvasNodeData = {
    id: string;
    type: CanvasNodeTypeId;
    title: string;
    createdAt?: string;
    updatedAt?: string;
    position: Position;
    width: number;
    height: number;
    parentId?: string;
    metadata?: CanvasNodeMetadata;
};

/** 豆包账号节点支持的任务类型：对话（大纲/扩写）、生图、生视频。 */
export type DoubaoNodeTaskMode = "chat" | "image" | "video";

export type DoubaoNodeRunStatus = "idle" | "running" | "success" | "error" | "needs_attention" | "cancelled";

export type DoubaoAccountNodeState = {
    schemaVersion: 1;
    /** 绑定的豆包账号；未绑定时执行会提示先选择账号。 */
    accountId?: number;
    mode: DoubaoNodeTaskMode;
    prompt: string;
    ratio?: string;
    duration?: number;
    /** 豆包视频模型（Seedance 2.5 / 2.0 / 2.0 Fast / 2.0 Mini），与旧工作站统一会话参数一致。 */
    videoModel?: string;
    status: DoubaoNodeRunStatus;
    statusText?: string;
    error?: string;
    /** 对话模式的结果文本；作为文本素材供下游消费。 */
    resultText?: string;
    /** 图片/视频结果在节点卡片内的预览（data URL）。 */
    resultPreviewUrl?: string;
    /** 视频异步任务 id，恢复轮询用。 */
    videoTaskId?: string;
    /** 豆包最新回复原文（包括等待用户回复时的提问或确认提示词）。 */
    latestReply?: string;
    /** 视频任务进度（0-100）。 */
    progress?: number;
    lastRunAt?: string;
};

export type CanvasConnection = {
    id: string;
    fromNodeId: string;
    toNodeId: string;
    /** Optional world-space path used by captured read-only fixtures. */
    pathD?: string;
    fromHandleId?: string;
    toHandleId?: string;
    fromAnchorRatio?: number;
    toAnchorRatio?: number;
    relation?: "storyboard-output" | "storyboard-asset-reference" | "batch-output";
    storyboardRowId?: string;
};

export type CanvasDisplayConnection = {
    connection: CanvasConnection;
    from: CanvasNodeData;
    to: CanvasNodeData;
};

export type CanvasAssistantReference = {
    id: string;
    type: CanvasNodeTypeId;
    title: string;
    dataUrl?: string;
    storageKey?: string;
    text?: string;
};

export type CanvasAssistantImage = {
    id: string;
    dataUrl: string;
    storageKey?: string;
    prompt: string;
};

export type CanvasAssistantMessage = {
    id: string;
    role: "user" | "assistant" | "system" | "tool" | "error";
    title?: string;
    text: string;
    meta?: string;
    detail?: unknown;
    references?: CanvasAssistantReference[];
};

export type CanvasAssistantPendingBackendSession = {
    id: string;
    kind: "cinematic";
    messageId: string;
    status: "pending";
    startedAt: string;
};

export type CanvasAssistantSession = {
    id: string;
    title: string;
    messages: CanvasAssistantMessage[];
    pendingBackendSession?: CanvasAssistantPendingBackendSession;
    generationEffectKeys?: string[];
    createdAt: string;
    updatedAt: string;
};

export type ConnectionHandle = {
    nodeId: string;
    handleType: "source" | "target";
    handleId?: string;
    anchorRatio?: number;
};

export type CanvasSelectionStrategy = "replace" | "add" | "toggle" | "subtract";
export type CanvasSelectionHitMode = "contain" | "intersect";

export type SelectionBox = {
    startWorldX: number;
    startWorldY: number;
    currentWorldX: number;
    currentWorldY: number;
    strategy: CanvasSelectionStrategy;
    hitMode: CanvasSelectionHitMode;
    initialSelectedNodeIds: string[];
};

export type ContextMenuState =
    | {
          type: "canvas";
          x: number;
          y: number;
          position: Position;
          createOpen?: boolean;
      }
    | {
          type: "node";
          x: number;
          y: number;
          nodeId: string;
      }
    | {
          type: "connection";
          x: number;
          y: number;
          connectionId: string;
      };
