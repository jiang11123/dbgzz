import { expect, test } from "bun:test";

import { assistantModelOptions } from "../src/lib/assistant-model";
import { groupModelsByDisplayName } from "../src/lib/model-selection";
import { createModelChannel, defaultConfig, filterModelsByCapability, modelDisplayName, normalizeConfigSnapshot, resolveModelChannel } from "../src/stores/use-config-store";

test("默认模型下拉在上万模型的单渠道下仍能快速生成选项", () => {
    const models = Array.from({ length: 10_000 }, (_, index) => `chat-model-${index}`);
    const channel = createModelChannel({
        id: "studio",
        name: "工作室渠道",
        baseUrl: "https://api.example.com",
        apiKey: "synthetic-key",
        models,
        modelProfiles: models.map((model) => ({ model, capability: "text" as const, protocol: "chat-completion" as const })),
    });
    const config = normalizeConfigSnapshot({ config: { ...defaultConfig, channels: [channel], textModel: "studio::chat-model-1" } }).config;
    const started = performance.now();
    for (const capability of ["image", "video", "text", "audio"] as const) {
        const matched = filterModelsByCapability(config.models, capability, config.channels);
        const groups = capability === "video" ? groupModelsByDisplayName(config, matched) : matched.map((model) => ({ models: [model] }));
        for (const group of groups) {
            modelDisplayName(config, group.models[0]!);
            resolveModelChannel(config, group.models[0]!);
        }
    }
    const assistant = assistantModelOptions(config);
    const elapsed = performance.now() - started;
    expect(filterModelsByCapability(config.models, "text", config.channels)).toHaveLength(10_000);
    expect(assistant).toHaveLength(10_000);
    expect(elapsed).toBeLessThan(1_000);
});
