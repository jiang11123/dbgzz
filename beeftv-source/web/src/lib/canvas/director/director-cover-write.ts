import type { UploadedImage } from "@/services/image-storage";
import type { CanvasNodeData, CanvasNodeMetadata } from "@/types/canvas";
import type { DirectorScene } from "@/types/director";

export function shouldCaptureDirectorCover(node: CanvasNodeData, scene: DirectorScene): boolean {
    if (node.metadata?.directorSceneId !== scene.id || !scene.shots.some((shot) => shot.id === node.metadata?.directorShotId)) return false;
    return !node.metadata.directorCoverStorageKey || node.metadata.directorCoverSceneUpdatedAt !== scene.updatedAt;
}

export function shouldCommitDirectorCover(input: { projectId: string; currentProjectId: string | null; node: CanvasNodeData | undefined; scene: DirectorScene | undefined; shotId: string; expectedSceneUpdatedAt: string; requestId: string; latestRequestId: string }): boolean {
    const { projectId, currentProjectId, node, scene, shotId, expectedSceneUpdatedAt, requestId, latestRequestId } = input;
    return currentProjectId === projectId
        && requestId === latestRequestId
        && Boolean(node && scene && node.metadata?.workflowKind === "shot"
            && node.metadata.directorSceneId === scene.id
            && node.metadata.directorShotId === shotId
            && scene.shots.some((shot) => shot.id === shotId)
            && scene.updatedAt === expectedSceneUpdatedAt);
}

export function directorCoverMetadata(image: UploadedImage, sceneUpdatedAt: string): Pick<CanvasNodeMetadata, "directorCoverStorageKey" | "directorCoverUrl" | "directorCoverSceneUpdatedAt"> {
    const url = image.url.trim();
    return {
        directorCoverStorageKey: image.storageKey,
        directorCoverUrl: /^(https?:\/\/|\/api\/)/i.test(url) ? url : undefined,
        directorCoverSceneUpdatedAt: sceneUpdatedAt,
    };
}
