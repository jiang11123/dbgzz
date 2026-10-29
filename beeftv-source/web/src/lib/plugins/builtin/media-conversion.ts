import { MEDIA_CONVERSION_NODE_TYPE } from "@/lib/media-conversion/contracts";

import { registerPlugin } from "../plugin-registry";
import { PLUGIN_API_VERSION, type PluginManifest, type RegisteredPlugin } from "../plugin-types";

export const MEDIA_CONVERSION_PLUGIN_ID = "media-conversion";

const manifest: PluginManifest = {
    apiVersion: PLUGIN_API_VERSION,
    id: MEDIA_CONVERSION_PLUGIN_ID,
    name: "媒体转换节点",
    version: "0.1.0",
    publishedAt: "2026-09-08",
    updatedAt: "2026-09-08",
    description: "在画布中提供图片和视频首帧转换节点，支持灰度、Canny 边缘、AI 线稿、本地 Depth Anything V2 深度图和 OpenPose 姿态骨架。",
    documentation:
        "# 媒体转换节点\n\n连接图片到转换节点后，可以在节点内选择灰度图、Canny 边缘、AI 线稿、深度图或姿态骨架；连接视频时，灰度图和 Canny 边缘会先提取视频首帧再处理。AI 线稿使用本机 ControlNet Aux 预处理模型，深度图使用本机已安装的 Depth Anything V2 Small 模型，姿态骨架使用 ControlNet Aux 的 OpenPose 人体预处理模型运行；这些操作都不会加载 Stable Diffusion 重绘管线。姿态转换只绘制人体骨架，未检测到人物时会跳过并提示。透明抠图和视频高级逐帧模型仍在验证，会明确提示不可用。\n\n该插件只读取当前节点的媒体输入，并把结果保存回当前画布节点的本地素材存储。",
    author: "BeefTV 团队",
    surfaces: ["node"],
    permissions: ["canvas.read", "canvas.write", "media.read"],
    trusted: true,
    runtime: { web: "declarative" },
    contributes: {
        transforms: [
            {
                id: MEDIA_CONVERSION_NODE_TYPE,
                input: "media",
                output: "media",
                runtime: "declarative",
            },
        ],
    },
};

export const mediaConversionPlugin: RegisteredPlugin = { manifest };

registerPlugin(mediaConversionPlugin);
