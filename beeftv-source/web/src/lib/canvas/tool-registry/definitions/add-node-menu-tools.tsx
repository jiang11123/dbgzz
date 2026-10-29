import { Clock3, Folder, FolderOpen, Image as ImageIcon, Layers3, MessageSquareText, Palette, UploadCloud, UserRound, Video, Workflow } from "lucide-react";

import { getNodeIcon, getNodeLabel } from "@/lib/canvas/node-registry";
import { CANVAS_DEVELOPING_LABEL, getCanvasNodeCreationDisabledReason } from "@/lib/canvas/canvas-feature-availability";
import { registerAddNodeMenuCommands, type AddNodeMenuCommand } from "@/lib/canvas/tool-registry";
import { CanvasNodeType } from "@/types/canvas";

/** 真正创建节点的命令，文案与图标统一取自节点注册表。 */
function nodeCommand(type: CanvasNodeType, rest: Omit<AddNodeMenuCommand, "id" | "label" | "icon" | "section">): AddNodeMenuCommand {
    return { id: type, label: getNodeLabel(type), icon: getNodeIcon(type), section: "node", ...rest };
}

export const addNodeMenuCommands: AddNodeMenuCommand[] = [
    // 项目级动作不占用节点网格，创作节点保持统一排列。
    { id: "style", label: "项目画风", icon: <Palette />, section: "project", defaultOrder: 10, applicable: (ctx) => !ctx.isProjectLinked, run: (ctx) => ctx.handlers.onChooseStyle() },
    // 创作节点
    nodeCommand(CanvasNodeType.Text, { defaultOrder: 10, run: (ctx) => ctx.handlers.onAddText() }),
    nodeCommand(CanvasNodeType.Image, { defaultOrder: 20, run: (ctx) => ctx.handlers.onAddImage() }),
    nodeCommand(CanvasNodeType.Video, { defaultOrder: 30, run: (ctx) => ctx.handlers.onAddVideo() }),
    // 豆包节点：分为文字节点、图片节点、视频节点三个独立节点
    { ...nodeCommand(CanvasNodeType.DoubaoAccount, { defaultOrder: 31, applicable: (ctx) => ctx.showDoubaoNodes === true, run: (ctx) => ctx.handlers.onAddDoubaoAccountNode("chat") }), id: "doubao-text-preset", label: "豆包文字", icon: <MessageSquareText /> },
    { ...nodeCommand(CanvasNodeType.DoubaoAccount, { defaultOrder: 32, applicable: (ctx) => ctx.showDoubaoNodes === true, run: (ctx) => ctx.handlers.onAddDoubaoAccountNode("image") }), id: "doubao-image-preset", label: "豆包图片", icon: <ImageIcon /> },
    { ...nodeCommand(CanvasNodeType.DoubaoAccount, { defaultOrder: 33, applicable: (ctx) => ctx.showDoubaoNodes === true, run: (ctx) => ctx.handlers.onAddDoubaoAccountNode("video") }), id: "doubao-video-preset", label: "豆包视频", icon: <Video /> },
    nodeCommand(CanvasNodeType.Upscale, { defaultOrder: 35, run: (ctx) => ctx.handlers.onAddExtensionNode(CanvasNodeType.Upscale) }),
    nodeCommand(CanvasNodeType.Audio, { defaultOrder: 40, applicable: (ctx) => ctx.workspaceMode !== "simple", run: (ctx) => ctx.handlers.onAddAudio() }),
    // 导演台落在节点分区，但它开的是导演工作台、不是某种画布节点，故不走注册表。
    { id: "director", label: "导演台", icon: <Layers3 />, section: "node", defaultOrder: 50, applicable: (ctx) => ctx.workspaceMode !== "simple", run: (ctx) => ctx.handlers.onOpenDirector() },
    { ...nodeCommand(CanvasNodeType.MediaConversion, { defaultOrder: 60, run: (ctx) => ctx.handlers.onAddExtensionNode(CanvasNodeType.MediaConversion) }), label: "智能剪辑", badge: CANVAS_DEVELOPING_LABEL, disabledReason: getCanvasNodeCreationDisabledReason(CanvasNodeType.MediaConversion) },
    { ...nodeCommand(CanvasNodeType.Frame, { defaultOrder: 70, applicable: (ctx) => ctx.workspaceMode !== "simple", run: (ctx) => ctx.handlers.onAddFrame() }), label: "逐帧拉片", badge: CANVAS_DEVELOPING_LABEL, disabledReason: getCanvasNodeCreationDisabledReason(CanvasNodeType.Frame) },
    { ...nodeCommand(CanvasNodeType.Script, { defaultOrder: 80, run: (ctx) => ctx.handlers.onAddScript() }), label: "脚本", badge: CANVAS_DEVELOPING_LABEL, disabledReason: getCanvasNodeCreationDisabledReason(CanvasNodeType.Script) },
    nodeCommand(CanvasNodeType.Drawing, { defaultOrder: 90, run: (ctx) => ctx.handlers.onAddDrawing() }),
    { id: "folder", label: "文件夹", icon: <Folder />, badge: "6 款", section: "node", defaultOrder: 95, run: (ctx) => ctx.handlers.onAddFolder() },
    nodeCommand(CanvasNodeType.BatchTable, { defaultOrder: 100, run: (ctx) => ctx.handlers.onAddExtensionNode(CanvasNodeType.BatchTable) }),
    // 云端和本地工作流共用独立配置节点，不进入基础模型节点的渠道选择。
    { id: "workflow", label: "工作流", icon: <Workflow />, section: "workflow", defaultOrder: 10, applicable: (ctx) => ctx.workspaceMode !== "simple", run: (ctx) => ctx.handlers.onAddWorkflow() },
    // 导入资源
    { id: "upload", label: "上传", icon: <UploadCloud />, section: "resource", defaultOrder: 10, run: (ctx) => ctx.handlers.onUpload() },
    { id: "project-character", label: "添加角色卡", icon: <UserRound />, section: "resource", defaultOrder: 20, applicable: (ctx) => ctx.isProjectLinked, run: (ctx) => ctx.handlers.onOpenProjectCharacters() },
    { id: "generation-history", label: "从生成历史选择", icon: <Clock3 />, section: "resource", defaultOrder: 30, run: (ctx) => ctx.handlers.onOpenGenerationHistory() },
    { id: "assets", label: "素材库", icon: <FolderOpen />, section: "resource", defaultOrder: 40, applicable: (ctx) => !ctx.isProjectLinked, run: (ctx) => ctx.handlers.onOpenMyAssets() },
];

registerAddNodeMenuCommands(addNodeMenuCommands);
