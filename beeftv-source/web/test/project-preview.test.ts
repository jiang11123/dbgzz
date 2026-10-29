import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { projectPreviewMedia, projectPreviewMediaCandidates } from "@/components/canvas/canvas-project-card";
import * as workspaceProject from "@/lib/canvas/canvas-workspace-project";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

const node = (id: string, type: CanvasNodeType, metadata: CanvasNodeData["metadata"] = {}): CanvasNodeData => ({
    id,
    type,
    title: id,
    position: { x: 0, y: 0 },
    width: 100,
    height: 100,
    metadata,
});

describe("project library covers", () => {
    test("finds media beyond the fourth node and inside another canvas of the same project", () => {
        const rootNodes = Array.from({ length: 5 }, (_, index) => node(`text-${index}`, CanvasNodeType.Text));
        const childImage = node("child-image", CanvasNodeType.Image, { content: "https://example.com/image.png" });
        const projects = [
            { id: "root", workspaceProjectId: "root", createdAt: "2026-01-01", updatedAt: "2026-01-01", nodes: rootNodes },
            { id: "child", workspaceProjectId: "root", createdAt: "2026-01-02", updatedAt: "2026-01-02", nodes: [childImage] },
        ];
        expect(typeof workspaceProject.previewNodesForWorkspaceProject).toBe("function");
        expect(workspaceProject.previewNodesForWorkspaceProject(projects, "root")).toEqual([childImage]);
    });

    test("uses a persisted image key even when its transient URL is absent", () => {
        const image = node("image", CanvasNodeType.Image, { storageKey: "image:example" });
        expect(projectPreviewMedia([image])?.node.id).toBe("image");
    });

    test("keeps a node's original image after a stale preview address", () => {
        const image = node("image", CanvasNodeType.Image, { previewContent: "https://example.com/broken.png", content: "https://example.com/working.png" });
        expect(projectPreviewMediaCandidates([image]).map((media) => media.url)).toEqual(["https://example.com/broken.png", "https://example.com/working.png"]);
    });

    test("empty cover contains only the centered icon", () => {
        const component = readFileSync(new URL("../src/components/canvas/canvas-project-card.tsx", import.meta.url), "utf8");
        const css = readFileSync(new URL("../src/styles/workspace-product.css", import.meta.url), "utf8");
        expect(component).not.toContain('<span className="canvas-project-empty-image" aria-hidden="true" />');
        expect(css).not.toContain(".canvas-project-empty-image { width: 64px; height: 48px;");
    });

    test("home recents use the same complete project preview as the library", () => {
        const home = readFileSync(new URL("../src/pages/home/index.tsx", import.meta.url), "utf8");
        const dashboard = readFileSync(new URL("../src/pages/home/home-dashboard.tsx", import.meta.url), "utf8");
        expect(home).toContain("previewNodesForWorkspaceProject(localProjects, project.id)");
        expect(dashboard).toContain("<ProjectPreview project={{ id: project.id, nodes: project.previewNodes }}");
    });
});
