import type { ModelProtocol } from "@/lib/model-protocols";
import { decodeChannelModel, encodeChannelModel, isBuiltinBeefAPIChannel, normalizeModelOptionValue, type AiConfig, type ModelChannel } from "@/stores/use-config-store";

export const MANAGED_ASSISTANT_MODELS = ["gpt-6-astra", "claude-opus-5-5", "deepseek-v4.1-flash", "glm-5.3", "gemini-3.8-flash"] as const;

/**
 * 画布助手只能走这三种对话协议：它需要多轮工具调用，
 * 生图/视频/音频协议和单轮补全协议都无法承载这个回路。
 */
export const ASSISTANT_MODEL_PROTOCOLS: ModelProtocol[] = ["chat-completion", "claude-api", "openai-response", "responses"];

/** 文本能力未显式声明协议时，渠道层按 chat-completion 发起请求，因此同样可选。 */
const DEFAULT_TEXT_PROTOCOL: ModelProtocol = "chat-completion";

function protocolSupported(protocol: ModelProtocol | undefined) {
    return ASSISTANT_MODEL_PROTOCOLS.includes(protocol?.trim() || DEFAULT_TEXT_PROTOCOL);
}

function channelAssistantModels(channel: ModelChannel, defaultTextModel: string) {
    if (channel.enabled === false) return [];
    const channelModels = new Set(channel.models);
    const available = (channel.modelProfiles || [])
        .filter((profile) => profile.capability === "text" && protocolSupported(profile.protocol))
        .map((profile) => profile.model.trim())
        .filter((model) => model && channelModels.has(model));
    const textSelection = decodeChannelModel(defaultTextModel);
    if (channel.scope !== "system" && !channel.pinned && !channel.credentialRef &&
        textSelection?.channelId === channel.id && channel.models.includes(textSelection.model) &&
        !channel.modelProfiles?.some((profile) => profile.model === textSelection.model)) {
        const protocol = channel.interfaceType || (channel.apiFormat === "claude" ? "claude-api" : channel.apiFormat === "openai" ? DEFAULT_TEXT_PROTOCOL : "unsupported");
        if (protocolSupported(protocol)) available.push(textSelection.model);
    }
    const models = isBuiltinBeefAPIChannel(channel)
        ? MANAGED_ASSISTANT_MODELS.map((model) => channel.modelAliases?.[model] || model).filter((model) => available.includes(model))
        : available;
    return models.map((model) => encodeChannelModel(channel.id, model));
}

/** 助手可选模型包含自定义渠道里没有能力档案的默认文本模型。 */
export function assistantModelOptions(config: AiConfig): string[] {
    const seen = new Set<string>();
    const options: string[] = [];
    const defaultTextModel = normalizeModelOptionValue(config.textModel, config.channels);
    for (const channel of config.channels) {
        for (const option of channelAssistantModels(channel, defaultTextModel)) {
            if (seen.has(option)) continue;
            seen.add(option);
            options.push(option);
        }
    }
    return options;
}

/**
 * 归一化已保存的助手模型：空值表示跟随默认文本模型，
 * 无效值返回空值供界面提示，不代表可以改用另一模型。
 */
export function normalizeAssistantModel(config: AiConfig, value: unknown): string {
    const candidate = normalizeModelOptionValue(value, config.channels);
    if (!candidate || !decodeChannelModel(candidate)) return "";
    return assistantModelOptions(config).includes(candidate) ? candidate : "";
}

/** 助手实际使用的模型：未单独选择时跟随默认文本模型。 */
export function resolveAssistantModel(config: AiConfig): string {
    return normalizeAssistantModel(config, config.assistantModel || config.textModel);
}
