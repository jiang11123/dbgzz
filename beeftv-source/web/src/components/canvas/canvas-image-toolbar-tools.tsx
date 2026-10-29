import type { ReactNode } from "react";
import { Brush, Camera, Copy, FileText, Globe2, Grid2x2, Lock, LockOpen, Maximize2, PencilLine, Crop, SlidersHorizontal, Smile, Sun, Upload, Scaling } from "lucide-react";

import type { CanvasNodeData } from "@/types/canvas";
import type { NodeToolbarGroup } from "@/lib/canvas/tool-registry";
import type { CanvasWorkflowContribution } from "@/lib/canvas/workflow-capability";

type ImageNodeActionToolId = "copyPrompt" | "reversePrompt" | "replace" | "resize" | "annotation" | "maskEdit" | "emotion" | "portraitTexture" | "crop" | "split" | "upscale" | "superResolve" | "angle" | "lighting" | "panorama" | "view";

type ImageToolHandlers = {
    onUpload: (node: CanvasNodeData) => void;
    onToggleFreeResize: (node: CanvasNodeData) => void;
    onAnnotate: (node: CanvasNodeData) => void;
    onMaskEdit: (node: CanvasNodeData) => void;
    onEmotion: (node: CanvasNodeData) => void;
    onPortraitTexture: (node: CanvasNodeData) => void;
    onCrop: (node: CanvasNodeData) => void;
    onUpscale: (node: CanvasNodeData) => void;
    onSuperResolve: (node: CanvasNodeData) => void;
    onAngle: (node: CanvasNodeData) => void;
    onLighting: (node: CanvasNodeData) => void;
    onPanorama: (node: CanvasNodeData) => void;
    onViewImage: (node: CanvasNodeData) => void;
    onCopyPrompt: (node: CanvasNodeData) => void;
    onReversePrompt: (node: CanvasNodeData) => void;
};

type ImageToolDefinition = {
    workflow?: CanvasWorkflowContribution;
    id: ImageNodeActionToolId;
    label: string | ((node: CanvasNodeData) => string);
    icon: (node: CanvasNodeData) => ReactNode;
    group: NodeToolbarGroup;
    order: number;
    section?: string;
    description?: string;
    active?: (node: CanvasNodeData) => boolean;
    run: (node: CanvasNodeData, handlers: ImageToolHandlers) => void;
};

const imageToolDefinitions: ImageToolDefinition[] = [
    {
        id: "copyPrompt",
        section: "生成信息",
        label: "复制提示词",
        icon: () => <Copy className="size-3.5" />,
        group: "more",
        order: 50,
        run: (node, handlers) => handlers.onCopyPrompt(node),
    },
    {
        id: "reversePrompt",
        workflow: { mode: "recipe", outputType: "text" },
        section: "生成信息",
        label: "反推提示词",
        icon: () => <FileText className="size-3.5" />,
        group: "more",
        order: 60,
        run: (node, handlers) => handlers.onReversePrompt(node),
    },
    {
        id: "replace",
        label: "替换图片",
        icon: () => <Upload className="size-3.5" />,
        group: "more",
        section: "素材",
        order: 45,
        run: (node, handlers) => handlers.onUpload(node),
    },
    {
        id: "resize",
        label: "锁定宽高比",
        section: "节点管理",
        active: (node) => !node.metadata?.freeResize,
        icon: (node) => (node.metadata?.freeResize ? <LockOpen className="size-3.5" /> : <Lock className="size-3.5" />),
        group: "more",
        order: 70,
        run: (node, handlers) => handlers.onToggleFreeResize(node),
    },
    {
        id: "annotation",
        workflow: { mode: "manual", reason: "标注需要手绘，请在画布完成后作为固定参考输入" },
        section: "拆分与标记",
        description: "添加标记，另存为新图片",
        label: "标注",
        icon: () => <PencilLine className="size-3.5" />,
        group: "process",
        order: 40,
        run: (node, handlers) => handlers.onAnnotate(node),
    },
    {
        id: "maskEdit",
        workflow: { mode: "recipe", outputType: "image" },
        label: "局部重绘",
        description: "涂抹要修改的区域，生成新图片",
        icon: () => <Brush className="size-3.5" />,
        group: "primary",
        order: 10,
        run: (node, handlers) => handlers.onMaskEdit(node),
    },
    {
        id: "emotion",
        workflow: { mode: "recipe", outputType: "image" },
        label: "表情调整",
        section: "人像调整",
        description: "调整人物表情，生成新图片",
        icon: () => <Smile className="size-3.5" />,
        group: "portrait",
        order: 50,
        run: (node, handlers) => handlers.onEmotion(node),
    },
    {
        id: "portraitTexture",
        workflow: { mode: "recipe", outputType: "image" },
        label: "质感调整",
        section: "人像调整",
        description: "设置肤质、光影与融合，再执行生成",
        icon: () => <SlidersHorizontal className="size-3.5" />,
        group: "portrait",
        order: 60,
        run: (node, handlers) => handlers.onPortraitTexture(node),
    },
    {
        id: "crop",
        workflow: { operationId: "image.crop", outputType: "image" },
        label: "裁切",
        section: "构图与尺寸",
        description: "保留所选区域，生成新图片",
        icon: () => <Crop className="size-3.5" />,
        group: "process",
        order: 10,
        run: (node, handlers) => handlers.onCrop(node),
    },
    {
        id: "split",
        workflow: { operationId: "image.split", outputType: "image" },
        label: "宫格切分",
        section: "拆分与标记",
        description: "按行列拆成多个图片节点",
        icon: () => <Grid2x2 className="size-3.5" />,
        group: "process",
        order: 45,
        run: () => undefined,
    },
    {
        id: "upscale",
        workflow: { operationId: "image.resize", outputType: "image" },
        label: "调整尺寸",
        section: "构图与尺寸",
        description: "插值放大像素尺寸，不是 AI 超分",
        icon: () => <Scaling className="size-3.5" />,
        group: "process",
        order: 20,
        run: (node, handlers) => handlers.onUpscale(node),
    },
    {
        id: "angle",
        workflow: { mode: "recipe", outputType: "image" },
        label: "多角度",
        section: "视角",
        description: "调整摄影机角度，生成新视角",
        icon: () => <Camera className="size-3.5" />,
        group: "viewpoint",
        order: 20,
        run: (node, handlers) => handlers.onAngle(node),
    },
    {
        id: "lighting",
        workflow: { mode: "recipe", outputType: "image" },
        label: "打光",
        section: "视角",
        description: "调整光线方向、亮度与光效，生成新图片",
        icon: () => <Sun className="size-3.5" />,
        group: "lighting",
        order: 30,
        run: (node, handlers) => handlers.onLighting(node),
    },
    {
        id: "view",
        label: "预览",
        icon: () => <Maximize2 className="size-3.5" />,
        group: "utility",
        order: 10,
        run: (node, handlers) => handlers.onViewImage(node),
    },
    {
        id: "panorama",
        workflow: { mode: "recipe", outputType: "image" },
        label: "全景图",
        section: "视角",
        description: "基于该图片创建 360° 全景查看节点",
        icon: () => <Globe2 className="size-3.5" />,
        group: "panorama",
        order: 80,
        run: (node, handlers) => handlers.onPanorama(node),
    },
];

export function buildImageToolbarTools(node: CanvasNodeData, handlers: ImageToolHandlers) {
    return imageToolDefinitions.map((tool) => ({
        id: tool.id,
        label: resolveToolText(tool.label, node),
        icon: tool.icon(node),
        group: tool.group,
        order: tool.order,
        section: tool.section,
        description: tool.description,
        active: tool.active?.(node),
        onClick: () => tool.run(node, handlers),
    }));
}

export function listImageWorkflowTools(node: CanvasNodeData) {
    return imageToolDefinitions.filter(tool => tool.workflow || ["process", "portrait", "viewpoint", "lighting", "panorama"].includes(tool.group)).map(tool => ({
        id: `image.${tool.id}`, label: resolveToolText(tool.label, node), icon: tool.icon(node),
        workflow: tool.workflow || { mode: "manual" as const }, description: tool.description,
    }));
}

function resolveToolText(value: string | ((node: CanvasNodeData) => string), node: CanvasNodeData) {
    return typeof value === "function" ? value(node) : value;
}
