import type { ModelChannel } from "@/stores/use-config-store";

export type ModelProtocol = string;
export type ProtocolCapability = "text" | "image" | "video" | "audio";
export type ModelProtocolWorkflow = { id: string; label: string; providerId: string; capability: ProtocolCapability; parameters: Array<{ name: string; type: string; required?: boolean; description?: string; values?: string[]; mapping?: string }>; defaults?: Record<string, string | number | boolean> };
export type ModelProtocolDefinition = { value: ModelProtocol; label: string; vendor?: string; capability: ProtocolCapability; create: string; contentType: string; poll?: string; media: string; enabled?: boolean; baseUrl?: string; authType?: string; workflows?: ModelProtocolWorkflow[] };

export function protocolGroups(protocols: ModelProtocolDefinition[]) {
    return (["text", "image", "video", "audio"] as ProtocolCapability[]).map((capability) => ({ label: { text: "文本", image: "图片", video: "视频", audio: "音频" }[capability], options: protocols.filter((item) => item.capability === capability && item.enabled !== false).map((item) => ({ label: `${item.label} · ${item.create.replace(/^POST /, "")}`, value: item.value })) }));
}
export function modelProtocolDefinition(value: string | undefined, definitions: ModelProtocolDefinition[] = []) { return definitions.find((item) => item.value === value); }
export function modelProtocolLabel(value: string | undefined, definitions: ModelProtocolDefinition[] = []) { return modelProtocolDefinition(value, definitions)?.label || (value ? value : "未安装协议"); }
// Protocol → capability for the protocols the host ships without a plugin
// catalog. Runtime definitions win; unknown/custom ids stay unresolved so a
// user's own contract is never silently rewritten.
const BUILTIN_PROTOCOL_CAPABILITIES: Record<ModelProtocol, ProtocolCapability> = {
    "chat-completion": "text",
    "openai-response": "text",
    responses: "text",
    "claude-api": "text",
    "gemini-generate-content": "text",
    "openai-image": "image",
    "openai-videos": "video",
    "gemini-image": "image",
    "grok-image": "image",
    "volcengine-ark-image": "image",
    "volcengine-ark-agent-plan-image": "image",
    "volcengine-jimeng-image": "image",
    newapi: "video",
    "newapi-channel-1": "video",
    "newapi-channel-2": "video",
    "video-generations-json": "video",
    "xai-video": "video",
    "volcengine-ark-video": "video",
    "volcengine-ark-agent-plan-video": "video",
    "volcengine-jimeng-video": "video",
    "gemini-veo": "video",
    "novita-video": "video",
    "minimax-video": "video",
    "agnes-video": "video",
    "full-video": "video",
    "openai-audio": "audio",
    "async-audio": "audio",
};
export function modelProtocolCapability(value: string | undefined, definitions: ModelProtocolDefinition[] = []) {
    const definition = modelProtocolDefinition(value, definitions);
    if (definition) return definition.capability;
    return value ? BUILTIN_PROTOCOL_CAPABILITIES[value] : undefined;
}
export function isVolcengineArkImageProtocol(protocol?: string) {
    return protocol === "volcengine-ark-image" || protocol === "volcengine-ark-agent-plan-image";
}
export function isVolcengineArkVideoProtocol(protocol?: string) {
    return protocol === "volcengine-ark-video" || protocol === "volcengine-ark-agent-plan-video";
}
export function protocolForModelCatalog(_endpointTypes: string[] = []): ModelProtocol | undefined {
    // A provider catalog cannot invent a protocol ID. The channel's selected
    // plugin or an explicit model configuration must supply it.
    return undefined;
}
export function protocolForBeefAPICatalog(endpointTypes: string[] = []): ModelProtocol | undefined {
    // Only explicit wire contracts map to host protocol IDs; generic "openai"
    // metadata cannot replace a user's configured protocol.
    const endpoints = endpointTypes.map((value) => value.trim().toLowerCase());
    const mappings: Array<[string, string[]]> = [
        ["openai-image", ["image-generation", "images", "images.generations"]],
        ["openai-videos", ["openai-video", "videos", "videos.generations"]],
        ["openai-audio", ["audio.speech", "audio-speech"]],
        ["openai-response", ["openai-response", "openai-response-compact", "responses"]],
        ["claude-api", ["anthropic", "messages"]],
        ["gemini-generate-content", ["gemini"]],
        ["chat-completion", ["chat.completions", "chat-completions"]],
    ];
    return mappings.find(([, aliases]) => aliases.some((alias) => endpoints.includes(alias)))?.[0];
}
export function modelProtocolSummary(value: string | undefined, definitions: ModelProtocolDefinition[] = []) { const protocol = modelProtocolDefinition(value, definitions); return protocol ? [protocol.create, protocol.contentType, protocol.poll, protocol.media].filter(Boolean).join(" · ") : "当前协议未安装或尚未选择。"; }
export function normalizeModelProtocol(value: unknown): ModelProtocol | undefined {
    const protocol = typeof value === "string" && value.trim() ? value.trim() : undefined;
    return protocol === "google-gemini-generate-content" ? "gemini-generate-content" : protocol;
}

const STANDARD_PROTOCOLS: Record<ProtocolCapability, ModelProtocol[]> = {
    text: ["chat-completion", "openai-response"],
    image: ["openai-image"],
    video: ["newapi-channel-2", "newapi"],
    audio: ["openai-audio"],
};

const FALLBACK_PROTOCOLS: Record<ProtocolCapability, ModelProtocol> = {
    text: "chat-completion",
    image: "openai-image",
    video: "newapi-channel-2",
    audio: "openai-audio",
};

export function inferProtocolCapabilityFromModel(model: string): ProtocolCapability {
    const lower = model.toLowerCase();
    if (
        lower.includes("audio") ||
        lower.includes("tts") ||
        lower.includes("voice") ||
        lower.includes("speech") ||
        lower.includes("sound") ||
        lower.includes("music")
    ) {
        return "audio";
    }
    if (
        lower.includes("seedream") ||
        lower.includes("gpt-image") ||
        lower.includes("image") ||
        lower.includes("dall-e") ||
        lower.includes("dalle") ||
        lower.includes("flux") ||
        lower.includes("imagen") ||
        lower.includes("banana") ||
        lower.includes("midjourney") ||
        lower.includes("sdxl") ||
        lower.includes("stable-diffusion")
    ) {
        return "image";
    }
    if (
        lower.includes("video") ||
        lower.includes("sora") ||
        lower.includes("veo") ||
        lower.includes("kling") ||
        lower.includes("seedance") ||
        lower.includes("minimax-video") ||
        lower.includes("hailuo") ||
        lower.includes("pika") ||
        lower.includes("runway") ||
        lower.includes("omni") ||
        lower.includes("cogvideo") ||
        lower.includes("wan")
    ) {
        return "video";
    }
    return "text";
}

export function defaultProtocolForCapability(capability: ProtocolCapability, availableProtocols: ModelProtocolDefinition[] = []): ModelProtocol {
    for (const id of STANDARD_PROTOCOLS[capability] || []) {
        if (!availableProtocols.length || availableProtocols.some((item) => item.value === id && item.enabled !== false)) return id;
    }
    const matched = availableProtocols.find((item) => item.capability === capability && item.enabled !== false);
    return matched?.value || FALLBACK_PROTOCOLS[capability] || "chat-completion";
}

export function defaultProtocolForModel(model: string, availableProtocols: ModelProtocolDefinition[] = []): ModelProtocol {
    return defaultProtocolForCapability(inferProtocolCapabilityFromModel(model), availableProtocols);
}

export function usesOpenAICompatibleProtocolDefault(apiFormat?: string) {
    return apiFormat !== "gemini" && apiFormat !== "claude";
}

type ChannelModelProfile = NonNullable<ModelChannel["modelProfiles"]>[number];

export function ensureModelProfilesWithUiDefaults(
    models: string[],
    profiles: Array<Omit<ChannelModelProfile, "capability"> & { capability?: ProtocolCapability }> | undefined,
    availableProtocols: ModelProtocolDefinition[] = [],
    apiFormat?: string,
): ChannelModelProfile[] {
    const byModel = new Map((profiles || []).filter((item) => models.includes(item.model)).map((item) => [item.model, item]));
    return models.map((model) => {
        const current = byModel.get(model);
        if (current?.protocol && current.capability) return { ...current, capability: current.capability, protocol: current.protocol };
        const capability = current?.capability || modelProtocolCapability(current?.protocol, availableProtocols) || inferProtocolCapabilityFromModel(model);
        const protocol = current?.protocol || (capability !== "video" && usesOpenAICompatibleProtocolDefault(apiFormat) ? defaultProtocolForCapability(capability, availableProtocols) : undefined);
        return { ...current, model, capability, protocol };
    });
}
