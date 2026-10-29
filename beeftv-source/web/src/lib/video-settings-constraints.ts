import { beefAPIVideoContract, isBeefAPIEndpoint } from "./beefapi-video-contracts";
import { h3ReferenceMode, h3VideoOperation, isH3Model, isH3Style } from "./h3-video";
import { seedanceSettingsConstraints, type SeedanceSettingsConstraints } from "./seedance-task-constraints";
import { modelOptionName, resolveModelRequestConfig, type AiConfig } from "@/stores/use-config-store";
import type { CanvasNodeMetadata } from "@/types/canvas";

export type VideoSettingsConstraints = SeedanceSettingsConstraints & { ratioHelp?: string };

export function videoSettingsConstraints(
    config: AiConfig,
    input: { imageCount?: number; videoCount?: number; audioCount?: number; characterCount?: number },
    metadata?: Pick<CanvasNodeMetadata, "videoEditOperation" | "videoStartFrameNodeId" | "videoEndFrameNodeId" | "videoMiddleFrameNodeId">,
): VideoSettingsConstraints {
    const model = modelOptionName(config.model);
    const imageCount = input.imageCount || 0;
    const videoCount = input.videoCount || 0;
    const audioCount = input.audioCount || 0;
    const first = metadata?.videoStartFrameNodeId;
    const last = metadata?.videoEndFrameNodeId;
    const resolved = resolveModelRequestConfig(config, config.model);
    const h3 = isBeefAPIEndpoint(resolved.baseUrl) && beefAPIVideoContract(model) && isH3Model(model);
    if (h3) {
        // Canvas submission resolves the operation before building the provider payload.
        const counts = { imageCount, videoCount, audioCount };
        const referenceMode = h3ReferenceMode(model, counts, { ...metadata, videoEditOperation: h3VideoOperation(model, counts, metadata?.videoEditOperation) });
        if (referenceMode) return {};
        if (input.characterCount) {
            // A card can expand into several views and change the submission mode.
            const ratioHelp = first || last
                ? model === "minimax-h3-max"
                    ? "首尾帧生成不能混用角色参考图；H3 Max 多素材参考生成可组合关键帧与角色参考图，使用所选比例。"
                    : "角色卡带参考图时，不能与指定的首尾帧同时使用。请移除角色卡，或取消首尾帧指定后再生成。"
                : isH3Style(model)
                    ? "角色卡带参考图时，视频比例由参考图决定；所选比例只在没有参考图时生效。"
                    : "首尾帧生成时，比例随实际参考图；多素材参考生成使用所选比例。";
            return { ratioHelp };
        }
        if (!imageCount) return {};
        const frame = last && !first ? "尾帧" : "首帧";
        return {
            ratioLabel: `随${frame}图片`,
            ratioHelp: `视频比例由${frame}图片决定。需要其他比例时，请先裁切或扩图，再生成视频。`,
        };
    }
    return seedanceSettingsConstraints(model, imageCount, videoCount, audioCount, metadata?.videoEditOperation, Boolean(first || last));
}
