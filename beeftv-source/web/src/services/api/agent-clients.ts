import { http } from "@/services/api/request";

/** 外部编辑器/CLI 接入 BeefTV 画布的客户端类型。 */
export type AgentClientKind = "codex" | "claude" | "claude-desktop" | "cursor" | "other";

/** 授予外部客户端的画布权限。 */
export type AgentClientMode = "read-only" | "read-write";

export type AgentClient = {
    id: string;
    label: string;
    kind: AgentClientKind;
    mode: AgentClientMode;
    createdAt: string;
    lastUsedAt: string | null;
};

export type AgentClientCli = {
    path: string;
    available: boolean;
    installCommand: string;
};

export type AgentClientList = {
    clients: AgentClient[];
    cli: AgentClientCli;
};

/**
 * 接入指引由后端生成：codex / claude 返回单条 `command`，cursor / other 返回 `json`。
 * 凭证只嵌在这段文本里，接口不再单独返回可展示的明文。
 */
export type AgentClientSetup = {
    kind: AgentClientKind;
    title: string;
    command?: string;
    json?: string;
};

export type AgentClientRegistration = {
    client: AgentClient;
    token: string;
    setup: AgentClientSetup;
};

export function listAgentClients(signal?: AbortSignal) {
    return http.get<AgentClientList>("/agent-clients", { signal });
}

export function createAgentClient(body: { kind: AgentClientKind; label?: string }) {
    return http.post<AgentClientRegistration>("/agent-clients", { kind: body.kind, ...(body.label ? { label: body.label } : {}) });
}

export function revokeAgentClient(id: string) {
    return http.delete<{ revoked: boolean }>(`/agent-clients/${encodeURIComponent(id)}`);
}
