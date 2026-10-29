import { expect, test } from "bun:test";
import { seedanceReferenceRatioWarning } from "../src/lib/seedance-channel-warning";
import { seedanceSettingsConstraints } from "../src/lib/seedance-task-constraints";
import { explainGenerationError } from "../src/lib/generation-error";

const request = { model: "seedance-2.5", credentialRef: "beefapi-enterprise", videoCount: 1, ratio: "16:9", operation: "reference_to_video" };
test("only affected routes and reference-video requests require informed consent", () => {
    expect(seedanceReferenceRatioWarning(request)?.content).toContain("不会自动退款");
    expect(seedanceReferenceRatioWarning({ ...request, model: "seedance-2.0" })?.okText).toBe("接受风险并生成");
    for (const patch of [{ model: "seedance-2.0-fast" }, { model: "seedance-2.0-mini" }, { videoCount: 0 }, { ratio: "adaptive" }, { operation: "extend" }, { operation: "inpaint" }, { credentialRef: "", baseUrl: "https://ark.cn-beijing.volces.com/api/v3" }, { credentialRef: "", baseUrl: "https://whatstoken.ai.attacker.invalid" }]) {
        expect(seedanceReferenceRatioWarning({ ...request, ...patch })).toBeUndefined();
    }
    expect(seedanceReferenceRatioWarning({ ...request, credentialRef: "", baseUrl: "https://www.whatstoken.ai/api/v3" })).toBeDefined();
});

test("mode-specific controls keep free ratio in reference mode and unlock on model change", () => {
    expect(seedanceSettingsConstraints("seedance-2.5",1,0,0).ratioLabel).toBe("随首帧");
    expect(seedanceSettingsConstraints("seedance-2.5",1,1,1,"reference_to_video").ratioLabel).toBeUndefined();
    expect(seedanceSettingsConstraints("seedance-2.5",1,0,0,"reference_to_video").ratioLabel).toBeUndefined();
    expect(seedanceSettingsConstraints("seedance-2.0",1,0,0).ratioLabel).toBeUndefined();
    expect(seedanceSettingsConstraints("seedance-2.5",0,1,0,"inpaint")).toEqual({ratioLabel:"随原视频",durationLocked:true});
});

test("specific frame errors survive task-log serialization", () => {
    for (const code of ["video_first_frame_ratio_unreadable", "video_first_frame_ratio_unsupported", "video_first_frame_ratio_mismatch"]) {
        const first=explainGenerationError({error:{code:"invalid_request",message:code}});
        expect(first.category).toBe("invalid_params");
        expect(first.message).not.toContain("检查模型、尺寸");
    }
});
