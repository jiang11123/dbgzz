import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";

import { HomeDashboard } from "@/pages/home/home-dashboard";
import { CanvasShortDramaEmptyState } from "@/components/canvas/canvas-short-drama-entry";
import { CreationModeTabs } from "@/pages/create/creation-workspace";
import { selectionToolbarTools } from "@/lib/canvas/tool-registry/definitions/selection-toolbar-tools";

const root = resolve(import.meta.dir, "..");

/** 旧内置 Agent 已退场；这些模块不得回来，也不得再有 src 引用它们。 */
const RETIRED_AGENT_MODULES = [
    "src/components/canvas/canvas-cloud-agent-panel.tsx",
    "src/components/canvas/canvas-cloud-agent-chat-ui.tsx",
    "src/components/canvas/canvas-cloud-agent-settings.tsx",
    "src/components/canvas/canvas-cloud-agent.css",
    "src/components/canvas/canvas-agent-skill-library-modal.tsx",
    "src/components/canvas/canvas-agent-image-approval-settings.tsx",
    "src/components/canvas/use-agent-panel-layout.ts",
    "src/pages/create/creation-agent-entry.tsx",
    "src/pages/settings/agent-memory-pane.tsx",
    "src/services/api/agent.ts",
    "src/services/api/agent-memories.ts",
    "src/services/cloud-agent-conversations.ts",
    "src/services/agent-canvas-sync.ts",
    "src/pages/canvas/use-canvas-assistant-visibility.ts",
    "src/lib/canvas/cloud-agent-plan.ts",
    "src/lib/canvas/agent-panel-layout.ts",
    "src/lib/canvas/agent-tool-presentation.ts",
    "src/lib/canvas/agent-media-approval.ts",
    "src/lib/canvas/agent-error-presentation.ts",
    "src/lib/canvas/agent-approval-presentation.ts",
    "src/lib/canvas/agent-canvas-actions.ts",
    "src/lib/canvas/agent-debug-export.ts",
    "src/lib/canvas/agent-canvas-snapshot.ts",
    "src/components/canvas/canvas-creative-interaction.tsx",
    "src/services/creative-agent-controller.ts",
    "src/services/creative-agent-recovery.ts",
    "src/components/creation/creative-agent-cards.tsx",
    "src/components/creation/creative-agent-cards.css",
    "src/lib/creation/creative-agent-contract.ts",
    "src/lib/creation/creative-agent-state.ts",
    "src/lib/creation/creative-agent-tools.ts",
    "src/lib/creation/creative-plan.ts",
    "src/lib/creation/creative-scenarios.ts",
];

const RETIRED_AGENT_IMPORT_FRAGMENTS = [
    "canvas-cloud-agent",
    "creation-agent-entry",
    "agent-memory-pane",
    "services/api/agent\"",
    "services/api/agent'",
    "cloud-agent-conversations",
    "agent-canvas-sync",
    "use-canvas-assistant-visibility",
    "cloud-agent-plan",
    "lib/canvas/agent-approval-presentation",
    "lib/canvas/agent-canvas-actions",
    "lib/canvas/agent-debug-export",
    "lib/canvas/agent-error-presentation",
    "lib/canvas/agent-media-approval",
    "lib/canvas/agent-panel-layout",
    "lib/canvas/agent-tool-presentation",
    "lib/canvas/agent-canvas-snapshot",
    "canvas-creative-interaction",
    "creative-agent-controller",
    "creative-agent-recovery",
    "creative-agent-cards",
    "creative-agent-contract",
    "creative-agent-state",
    "creative-agent-tools",
    "lib/creation/creative-plan",
    "lib/creation/creative-scenarios",
];

/** 这两个模块名字带 agent，但服务的是保留能力，不能跟着退场一起删。 */
const RETAINED_AGENT_NAMED_MODULES = [
    "src/lib/canvas/agent-context-budget.ts",
    "src/services/agent-image-preview.ts",
];

function collectSourceFiles(directory: string): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) return collectSourceFiles(path);
        if (entry.isFile() && (path.endsWith(".ts") || path.endsWith(".tsx") || path.endsWith(".css"))) return [path];
        return [];
    });
}

describe("旧内置 Agent 页面入口退场", () => {
    test("首页不再提供 Agent 能力入口，手工创作入口仍然指向真实画布路径", () => {
        const markup = renderToStaticMarkup(
            <MemoryRouter>
                <HomeDashboard projects={[]} loading={false} error={false} onRetry={() => {}} />
            </MemoryRouter>,
        );
        expect(markup).not.toContain("BeefTV Agent");
        expect(markup).not.toContain('data-mode="agent"');
        expect(markup).toContain("新建画布创作");
        for (const [label, href] of [
            ["自由画布", "/canvas?mode=new"],
            ["视频生成", "/canvas?mode=new&amp;add=video"],
            ["图片生成", "/canvas?mode=new&amp;add=image"],
            ["音频生成", "/canvas?mode=new&amp;add=audio"],
        ] as const) {
            expect(markup).toContain(label);
            expect(markup).toContain(href);
        }
    });

    test("创作页模式切换只剩图片/视频/文本，不再渲染 Agent 模式", () => {
        const markup = renderToStaticMarkup(<CreationModeTabs mode="image" onModeChange={() => {}} />);
        expect(markup).toContain("图片");
        expect(markup).toContain("视频");
        expect(markup).toContain("文本");
        expect(markup).not.toContain("Agent");
        expect(markup).not.toContain('data-mode="agent"');
        expect(markup).toContain('data-active-mode="image"');
        // 三列网格：Agent 按钮占用的第四列必须消失。
        expect(markup).toContain("repeat(3, minmax(0, 1fr))");
        expect(markup).not.toContain("repeat(4,");
    });

    test("工作区侧栏与顶栏不再出现旧 Agent 文案", () => {
        // 侧栏导航依赖 Vite define（__APP_VERSION__）渲染，因此这里只做文案回归守卫；
        // 真实浏览器验收在实施报告中记录（.local/browser-check/check.mjs）。
        const sidebar = readFileSync(resolve(root, "src/components/layout/workspace-sidebar-nav.tsx"), "utf8");
        expect(sidebar).not.toContain("BeefTV Agent");
        const topBar = readFileSync(resolve(root, "src/components/layout/workspace-top-bar.tsx"), "utf8");
        expect(topBar).not.toContain("短剧 Agent");
        const projectsPage = readFileSync(resolve(root, "src/pages/projects/index.tsx"), "utf8");
        expect(projectsPage).not.toContain("短剧 Agent");
    });

    test("短剧起步引导不再提供「交给 Agent」路径", () => {
        const markup = renderToStaticMarkup(
            <CanvasShortDramaEmptyState onCreatePipeline={() => {}} onStartFreeform={() => {}} onUpload={() => {}} onAddText={() => {}} onAddScript={() => {}} />,
        );
        expect(markup).toContain("自己创作");
        expect(markup).toContain("自由空白画布");
        expect(markup).not.toContain("交给 Agent");
        expect(markup).not.toContain("一句话生成影视项目");
        expect(markup).toContain("md:grid-cols-2");
    });

    test("选区工具栏不再暴露发送到 Agent 的工具", () => {
        const rendered = selectionToolbarTools.map((tool) => `${tool.id}|${typeof tool.label === "string" ? tool.label : ""}`);
        expect(rendered.some((entry) => entry.includes("agent") || entry.includes("Agent"))).toBe(false);
        expect(selectionToolbarTools.map((tool) => tool.id)).toContain("selection-merge-videos");
    });

    test("名字带 agent 但服务保留能力的模块必须留下", () => {
        // agent-context-budget 约束手工工具生成的请求预算；agent-image-preview
        // 为美术评审提供看图素材。两者与旧内置 Agent 入口无关。
        for (const path of RETAINED_AGENT_NAMED_MODULES) {
            expect(existsSync(resolve(root, path))).toBe(true);
        }
        const generationTask = readFileSync(resolve(root, "src/services/api/generation-task.ts"), "utf8");
        expect(generationTask).toContain("assertAgentExchangeBudget");
        const artCritique = readFileSync(resolve(root, "src/services/art-critique-execution.ts"), "utf8");
        expect(artCritique).toContain("inspectAgentImage");
    });

    test("退场模块在源码中物理缺席且没有残留引用", () => {
        for (const path of RETIRED_AGENT_MODULES) {
            expect(existsSync(resolve(root, path))).toBe(false);
        }
        const offenders: string[] = [];
        for (const path of collectSourceFiles(resolve(root, "src"))) {
            if (!statSync(path).isFile()) continue;
            const source = readFileSync(path, "utf8");
            for (const fragment of RETIRED_AGENT_IMPORT_FRAGMENTS) {
                if (source.includes(fragment)) offenders.push(`${path.slice(root.length + 1)} -> ${fragment}`);
            }
        }
        expect(offenders).toEqual([]);
    });

    test("旧 Agent 深链参数在画布页被剥离，不会重新打开已退场的面板", () => {
        const source = readFileSync(resolve(root, "src/pages/canvas/project.tsx"), "utf8");
        expect(source).not.toContain("CanvasCloudAgentPanel");
        expect(source).not.toContain("openAgent");
        // 仍然认识旧参数，并且只做剥离，不再触发任何 Agent 行为。
        expect(source).toContain('next.delete("agent")');
        expect(source).toContain('next.delete("conversation")');
    });
});
