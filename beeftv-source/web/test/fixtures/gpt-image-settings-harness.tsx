import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { ImageSettingsPanel } from "../../src/components/image-settings-panel";
import { canvasThemes } from "../../src/lib/canvas-theme";
import { defaultConfig, createModelChannel, normalizeConfigSnapshot, type AiConfig } from "../../src/stores/use-config-store";
import { defaultModelCapabilityConfig } from "../../src/lib/model-capabilities";
import { submitBackendGenerationTask } from "../../src/services/api/generation-task";
import { qualityOptions } from "../../src/pages/create/creation-types";

const models = ["gpt-image-2", "gpt-image-2.5-flare", "gpt-image-2.5-sunburst"];
const legacyProfile = defaultModelCapabilityConfig("openai-image", "gpt-image-2");
legacyProfile.image!.quality = { supported: true, values: ["auto", "low", "medium", "high"], default: "auto" };
const channel = createModelChannel({ id: "beefapi", baseUrl: "https://enterprise.beefapi.com/v1", apiKey: "fixture-only", models,
    modelProfiles: models.map((model) => ({ model, capability: "image", protocol: "openai-image", capabilityConfig: legacyProfile })) });

function Harness() {
    const [config, setConfig] = useState<AiConfig>(() => normalizeConfigSnapshot({ config: { ...defaultConfig, channels: [channel], model: "beefapi::gpt-image-2", imageModel: "beefapi::gpt-image-2", quality: "auto", size: "1024x1024", count: "1" } }).config);
    const [status, setStatus] = useState("");
    const theme = new URLSearchParams(location.search).get("theme") === "dark" ? "dark" : "light";
    return <main className="p-4" style={{ width: 360, maxWidth: "100%", color: canvasThemes[theme].node.text, background: canvasThemes[theme].canvas.background }}>
        <label>模型<select aria-label="模型" value={config.model} onChange={(event) => setConfig((old) => ({ ...old, model: event.target.value, quality: "low" }))}>
            {models.map((model) => <option key={model} value={`beefapi::${model}`}>{model}</option>)}
        </select></label>
        <ImageSettingsPanel config={config} theme={canvasThemes[theme]} onConfigChange={(key, value) => setConfig((old) => ({ ...old, [key]: value }))} />
        <button onClick={async () => { setStatus(""); try { await submitBackendGenerationTask({ config, mode: "image", prompt: "fixture cat", projectId: "fixture-project" }); setStatus("已校验"); } catch (error) { setStatus(String(error)); } }}>校验请求</button>
        <output data-testid="creation-labels">{qualityOptions.filter((item) => ["xhigh", "max"].includes(item.value)).map((item) => item.label).join("、")}</output>
        <output data-testid="selection">{JSON.stringify({ quality: config.quality, size: config.size })}</output>
        <output role="status">{status}</output>
    </main>;
}
createRoot(document.getElementById("root")!).render(<Harness />);
