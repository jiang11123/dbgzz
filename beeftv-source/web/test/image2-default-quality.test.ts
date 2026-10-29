import { expect, test } from "bun:test";
import { defaultImageCapabilityConfig, normalizeImageValue, upgradeGPTImageCapability } from "../src/lib/model-capabilities";
import { backendProviderConfig } from "../src/services/api/generation-task";
import { createModelChannel, defaultConfig, normalizeConfigSnapshot } from "../src/stores/use-config-store";

test("image2缺省与旧auto统一显示并提交low，显式质量和尺寸保留", () => {
    const legacy = defaultImageCapabilityConfig("openai-image", "gpt-image-2");
    legacy.quality = { supported: true, values: ["auto", "low", "medium", "high"], default: "auto" };
    const profile = upgradeGPTImageCapability(legacy, "openai-image", "gpt-image-2");
    expect(profile.quality).toEqual({ supported: true, values: ["low", "medium", "high"], default: "low" });
    expect(legacy.quality.default).toBe("auto");
    const channel = createModelChannel({ id: "beefapi", baseUrl: "https://enterprise.beefapi.com/v1", models: ["gpt-image-2"], modelProfiles: [{ model:"gpt-image-2", capability:"image", protocol:"openai-image", capabilityConfig:{ version:1, image:legacy } }] });
    for (const quality of ["", "auto", "low", "medium", "high"]) {
        const want = !quality || quality === "auto" ? "low" : quality;
        for (const size of ["1024x1024", "2048x2048", "2880x2880"]) {
            const config = normalizeConfigSnapshot({ config:{ ...defaultConfig, channels:[channel], model:"beefapi::gpt-image-2", imageModel:"beefapi::gpt-image-2", quality, size } }).config;
            expect(normalizeImageValue(profile, config)).toMatchObject({ quality:want, size });
            expect(backendProviderConfig(config)).toMatchObject({ model:"gpt-image-2", quality:want, size });
        }
    }
    const custom = { ...legacy, quality: { supported:true, values:["medium", "high"], default:"medium" } };
    expect(upgradeGPTImageCapability(custom, "openai-image", "gpt-image-2").quality).toEqual(custom.quality);
    for (const model of ["gpt-image-2.5-flare", "gpt-image-2.5-sunburst"]) {
        expect(defaultImageCapabilityConfig("openai-image", model).quality.default).toBe("auto");
        expect(defaultImageCapabilityConfig("openai-image", model).quality.values).toContain("max");
    }
});
