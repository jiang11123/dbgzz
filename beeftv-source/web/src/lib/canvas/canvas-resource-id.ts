import type { Asset } from "@/stores/use-asset-store";
import type { CanvasNodeData } from "@/types/canvas";

const RESOURCE_FILE_PATHNAME_PATTERN = /^\/(?:api\/(?:v1\/)?)?resources\/([^/]+)\/file$/;
const RESOURCE_ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;

function validOwnedResourceId(raw: string): string {
    const trimmed = raw.trim();
    return RESOURCE_ID_PATTERN.test(trimmed) ? trimmed : "";
}

function resourceIdFromPathname(pathname: string): string {
    const match = RESOURCE_FILE_PATHNAME_PATTERN.exec(pathname);
    if (!match) return "";
    try {
        return validOwnedResourceId(decodeURIComponent(match[1]));
    } catch {
        return "";
    }
}

function extractSingleOwnedResourceId(raw?: string): string {
    const value = raw?.trim() || "";
    if (!value) return "";
    if (value.startsWith("resource:")) {
        return validOwnedResourceId(value.slice("resource:".length));
    }
    if (value.startsWith("/")) {
        const pathname = value.split(/[?#]/, 1)[0] || "";
        return resourceIdFromPathname(pathname);
    }
    if (/^(?:https?|wails):\/\//i.test(value)) {
        try {
            const parsed = new URL(value);
            return resourceIdFromPathname(parsed.pathname);
        } catch {
            return "";
        }
    }
    return "";
}

export function extractOwnedResourceId(storageKey?: string, url?: string): string {
    return extractSingleOwnedResourceId(storageKey) || extractSingleOwnedResourceId(url);
}

export function canvasNodeResourceId(node: CanvasNodeData) {
    return extractOwnedResourceId(node.metadata?.storageKey, node.metadata?.content);
}

export function assetResourceId(asset: Asset) {
    if (asset.kind === "text" || asset.kind === "entity") return "";
    const resourceKey = typeof asset.metadata?.resourceKey === "string" ? asset.metadata.resourceKey : undefined;
    const mediaUrl = "url" in asset.data ? asset.data.url : "dataUrl" in asset.data ? asset.data.dataUrl : undefined;
    return extractOwnedResourceId(asset.data.storageKey || resourceKey, mediaUrl || asset.coverUrl);
}

/** History insert reuses the owned Asset for the same Resource. Do not invent a new pairing. */
export function bindCanvasNodeResourceAsset(node: CanvasNodeData, sourceNodes: CanvasNodeData[], assets: Asset[]): CanvasNodeData {
    if (node.metadata?.assetId) return node;
    const resourceID = canvasNodeResourceId(node);
    if (!resourceID) return node;
    const nodeSpecific = assets.find((item) => item.metadata?.nodeId === node.id && assetResourceId(item) === resourceID);
    if (nodeSpecific) {
        return { ...node, metadata: { ...node.metadata, assetId: nodeSpecific.id } };
    }
    const siblingAssetIds = Array.from(
        new Set(
            sourceNodes
                .filter((item) => item.metadata?.assetId && canvasNodeResourceId(item) === resourceID)
                .map((item) => item.metadata!.assetId!),
        ),
    );
    if (siblingAssetIds.length === 1) {
        return { ...node, metadata: { ...node.metadata, assetId: siblingAssetIds[0] } };
    }
    if (siblingAssetIds.length > 1) return node;
    const matchingAssets = assets.filter((item) => assetResourceId(item) === resourceID);
    if (matchingAssets.length === 1) {
        return { ...node, metadata: { ...node.metadata, assetId: matchingAssets[0].id } };
    }
    return node;
}
