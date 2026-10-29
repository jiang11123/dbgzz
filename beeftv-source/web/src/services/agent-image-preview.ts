import { imageToDataUrl } from "@/services/image-storage";
import { resourceIdFromStorageKey, resourceStorageKey, uploadResourceFile } from "@/services/api/resources";
import { getActiveUserScope } from "@/lib/user-scope";

// 预算只作用于视觉分析副本，不修改原素材。
export async function agentImagePreviews(images: Parameters<typeof imageToDataUrl>[0][]): Promise<string[]> {
    if (!images.length) return [];
    const limit = Math.min(256 * 1024, Math.floor(2 * 1024 * 1024 / images.length));
    if (limit < 16 * 1024) throw new Error("本次参考图片过多，请分批选择图片后继续。");
    const previews: string[] = [];
    // 顺序解码，避免多张原图同时占用内存。
    for (const source of images) {
        const url = await imageToDataUrl(source);
        if (!url) throw new Error("参考图片无法读取，请重新选择图片。");
        const image = new Image();
        image.src = url;
        try { await image.decode(); }
        catch { throw new Error("参考图片无法解码，请重新选择图片。"); }
        const canvas = document.createElement("canvas");
        try {
            const context = canvas.getContext("2d");
            if (!context) throw new Error("无法准备看图预览，请刷新后重试。");
            let edge = Math.min(1600, Math.max(image.naturalWidth, image.naturalHeight));
            let preview = "";
            while (edge > 0) {
                const scale = Math.min(1, edge / Math.max(image.naturalWidth, image.naturalHeight));
                canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
                canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
                context.fillStyle = "#ffffff";
                context.fillRect(0, 0, canvas.width, canvas.height);
                context.drawImage(image, 0, 0, canvas.width, canvas.height);
                preview = canvas.toDataURL("image/jpeg", 0.82);
                if (preview.length <= limit) break;
                if (edge <= 128) break;
                edge = Math.floor(edge * 0.75);
            }
            if (!preview || preview.length > limit) throw new Error("参考图片体积过大，请减少本次选择的图片后继续。");
            previews.push(preview);
        } finally {
            canvas.width = 0;
            canvas.height = 0;
            image.src = "";
        }
    }
    return previews;
}

type AgentImageCrop = { x: number; y: number; width: number; height: number };

export async function inspectAgentImage(source: Parameters<typeof imageToDataUrl>[0], detail: "preview" | "original" | "crop", crop?: AgentImageCrop) {
    const scope = getActiveUserScope();
    const dataUrl = await encodeAgentImage(source, detail, crop);
    if (scope !== getActiveUserScope()) throw new DOMException("账号已切换", "AbortError");
    if (detail === "original" && resourceIdFromStorageKey(source.storageKey)) return { storageKey: source.storageKey!, encodedBytes: dataUrl.length };
    const response = await fetch(dataUrl);
    if (!response.ok) throw new Error("读取看图素材失败");
    const blob = await response.blob();
    const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
    const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    if (scope !== getActiveUserScope()) throw new DOMException("账号已切换", "AbortError");
    const resource = await uploadResourceFile(blob, "image", { fileName: `agent-inspect-${hash.slice(0, 12)}.${blob.type === "image/png" ? "png" : "jpg"}`, idempotencyKey: `agent-inspect:${hash}` });
    if (scope !== getActiveUserScope()) throw new DOMException("账号已切换", "AbortError");
    return { storageKey: resourceStorageKey(resource.id), encodedBytes: dataUrl.length };
}

async function encodeAgentImage(source: Parameters<typeof imageToDataUrl>[0], detail: "preview" | "original" | "crop", crop?: AgentImageCrop) {
    if (detail === "preview") return (await agentImagePreviews([source]))[0];
    const url = await imageToDataUrl(source);
    if (!url) throw new Error("参考图片无法读取，请重新选择图片。");
    if (detail === "original") {
        if (url.length > 6 * 1024 * 1024) throw new Error("原图超过本次看图预算，请改用 crop 分区检查，不要降低细节精度。");
        return url;
    }
    if (!crop || ![crop.x, crop.y, crop.width, crop.height].every((value) => typeof value === "number" && Number.isFinite(value)) || crop.x < 0 || crop.y < 0 || crop.width <= 0 || crop.height <= 0 || crop.x + crop.width > 1 || crop.y + crop.height > 1) throw new Error("裁剪范围必须是 0 到 1 的归一化坐标，且完整位于原图内。");
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement("canvas");
    try {
        canvas.width = Math.max(1, Math.round(image.naturalWidth * crop.width));
        canvas.height = Math.max(1, Math.round(image.naturalHeight * crop.height));
        const context = canvas.getContext("2d");
        if (!context) throw new Error("无法读取图片局部，请刷新后重试。");
        context.drawImage(image, image.naturalWidth * crop.x, image.naturalHeight * crop.y, image.naturalWidth * crop.width, image.naturalHeight * crop.height, 0, 0, canvas.width, canvas.height);
        const result = canvas.toDataURL("image/png");
        if (result.length > 6 * 1024 * 1024) throw new Error("该区域超过本次看图预算，请缩小裁剪范围后继续检查。");
        return result;
    } finally { canvas.width = 0; canvas.height = 0; image.src = ""; }
}
