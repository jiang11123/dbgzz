import { CanvasNodeType, type CanvasNodeData, type CanvasNodeTypeId } from "@/types/canvas";

const FILE_NAME_PART_LIMIT = 80;

const MIME_EXTENSIONS: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/svg+xml": "svg",
    "image/avif": "avif",
    "image/bmp": "bmp",
    "image/tiff": "tiff",
    "video/mp4": "mp4",
    "video/webm": "webm",
    "video/quicktime": "mov",
    "video/ogg": "ogv",
    "video/mpeg": "mpeg",
    "video/x-msvideo": "avi",
    "video/x-matroska": "mkv",
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/wave": "wav",
    "audio/vnd.wave": "wav",
    "audio/x-pn-wav": "wav",
    "audio/aac": "aac",
    "audio/flac": "flac",
    "audio/ogg": "ogg",
    "audio/opus": "opus",
    "audio/webm": "webm",
    "audio/x-m4a": "m4a",
};

const CONTENT_EXTENSIONS = new Set(Object.values(MIME_EXTENSIONS).concat(["jpeg", "mpg"]));

export function buildCanvasMediaDownloadFileName(canvasTitle: string, node: CanvasNodeData, now = new Date()) {
    const canvasName = safeFileNamePart(canvasTitle, "未命名画布");
    const nodeName = safeFileNamePart(node.title, defaultNodeName(node.type));
    return `${canvasName}_${nodeName}_${formatDownloadDate(now)}.${canvasMediaFileExtension(node)}`;
}

export function sanitizeDownloadFileName(value: string, fallback = "未命名文件") {
    const leaf = value.trim().replace(/\\/g, "/").split("/").pop() || "";
    const lastDot = leaf.lastIndexOf(".");
    const extension = lastDot > 0 ? leaf.slice(lastDot + 1) : "";
    const base = lastDot > 0 ? leaf.slice(0, lastDot) : leaf;
    const safeBase = safeFileNamePart(base, fallback);
    if (!extension || !/^[a-z0-9]{1,8}$/i.test(extension)) return safeBase;
    return `${safeBase}.${extension.toLowerCase() === "jpeg" ? "jpg" : extension.toLowerCase()}`;
}

export function canvasMediaFileExtension(node: CanvasNodeData) {
    return mediaFileExtension(node.metadata?.mimeType, node.metadata?.content)
        || defaultExtension(node.type);
}

export function mediaFileExtension(mimeType?: string, content?: string) {
    return extensionFromMimeType(mimeType) || extensionFromContent(content);
}

function extensionFromMimeType(mimeType?: string) {
    const normalized = mimeType?.split(";", 1)[0]?.trim().toLowerCase();
    return normalized ? MIME_EXTENSIONS[normalized] : undefined;
}

function extensionFromContent(content?: string) {
    if (!content) return undefined;
    const dataMimeType = content.match(/^data:([^;,]+)/i)?.[1];
    const dataExtension = extensionFromMimeType(dataMimeType);
    if (dataExtension) return dataExtension;
    const path = content.split(/[?#]/, 1)[0];
    const extension = path.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase();
    if (!extension || !CONTENT_EXTENSIONS.has(extension)) return undefined;
    if (extension === "jpeg") return "jpg";
    if (extension === "mpg") return "mpeg";
    return extension;
}

function safeFileNamePart(value: string, fallback: string) {
    const normalized = value
        .trim()
        .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
        .replace(/_+/g, "_")
        .replace(/\s+/g, " ")
        .replace(/^_+|_+$/g, "")
        .slice(0, FILE_NAME_PART_LIMIT)
        .replace(/[. ]+$/g, "");
    if (!normalized) return fallback;
    return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(normalized) ? `_${normalized}` : normalized;
}

function formatDownloadDate(date: Date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}${month}${day}`;
}

function defaultNodeName(type: CanvasNodeTypeId) {
    if (type === CanvasNodeType.Video) return "视频节点";
    if (type === CanvasNodeType.Audio) return "音频节点";
    return "图片节点";
}

function defaultExtension(type: CanvasNodeTypeId) {
    if (type === CanvasNodeType.Video) return "mp4";
    if (type === CanvasNodeType.Audio) return "mp3";
    return "png";
}
