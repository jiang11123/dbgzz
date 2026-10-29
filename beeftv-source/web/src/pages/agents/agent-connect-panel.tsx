import { App, Button } from "antd";
import { Copy } from "lucide-react";
import { useEffect, useState } from "react";

import { useCopyText } from "@/hooks/use-copy-text";
import { createAgentClient, type AgentClientKind, type AgentClientRegistration } from "@/services/api/agent-clients";

import { agentClientKindLabel, agentClientSetupBlock } from "./agent-client-presentation";

export function AgentConnectPanel({ kind, onClose, onConfigured, verifiedClientIds, onBusyChange }: { kind: AgentClientKind | null; onClose: () => void; onConfigured: () => void; verifiedClientIds: string[]; onBusyChange: (busy: boolean) => void }) {
    const { message } = App.useApp();
    const copyText = useCopyText();
    const [submitting, setSubmitting] = useState(false);
    const [registration, setRegistration] = useState<AgentClientRegistration | null>(null);

    useEffect(() => {
        if (!kind) return;
        setSubmitting(false);
        setRegistration(null);
    }, [kind]);

    const connect = async () => {
        if (!kind) return;
        setSubmitting(true);
        onBusyChange(true);
        try {
            const result = await createAgentClient({ kind });
            setRegistration(result);
            onConfigured();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "连接失败，请稍后重试");
        } finally {
            setSubmitting(false);
            onBusyChange(false);
        }
    };

    const setup = agentClientSetupBlock(registration?.setup);
    const verified = Boolean(registration && verifiedClientIds.includes(registration.client.id));

    return (
        <div className="agent-connect-panel" aria-label={`连接 ${agentClientKindLabel(kind || "other")}`}>
            {registration && setup ? (
                <div className="flex flex-col gap-3 py-1">
                    <p role="status" className="text-sm">{verified ? "已检测到该工具访问 BeefTV，连接验证成功。" : "等待工具连接。请运行下方命令或添加配置，再在工具中启用 BeefTV。"}</p>
                    <p className="text-xs leading-5 text-foreground/60">{setup.instruction}</p>
                    <pre className="max-h-64 overflow-auto rounded-md bg-surface-active px-3.5 py-3 text-[12px] leading-5 font-mono whitespace-pre-wrap break-all text-foreground/85">{setup.text}</pre>
                    <div className="flex items-center justify-between gap-3">
                        <p className="min-w-0 text-xs leading-5 text-foreground/50">这段内容只显示一次，关掉后需要重新连接。</p>
                        <Button size="small" icon={<Copy className="size-3.5" />} onClick={() => copyText(setup.text)}>复制</Button>
                    </div>
                </div>
            ) : registration ? (
                <p className="py-2 text-xs leading-5 text-foreground/60">没有拿到接入内容，请断开后重新连接。</p>
            ) : (
                <div className="flex flex-col gap-3 py-1">
                    <p className="text-xs leading-5 text-foreground/60">连接后可使用 BeefTV 的全部创作工具。每次操作的审批由 {agentClientKindLabel(kind || "other")} 负责。</p>
                </div>
            )}
            <div className="mt-4 flex justify-end gap-2">
                <Button disabled={submitting} onClick={onClose}>{registration ? "收起" : "取消"}</Button>
                {!registration && <Button type="primary" loading={submitting} onClick={() => void connect()}>生成连接配置</Button>}
            </div>
        </div>
    );
}
