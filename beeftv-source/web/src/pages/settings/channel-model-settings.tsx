import { useEffect, useState } from "react";
import { Alert, App, Button, Popconfirm, Segmented, Tag } from "antd";
import { ReferenceMediaTransportFields } from "./reference-media-transport-fields";
import { ChevronRight, FlaskConical, Settings2 } from "lucide-react";

import { ModelEditorModal } from "@/components/model-editor-modal";
import { ModelProtocolBrowser } from "@/components/model-protocol-browser";
import { testChannelModelConnection } from "@/lib/model-connection-test";
import { seedancePortraitLabel } from "@/lib/seedance-portrait";
import { ModelCapabilityEditor } from "@/components/model-capability-editor";
import { type ModelCapabilityChoice } from "@/components/model-protocol-picker";
import { defaultModelCapabilityConfig } from "@/lib/model-capabilities";
import { defaultProtocolForCapability, defaultProtocolForModel, inferProtocolCapabilityFromModel, modelProtocolCapability, modelProtocolDefinition, type ModelProtocol, type ModelProtocolDefinition } from "@/lib/model-protocols";
import { fetchPluginProviderCatalog } from "@/services/api/plugin-catalog";
import { modelOptionName, type ModelChannel } from "@/stores/use-config-store";
import { currentModelConnectionReceipt, useModelConnectionTests } from "@/stores/use-model-connection-tests";

type ModelProfile = NonNullable<ModelChannel["modelProfiles"]>[number];

export function ChannelModelSettings({ channel, onChange, draft = false }: { channel: ModelChannel; onChange: (profiles: ModelProfile[]) => void; draft?: boolean }) {
    const { message } = App.useApp();
    const [testingModel, setTestingModel] = useState("");
    const [editorTab, setEditorTab] = useState("protocol");
    const [protocolLoading, setProtocolLoading] = useState(true);
    const [protocolError, setProtocolError] = useState("");
    const [activeModel, setActiveModel] = useState<string | null>(null);
    const [availableProtocols, setAvailableProtocols] = useState<ModelProtocolDefinition[]>([]);
    const { receipts, record } = useModelConnectionTests();
    const testResult = activeModel ? currentModelConnectionReceipt(receipts, channel, activeModel) : undefined;

    useEffect(() => {
        let active = true;
        void fetchPluginProviderCatalog("user.custom-channel").then((items) => { if (active) setAvailableProtocols(items); })
            .catch((error) => { if (active) setProtocolError(error instanceof Error ? error.message : "协议目录读取失败"); })
            .finally(() => { if (active) setProtocolLoading(false); });
        return () => { active = false; };
    }, []);

    if (!channel.models.length) return (
        <div className="mt-4">
            <div className="text-xs font-medium">模型能力与请求协议</div>
            <p className="mt-2 text-xs leading-5 text-foreground/58">
                先在上方「模型列表」输入模型名并按回车，再为模型选择能力与请求协议。
            </p>
        </div>
    );

    const updateProfile = (model: string, patch: Partial<ModelProfile>) => {
        const defaultProtocol = inferProtocolCapabilityFromModel(model) === "video" ? channel.interfaceType : defaultProtocolForModel(model, availableProtocols);
        const defaultCap = modelProtocolCapability(defaultProtocol, availableProtocols) || inferProtocolCapabilityFromModel(model);
        const current = channel.modelProfiles?.find((item) => item.model === model) || {
            model,
            capability: defaultCap,
            protocol: defaultProtocol,
            capabilityConfig: defaultModelCapabilityConfig(defaultProtocol, model),
        };
        const nextProfile = { ...current, ...patch, model };
        if ("protocol" in patch) nextProfile.authType = modelProtocolDefinition(nextProfile.protocol, availableProtocols)?.authType;
        const next = [...(channel.modelProfiles || []).filter((item) => item.model !== model), nextProfile];
        onChange(next.filter((item) => channel.models.includes(item.model)));
    };

    const testModel = async (model: string, capability: ModelProfile["capability"], protocol: ModelProtocol) => {
        setTestingModel(model);
        try {
            const detail = await testChannelModelConnection(channel, model, capability, protocol);
            record(channel, model, { success: true, detail });
            message.success(`模型测试通过：${detail}`);
        } catch (error) {
            const detail = error instanceof Error ? error.message : "模型测试失败";
            record(channel, model, { success: false, detail });
            message.error(detail);
        } finally {
            setTestingModel("");
        }
    };

    const activeModelProfile = activeModel ? channel.modelProfiles?.find((item) => item.model === activeModel) : undefined;
    const inferredProtocol = activeModel ? (inferProtocolCapabilityFromModel(activeModel) === "video" ? channel.interfaceType || "" : defaultProtocolForModel(activeModel, availableProtocols)) : "";
    const activeProtocol = activeModelProfile ? activeModelProfile.protocol || channel.interfaceType || "" : inferredProtocol;
    const activeCapability = activeModelProfile?.capability || modelProtocolCapability(activeProtocol, availableProtocols) || (activeModel ? inferProtocolCapabilityFromModel(activeModel) : "text");

    return (
        <div className="mt-4">
            <div className="mb-2 flex items-center justify-between gap-3">
                <div>
                    <div className="text-xs font-medium">模型能力与请求协议</div>
                    <div className="mt-0.5 text-[var(--fs-tiny)] text-foreground/42">按服务商要求调整参数，也可以生成一次来验证连接。</div>
                </div>
                <span className="text-[var(--fs-tiny)] text-foreground/35">{channel.models.length} 个模型</span>
            </div>
            <div className="space-y-2">
                {channel.models.map((rawModel) => {
                    const model = modelOptionName(rawModel);
                    const profile = channel.modelProfiles?.find((item) => item.model === model);
                    const protocol = profile ? profile.protocol || channel.interfaceType || "" : (inferProtocolCapabilityFromModel(model) === "video" ? channel.interfaceType || "" : defaultProtocolForModel(model, availableProtocols));
                    const capability = profile?.capability || modelProtocolCapability(protocol, availableProtocols) || inferProtocolCapabilityFromModel(model);
                    const displayName = seedancePortraitLabel(model) || profile?.displayName?.trim() || model;
                    return (
                        <div key={model} className="flex min-w-0 items-center gap-3 rounded-md bg-surface-active px-3 py-2.5 transition-colors hover:bg-surface-hover">
                            <span className="grid size-8 shrink-0 place-items-center rounded-md bg-foreground/[.045] text-foreground/65">
                                <Settings2 className="size-4" />
                            </span>
                            <div className="min-w-0 flex-1">
                                <div className="truncate text-xs font-medium" title={displayName === model ? model : `${displayName} (${model})`}>
                                    {displayName}
                                </div>
                                <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5">
                                    <Tag className="mr-0 text-[var(--fs-tiny)]" bordered={false}>
                                        {capabilityLabel(capability)}
                                    </Tag>
                                    <span className="truncate font-mono text-[var(--fs-tiny)] text-foreground/40" title={modelProtocolDefinition(protocol, availableProtocols)?.create}>
                                        {modelProtocolDefinition(protocol, availableProtocols)?.create || "待配置请求协议"}
                                    </span>
                                </div>
                            </div>
                            <Button type="text" size="small" icon={<ChevronRight className="size-4" />} iconPosition="end" onClick={() => { setEditorTab("protocol"); setActiveModel(model); }}>
                                配置使用
                            </Button>
                        </div>
                    );
                })}
            </div>
            <ModelEditorModal
                open={Boolean(activeModel)}
                busy={Boolean(testingModel)}
                title="编辑模型使用配置"
                subtitle={activeModel || ""}
                activeKey={editorTab}
                onTabChange={setEditorTab}
                onClose={() => setActiveModel(null)}
                footer={
                    <div className="model-editor-footer">
                        <span className="text-xs text-foreground/50">{draft ? "完成后，点击「保存并使用」保存更改" : "更改实时保存到本地工作区"}</span>
                        <div className="model-editor-footer-actions">
                            <Popconfirm title="生成一次测试结果？" description="会向当前服务商提交真实生成任务，费用由服务商收取。结果可在任务中心查看。" okText="开始生成" cancelText="取消" onConfirm={() => { if (activeModel && activeProtocol) void testModel(activeModel, activeCapability, activeProtocol); }}>
                            <Button
                                icon={<FlaskConical className="size-4" />}
                                loading={Boolean(testingModel)}
                                disabled={!activeProtocol || protocolLoading || Boolean(protocolError)}
                            >
                                生成测试
                            </Button>
                            </Popconfirm>
                            <Button disabled={Boolean(testingModel)} onClick={() => setActiveModel(null)}>完成</Button>
                        </div>
                    </div>
                }
                items={activeModel ? [
                    {
                        key: "protocol",
                        label: "基本信息",
                        children: <div className="space-y-4" inert={Boolean(testingModel)}>
                            {!testingModel && testResult && <Alert type={testResult.success ? "success" : "error"} title={testResult.detail} showIcon />}
                            <section className="space-y-2">
                                <div className="text-xs font-medium">模型能力</div>
                                <Segmented<ModelCapabilityChoice>
                                    block
                                    options={[{ label: "文本", value: "text" }, { label: "图片", value: "image" }, { label: "视频", value: "video" }, { label: "音频", value: "audio" }]}
                                    value={activeCapability}
                                    onChange={(nextCapability) => {
                                        const nextProtocol = availableProtocols.find((item) => item.value === activeProtocol && item.capability === nextCapability && item.enabled !== false)?.value || (nextCapability === "video" ? undefined : defaultProtocolForCapability(nextCapability, availableProtocols));
                                        updateProfile(activeModel, {
                                            protocol: nextProtocol,
                                            capability: nextCapability,
                                            capabilityConfig: nextCapability === "image" || nextCapability === "video" ? defaultModelCapabilityConfig(nextProtocol, activeModel) : undefined,
                                        });
                                    }}
                                />
                            </section>
                            {channel.scope !== "system" && activeCapability !== "text" && activeProtocol !== "full-video" && <ReferenceMediaTransportFields value={activeModelProfile?.referenceMediaTransport} onChange={(referenceMediaTransport) => updateProfile(activeModel, { referenceMediaTransport })} />}
                            <section className="space-y-2">
                                <div className="text-xs font-medium">请求协议</div>
                                <ModelProtocolBrowser
                                    loading={protocolLoading}
                                    error={protocolError}
                                    capability={activeCapability}
                                    value={activeProtocol}
                                    protocols={availableProtocols}
                                    onChange={(nextProtocol) => updateProfile(activeModel, {
                                        protocol: nextProtocol,
                                        capabilityConfig: activeCapability === "image" || activeCapability === "video" ? defaultModelCapabilityConfig(nextProtocol, activeModel) : undefined,
                                    })}
                                />
                            </section>
                        </div>,
                    },
                    {
                        key: "capabilities",
                        label: "能力与参数",
                        children: <div inert={Boolean(testingModel)}>
                            {activeCapability === "image" || activeCapability === "video" ? (
                                <ModelCapabilityEditor
                                    capability={activeCapability}
                                    model={activeModel}
                                    value={activeModelProfile?.capabilityConfig || defaultModelCapabilityConfig(activeProtocol, activeModel)}
                                    protocol={activeProtocol}
                                    onChange={(capabilityConfig) => updateProfile(activeModel, { capabilityConfig })}
                                />
                            ) : <p className="text-xs text-foreground/50">当前模型类型无需额外配置引用与参数。</p>}
                        </div>,
                    },
                ] : []}
            />
        </div>
    );
}

function capabilityLabel(value: ModelProfile["capability"]) {
    return { text: "文本", image: "图片", video: "视频", audio: "音频", "": "待配置" }[value] || "待配置";
}
