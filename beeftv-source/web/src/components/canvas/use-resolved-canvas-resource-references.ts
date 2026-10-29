import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import type { CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";
import { loadCanvasDrawingPreview } from "@/lib/canvas/canvas-drawing-storage";
import { resolveImageUrl } from "@/services/image-storage";
import { acquireCanvasVideoPreview, canvasDerivedPreviewSourceKey } from "@/services/canvas-video-preview";
import { captureUserScopeEpoch, getUserScopeGeneration, subscribeUserScope, userScopeEpochMatches } from "@/lib/user-scope";

type ResolvedPreview = {
    identity: string;
    url: string;
    owner: PreviewRequest;
};

type PreviewRequest = { cancelled: boolean; release?: () => void };

function releaseRequest(request: PreviewRequest) {
    request.cancelled = true;
    request.release?.();
}

const previewPromiseCache = new Map<string, Promise<string>>();
subscribeUserScope(() => previewPromiseCache.clear());

export function useResolvedCanvasResourceReferences(references: CanvasResourceReference[], options?: { projectId?: string; videoPreviewEnabled?: boolean }) {
    const projectId = options?.projectId;
    const videoPreviewEnabled = options?.videoPreviewEnabled;
    const scopeGeneration = useSyncExternalStore(subscribeUserScope, getUserScopeGeneration, getUserScopeGeneration);
    const requests = useMemo(
        () => references.flatMap((reference) => {
            const identity = previewIdentity(reference, projectId);
            const decodeVideo = videoPreviewEnabled ?? reference.active;
            return identity ? [{ reference, decodeVideo, identity: JSON.stringify([reference.id, scopeGeneration, identity, reference.kind === "video" && decodeVideo]) }] : [];
        }),
        [projectId, references, scopeGeneration, videoPreviewEnabled],
    );
    const [resolvedById, setResolvedById] = useState<Record<string, ResolvedPreview>>({});
    const inFlight = useRef(new Map<string, PreviewRequest>());

    useEffect(() => () => {
        for (const request of inFlight.current.values()) releaseRequest(request);
        inFlight.current.clear();
    }, []);

    useEffect(() => {
        const activeKeys = new Set(requests.map(({ identity }) => identity));
        for (const [key, request] of inFlight.current) {
            if (activeKeys.has(key)) continue;
            releaseRequest(request);
            inFlight.current.delete(key);
        }
        const epoch = captureUserScopeEpoch();
        requests.forEach(({ reference, identity, decodeVideo }) => {
            if (inFlight.current.has(identity)) return;
            const request: PreviewRequest = { cancelled: false };
            inFlight.current.set(identity, request);
            const isCurrent = () => !request.cancelled && userScopeEpochMatches(epoch);
            void (async () => {
                let url = await resolveReferencePreview(reference, identity, projectId);
                if (!isCurrent()) return;
                // A blob supplied by another preview consumer is lease-owned,
                // not a durable poster. Visible consumers need their own lease.
                if (reference.videoPreviewSource && !reference.previewStorageKey && url.startsWith("blob:")) url = "";
                // Lists include unused nodes and assets; decode only used videos
                // or thumbnails currently visible in the mention menu.
                if (!url && reference.videoPreviewSource && decodeVideo) {
                    const lease = acquireCanvasVideoPreview(reference.videoPreviewSource);
                    request.release = lease.release;
                    url = (await lease.promise)?.content || "";
                }
                if (!isCurrent()) return;
                if (!url) { inFlight.current.delete(identity); request.release?.(); return; }
                setResolvedById((current) => {
                    if (current[reference.id]?.owner === request && current[reference.id]?.url === url) return current;
                    return { ...current, [reference.id]: { identity, url, owner: request } };
                });
            })();
        });
    }, [projectId, requests]);

    return useMemo(
        () => references.map((reference) => {
            const key = previewIdentity(reference, projectId);
            const decodeVideo = videoPreviewEnabled ?? reference.active;
            const identity = key ? JSON.stringify([reference.id, scopeGeneration, key, reference.kind === "video" && decodeVideo]) : "";
            const resolved = identity ? resolvedById[reference.id] : undefined;
            const owned = resolved?.identity === identity && inFlight.current.get(identity) === resolved.owner && !resolved.owner.cancelled;
            if (owned) return resolved.url !== reference.previewUrl ? { ...reference, previewUrl: resolved.url } : reference;
            // Never render a derived URL without an active owner, including the
            // first render after scrolling back or switching user scope.
            return reference.videoPreviewSource && !reference.previewStorageKey && reference.previewUrl?.startsWith("blob:") ? { ...reference, previewUrl: undefined } : reference;
        }),
        [projectId, references, resolvedById, scopeGeneration, videoPreviewEnabled],
    );
}

function previewIdentity(reference: CanvasResourceReference, projectId?: string) {
    // 只有当 drawingId 和 projectId 同时存在时才返回绘图身份,避免不完整的缓存键导致运行时错误
    if (reference.drawingId) {
        if (!projectId) return "";
        return `drawing:${projectId}:${reference.drawingId}:${reference.drawingRevision || 0}`;
    }
    const storageKey = reference.kind === "video" ? reference.previewStorageKey : reference.storageKey;
    if (reference.kind === "video" && reference.videoPreviewSource) {
        return `video:${storageKey || ""}:${canvasDerivedPreviewSourceKey(reference.videoPreviewSource)}`;
    }
    if (!storageKey || !["image", "video", "character"].includes(reference.kind)) return "";
    return `${reference.kind}:${storageKey}`;
}

function resolveReferencePreview(reference: CanvasResourceReference, identity: string, projectId?: string) {
    if (reference.kind === "video" && !reference.previewStorageKey) return Promise.resolve(reference.previewUrl || "");
    const cached = previewPromiseCache.get(identity);
    if (cached) return cached;
    if (reference.drawingId && projectId) {
        const pending = loadCanvasDrawingPreview(projectId, reference.drawingId)
            .then((preview) => preview ? blobToDataUrl(preview) : reference.previewUrl || "")
            .catch(() => reference.previewUrl || "")
            .then((url) => {
                if (!url) previewPromiseCache.delete(identity);
                return url;
            });
        previewPromiseCache.set(identity, pending);
        return pending;
    }
    const storageKey = reference.kind === "video" ? reference.previewStorageKey : reference.storageKey;
    const pending = resolveImageUrl(storageKey, reference.previewUrl || "", { cacheMiss: true })
        .catch(() => reference.previewUrl || "")
        .then((url) => {
            if (!url) previewPromiseCache.delete(identity);
            return url;
        });
    previewPromiseCache.set(identity, pending);
    return pending;
}

function blobToDataUrl(blob: Blob) {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(reader.error || new Error("读取绘图预览失败"));
        reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
        reader.readAsDataURL(blob);
    });
}
