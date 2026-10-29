import { describe, expect, test } from "bun:test";

import { decideExternalCanvasRevision } from "@/lib/canvas/canvas-external-revision";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
import type { CanvasNodeData } from "@/types/canvas";

function node(id: string, title: string, prompt: string): CanvasNodeData {
    return { id, type: "image", title, position: { x: 0, y: 0 }, width: 320, height: 220, metadata: { prompt } };
}

function project(patch: Partial<CanvasProject> & { id: string; revision: number }): CanvasProject {
    return {
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
    };
}

describe("外部新 revision 的取舍", () => {
    test("本地没有未确认编辑时应用外部内容", () => {
        const remote = project({ id: "c1", revision: 4, title: "外部改名", nodes: [node("n1", "镜头1", "外部提示")] });
        const local = project({ id: "c1", revision: 3, title: "旧名" });

        const decision = decideExternalCanvasRevision({ remote, local, hasLocalEdits: false });

        expect(decision.kind).toBe("apply");
        if (decision.kind !== "apply") throw new Error("expected apply");
        expect(decision.project.title).toBe("外部改名");
        expect(decision.project.revision).toBe(4);
        expect(decision.project.nodes).toHaveLength(1);
        expect(decision.remoteRevision).toBe(4);
        expect(decision.localRevision).toBe(3);
    });

    test("本地有未确认编辑时保留本地内容，并把远端原样留作候选", () => {
        const remote = project({ id: "c1", revision: 9, title: "外部改名", nodes: [node("n1", "镜头1", "外部提示")] });
        const local = project({ id: "c1", revision: 3, title: "本地正在编辑", nodes: [node("n1", "镜头1", "用户刚写的提示")] });

        const decision = decideExternalCanvasRevision({ remote, local, hasLocalEdits: true });

        expect(decision.kind).toBe("keep-local");
        if (decision.kind !== "keep-local") throw new Error("expected keep-local");
        expect(decision.projectId).toBe("c1");
        expect(decision.candidate).toBe(remote);
        expect(decision.candidate.nodes[0].metadata?.prompt).toBe("外部提示");
        expect(decision.localRevision).toBe(3);
        expect(decision.remoteRevision).toBe(9);
    });

    test("应用到本地时保留本机视角与画布外观偏好", () => {
        const remote = project({ id: "c1", revision: 5, viewport: { x: 0, y: 0, k: 1 } });
        const local = project({
            id: "c1",
            revision: 4,
            viewport: { x: 640, y: -120, k: 1.75 },
            appearance: { mode: "light" },
            backgroundMode: "dots",
        });

        const decision = decideExternalCanvasRevision({ remote, local, hasLocalEdits: false });

        if (decision.kind !== "apply") throw new Error("expected apply");
        expect(decision.project.viewport).toEqual({ x: 640, y: -120, k: 1.75 });
        expect(decision.project.backgroundMode).toBe("dots");
        expect(decision.project.appearance).toEqual({ mode: "light" });
    });

    test("本地还没有该画布记录时直接落到本地", () => {
        const remote = project({ id: "new", revision: 1 });

        const decision = decideExternalCanvasRevision({ remote, local: undefined, hasLocalEdits: false });

        expect(decision.kind).toBe("apply");
        if (decision.kind !== "apply") throw new Error("expected apply");
        expect(decision.project.id).toBe("new");
        expect(decision.localRevision).toBe(0);
    });
});
