import { hydrateNodeGenerationContext, type NodeGenerationContext } from "@/components/canvas/canvas-node-generation";
import { cacheResourceObjectUrl } from "@/services/resource-blob-cache";
import { saveCanvasDrawing } from "@/lib/canvas/canvas-drawing-storage";
import { setActiveUserScope } from "@/lib/user-scope";
import { configureApiRuntime } from "@/services/api/request";
import "@/services/api/projects";
import type { ReferenceImage } from "@/types/image";

// This harness runs the production hydration, IndexedDB, drawing publication and
// canvas-filter code. Only its HTTP resource/character endpoints are fixtures.
setActiveUserScope(`light-references-${crypto.randomUUID()}`);
const status = document.querySelector<HTMLPreElement>("#status")!;
const results: Record<string, unknown> = {};
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function context(referenceImages: ReferenceImage[] = []): NodeGenerationContext {
    return { prompt: "保留角色和构图", referenceImages, referenceVideos: [], referenceAudios: [], characterReferences: [], resolvedCharacterVersions: [], resolvedCharacterVoices: [], textCount: 1, imageCount: referenceImages.length, videoCount: 0, audioCount: 0 };
}
function canvas(rgb: string) {
    const element = document.createElement("canvas"); element.width = 4; element.height = 4;
    const ctx = element.getContext("2d")!; ctx.fillStyle = rgb; ctx.fillRect(0, 0, 4, 4);
    return element;
}
async function blob(element: HTMLCanvasElement) { return (await new Promise<Blob | null>(resolve => element.toBlob(resolve, "image/png")))!; }
async function pixel(url: string) {
    const image = new Image(); image.crossOrigin = "anonymous"; image.src = url; await image.decode();
    const ctx = canvas("black").getContext("2d")!; ctx.drawImage(image, 0, 0);
    return [...ctx.getImageData(1, 1, 1, 1).data];
}
// HTTP/1 browsers allow six connections per origin. Metadata uses a separate
// fixture origin so this harness isolates the application's cache queue from
// the browser transport cap; production also uses multiplexed HTTP/2.
const cacheOrigin = location.origin.replace("127.0.0.1", "localhost");
async function serverState() { return (await fetch("/__light_references/state")).json(); }

document.querySelector<HTMLButtonElement>("#block-cache")!.onclick = async () => {
    configureApiRuntime(`${cacheOrigin}/api`, "fixture-only");
    for (let index = 0; index < 16; index++) void cacheResourceObjectUrl(`resource:blocked-${index}`).catch(() => {});
    status.textContent = "正在占满预览缓存下载队列";
};
document.querySelector<HTMLButtonElement>("#prepare-references")!.onclick = async () => {
    try {
        check((await serverState()).blocked >= 6, "the real cache transport must be blocked");
        configureApiRuntime("/api", "fixture-only");
        const owned: ReferenceImage = { id: "owned", name: "owned.png", type: "image/png", dataUrl: "", storageKey: "resource:owned", url: "/api/resources/owned/file" };
        const remote: ReferenceImage = { id: "remote", name: "remote.png", type: "image/png", dataUrl: "", url: `${location.origin}/__light_references/remote.png` };
        const input = { ...context([owned, remote]), characterReferences: [{ nodeId: "character-node", assetId: "character" }] };
        const before = performance.now();
        const hydrated = await hydrateNodeGenerationContext(input, "canvas", "project", "image");
        check(hydrated.referenceImages.length === 4, "owned image, remote image, character main and supplement must be retained");
        check(hydrated.referenceImages.every(image => image.dataUrl === ""), "references must stay lightweight");
        const state = await serverState();
        check(state.blobReads === 0 && state.uploads === 0, "stored references must not read or reupload blobs");
        results.references = { elapsedMs: Math.round(performance.now() - before), storageKeys: hydrated.referenceImages.map(image => image.storageKey || image.url), scheduledDownloads: 16, blocked: state.blocked, blobReads: state.blobReads };
        status.textContent = JSON.stringify(results);
        status.dataset.references = "passed";
    } catch (error) { status.textContent = String(error); status.dataset.error = "true"; }
};
document.querySelector<HTMLButtonElement>("#prepare-derived")!.onclick = async () => {
    try {
        const blue = canvas("rgb(20,40,200)"); const drawingBlob = await blob(blue);
        const saved = await saveCanvasDrawing("canvas", "drawing", "excalidraw", { elements: [{ id: "shape", type: "rectangle", isDeleted: false }] }, null, drawingBlob, { blob: drawingBlob, pageId: "page", width: 4, height: 4, mimeType: "image/png", background: "white" });
        const original = canvas("rgb(100,50,20)").toDataURL("image/png");
        const images: ReferenceImage[] = [
            { id: "drawing", name: "drawing.png", type: "image/png", dataUrl: "", storageKey: "resource:old-render", source: { kind: "drawing", drawingId: "drawing", revision: saved.revision, shapeCount: 1 } },
            { id: "graded", name: "graded.png", type: "image/png", dataUrl: "", storageKey: "resource:original", source: { kind: "colorgrade", url: original, grade: { brightness: 150, contrast: 100, saturate: 100, hueRotate: 0 } } },
        ];
        const hydrated = await hydrateNodeGenerationContext(context(images), "canvas", undefined, "image");
        check(hydrated.referenceImages.every(image => image.storageKey?.startsWith("resource:upload-")), "derived references must use uploaded composites");
        const [drawingPixel, gradedPixel] = await Promise.all(hydrated.referenceImages.map(image => pixel(image.url!)));
        check(drawingPixel.join() === "20,40,200,255", "drawing upload must preserve the authored render");
        check(gradedPixel.join() === "150,75,30,255", "color grade must change the actual uploaded pixels");
        const state = await serverState(); check(state.uploads === 2, "one upload per derived render");
        const repeated = await hydrateNodeGenerationContext(context(images), "canvas", undefined, "image");
        check((await serverState()).uploads === 2, "unchanged drawing and grade publications must be reused");
        check(repeated.referenceImages.map(image => image.storageKey).join() === hydrated.referenceImages.map(image => image.storageKey).join(), "same composite publication must be retained");
        results.derived = { drawingPixel, gradedPixel, uploads: state.uploads };
        status.textContent = JSON.stringify(results); status.dataset.derived = "passed";
    } catch (error) { status.textContent = String(error); status.dataset.error = "true"; }
};
