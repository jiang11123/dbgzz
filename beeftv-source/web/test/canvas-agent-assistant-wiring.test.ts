import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const source = read("src/services/api/agent-assistant.ts");
const hook = read("src/pages/canvas/use-canvas-assistant.ts");
const sidebar = read("src/pages/canvas/canvas-assistant-sidebar.tsx");
const composer = read("src/pages/canvas/canvas-assistant-composer.tsx");
const turn = read("src/pages/canvas/canvas-assistant-turn.tsx");
const copy = read("src/pages/canvas/canvas-assistant-copy.ts");
const project = read("src/pages/canvas/project.tsx");
const proposal = read("src/pages/canvas/use-canvas-assistant-proposal.ts");
const syncStatus = read("src/pages/canvas/canvas-sync-status.tsx");

/** 粗略取出源码里的字符串字面量与模板字符串，用于检查渲染文案。 */
function source_string_literals(code: string) {
    const literals = code.match(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g) ?? [];
    return literals.map((literal) => literal.slice(1, -1));
}

describe("助手前端接线", () => {
    test("流式对话与停止打到后端真实注册的 /api/assistant/* 路由", () => {
        // 后端 registerAgentProxyRoutes 注册的是 /assistant/chat 与 /assistant/cancel；
        // 曾经写成 /api/agent/* 时每一次发送都只拿到 404，面板永远没有回复。
        // 原生 Wails 的页面 origin 不是后端地址，必须使用当前运行时的 API base。
        expect(source).toContain('fetch(`${apiBaseURL}/assistant/chat`');
        expect(source).toContain('fetch(`${apiBaseURL}/assistant/cancel`');
        expect(source).not.toContain("/api/agent/chat");
        expect(source).not.toContain("/api/agent/cancel");
        expect(source).toContain('http.post<{ token: string; expiresAt: string }>("/assistant/ui-session"');
        expect(source).toContain('http.get<AgentHostStatus>("/assistant/status")');
    });

    test("会话、历史、撤销、重启走契约里的路由，并带 UI 会话头", () => {
        expect(source).toContain('"/assistant/host/restart"');
        expect(source).toContain("/assistant/sessions?canvasId=");
        expect(source).toContain('"/assistant/sessions"');
        expect(source).toContain('"/assistant/sessions/activate"');
        expect(source).toContain("/assistant/history?");
        expect(source).toContain("/undo");
        expect(source).toContain('"X-Beeftv-Ui-Session": token');
    });

    test("界面文案使用用户语，不出现实现者术语", () => {
        // 只看会渲染给用户的字符串字面量，避免把 DOM 变量名当成文案。
        const files = [copy, sidebar, composer, turn];
        const userFacing = files.flatMap(source_string_literals).filter((text) => /[一-鿿]/.test(text));
        expect(userFacing.length).toBeGreaterThan(10);
        for (const text of userFacing) {
            // BeefAPI 是用户自己的账户名称，属于产品名，不是实现细节；
            // 先摘掉它再检查术语，避免把品牌名误判成 "API"。
            const scrubbed = text.replaceAll("BeefAPI", "");
            for (const term of ["agent-host", "宿主", "Node", "幂等", "MCP", "revision", "API", "token", "session"]) {
                expect(scrubbed).not.toContain(term);
            }
        }
    });

    test("回合落地后画布立刻拉取最新内容，并点亮改动过的节点", () => {
        expect(hook).toContain("onCanvasChanged");
        expect(project).toContain("refreshLocalCanvasProjectIfChanged(canvasId).then(() => highlightAssistantNodes(");
    });

    test("发送时冻结选中对象快照，不随后续选择变化", () => {
        expect(hook).toContain("const selectedSnapshot = [...selectedNodeIds]");
        expect(hook).toContain("selectedSnapshot");
        // 归属也一起冻结：结果只写回发送时那个画布。
        expect(hook).toContain("const targetCanvas = activeCanvasRef.current");
    });

    test("面板是右侧停靠栏，不再是浮在画布上的绝对定位卡片", () => {
        expect(project).not.toContain("absolute right-4 top-24");
        expect(project).not.toContain("CanvasAgentAssistantPanel");
        expect(sidebar).toContain('className="canvas-assistant-sidebar"');
    });

    test("面板只使用应用里真实存在的样式变量", () => {
        const css = read("src/pages/canvas/canvas-assistant-sidebar.css");
        // 这些变量在 globals.css 里从来没有定义过；用它们会让面板变成透明白框。
        for (const missing of ["--bg-elevated", "--text-primary", "--border-color", "--bg-hover", "--text-secondary", "--accent-color", "--shadow-panel", "--bg-subtle", "--bg-input", "--canvas-panel-bg", "--canvas-panel-border"]) {
            expect(css).not.toContain(missing);
            expect(sidebar).not.toContain(missing);
        }
        expect(css).toContain("var(--background)");
        expect(css).toContain("var(--border)");
        expect(css).toContain("var(--muted-foreground)");
    });

    test("外部改动提示搬到顶栏保存状态，面板里不再重复", () => {
        expect(syncStatus).toContain("pendingExternalCanvasRevision");
        expect(syncStatus).toContain("acceptExternalCanvasRevision");
        expect(sidebar).not.toContain("pendingExternalCanvasRevision");
    });

    test("助手入口与快捷键都接上了", () => {
        const topBar = read("src/pages/canvas/canvas-project-top-bar.tsx");
        const keyboard = read("src/pages/canvas/use-canvas-keyboard.ts");
        const shortcuts = read("src/lib/canvas/canvas-shortcuts.ts");
        const selectionTools = read("src/lib/canvas/tool-registry/definitions/selection-toolbar-tools.tsx");
        const emptyState = read("src/components/canvas/canvas-short-drama-entry.tsx");
        expect(topBar).toContain("canvas-topbar-agent-button");
        expect(topBar).toContain('aria-pressed={assistantOpen}');
        expect(keyboard).toContain('key === "j"');
        expect(keyboard).toContain("onToggleAssistant?.()");
        expect(shortcuts).toContain('id: "assistant"');
        expect(selectionTools).toContain("问助手");
        expect(emptyState).toContain("或让助手搭个草案");
    });

    test("付费生成由画布既有生成链路执行，面板不自己调模型", () => {
        expect(project).toContain("runAssistantProposal");
        expect(project).toContain("useCanvasAssistantProposal");
        expect(proposal).toContain("const generateForThisRun = handleGenerateNodeRef.current");
        expect(proposal).toMatch(/generate:\s*(?:generateForThisRun\b|\([^)]*\)\s*=>\s*generateForThisRun\()/);
        expect(proposal).toContain("stillOwns: () => lifetime.matches(owner, projectIdRef.current)");
        expect(proposal).toContain("prepareAssistantProposalSnapshot");
        expect(proposal).toContain("executeAssistantProposal");
        for (const file of [sidebar, composer, turn, hook]) {
            expect(file).not.toContain("services/api/image");
            expect(file).not.toContain("channel-transport");
        }
    });
});
