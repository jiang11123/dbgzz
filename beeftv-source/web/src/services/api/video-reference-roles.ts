import type { ReferenceImage } from "@/types/image";

import type { RequestOptions } from "./video-contracts";

export type VideoImageRole = "first_frame" | "last_frame" | "reference_image";

export type ResolvedVideoImageReference = {
    image: ReferenceImage;
    role: VideoImageRole;
};

type VideoReferenceContext = {
    videoCount?: number;
    audioCount?: number;
};

export function resolveVideoImageReferences(images: ReferenceImage[], options?: RequestOptions, context: VideoReferenceContext = {}): ResolvedVideoImageReference[] {
    const operation = options?.videoEditOperation?.trim();
    if (operation === "reference_to_video") {
        return images.map((image) => ({ image, role: "reference_image" }));
    }

    const startFrameId = options?.videoStartFrameNodeId?.trim();
    const endFrameId = options?.videoEndFrameNodeId?.trim();
    if (startFrameId || endFrameId) {
        return images.map((image) => ({
            image,
            role: image.id === startFrameId ? "first_frame" : image.id === endFrameId ? "last_frame" : "reference_image",
        }));
    }

    if (context.videoCount || context.audioCount) {
        return images.map((image) => ({ image, role: "reference_image" }));
    }

    // 传统创作页没有帧节点 ID：保留单图首帧、双图首尾帧的历史语义。
    return images.map((image, index) => ({
        image,
        role: index === 0 ? "first_frame" : index === 1 && images.length === 2 ? "last_frame" : "reference_image",
    }));
}

export function hasExplicitVideoFrames(options?: RequestOptions) {
    return options?.videoEditOperation !== "reference_to_video" && Boolean(options?.videoStartFrameNodeId || options?.videoEndFrameNodeId);
}
