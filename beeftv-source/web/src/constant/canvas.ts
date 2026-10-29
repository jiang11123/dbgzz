import { CanvasNodeType } from "@/types/canvas";
import type { CanvasNodeMetadata } from "@/types/canvas";

type CanvasNodeSpec = {
    width: number;
    height: number;
    title: string;
    metadata?: CanvasNodeMetadata;
};

export const NODE_DEFAULT_SIZE = {
    [CanvasNodeType.Image]: { width: 720, height: 405, title: "图片" },
    // LibTV 的文本节点以近似正方形卡片承载提示词与生成入口，作为首屏复刻基准固定为 350×350。
    [CanvasNodeType.Text]: { width: 350, height: 350, title: "文本节点" },
    [CanvasNodeType.Drawing]: { width: 440, height: 300, title: "绘图" },
    [CanvasNodeType.Script]: { width: 920, height: 360, title: "分镜脚本" },
    [CanvasNodeType.Skill]: { width: 360, height: 220, title: "技能" },
    // 配置节点同时承载模式、渠道、工作流和参数；预留稳定空间，避免控件和错误状态互相挤压。
    [CanvasNodeType.Config]: { width: 480, height: 390, title: "生成配置" },
    [CanvasNodeType.Video]: { width: 720, height: 405, title: "视频" },
    // LibTV renders an empty audio node as a square media card, not a
    // shallow waveform strip; this keeps the empty-state affordance visible.
    [CanvasNodeType.Audio]: { width: 320, height: 320, title: "音频" },
    [CanvasNodeType.Frame]: { width: 760, height: 520, title: "未命名背板" },
    [CanvasNodeType.Workflow]: { width: 1180, height: 1030, title: "工作流" },
    [CanvasNodeType.WorkflowControl]: { width: 1100, height: 180, title: "工作流进度" },
    [CanvasNodeType.Markdown]: { width: 420, height: 320, title: "Markdown" },
    [CanvasNodeType.Svg]: { width: 420, height: 320, title: "SVG" },
    [CanvasNodeType.Html]: { width: 520, height: 380, title: "HTML" },
    [CanvasNodeType.Panorama]: { width: 520, height: 300, title: "全景" },
    [CanvasNodeType.Compare]: { width: 520, height: 320, title: "对比" },
    [CanvasNodeType.Chart]: { width: 480, height: 320, title: "图表" },
    [CanvasNodeType.ColorGrade]: { width: 420, height: 360, title: "调色" },
    [CanvasNodeType.MediaConversion]: { width: 480, height: 460, title: "转换" },
    [CanvasNodeType.Upscale]: { width: 420, height: 240, title: "AI超分" },
    [CanvasNodeType.BatchTable]: { width: 1280, height: 560, title: "批量创作表" },
    [CanvasNodeType.Director]: { width: 640, height: 640, title: "导演台" },
    [CanvasNodeType.DoubaoAccount]: { width: 480, height: 560, title: "豆包账号" },
} satisfies Record<CanvasNodeType, { width: number; height: number; title: string }>;

export const NODE_SPECS = {
    [CanvasNodeType.Image]: {
        ...NODE_DEFAULT_SIZE[CanvasNodeType.Image],
        metadata: { content: "", status: "idle" },
    },
    [CanvasNodeType.Text]: {
        ...NODE_DEFAULT_SIZE[CanvasNodeType.Text],
        metadata: { content: "", status: "idle", fontSize: 14 },
    },
    [CanvasNodeType.Drawing]: {
        ...NODE_DEFAULT_SIZE[CanvasNodeType.Drawing],
        metadata: { status: "success" },
    },
    [CanvasNodeType.Script]: {
        ...NODE_DEFAULT_SIZE[CanvasNodeType.Script],
        metadata: {
            status: "idle",
            workflowKind: "script",
            storyboard: {
                rows: [],
                visibleColumns: ["shotNumber", "durationSeconds", "videoMotionPrompt", "dialogue", "assets"],
                referenceNodeIds: [],
            },
        },
    },
    [CanvasNodeType.Skill]: {
        ...NODE_DEFAULT_SIZE[CanvasNodeType.Skill],
        metadata: { status: "success" },
    },
    [CanvasNodeType.Config]: {
        ...NODE_DEFAULT_SIZE[CanvasNodeType.Config],
        metadata: { content: "", status: "idle", generationMode: "image" },
    },
    [CanvasNodeType.Video]: {
        ...NODE_DEFAULT_SIZE[CanvasNodeType.Video],
        metadata: { content: "", status: "idle" },
    },
    [CanvasNodeType.Audio]: {
        ...NODE_DEFAULT_SIZE[CanvasNodeType.Audio],
        metadata: { content: "", status: "idle" },
    },
    [CanvasNodeType.Frame]: {
        ...NODE_DEFAULT_SIZE[CanvasNodeType.Frame],
        metadata: { frame: { collapsed: false, expandedWidth: NODE_DEFAULT_SIZE[CanvasNodeType.Frame].width, expandedHeight: NODE_DEFAULT_SIZE[CanvasNodeType.Frame].height } },
    },
    [CanvasNodeType.Workflow]: { ...NODE_DEFAULT_SIZE[CanvasNodeType.Workflow], metadata: undefined },
    [CanvasNodeType.WorkflowControl]: { ...NODE_DEFAULT_SIZE[CanvasNodeType.WorkflowControl], metadata: undefined },
    [CanvasNodeType.Markdown]: {
        ...NODE_DEFAULT_SIZE[CanvasNodeType.Markdown],
        metadata: { content: "", status: "idle" },
    },
    [CanvasNodeType.Svg]: {
        ...NODE_DEFAULT_SIZE[CanvasNodeType.Svg],
        metadata: { content: "", status: "idle" },
    },
    [CanvasNodeType.Html]: {
        ...NODE_DEFAULT_SIZE[CanvasNodeType.Html],
        metadata: { content: "", status: "idle" },
    },
    [CanvasNodeType.Panorama]: {
        ...NODE_DEFAULT_SIZE[CanvasNodeType.Panorama],
        metadata: { content: "", status: "idle" },
    },
    [CanvasNodeType.Compare]: {
        ...NODE_DEFAULT_SIZE[CanvasNodeType.Compare],
        metadata: { status: "idle" },
    },
    [CanvasNodeType.Chart]: {
        ...NODE_DEFAULT_SIZE[CanvasNodeType.Chart],
        metadata: { content: "", status: "idle" },
    },
    [CanvasNodeType.ColorGrade]: {
        ...NODE_DEFAULT_SIZE[CanvasNodeType.ColorGrade],
        metadata: { status: "idle" },
    },
    [CanvasNodeType.MediaConversion]: { ...NODE_DEFAULT_SIZE[CanvasNodeType.MediaConversion], metadata: { status: "idle" } },
    [CanvasNodeType.Upscale]: { ...NODE_DEFAULT_SIZE[CanvasNodeType.Upscale], metadata: { status: "idle" } },
    [CanvasNodeType.BatchTable]: {
        ...NODE_DEFAULT_SIZE[CanvasNodeType.BatchTable],
        metadata: {
            status: "idle",
            batchTable: {
                operation: "try_on",
                concurrency: 10,
                referenceColumns: [
                    { id: "reference-1", label: "参考图 1" },
                    { id: "reference-2", label: "参考图 2" },
                    { id: "reference-3", label: "参考图 3" },
                ],
                rows: [],
            },
        },
    },
    [CanvasNodeType.Director]: {
        ...NODE_DEFAULT_SIZE[CanvasNodeType.Director],
        metadata: { status: "idle", workflowKind: "shot" },
    },
    [CanvasNodeType.DoubaoAccount]: {
        ...NODE_DEFAULT_SIZE[CanvasNodeType.DoubaoAccount],
        metadata: { status: "idle", doubaoAccountNode: { schemaVersion: 1, mode: "chat", prompt: "", status: "idle" } },
    },
} satisfies Record<CanvasNodeType, CanvasNodeSpec>;

export function getNodeSpec(type: CanvasNodeType) {
    return NODE_SPECS[type];
}
