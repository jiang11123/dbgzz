import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const dialog = readFileSync(new URL("../src/pages/canvas/canvas-project-status-dialogs.tsx", import.meta.url), "utf8");
const project = readFileSync(new URL("../src/pages/canvas/project.tsx", import.meta.url), "utf8");
const editorDialogs = readFileSync(new URL("../src/pages/canvas/canvas-project-editor-dialogs.tsx", import.meta.url), "utf8");
const mediaDialogs = readFileSync(new URL("../src/pages/canvas/canvas-project-media-dialogs.tsx", import.meta.url), "utf8");
const toolbar = readFileSync(new URL("../src/components/canvas/canvas-node-toolbar.tsx", import.meta.url), "utf8");

test("image and video AI upscale create processing nodes and retain local size adjustment", () => {
    expect(dialog).not.toContain("CanvasAIUpscaleDialog");
    expect(project).toContain("onSuperResolve={createUpscaleProcessingNode}");
    expect(project).toContain("useCanvasUpscaleBatch({");
    expect(editorDialogs).not.toContain("onAIUpscale={status.onAIUpscale}");
    expect(toolbar.match(/id: "ai-upscale"/g)).toHaveLength(2);
    expect(mediaDialogs).toContain("<CanvasNodeUpscaleDialog");
    expect(project).toContain("onUpscale: (node, params) => void upscaleImageNode(node, params)");
});

test("upscale retry uses the original task or processing batch before generic generation", () => {
    const retry = project.slice(project.indexOf("const retryCanvasNode ="), project.indexOf("const locateAssistantNodes ="));
    expect(retry.indexOf('endsWith(".ai-upscale")')).toBeLessThan(retry.indexOf("canvasNodeRetryPlan("));
    expect(retry).toContain("recoverAIUpscale(node)");
    expect(retry).toContain("startUpscaleBatch(processor)");
});

test("upscale completion adopts canonical task binding without a second snapshot writer", () => {
    const mediaTools = readFileSync(new URL("../src/pages/canvas/use-canvas-media-tools.ts", import.meta.url), "utf8");
    const observer = mediaTools.slice(mediaTools.indexOf("const observeAIUpscale ="), mediaTools.indexOf("const recoverAIUpscale ="));
    expect(observer).toContain("await bindBackendCanvasGenerationResult({");
    expect(observer).not.toContain("persistMediaNodes(");
    expect(observer).not.toContain("buildGenerationTaskNodeResult(");
});
