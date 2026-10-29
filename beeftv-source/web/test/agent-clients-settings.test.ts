import { describe, expect, test } from "bun:test";

import { assistantModelOptions, normalizeAssistantModel, resolveAssistantModel } from "@/lib/assistant-model";
import { agentClientLastUsedLabel, agentClientModeLabel, agentClientModeSummary, agentClientSetupBlock } from "@/pages/agents/agent-client-presentation";
import { createAgentClient, listAgentClients, revokeAgentClient } from "@/services/api/agent-clients";
import { ApiError, apiClient } from "@/services/api/request";
import { createModelChannel, defaultConfig, type AiConfig, type ModelChannel } from "@/stores/use-config-store";

type Recorded = { method?: string; url?: string; data?: unknown };

async function withStubbedApi<T>(envelope: unknown, status: number, run: (recorded: Recorded[]) => Promise<T>) {
    const original = apiClient.request;
    const recorded: Recorded[] = [];
    apiClient.request = (async (config: Recorded) => {
        recorded.push({ method: config.method, url: config.url, data: config.data });
        if (status >= 400) {
            throw { isAxiosError: true, message: `Request failed with status code ${status}`, response: { status, data: envelope, headers: {} } };
        }
        return { data: envelope, status, headers: {} };
    }) as typeof apiClient.request;
    try {
        return await run(recorded);
    } finally {
        apiClient.request = original;
    }
}

describe("外部 Agent 接入 API", () => {
    test("旧版只读连接保持只读提示，新连接使用全部创作工具", () => {
        expect(agentClientModeLabel("read-only")).toBe("旧版只读连接");
        expect(agentClientModeSummary("read-only")).toContain("重新连接");
        expect(agentClientModeLabel("read-write")).toBe("全部创作工具");
    });
    test("列表按信封解包，并同时给出已连接客户端和命令行工具状态", async () => {
        const data = {
            clients: [{ id: "c-1", label: "Codex", kind: "codex", mode: "read-only", createdAt: "2026-09-20T02:00:00Z", lastUsedAt: null }],
            cli: { path: "/Applications/BeefTV.app/Contents/Resources/beeftv", available: true, installCommand: "ln -s /x/beeftv /usr/local/bin/beeftv" },
        };
        await withStubbedApi({ code: 0, data, msg: "ok" }, 200, async (recorded) => {
            await expect(listAgentClients()).resolves.toEqual(data);
            expect(recorded[0]).toMatchObject({ method: "get", url: "/agent-clients" });
        });
    });

    test("创建只提交类型，并解包出一次性接入内容", async () => {
        const data = {
            client: { id: "c-2", label: "Cursor", kind: "cursor", mode: "read-write", createdAt: "2026-09-20T02:00:00Z", lastUsedAt: null },
            token: "secret-token",
            setup: { kind: "cursor", title: "Cursor", json: '{"mcpServers":{}}' },
        };
        await withStubbedApi({ code: 0, data, msg: "ok" }, 200, async (recorded) => {
            await expect(createAgentClient({ kind: "cursor" })).resolves.toEqual(data);
            expect(recorded[0]).toMatchObject({ method: "post", url: "/agent-clients", data: { kind: "cursor" } });
        });
    });

    test("断开对 id 做路径转义，并解包 revoked", async () => {
        await withStubbedApi({ code: 0, data: { revoked: true }, msg: "ok" }, 200, async (recorded) => {
            await expect(revokeAgentClient("c 3/4")).resolves.toEqual({ revoked: true });
            expect(recorded[0]).toMatchObject({ method: "delete", url: "/agent-clients/c%203%2F4" });
        });
    });

    test("后端还没有这个能力时抛出可识别的 404，页面据此显示空态", async () => {
        await withStubbedApi({ code: 40401, data: null, msg: "not found", reason: "not_found" }, 404, async () => {
            const thrown = await listAgentClients().catch((error) => error);
            expect(thrown).toBeInstanceOf(ApiError);
            expect(thrown).toMatchObject({ status: 404, reason: "not_found" });
        });
    });
});

describe("接入内容按客户端类型选命令或配置", () => {
    test("Claude Desktop 使用配置文件而非 Claude Code 命令", () => {
        const block = agentClientSetupBlock({ kind: "claude-desktop", title: "T", json: '{"mcpServers":{"beeftv":{}}}' });
        expect(block?.format).toBe("json");
        expect(block?.instruction).toContain("保留已有服务");
        expect(block?.instruction).toContain("完全退出");
        expect(block?.instruction).not.toContain("终端运行");
    });
    test("codex / claude 展示终端命令", () => {
        for (const kind of ["codex", "claude"] as const) {
            const block = agentClientSetupBlock({ kind, title: "T", command: "beeftv mcp add", json: '{"mcpServers":{}}' });
            expect(block).toMatchObject({ text: "beeftv mcp add", format: "command" });
            expect(block?.instruction).toContain("PowerShell");
        }
    });

    test("cursor 展示配置并指向 ~/.cursor/mcp.json", () => {
        const block = agentClientSetupBlock({ kind: "cursor", title: "T", command: "beeftv mcp add", json: '{"mcpServers":{"beeftv":{}}}' });
        expect(block).toMatchObject({ text: '{"mcpServers":{"beeftv":{}}}', format: "json", instruction: "粘贴到 ~/.cursor/mcp.json。" });
    });

    test("其他 MCP 客户端展示配置，指引不提 Cursor 的路径", () => {
        const block = agentClientSetupBlock({ kind: "other", title: "T", json: '{"mcpServers":{}}' });
        expect(block?.format).toBe("json");
        expect(block?.instruction).not.toContain(".cursor");
    });

    test("只给到另一种形式时按实际内容展示，不留空白", () => {
        expect(agentClientSetupBlock({ kind: "codex", title: "T", json: '{"mcpServers":{}}' })).toMatchObject({ format: "json" });
        expect(agentClientSetupBlock({ kind: "cursor", title: "T", command: "beeftv mcp add" })).toMatchObject({ format: "command" });
        expect(agentClientSetupBlock({ kind: "codex", title: "T" })).toBeNull();
        expect(agentClientSetupBlock(undefined)).toBeNull();
    });
});

describe("最近使用时间", () => {
    const now = Date.parse("2026-09-29T12:00:00Z");

    test("没用过就说没用过", () => {
        expect(agentClientLastUsedLabel(null, now)).toBe("还没用过");
        expect(agentClientLastUsedLabel("", now)).toBe("还没用过");
        expect(agentClientLastUsedLabel("not-a-date", now)).toBe("还没用过");
    });

    test("按相对时间收敛到一句话", () => {
        expect(agentClientLastUsedLabel("2026-09-29T11:59:30Z", now)).toBe("刚刚");
        expect(agentClientLastUsedLabel("2026-09-29T11:30:00Z", now)).toBe("30 分钟前");
        expect(agentClientLastUsedLabel("2026-09-29T06:00:00Z", now)).toBe("6 小时前");
        expect(agentClientLastUsedLabel("2026-09-26T12:00:00Z", now)).toBe("3 天前");
        expect(agentClientLastUsedLabel("2026-01-05T12:00:00Z", now)).toContain("2026");
    });
});

function configWithChannels(channels: ModelChannel[], overrides: Partial<AiConfig> = {}): AiConfig {
    return { ...defaultConfig, channels, ...overrides };
}

function channel(id: string, profiles: Array<{ model: string; capability: "text" | "image"; protocol?: string }>, enabled = true): ModelChannel {
    return createModelChannel({
        id,
        name: `渠道 ${id}`,
        enabled,
        models: profiles.map((profile) => profile.model),
        modelProfiles: profiles.map((profile) => ({ model: profile.model, capability: profile.capability, protocol: profile.protocol })),
    });
}

describe("助手模型可选项", () => {
    const config = configWithChannels([
        channel("a", [
            { model: "chat-1", capability: "text", protocol: "chat-completion" },
            { model: "claude-1", capability: "text", protocol: "claude-api" },
            { model: "resp-1", capability: "text", protocol: "responses" },
            { model: "legacy-1", capability: "text", protocol: "openai-completion" },
            { model: "img-1", capability: "image", protocol: "openai-image" },
        ]),
        channel("b", [{ model: "chat-2", capability: "text", protocol: "chat-completion" }], false),
    ]);

    test("只留文本能力且协议受支持的模型，值形如 channelId::modelId", () => {
        expect(assistantModelOptions(config)).toEqual(["a::chat-1", "a::claude-1", "a::resp-1"]);
    });

    test("未启用渠道的模型不出现在可选项里", () => {
        expect(assistantModelOptions(config)).not.toContain("b::chat-2");
    });

    test("文本模型没写协议时按对话协议处理，仍然可选", () => {
        const implicit = configWithChannels([channel("c", [{ model: "chat-3", capability: "text" }])]);
        expect(assistantModelOptions(implicit)).toEqual(["c::chat-3"]);
    });
});

describe("助手模型的保存值", () => {
    const config = configWithChannels([channel("a", [{ model: "chat-1", capability: "text", protocol: "chat-completion" }])], { textModel: "a::chat-1" });

    test("空值表示跟随默认文本模型", () => {
        expect(normalizeAssistantModel(config, "")).toBe("");
        expect(normalizeAssistantModel(config, undefined)).toBe("");
        expect(resolveAssistantModel(config)).toBe("a::chat-1");
    });

    test("保存的是渠道加模型的完整取值", () => {
        expect(normalizeAssistantModel(config, "a::chat-1")).toBe("a::chat-1");
        expect(resolveAssistantModel({ ...config, assistantModel: "a::chat-1" })).toBe("a::chat-1");
    });

    test("指向已消失的渠道或不支持的协议时回落到跟随默认", () => {
        expect(normalizeAssistantModel(config, "gone::chat-1")).toBe("");
        const unsupported = configWithChannels([channel("a", [{ model: "img-1", capability: "image", protocol: "openai-image" }])], { textModel: "" });
        expect(normalizeAssistantModel(unsupported, "a::img-1")).toBe("");
        expect(resolveAssistantModel({ ...unsupported, assistantModel: "a::img-1" })).toBe("");
    });

    test("默认配置带上助手模型字段，默认为空", () => {
        expect(defaultConfig.assistantModel).toBe("");
    });
});
