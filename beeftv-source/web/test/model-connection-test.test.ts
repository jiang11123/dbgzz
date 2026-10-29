import { expect, test } from "bun:test";
import { testChannelModelConnection } from "@/lib/model-connection-test";
import { createModelChannel } from "@/stores/use-config-store";
import { defaultModelCapabilityConfig } from "@/lib/model-capabilities";

const channel = createModelChannel({ id: "test", apiKey: "fake", baseUrl: "https://example.invalid", models: ["test-model"] });

test("text requires final nonempty content", async () => {
    expect(await testChannelModelConnection(channel, "test-model", "text", "chat-completion", async () => ({ text: "OK" }))).toContain("文本响应");
    await expect(testChannelModelConnection(channel, "test-model", "text", "chat-completion", async () => ({ text: " " }))).rejects.toThrow("没有返回可用结果");
});
test("media requires a final result, not only a submitted task", async () => {
    expect(await testChannelModelConnection(channel, "test-model", "image", "openai-image", async () => ({ images: [{ dataUrl: "https://example.invalid/image.png" }] }))).toContain("已完成图片生成");
    await expect(testChannelModelConnection(channel, "test-model", "audio", "openai-audio", async () => ({}))).rejects.toThrow("没有返回可用结果");
    await expect(testChannelModelConnection(channel, "test-model", "video", "openai-videos", async () => ({}))).rejects.toThrow("没有返回可用结果");
});
test("video waits for completion with the lowest supported test specification", async () => {
    const capabilityConfig = defaultModelCapabilityConfig("openai-videos", "test-model");
    capabilityConfig.video!.duration = { selection: "enum", values: [8, 4, 12], default: 8 };
    capabilityConfig.video!.defaultRatio = "9:16";
    capabilityConfig.video!.resolutions = ["1080", "720"];
    const configured = { ...channel, modelProfiles: [{ model: "test-model", capability: "video" as const, protocol: "openai-videos", capabilityConfig }] };
    const result = await testChannelModelConnection(configured, "test-model", "video", "openai-videos", async ({ config }) => {
        expect(config).toMatchObject({ videoSeconds: "4", size: "9:16", vquality: "720" });
        return { video: { storageKey: "test-video", dataUrl: "" } };
    });
    expect(result).toContain("已完成视频生成");
    expect(result).not.toContain("画布");
});
