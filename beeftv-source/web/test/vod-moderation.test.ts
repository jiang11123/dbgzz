import { expect, test } from "bun:test";
import { explainGenerationError } from "../src/lib/generation-error";
import { canvasGenerationFailureMetadata, canvasGenerationRetryBlocked } from "../src/pages/canvas/canvas-generation-failure";

test("VOD safety rejection reaches canvas copy and blocks unchanged retry", () => {
    expect(explainGenerationError("VOD image task failed [RequestLimitExceeded]: opaque").category).toBe("concurrency");
    for (const input of [
        "VOD image task failed: task failed with status: FAIL, message: recv from gpt image edit api failed. http_code:400, message:Your request was rejected by the safety system. If you believe this is an error, contact us at Azure support ticket",
        "VOD image task failed [ContentModerationFailed]: opaque",
        "VOD image task failed [InvalidParameter.VoilationContent]: opaque",
        "Your request was rejected as a result of our safety system.",
        { code: "ContentModerationFailed", message: "opaque" },
        { code: "InvalidParameter.VoilationContent", message: "opaque" },
        { code: "content_policy_violation", message: "本次图片生成未通过内容安全审核，请调整提示词或参考素材后重试。" },
    ]) {
        const result = explainGenerationError(input);
        expect(result.moderation).toBe(true);
        expect(result.message).toContain("内容安全审核");
        expect(result.message).not.toContain("Azure");
        expect(result.blockAutomaticRetry).toBe(true);
        const metadata = canvasGenerationFailureMetadata(input, { prompt: "draw", mode: "image" });
        expect(metadata.errorDetails).toContain("内容安全审核");
        expect(canvasGenerationRetryBlocked(metadata, { prompt: "draw", mode: "image" })).toBe(true);
        expect(explainGenerationError(metadata.errorDetails).moderation).toBe(true);
    }
    for (const input of ["safety system unavailable", { code: "invalid_api_key", message: "Your request was rejected by the safety system." }, { prompt: "Your request was rejected by the safety system." }]) {
        expect(explainGenerationError(input).moderation).toBe(false);
    }
});
