import { describe, expect, test } from "bun:test";

import { canvasContentSnapshot, sameCanvasContent, sameCanvasDocument } from "@/lib/canvas/canvas-content";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";

function project(patch: Record<string, unknown> = {}): CanvasProject {
    return {
        id: "c1",
        revision: 3,
        title: "画布",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        nodes: [],
        connections: [],
        chatSessions: [],
        activeChatId: null,
        backgroundMode: "grid",
        showImageInfo: false,
        viewport: { x: 0, y: 0, k: 1 },
        directorScenes: [],
        ...patch,
    } as unknown as CanvasProject;
}

// 字段覆盖：任何文档字段的本地差异都必须被判为「有未确认编辑」。
// 旧实现用七字段白名单，folderId/projectId/canvasTitle 这类字段的编辑会被静默漏判。
const DOCUMENT_FIELD_CASES: Array<[string, Record<string, unknown>]> = [
    ["title", { title: "改过的标题" }],
    ["folderId", { folderId: "folder-1" }],
    ["projectId", { projectId: "domain-project" }],
    ["canvasTitle", { canvasTitle: "画布别名" }],
    ["workspaceProjectId", { workspaceProjectId: "ws-2" }],
    ["nodes", { nodes: [{ id: "n1", type: "text", title: "节点", position: { x: 0, y: 0 }, width: 100, height: 100, metadata: {} }] }],
    ["connections", { connections: [{ id: "e1", fromNodeId: "n1", toNodeId: "n2" }] }],
    ["chatSessions", { chatSessions: [{ id: "s1", title: "会话", messages: [] }] }],
    ["activeChatId", { activeChatId: "s1" }],
    ["timeline", { timeline: { version: 2, tracks: [], clips: [], durationMs: 0 } }],
    ["directorScenes", { directorScenes: [{ id: "scene-1" }] }],
    ["starterMode", { starterMode: "short-drama" }],
];

describe("sameCanvasDocument 的字段规则", () => {
    for (const [field, patch] of DOCUMENT_FIELD_CASES) {
        test(`${field} 的本地差异必须被识别`, () => {
            expect(sameCanvasDocument(project(), project(patch))).toBe(false);
        });
    }

    test("本机查看偏好与服务端元数据不构成文档编辑", () => {
        expect(sameCanvasDocument(project(), project({ appearance: { mode: "light" } }))).toBe(true);
        expect(sameCanvasDocument(project(), project({ backgroundMode: "dots" }))).toBe(true);
        expect(sameCanvasDocument(project(), project({ showImageInfo: true }))).toBe(true);
        expect(sameCanvasDocument(project(), project({ viewport: { x: 900, y: -20, k: 2 } }))).toBe(true);
        expect(sameCanvasDocument(project(), project({ updatedAt: "2099-01-01T00:00:00.000Z" }))).toBe(true);
        expect(sameCanvasDocument(project(), project({ revision: 99 }))).toBe(true);
    });

    test("外部写入的缺字段文档不会因为本机外观偏好或空默认值被判成有未确认编辑", () => {
        // 服务端/外部入口产出的画布可能完全没有外观、背景与会话数组。
        const external = { id: "c1", revision: 5, title: "画布", nodes: [], connections: [] } as unknown as CanvasProject;
        const local = project({ appearance: { mode: "dark" }, backgroundMode: "grid", showImageInfo: true, chatSessions: [], activeChatId: null, directorScenes: [] });
        expect(sameCanvasDocument(external, local)).toBe(true);
    });

    test("缺字段只在对方为空值时才等价：非空值一律算差异", () => {
        const withoutFolder = project();
        delete (withoutFolder as unknown as Record<string, unknown>).folderId;

        // 本地把画布移进文件夹（服务端这一版还没有该字段）→ 必须识别为用户编辑。
        expect(sameCanvasDocument(withoutFolder, project({ folderId: "folder-9" }))).toBe(false);
        // 服务端有文件夹、本地缺字段 → 同样必须识别。
        expect(sameCanvasDocument(project({ folderId: "folder-9" }), withoutFolder)).toBe(false);
        // 空字符串文件夹等价于没有文件夹。
        expect(sameCanvasDocument(withoutFolder, project({ folderId: "" }))).toBe(true);
    });

    test("文档内容一致时相等，与整份内容比较（sameCanvasContent）区分开", () => {
        const base = project();
        expect(sameCanvasDocument(base, project({ viewport: { x: 5, y: 5, k: 1 } }))).toBe(true);
        expect(sameCanvasContent(base, project({ viewport: { x: 5, y: 5, k: 1 } }))).toBe(true);
        // 外观差异：整份内容比较会判为不同，文档比较按本机偏好容忍。
        expect(sameCanvasContent(base, project({ backgroundMode: "dots" }))).toBe(false);
        expect(sameCanvasDocument(base, project({ backgroundMode: "dots" }))).toBe(true);
    });

    test("canvasContentSnapshot 仍是拒绝字段的唯一来源（视口/时间戳/revision/远端哈希）", () => {
        const snapshot = canvasContentSnapshot(project({ viewport: { x: 1, y: 1, k: 1 }, revision: 42 }));
        expect("viewport" in snapshot).toBe(false);
        expect("updatedAt" in snapshot).toBe(false);
        expect("revision" in snapshot).toBe(false);
        expect("remoteContentHash" in snapshot).toBe(false);
    });
});
