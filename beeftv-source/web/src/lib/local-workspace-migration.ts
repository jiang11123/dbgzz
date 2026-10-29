type LocalCanvasProject = { remoteContentHash?: string; [key: string]: unknown };
type LocalAsset = {
    metadata?: Record<string, unknown>;
    pendingRemoteUpload?: boolean;
    remoteUploadError?: string;
    [key: string]: unknown;
};

/** Remove hosted synchronization markers while preserving the actual local work. */
export function normalizeLocalCanvasProject<T extends LocalCanvasProject>(project: T): T {
    if (!project.remoteContentHash) return project;
    const next = { ...project };
    delete next.remoteContentHash;
    return next;
}

/** External plugin sync records are not part of a local workspace asset. */
export function normalizeLocalAsset<T extends LocalAsset>(asset: T): T {
    const hasLegacyRemoteState = Boolean(asset.pendingRemoteUpload || asset.remoteUploadError || asset.metadata?.externalSync);
    if (!hasLegacyRemoteState) return asset;
    const next = { ...asset } as T;
    delete next.pendingRemoteUpload;
    delete next.remoteUploadError;
    if (asset.metadata?.externalSync) {
        const metadata = { ...asset.metadata };
        delete metadata.externalSync;
        next.metadata = metadata;
    }
    return next;
}
