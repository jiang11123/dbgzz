import { expect, test } from "bun:test";
import { mediaReviewModelOptions, normalizeMediaReviewModel } from "@/lib/media-review-model";
import { createModelChannel, defaultConfig, normalizeConfigSnapshot } from "@/stores/use-config-store";
import { mergeManagedBeefAPICatalog, withChannels } from "@/pages/settings/channel-settings-pane";

const model = "wand-vega-vl-1.0-flash";
const managed = createModelChannel({ id: "beefapi", pinned: true, models: [model, "gpt-6-astra"], modelProfiles: [
    { model, capability: "text", protocol: "chat-completion" },
    { model: "gpt-6-astra", capability: "text", protocol: "chat-completion" },
] });
const custom = { ...managed, id: "custom", pinned: false };
const config = { ...defaultConfig, assistantModel: "beefapi::gpt-6-astra", channels: [managed, custom] };

test("media choices require an available video adapter and do not use main assistant restrictions", () => {
    expect(mediaReviewModelOptions(config)).toEqual([`beefapi::${model}`, `custom::${model}`]);
    for (const change of [{ enabled: false }, { models: [] }, { modelProfiles: [] }, { modelProfiles: [{ model, capability: "video" as const, protocol: "newapi" }] }, { modelProfiles: [{ model, capability: "text" as const, protocol: "responses" }] }]) {
        expect(mediaReviewModelOptions({ ...config, channels: [{ ...managed, ...change }] })).toEqual([]);
    }
    expect(normalizeMediaReviewModel(config, "beefapi::gpt-6-astra")).toBe("");
    expect(normalizeMediaReviewModel(config, `missing::${model}`)).toBe("");
    expect(normalizeMediaReviewModel(config, "")).toBe("");
});

test("saved media choice and explicit off survive normalization, reconnect and catalog refresh", () => {
    for (const selection of [`custom::${model}`, "", `missing::${model}`]) {
        const saved = normalizeConfigSnapshot({ config: { ...config, mediaReviewModel: selection } }).config;
        expect(saved.mediaReviewModel).toBe(selection);
        const server = { ...config, mediaReviewModel: `beefapi::${model}` };
        expect(mergeManagedBeefAPICatalog(saved, server, true).mediaReviewModel).toBe(selection);
        expect(mergeManagedBeefAPICatalog(saved, server).mediaReviewModel).toBe(selection);
    }
    const selected = { ...config, mediaReviewModel: `custom::${model}` };
    expect(withChannels(selected, [managed]).mediaReviewModel).toBe("");
    expect(withChannels(selected, [{ ...managed, models: [] }, custom]).mediaReviewModel).toBe(selected.mediaReviewModel);
    expect(normalizeConfigSnapshot({ config: { ...config, mediaReviewModel: undefined } }).config.mediaReviewModel).toBe("");
});

test("catalog aliases are selectable without silently choosing another model", () => {
    const channel = { ...managed, models: ["catalog-wand"], modelAliases: { [model]: "catalog-wand" }, modelProfiles: [{ model: "catalog-wand", capability: "text" as const, protocol: "chat-completion" }] };
    const aliased = { ...config, channels: [channel] };
    expect(mediaReviewModelOptions(aliased)).toEqual(["beefapi::catalog-wand"]);
    expect(normalizeMediaReviewModel(aliased, `beefapi::${model}`)).toBe("beefapi::catalog-wand");
});
