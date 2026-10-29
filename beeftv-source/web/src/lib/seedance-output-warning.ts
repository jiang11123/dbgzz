import { seedanceTaskOptions } from "./seedance-task-constraints";

// Compare the immutable submitted request, not editable canvas settings. Media
// header padding may differ by a few pixels; never treat that as a new failure.
export function seedanceOutputWarning(inputJson: string | undefined, width?: number, height?: number, taskModel?: string): string | undefined {
    if (!inputJson || !width || !height) return undefined;
    try {
        const input = JSON.parse(inputJson);
        const parameters = input.videoParameters;
        const model = String(parameters?.model || input.config?.model || taskModel || "");
        if (!/(?:seedance-2[.-][05]|seedance-2-[05])/.test(model)) return undefined;
        const images = Array.isArray(input.referenceImages) ? input.referenceImages : [];
        const videos = Array.isArray(input.referenceVideos) ? input.referenceVideos : [];
        const audios = Array.isArray(input.referenceAudios) ? input.referenceAudios : [];
        const operation = input.metadata?.videoEditOperation;
        const explicitFrame = input.metadata?.videoStartFrameNodeId || input.metadata?.videoEndFrameNodeId;
        const imageCount = parameters?.imageCount ?? images.length;
        const videoCount = parameters?.videoCount ?? videos.length;
        const audioCount = parameters?.audioCount ?? audios.length;
        const firstFrame = operation !== "reference_to_video" && (explicitFrame || (imageCount > 0 && imageCount <= 2 && !videoCount && !audioCount));
        const { ratio } = seedanceTaskOptions(model, String(parameters?.size || input.config?.size || ""), 5, firstFrame ? ["first_frame"] : [], videoCount, operation);
        const match = /^(\d+):(\d+)$/.exec(ratio);
        if (!match || Number(match[2]) <= 0) return undefined;
        if (Math.abs(width / height / (Number(match[1]) / Number(match[2])) - 1) <= 0.02) return undefined;
        return `视频已生成，但画幅与设置不一致：要求 ${ratio}，实际 ${width}×${height}。原片已保留。`;
    } catch { return undefined; }
}
