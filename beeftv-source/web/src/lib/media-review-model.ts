import { encodeChannelModel, normalizeModelOptionValue, type AiConfig } from "@/stores/use-config-store";

// Match the verified video + audio adapter in modelcatalog/media_review.go.
const MEDIA_REVIEW_MODEL = "wand-vega-vl-1.0-flash";

export function mediaReviewModelOptions(config: AiConfig): string[] {
    const options: string[] = [];
    for (const channel of config.channels) {
        if (channel.enabled === false) continue;
        const model = channel.modelAliases?.[MEDIA_REVIEW_MODEL] || MEDIA_REVIEW_MODEL;
        if (!channel.models.includes(model)) continue;
        const profile = channel.modelProfiles?.find((item) => item.model === model);
        if (!profile || profile.capability !== "text" || (profile.protocol?.trim() || "chat-completion") !== "chat-completion") continue;
        options.push(encodeChannelModel(channel.id, model));
    }
    return options;
}

export function normalizeMediaReviewModel(config: AiConfig, value: unknown): string {
    const candidate = normalizeModelOptionValue(value, config.channels);
    return mediaReviewModelOptions(config).includes(candidate) ? candidate : "";
}
