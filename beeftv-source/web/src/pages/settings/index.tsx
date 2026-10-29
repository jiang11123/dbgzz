import { App, Button } from "antd";
import { ArrowLeft } from "lucide-react";
import { useEffect, useLayoutEffect, useState, type ReactNode } from "react";
import { useNavigate, useSearchParams } from "react-router";

import { useConfigStore, useEffectiveConfig } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";
import { ChannelSettingsPane, channelValidationError, focusInvalidChannelField, isChannelReady } from "./channel-settings-pane";
import { ModelDefaultGrid } from "./model-default-grid";
import DiagnosticsPanel from "./diagnostics-panel";
import { StorageSettingsPane } from "./storage-settings-pane";
import { DepthComponentsPanel } from "@/components/depth-components-panel";
import { ReferenceStoragePane } from "./reference-storage-pane";
import { getDesktopAppBinding } from "@/services/desktop-runtime";
import { PageHeader } from "@/components/layout/workspace-page";

type ConfigSectionKey = "channels" | "models" | "storage" | "diagnostics";

export function isConfigSection(value: string | null): value is ConfigSectionKey {
    return value === "channels" || value === "storage" || value === "diagnostics";
}

export default function SettingsPage() {
    const { message } = App.useApp();
    const navigate = useNavigate();
    const [searchParams, setSearchParams] = useSearchParams();
    const requestedSection = searchParams.get("section");
    const customChannelsEnabled = useUserStore((state) => state.features.customChannelsEnabled);
    const initialSection = isConfigSection(requestedSection) ? requestedSection : "channels";
    const [activeTab, setActiveTab] = useState<ConfigSectionKey>(initialSection === "models" ? "channels" : initialSection);
    const config = useConfigStore((state) => state.config);
    const effectiveConfig = useEffectiveConfig();
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const shouldPromptContinue = searchParams.get("continue") === "1";
    const userChannels = config.channels.filter((channel) => channel.scope !== "system");
    const nativeStorage = Boolean(getDesktopAppBinding()?.StorageSettings);
    useLayoutEffect(() => {
        document.body.classList.add("app-user-overlays");
        return () => document.body.classList.remove("app-user-overlays");
    }, []);

    useEffect(() => {
        setActiveTab(isConfigSection(requestedSection) && (requestedSection !== "storage" || nativeStorage) ? requestedSection : "channels");
    }, [requestedSection, nativeStorage]);

    const selectSection = (section: ConfigSectionKey) => {
        setActiveTab(section);
        const next = new URLSearchParams(searchParams);
        next.set("section", section);
        setSearchParams(next, { replace: true });
    };

    const finishConfig = () => {
        const invalidChannel = customChannelsEnabled ? userChannels.find((channel) => channelValidationError(channel)) : undefined;
        if (invalidChannel) {
            selectSection("channels");
            message.warning(`${invalidChannel.name || "未命名渠道"}：${channelValidationError(invalidChannel)}`);
            focusInvalidChannelField(invalidChannel);
            return;
        }
        if (!effectiveConfig.channels.some(isChannelReady)) {
            selectSection("channels");
            message.error(customChannelsEnabled ? (shouldPromptContinue ? "请先完成至少一个渠道的 Base URL、API Key 和模型配置" : "当前没有可用渠道，请先完成连接信息和模型配置") : "当前没有可用的系统模型，请联系管理员配置系统渠道");
            return;
        }
        message.success("配置已保存，正在返回创作页面");
        navigate(-1);
    };

    const panes: Record<Exclude<ConfigSectionKey, "diagnostics">, ReactNode> = {
        channels: (
            <SettingsPane>
                <ChannelSettingsPane onOpenDiagnostics={() => selectSection("diagnostics")} />
                <div className="settings-section model-default-section">
                    <div className="settings-pane-header">
                        <div className="min-w-0">
                            <h2>默认模型</h2>
                        </div>
                    </div>
                    <ModelDefaultGrid config={effectiveConfig} onChange={(key, model) => updateConfig(key, model)} />
                </div>
            </SettingsPane>
        ),
        storage: (
            <SettingsPane>
                <PageHeader title="存储设置" />
                <div className="storage-settings-sections">
                    <StorageSettingsPane />
                    <ReferenceStoragePane />
                    <section className="settings-section storage-settings-block space-y-4" aria-label="深度捕捉组件">
                        <div className="settings-pane-header"><h2>深度捕捉组件</h2></div>
                        <DepthComponentsPanel />
                    </section>
                </div>
            </SettingsPane>
        ),
        models: (
            <SettingsPane>
                <div className="settings-pane-header">
                    <div className="min-w-0">
                        <h2>模型选择</h2>
                        <p>按领域选择默认模型；模型能力与请求协议在渠道“模型与能力”中配置。</p>
                    </div>
                </div>
                <div className="settings-section">
                            <ModelDefaultGrid config={effectiveConfig} onChange={(key, model) => updateConfig(key, model)} onOpenChannels={customChannelsEnabled ? () => selectSection("channels") : undefined} />
                </div>
            </SettingsPane>
        ),
    };

    return (
        <main className="settings-page app-workspace-page app-user-workspace app-section-page flex h-full min-h-0 flex-col text-foreground">
                {shouldPromptContinue ? <div className="settings-topbar shrink-0">
                    <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
                        {shouldPromptContinue ? <>
                        <Button icon={<ArrowLeft className="size-4" />} onClick={() => navigate(-1)}>返回创作</Button>
                        <Button type="primary" onClick={finishConfig}>保存并返回</Button>
                        </> : null}
                    </div>
                </div> : null}
            <div className="settings-library-frame flex min-h-0 flex-1 flex-col md:flex-row">
                <section className="settings-content flex min-h-0 min-w-0 flex-1 flex-col">
                    <div className="app-workspace-scroll app-section-page-content min-h-0 flex-1 overflow-y-auto overscroll-contain">
                        <div className="settings-pane-root mx-auto w-full max-w-none">
                            {panes[activeTab === "diagnostics" ? "channels" : activeTab]}
                        </div>
                    </div>
                </section>
            </div>
            <DiagnosticsPanel
                open={activeTab === "diagnostics"}
                onClose={() => selectSection("channels")}
                taskId={searchParams.get("taskId") || undefined}
                projectId={searchParams.get("projectId") || undefined}
            />
        </main>
    );
}

function SettingsPane({ children, fill = false }: { children: ReactNode; fill?: boolean }) {
    return <div className={fill ? "settings-pane h-full" : "settings-pane"}>{children}</div>;
}
