import { afterEach, expect, spyOn, test } from "bun:test";
import { hydrateNodeGenerationContext, type NodeGenerationContext } from "@/components/canvas/canvas-node-generation";
import * as images from "@/services/image-storage";
import * as projects from "@/services/api/projects";
import * as drawing from "@/lib/canvas/canvas-drawing-reference";
import * as grading from "@/lib/canvas/canvas-color-grade";
import type { ReferenceImage } from "@/types/image";

const restores: Array<() => void> = [];
afterEach(() => { for (const restore of restores.splice(0).reverse()) restore(); });

function context(referenceImages: ReferenceImage[]): NodeGenerationContext {
    return { prompt: "保留构图", referenceImages, referenceVideos: [], referenceAudios: [], characterReferences: [], resolvedCharacterVersions: [], resolvedCharacterVoices: [], textCount: 1, imageCount: referenceImages.length, videoCount: 0, audioCount: 0 };
}

function preventImageRead() {
    const read = spyOn(images, "imageToDataUrl").mockRejectedValue(new Error("preview cache is blocked"));
    restores.push(() => read.mockRestore());
    return read;
}

test("owned and HTTP image references do not wait for the browser preview cache", async () => {
    const read = preventImageRead();
    const references: ReferenceImage[] = [
        { id: "owned", name: "owned.png", type: "image/png", dataUrl: "", storageKey: "resource:owned", url: "blob:expired-preview" },
        { id: "remote", name: "remote.png", type: "image/png", dataUrl: "", url: "https://images.example/reference.png" },
        { id: "remote-data-url-field", name: "remote.png", type: "image/png", dataUrl: "https://images.example/legacy.png" },
    ];
    const hydrated = await hydrateNodeGenerationContext(context(references), "canvas", undefined, "video");
    expect(hydrated.referenceImages).toEqual(references);
    expect(read).not.toHaveBeenCalled();
});

test("character main and supplemental representations remain resource references", async () => {
    const read = preventImageRead();
    const detail = spyOn(projects, "getProjectCharacter").mockResolvedValue({
        asset: { id: "character", title: "禾禾" },
        character: { versionId: "v2", definition: {}, representations: [
            { id: "primary", resourceId: "primary-image", role: "primary" },
            { id: "side", resourceId: "side-image", role: "side" },
            { id: "duplicate", resourceId: "primary-image", role: "front" },
        ] },
    } as Awaited<ReturnType<typeof projects.getProjectCharacter>>);
    restores.push(() => detail.mockRestore());
    const input = { ...context([]), characterReferences: [{ nodeId: "character-node", assetId: "character" }] };
    const hydrated = await hydrateNodeGenerationContext(input, "canvas", "project", "image");
    expect(hydrated.referenceImages.map(image => image.storageKey)).toEqual(["resource:primary-image", "resource:side-image"]);
    expect(hydrated.referenceImages.every(image => image.dataUrl === "")).toBe(true);
    expect(hydrated.resolvedCharacterVersions).toEqual([{ assetId: "character", versionId: "v2" }]);
    expect(hydrated.prompt).toContain("禾禾");
    expect(read).not.toHaveBeenCalled();
});

test("drawing and color grade sources materialize even when their preview has a resource key", async () => {
    const read = preventImageRead();
    const drawingResolve = spyOn(drawing, "resolveCanvasDrawingReference").mockImplementation(async (_projectId, image) => ({ ...image, storageKey: "resource:drawing-render", dataUrl: "" }));
    const gradeResolve = spyOn(grading, "resolveCanvasColorGradeReference").mockImplementation(async image => ({ ...image, storageKey: "resource:graded-render", dataUrl: "" }));
    restores.push(() => drawingResolve.mockRestore(), () => gradeResolve.mockRestore());
    const references: ReferenceImage[] = [
        { id: "drawing", name: "drawing.png", type: "image/png", dataUrl: "", storageKey: "resource:old-render", source: { kind: "drawing", drawingId: "drawing", revision: 2, shapeCount: 1 } },
        { id: "grade", name: "grade.png", type: "image/png", dataUrl: "", storageKey: "resource:original-image", source: { kind: "colorgrade", url: "https://images.example/source.png", grade: { brightness: 150, contrast: 100, saturate: 100, hueRotate: 0 } } },
    ];
    const hydrated = await hydrateNodeGenerationContext(context(references), "canvas", undefined, "image");
    expect(hydrated.referenceImages.map(image => image.storageKey)).toEqual(["resource:drawing-render", "resource:graded-render"]);
    expect(drawingResolve).toHaveBeenCalledTimes(1);
    expect(gradeResolve).toHaveBeenCalledTimes(1);
    expect(read).not.toHaveBeenCalled();
});

test("unpublished local images retain conversion before backend preparation", async () => {
    const read = spyOn(images, "imageToDataUrl").mockResolvedValue("data:image/png;base64,bG9jYWw=");
    restores.push(() => read.mockRestore());
    const hydrated = await hydrateNodeGenerationContext(context([{ id: "local", name: "local.png", type: "image/png", dataUrl: "blob:local", storageKey: "local-image" }]), "canvas");
    expect(hydrated.referenceImages[0].dataUrl).toBe("data:image/png;base64,bG9jYWw=");
    expect(read).toHaveBeenCalledTimes(1);
});
