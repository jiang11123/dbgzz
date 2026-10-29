import { getDataUrlByteSize } from "@/lib/image-utils";
import { canvasNodeVideoPreviewUrl } from "@/lib/canvas/canvas-media-preview";
import { assetResourceId, bindCanvasNodeResourceAsset, canvasNodeResourceId, extractOwnedResourceId } from "@/lib/canvas/canvas-resource-id";
import type { Asset, AssetCategory, NewAsset } from "@/stores/use-asset-store";
import { CanvasNodeType, type CanvasNodeData, type CanvasNodeTypeId } from "@/types/canvas";

export { assetResourceId, bindCanvasNodeResourceAsset, canvasNodeResourceId, extractOwnedResourceId };

export type CanvasAssetSource = "canvas-generation" | "canvas-upload" | "canvas-manual";

type CanvasNodeAssetOptions = {
    canvasId: string;
    source: CanvasAssetSource;
    taskId?: string;
};

export function canvasNodeToAsset(node: CanvasNodeData, options: CanvasNodeAssetOptions): NewAsset | null {
    const content = node.metadata?.content?.trim() || "";
    const inferredResourceId = extractOwnedResourceId(node.metadata?.storageKey, content);
    const storageKey = node.metadata?.storageKey?.trim() || (inferredResourceId ? `resource:${inferredResourceId}` : undefined);
    const isMedia = node.type === CanvasNodeType.Image || node.type === CanvasNodeType.Video || node.type === CanvasNodeType.Audio;

    // 文本素材必须直接携带正文；媒体则允许只有持久 storageKey。后者常见于页面重载后：
    // blob/object URL 已失效，但资源定位符仍可从后端重新换取可访问地址，不能因此丢掉素材记录。
    if (node.type === CanvasNodeType.Text && !content) return null;
    if (isMedia && !content && !storageKey) return null;
    if (!isMedia && node.type !== CanvasNodeType.Text) return null;
    const title = node.metadata?.prompt?.slice(0, 24) || node.title || canvasAssetFallbackTitle(node.type);
    const metadata = {
        source: options.source,
        canvasId: options.canvasId,
        nodeId: node.id,
        taskId: options.taskId || node.metadata?.taskId,
        prompt: node.metadata?.prompt,
        resourceKey: storageKey,
    };
    const canonicalResourceUrl = inferredResourceId ? `/api/resources/${inferredResourceId}/file` : "";
    const mediaUrl = content || canonicalResourceUrl;
    const base = {
        title,
        coverUrl: node.type === CanvasNodeType.Image ? mediaUrl : node.type === CanvasNodeType.Video ? canvasNodeVideoPreviewUrl(node) : "",
        tags: node.metadata?.assetTags || [],
        category: canvasNodeAssetCategory(node),
        status: "confirmed" as const,
        source: "Canvas",
        metadata,
    };

    if (node.type === CanvasNodeType.Text) {
        return { ...base, kind: "text", data: { content } };
    }
    if (node.type === CanvasNodeType.Image) {
        const dataUrl = storageKey ? "" : content;
        return {
            ...base,
            kind: "image",
            data: {
                dataUrl,
                storageKey,
                width: node.metadata?.naturalWidth || node.width,
                height: node.metadata?.naturalHeight || node.height,
                bytes: node.metadata?.bytes || getDataUrlByteSize(dataUrl),
                mimeType: node.metadata?.mimeType || "image/png",
            },
        };
    }
    if (node.type === CanvasNodeType.Video) {
        return {
            ...base,
            kind: "video",
            data: {
                url: mediaUrl,
                storageKey,
                width: node.metadata?.naturalWidth || node.width,
                height: node.metadata?.naturalHeight || node.height,
                durationMs: node.metadata?.durationMs,
                hasAudio: node.metadata?.hasAudio,
                bytes: node.metadata?.bytes || 0,
                mimeType: node.metadata?.mimeType || "video/mp4",
            },
        };
    }
    if (node.type === CanvasNodeType.Audio) {
        return {
            ...base,
            kind: "audio",
            data: {
                url: mediaUrl,
                storageKey,
                durationMs: node.metadata?.durationMs,
                bytes: node.metadata?.bytes || 0,
                mimeType: node.metadata?.mimeType || "audio/mpeg",
            },
        };
    }
    return null;
}

/**
 * Stamp every resource-backed node that still lacks an Asset, using the same
 * owned Asset for the same Resource. Cached unbound siblings stay on the canvas.
 */
export async function bindMissingCanvasResourceAssets(nodes: CanvasNodeData[], assets: Asset[], ensure: (node: CanvasNodeData) => Promise<{ assetId: string }>): Promise<CanvasNodeData[]> {
    const bound = nodes.map((node) => bindCanvasNodeResourceAsset(node, nodes, assets));
    const missing = canvasNodesMissingResourceAssetBinding(bound);
    if (!missing.length) return bound;

    const assetIdByResource = new Map<string, string>();
    for (const node of missing) {
        const resourceID = canvasNodeResourceId(node);
        if (!resourceID || assetIdByResource.has(resourceID)) continue;
        const result = await ensure(node);
        if (result.assetId) assetIdByResource.set(resourceID, result.assetId);
    }

    return bound.map((node) => {
        if (node.metadata?.assetId) return node;
        const resourceID = canvasNodeResourceId(node);
        const assetId = resourceID ? assetIdByResource.get(resourceID) : undefined;
        return assetId ? { ...node, metadata: { ...node.metadata, assetId } } : node;
    });
}

/** Resource-backed canvas media must have an Asset binding before the whole snapshot can be synced. */
export function canvasNodesMissingResourceAssetBinding(nodes: CanvasNodeData[]) {
    return nodes.filter((node) => {
        if (node.type !== CanvasNodeType.Image && node.type !== CanvasNodeType.Video && node.type !== CanvasNodeType.Audio) return false;
        if (node.metadata?.assetId) return false;
        return Boolean(canvasNodeResourceId(node));
    });
}

export function findCanvasNodeAsset(assets: Asset[], node: CanvasNodeData, canvasId: string, taskId?: string) {
    const explicitId = node.metadata?.assetId;
    let explicitMismatched = false;
    if (explicitId) {
        const explicit = assets.find((asset) => asset.id === explicitId);
        if (explicit) {
            if (sameAssetResource(explicit, node, true)) return explicit;
            explicitMismatched = true;
        }
    }
    const generationTaskId = taskId || node.metadata?.taskId;
    const byNode = assets.find((asset) => {
        if (generationTaskId && asset.metadata?.taskId === generationTaskId && asset.metadata?.nodeId === node.id) return sameAssetResource(asset, node);
        if (asset.metadata?.nodeId !== node.id) return false;
        const sourceCanvasId = asset.metadata?.canvasId;
        if (sourceCanvasId !== canvasId && (sourceCanvasId || asset.metadata?.source !== "canvas-generation")) return false;
        return sameAssetResource(asset, node);
    });
    if (byNode) return byNode;
    if (!explicitId || explicitMismatched) {
        const nodeResourceId = canvasNodeResourceId(node);
        if (nodeResourceId) {
            return assets.find((asset) => assetResourceId(asset) === nodeResourceId);
        }
    }
    return undefined;
}

function sameAssetResource(asset: Asset, node: CanvasNodeData, allowUnboundExplicitAsset = false) {
    const nodeResourceId = canvasNodeResourceId(node);
    const assetResId = assetResourceId(asset);
    if (nodeResourceId && assetResId) return nodeResourceId === assetResId;
    if (allowUnboundExplicitAsset && nodeResourceId && !assetResId) return true;
    if (nodeResourceId || assetResId) return nodeResourceId === assetResId;
    const nodeResourceKey = node.metadata?.storageKey;
    const assetResourceKey = typeof asset.metadata?.resourceKey === "string" ? asset.metadata.resourceKey : assetStorageKey(asset);
    return !nodeResourceKey || !assetResourceKey || nodeResourceKey === assetResourceKey;
}

function assetStorageKey(asset: Asset) {
    if (asset.kind === "text" || asset.kind === "entity") return undefined;
    return asset.data.storageKey;
}

export function declaredCanvasNodeAssetCategory(node: CanvasNodeData): AssetCategory | undefined {
    if (node.metadata?.assetCategory) return node.metadata.assetCategory;
    if (node.metadata?.workflowKind === "character") return "character";
    if (node.metadata?.workflowKind === "scene") return "environment";
    if (node.metadata?.workflowKind === "styleboard") return "material";
    return undefined;
}

export function canvasNodeAssetCategory(node: CanvasNodeData): AssetCategory {
    const declared = declaredCanvasNodeAssetCategory(node);
    if (declared) return declared;
    if (node.type === CanvasNodeType.Image || node.type === CanvasNodeType.Video || node.type === CanvasNodeType.Audio) return "material";
    return "other";
}

function canvasAssetFallbackTitle(type: CanvasNodeTypeId) {
    if (type === CanvasNodeType.Image) return "画布图片";
    if (type === CanvasNodeType.Video) return "画布视频";
    if (type === CanvasNodeType.Audio) return "画布音频";
    return "画布文本";
}
