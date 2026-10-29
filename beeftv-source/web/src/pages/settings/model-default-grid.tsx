import { AudioLines, Bot, Film, Image, MessageSquareText, ScanEye } from "lucide-react";
import { Button, Select } from "antd";
import { useEffect, useRef } from "react";

import { assistantModelOptions, normalizeAssistantModel } from "@/lib/assistant-model";
import { mediaReviewModelOptions, normalizeMediaReviewModel } from "@/lib/media-review-model";
import { groupModelsByDisplayName } from "@/lib/model-selection";
import {
    filterModelsByCapability,
    isBuiltinBeefAPIChannel,
    modelDisplayName,
    resolveModelChannel,
    type AiConfig,
    type ModelCapability,
} from "@/stores/use-config-store";
import { workspaceCapabilities } from "@/services/workspace-mode";

import { recordModelPickerChange, recordModelPickerOpenChange, recordModelPickerPress, watchModelPickerBlockers, type ModelPickerSnapshot } from "./model-settings-diagnostics";

export type DefaultModelKey = "imageModel" | "videoModel" | "textModel" | "audioModel" | "assistantModel" | "mediaReviewModel";

type CapabilityRow = {
    kind: "capability";
    id: string;
    capability: ModelCapability;
    modelKey: DefaultModelKey;
    title: string;
    icon: typeof Image;
};

type AssistantRow = {
    kind: "assistant" | "media-review";
    id: string;
    modelKey: DefaultModelKey;
    title: string;
    icon: typeof Image;
};

const rows: Array<CapabilityRow | AssistantRow> = [
    { kind: "capability", id: "image", capability: "image", modelKey: "imageModel", title: "默认生图模型", icon: Image },
    { kind: "capability", id: "video", capability: "video", modelKey: "videoModel", title: "默认视频模型", icon: Film },
    { kind: "capability", id: "text", capability: "text", modelKey: "textModel", title: "默认文本模型", icon: MessageSquareText },
    { kind: "assistant", id: "assistant", modelKey: "assistantModel", title: "助手模型", icon: Bot },
    { kind: "media-review", id: "multimodal", modelKey: "mediaReviewModel", title: "默认多模态模型", icon: ScanEye },
    { kind: "capability", id: "audio", capability: "audio", modelKey: "audioModel", title: "默认音频模型", icon: AudioLines },
];

export function ModelDefaultGrid({ config, onChange, onOpenChannels }: { config: AiConfig; onChange: (key: DefaultModelKey, model: string) => void; onOpenChannels?: () => void }) {
    const localMode = workspaceCapabilities().local;
    const rootRef = useRef<HTMLDivElement>(null);
    useEffect(() => (rootRef.current ? watchModelPickerBlockers(rootRef.current) : undefined), []);
    const buildStartedAt = performance.now();
    const assistantModel = normalizeAssistantModel(config, config.assistantModel);
    const assistantOptions = assistantModelOptions(config);
    const mediaReviewModel = normalizeMediaReviewModel(config, config.mediaReviewModel);
    const mediaReviewOptions = mediaReviewModelOptions(config);
    return (
        <div ref={rootRef} className="model-default-settings">
            <p className="text-sm text-foreground/50">默认模型使用 API 渠道配置。豆包节点在节点内选择账号直接调用，无需配置这里的默认模型。</p>
            {rows.map((row) => {
                const isAssistant = row.kind === "assistant";
                const isMediaReview = row.kind === "media-review";
                const models = row.kind === "capability" ? filterModelsByCapability(config.models, row.capability, config.channels) : isAssistant ? assistantOptions : mediaReviewOptions;
                const selected = isAssistant ? assistantModel : isMediaReview ? mediaReviewModel : config[row.modelKey];
                const groups = row.kind === "capability" && row.capability === "video"
                    ? groupModelsByDisplayName(config, models)
                    : models.map((model) => ({ key: model, models: [model] }));
                const options = groups.map((group) => {
                    const model = group.models.includes(selected) ? selected : group.models[0];
                    const label = modelDisplayName(config, model);
                    const modelChannel = resolveModelChannel(config, model);
                    const channel = isBuiltinBeefAPIChannel(modelChannel) ? "BeefTV" : modelChannel.name || "未命名渠道";
                    return { value: model, label, searchLabel: `${label} ${channel}`, channel };
                });
                if (isAssistant) options.unshift({ value: "", label: "跟随默认文本模型", searchLabel: "跟随默认文本模型", channel: "" });
                if (isMediaReview) options.unshift({ value: "", label: "不使用独立多模态模型", searchLabel: "不使用独立多模态模型", channel: "" });
                const unavailable = isAssistant || isMediaReview ? Boolean(config[row.modelKey] && !selected) : Boolean(selected && !options.some((option) => option.value === selected));
                const value = unavailable ? undefined : (isAssistant || isMediaReview) && !config[row.modelKey] ? "" : options.some((option) => option.value === selected) ? selected : undefined;
                const Icon = row.icon;
                const snapshot: ModelPickerSnapshot = { pickerId: row.id, title: row.title, optionCount: options.length, hasValue: value !== undefined && value !== "", unavailable, disabled: !options.length, buildMs: performance.now() - buildStartedAt };
                return (
                    <section key={row.id} className="model-default-setting-row" aria-labelledby={`default-${row.id}-title`}>
                        <div className="model-default-setting-label">
                            <Icon className="size-4 shrink-0 text-foreground/50" />
                            <h3 id={`default-${row.id}-title`}>{row.title}</h3>
                        </div>
                        <div className="model-default-setting-control" onPointerDownCapture={(event) => {
                            if (event.target instanceof Element && event.target.closest(".model-default-select")) recordModelPickerPress(snapshot, { x: event.clientX, y: event.clientY });
                        }}>
                            <Select
                                aria-label={row.title}
                                className="model-default-select"
                                data-model-picker-id={row.id}
                                value={value}
                                options={options}
                                placeholder={unavailable ? "已选模型不可用，请重新选择" : options.length ? "选择模型" : "暂无可用模型"}
                                disabled={!options.length}
                                showSearch={{ optionFilterProp: "searchLabel" }}
                                listHeight={256}
                                popupMatchSelectWidth
                                classNames={{ popup: { root: `model-default-select-popup model-default-select-popup-${row.id}` } }}
                                optionRender={(option) => (
                                    <div className="model-default-select-option">
                                        <span>{option.data.label}</span>
                                        {option.data.channel ? <span className="model-default-select-channel">{option.data.channel}</span> : null}
                                    </div>
                                )}
                                onOpenChange={(open) => recordModelPickerOpenChange(snapshot, open)}
                                onChange={(model) => {
                                    recordModelPickerChange(snapshot);
                                    onChange(row.modelKey, model);
                                }}
                            />
                            {!options.length && localMode && onOpenChannels ? <Button type="link" size="small" onClick={onOpenChannels}>添加模型渠道</Button> : null}
                        </div>
                    </section>
                );
            })}
        </div>
    );
}
