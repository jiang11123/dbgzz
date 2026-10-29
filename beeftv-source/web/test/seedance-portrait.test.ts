import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { ModelPicker } from "../src/components/model-picker";
import { ModelDefaultGrid } from "../src/pages/settings/model-default-grid";
import { portraitPriceLines, portraitTaskRetryError, seedancePortraitLabel } from "../src/lib/seedance-portrait";
import { initialWorkbenchModel, refreshedWorkbenchModel } from "../src/pages/projects/detail/workflow-model-selection";
import { applyFetchedChannelModelCatalog } from "../src/pages/settings/channel-settings-pane";
import { compatibleModelInGroup, groupModelsByDisplayName, modelCompatibilityError, resolveCompatibleModel } from "../src/lib/model-selection";
import { resolveCanvasGenerationModel } from "../src/lib/canvas/canvas-project-generation";
import { defaultModelCapabilityConfig } from "../src/lib/model-capabilities";
import { defaultConfig, normalizeConfigSnapshot, normalizeModelOptionValue, type AiConfig } from "../src/stores/use-config-store";

function fixture(): AiConfig {
    const ids = ["seedance-2.0", "seedance-2.0-portrait"];
    return { ...defaultConfig, channels: [{ id: "beefapi", name: "BeefAPI", apiFormat: "openai", baseUrl: "https://beefapi.com", apiKey: "", models: ids, modelProfiles: ids.map((id) => ({ model: id, displayName: "Seedance 2.0 真人素材版", capability: "video", protocol: "newapi", capabilityConfig: defaultModelCapabilityConfig("newapi", id), videoPricing: { currency: "CNY", mode: "tokens", rates: { "720p": { output: 69, reference_video: 42 } } } })) }], models: ids.map((id) => `beefapi::${id}`), videoModels: ids.map((id) => `beefapi::${id}`) };
}

test("settings show one Seedance option and retain the selected legacy ID", () => {
    const config = fixture();
    config.videoModel = config.models[1];
    const html = renderToStaticMarkup(createElement(ModelDefaultGrid, { config, onChange: () => {} }));
    const videoRow = html.slice(html.indexOf('id="default-video-title"'), html.indexOf('id="default-text-title"'));
    expect(videoRow.match(/role="combobox"/g)).toHaveLength(1);
    expect(groupModelsByDisplayName(config, config.videoModels)).toHaveLength(1);
    expect(videoRow).toContain('title="Seedance 2.0"');
    expect(config.videoModel).toBe("beefapi::seedance-2.0-portrait");
});

test("legacy and canonical models share one menu entry without silently switching saved IDs", () => {
    const config = fixture();
    expect(groupModelsByDisplayName(config, config.models)).toHaveLength(1);
    expect(groupModelsByDisplayName(config, [...config.models].reverse())[0].models[0]).toBe(config.models[0]);
    config.channels[0].modelProfiles![0].capabilityConfig!.video!.references.maxImages = 0;
    const requirements = { capability: "video" as const, input: { textCount: 1, imageCount: 1, videoCount: 0, audioCount: 0, characterCount: 0 } };
    expect(resolveCompatibleModel(config, config.models[0], requirements)).toBe("");
    expect(resolveCompatibleModel(config, config.models[1], requirements)).toBe(config.models[1]);
});

test("unavailable saved portrait selection never becomes the default standard model", () => {
    const config = fixture();
    config.channels[0].models = ["seedance-2.0"];
    expect(resolveCanvasGenerationModel(config, "beefapi::seedance-2.0-portrait", "video")).toBe("beefapi::seedance-2.0-portrait");
});

test("explicit menu selection can recover to canonical while automatic generation keeps a missing-quote alias blocked", () => {
    const config = fixture();
    const [canonical, alias] = config.models;
    config.channels[0].modelProfiles![1].videoPricing = null;
    const requirements = { capability: "video" as const };
    const group = groupModelsByDisplayName(config, config.models)[0];
    expect(resolveCompatibleModel(config, alias, requirements)).toBe("");
    expect(compatibleModelInGroup(config, group.models, requirements, alias)).toBe(canonical);
});

test("workbench retains unavailable portrait defaults and explicit choices across catalog refresh", () => {
    const config = fixture();
    const standard = "beefapi::seedance-2.0";
    const portrait = "beefapi::seedance-2.0-portrait";
    config.videoModel = standard;
    config.channels[0].models = ["seedance-2.0"];
    const initial = initialWorkbenchModel(config, portrait, "video");
    expect(initial).toBe(portrait);
    expect(modelCompatibilityError(config, initial, { capability: "video" })).toContain("当前不可用");
    expect(refreshedWorkbenchModel(portrait, standard, true)).toBe(portrait);
    expect(refreshedWorkbenchModel(standard, portrait, true)).toBe(standard);
    expect(refreshedWorkbenchModel("", initial, true)).toBe(portrait);
    expect(refreshedWorkbenchModel(portrait, standard, false)).toBe(standard);
    config.videoModel = portrait;
    config.channels[0].models = ["seedance-2.0-portrait"];
    expect(initialWorkbenchModel(config, standard, "video")).toBe("");
});

test("task-center portrait retry never guesses an account quote from a bare model", () => {
    for (const detail of [undefined, "{}", JSON.stringify({ videoParameters: { model: "seedance-2.0-portrait", affectedChannel: true } })]) {
        expect(portraitTaskRetryError(detail, "seedance-2.0-portrait")).toContain("回到原画布");
    }
    expect(portraitTaskRetryError(JSON.stringify({ videoParameters: { model: "seedance-2.5-portrait" } }), "自定义名称")).toContain("确认当前价格");
    expect(portraitTaskRetryError(undefined, "seedance-2.0")).toBe("");
});

test("BYOK catalog refresh updates or clears portrait quote while retaining manual capabilities", () => {
    const config = fixture();
    const channel = { ...config.channels[0], id: "byok", baseUrl: "https://provider.example" };
    const original = channel.modelProfiles![1];
    const quote = { currency: "CNY" as const, mode: "tokens" as const, rates: { "720p": { output: 105, reference_video: 65 } } };
    const refreshed = applyFetchedChannelModelCatalog(channel, { models: [original.model], catalog: [{ id: original.model, modelType: "video", videoPricing: quote }] });
    const profile = refreshed.modelProfiles!.find((item) => item.model === original.model)!;
    expect(profile.videoPricing).toEqual(quote);
    expect(profile.capabilityConfig).toEqual(original.capabilityConfig);
    expect(profile.protocol).toBe(original.protocol);
    for (const catalog of [[{ id: original.model, modelType: "video" }], []]) {
        const removed = applyFetchedChannelModelCatalog(refreshed, { models: catalog.map((item) => item.id), catalog });
        expect(removed.modelProfiles!.find((item) => item.model === original.model)!.videoPricing).toBeNull();
        const removedConfig = { ...config, channels: [removed] };
        expect(modelCompatibilityError(removedConfig, `byok::${original.model}`, { capability: "video" })).toContain("价格暂不可用");
    }
    expect(refreshed.modelProfiles!.find((item) => item.model === "seedance-2.0")).toEqual(channel.modelProfiles![0]);
});

test("missing quote blocks portrait generation and never fabricates a price", () => {
    const config = fixture();
    config.channels[0].modelProfiles![1].videoPricing = null;
    expect(modelCompatibilityError(config, config.models[1], { capability: "video" })).toContain("价格暂不可用");
    expect(portraitPriceLines(undefined)).toEqual([]);
    expect(seedancePortraitLabel("beefapi::seedance-2.5-portrait")).toBe("Seedance 2.5");
});

test("selected portrait option offers account-sourced prices before generation", () => {
    const config = fixture();
    config.channels[0].modelProfiles![1].displayName = "Seedance 2.0-Pro";
    const html = renderToStaticMarkup(createElement(ModelPicker, { config, value: config.models[1], capability: "video", onChange() {} }));
    expect(html).toContain("Seedance 2.0");
    expect(html).not.toContain("Seedance 2.0-Pro");
    expect(html).toContain("视频参考单价");
    expect(html).toContain('aria-label="视频参考单价"');
    expect(html).toContain("¥69");
    expect(html).toContain("¥42");
    expect(html).not.toContain("必过");
});

test("canonical Seedance choice shows the returned official quote", () => {
    const config = fixture();
    config.channels[0].modelProfiles![0].videoPricing!.rates["720p"] = { output: 46, reference_video: 28 };
    const html = renderToStaticMarkup(createElement(ModelPicker, { config, value: config.models[0], capability: "video", onChange() {} }));
    expect(html).toContain("Seedance 2.0");
    expect(html).toContain("¥46");
    expect(html).toContain("¥28");
});


test("catalog restore and aliases cannot silently cross pricing tiers", () => {
    const config = fixture();
    const standard = config.models[0];
    const portrait = config.models[1];
    config.model = config.videoModel = portrait;
    config.channels[0].models = ["seedance-2.0"];
    expect(normalizeConfigSnapshot({ config }).config.videoModel).toBe(portrait);
    config.model = config.videoModel = standard;
    config.channels[0].models = ["seedance-2.0-portrait"];
    expect(normalizeConfigSnapshot({ config }).config.videoModel).toBe("");
    config.channels[0].modelAliases = { "seedance-2.0": "seedance-2.0-portrait" };
    expect(normalizeModelOptionValue(standard, config.channels)).toBe("");
    config.channels[0].models = ["seedance-2.0"];
    config.channels[0].modelAliases = { "seedance-2.0-portrait": "seedance-2.0" };
    expect(normalizeModelOptionValue(portrait, config.channels)).toBe("");
});

test("all shared submission paths reject missing quote, model or resolution before creating a task", async () => {
    const { runBackendGenerationTask, submitBackendGenerationTask, runBackendGenerationTaskBatch } = await import("../src/services/api/generation-task");
    let created = 0;
    const dependencies = {
        createTask: async () => { created++; throw new Error("CREATE_TASK_REACHED"); },
        waitTask: async () => { throw new Error("WAIT_TASK_REACHED"); },
        createId: () => "portrait-test",
    };
    for (const failure of ["quote", "model", "resolution"]) {
        const config = fixture();
        config.model = config.videoModel = config.models[1];
        if (failure === "quote") config.channels[0].modelProfiles![1].videoPricing = null;
        if (failure === "model") config.channels[0].models = ["seedance-2.0"];
        if (failure === "resolution") config.vquality = "1080";
        const options = { config, prompt: "Two adults standing in a studio", mode: "video" as const, retryOf: "previous-task" };
        for (const submit of [runBackendGenerationTask, submitBackendGenerationTask]) {
            await expect(submit(options, dependencies)).rejects.toThrow("不可用");
        }
        await expect(runBackendGenerationTaskBatch({ ...options, count: 2 }, dependencies)).rejects.toThrow("不可用");
    }
    expect(created).toBe(0);
});
