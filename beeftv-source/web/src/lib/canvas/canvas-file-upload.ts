import { fitNodeSize } from "@/lib/canvas/canvas-node-size";
import { NODE_DEFAULT_SIZE } from "@/constant/canvas";
import { CanvasNodeType, type CanvasNodeData, type Position } from "@/types/canvas";

export const CANVAS_UPLOAD_ACCEPT = "image/*,video/*,.mp4,.mov,.m4v,.mkv,.webm,.avi,audio/*,.mp3,.wav,text/plain,text/markdown,.txt,.md,.markdown";
export function isTextUploadFile(file: Pick<File, "name" | "type">) {
    return /\.(txt|md|markdown)$/i.test(file.name) || file.type === "text/plain" || file.type === "text/markdown";
}
export function uploadNodeType(file: Pick<File, "name" | "type">) {
    if (file.type.startsWith("image/")) return CanvasNodeType.Image;
    if (file.type.startsWith("video/") || /\.(mp4|mov|m4v|mkv|webm|avi)$/i.test(file.name)) return CanvasNodeType.Video;
    if (file.type.startsWith("audio/") || /\.(mp3|wav)$/i.test(file.name)) return CanvasNodeType.Audio;
    if (isTextUploadFile(file)) return CanvasNodeType.Text;
    return null;
}
export function uploadPercent(loaded: number, total: number): number | undefined {
    if (!Number.isFinite(loaded) || !Number.isFinite(total) || total <= 0) return undefined;
    return Math.round(Math.min(1, Math.max(0, loaded / total)) * 100);
}
export function uploadVeilOpacity(percent = 0) {
    return 1 - Math.min(100, Math.max(0, percent)) / 100 * 0.9;
}

export async function createFileUploadPlaceholder(id: string, file: File, position: Position) {
    const type = uploadNodeType(file);
    if (!type) throw new Error("请选择图片、视频、音频或 TXT / Markdown 文件");
    if (type === CanvasNodeType.Image) return createImageUploadPlaceholder(id, file, position, await readUploadImageSize(file));
    // 浏览器能否解码不决定能否导入；尺寸与封面由上传后的媒体信息补齐。
    const size = NODE_DEFAULT_SIZE[type];
    return {
        ...size, id, type, title: file.name,
        position: { x: position.x - size.width / 2, y: position.y - size.height / 2 },
        metadata: { fileUpload: "uploading", bytes: file.size, mimeType: file.type },
    } satisfies CanvasNodeData;
}

// 不使用 readImageMeta 的默认尺寸兜底：上传占位必须来自实际解码尺寸。
export async function readUploadImageSize(file: File): Promise<{ width: number; height: number }> {
    const url = URL.createObjectURL(file);
    const image = new Image();
    try {
        image.src = url;
        await image.decode();
        if (!image.naturalWidth || !image.naturalHeight) throw new Error("无法读取图片尺寸，请重新选择图片");
        return { width: image.naturalWidth, height: image.naturalHeight };
    } finally {
        URL.revokeObjectURL(url);
    }
}

export function createImageUploadPlaceholder(id: string, file: Pick<File, "name" | "size" | "type">, position: Position, naturalSize: { width: number; height: number }): CanvasNodeData {
    const size = fitNodeSize(naturalSize.width, naturalSize.height);
    return {
        id, type: CanvasNodeType.Image, title: file.name,
        position: { x: position.x - size.width / 2, y: position.y - size.height / 2 },
        ...size,
        metadata: { fileUpload: "uploading", naturalWidth: naturalSize.width, naturalHeight: naturalSize.height, bytes: file.size, mimeType: file.type },
    };
}

export function interruptFileUpload(node: CanvasNodeData): CanvasNodeData {
    if (node.metadata?.fileUpload !== "uploading") return node;
    return { ...node, metadata: { ...node.metadata, fileUpload: "error", fileUploadProgress: undefined, errorDetails: "上传已中断，请重新选择文件上传" } };
}
