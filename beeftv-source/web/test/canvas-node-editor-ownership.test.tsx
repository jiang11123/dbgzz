import { expect, spyOn, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "antd";

import { useCanvasNodeEditor } from "@/pages/canvas/use-canvas-node-editor";
import { getActiveUserScope, setActiveUserScope } from "@/lib/user-scope";
import * as assetSync from "@/services/project-asset-sync";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

function deferred<T = void>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

function switchScope(userId: string) {
    const previous = getActiveUserScope();
    setActiveUserScope(userId);
    return () => setActiveUserScope(previous);
}

function imageNode(id: string, extra: Partial<CanvasNodeData["metadata"]> = {}): CanvasNodeData {
    return {
        id,
        type: CanvasNodeType.Image,
        title: id,
        position: { x: 0, y: 0 },
        width: 8,
        height: 8,
        metadata: { content: "data:image/png;base64,xx", ...extra },
    };
}

function mountEditor(canvasId = "canvas-a") {
    const nodesRef = { current: [imageNode("node-1")] };
    const writes: string[] = [];
    let editor!: ReturnType<typeof useCanvasNodeEditor>;
    function Harness() {
        editor = useCanvasNodeEditor({
            canvasId,
            canvasTitle: "画布",
            domainProjectId: "project-a",
            nodesRef,
            setNodes: (value) => {
                writes.push("setNodes");
                nodesRef.current = typeof value === "function" ? value(nodesRef.current) : value;
            },
            setSelectedNodeIds: () => {},
            setSelectedConnectionId: () => {},
            setDialogNodeId: () => {},
            setToolbarNodeId: () => {},
            setHoveredNodeId: () => {},
        });
        return null;
    }
    renderToStaticMarkup(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
            <App>
                <Harness />
            </App>
        </QueryClientProvider>,
    );
    return { editor, nodesRef, writes };
}

test("category change threads canvas-manual source, category, captured scope and signal", async () => {
    const restore = switchScope("owner-a");
    const entered = deferred();
    const gate = deferred();
    const ensure = spyOn(assetSync, "ensureCanvasNodeAsset").mockImplementation(async (options) => {
        entered.resolve();
        await gate.promise;
        return { assetId: "asset-1", created: true, linkedToProject: true, confirmed: true };
    });
    try {
        const { editor, nodesRef } = mountEditor();
        editor.handleConfigNodeChange("node-1", { assetCategory: "character" });
        await entered.promise;
        expect(ensure.mock.calls[0]?.[0]).toMatchObject({
            canvasId: "canvas-a",
            domainProjectId: "project-a",
            source: "canvas-manual",
            category: "character",
        });
        expect(ensure.mock.calls[0]?.[0].expectedScope).toEqual(expect.objectContaining({ userScope: "owner-a" }));
        expect(ensure.mock.calls[0]?.[0].signal).toBeInstanceOf(AbortSignal);
        expect(nodesRef.current[0]?.metadata?.assetCategory).toBe("character");
        gate.resolve();
        await Bun.sleep(20);
        expect(nodesRef.current[0]?.metadata?.assetId).toBe("asset-1");
    } finally {
        gate.resolve();
        ensure.mockRestore();
        restore();
    }
});

test("A to B to A during category ensure keeps the local category patch and does not write assetId", async () => {
    const restore = switchScope("owner-a");
    const entered = deferred();
    const gate = deferred();
    const ensure = spyOn(assetSync, "ensureCanvasNodeAsset").mockImplementation(async () => {
        entered.resolve();
        await gate.promise;
        return { assetId: "stale-asset", created: true, linkedToProject: true, confirmed: true };
    });
    try {
        const { editor, nodesRef } = mountEditor();
        editor.handleConfigNodeChange("node-1", { assetCategory: "character" });
        await entered.promise;
        setActiveUserScope("owner-b");
        setActiveUserScope("owner-a");
        gate.resolve();
        await Bun.sleep(20);
        expect(nodesRef.current[0]?.metadata?.assetCategory).toBe("character");
        expect(nodesRef.current[0]?.metadata?.assetId).toBeUndefined();
    } finally {
        gate.resolve();
        ensure.mockRestore();
        restore();
    }
});

test("A to B to A during saveNodeAsset does not write assetId", async () => {
    const restore = switchScope("owner-a");
    const entered = deferred();
    const gate = deferred();
    const ensure = spyOn(assetSync, "ensureCanvasNodeAsset").mockImplementation(async () => {
        entered.resolve();
        await gate.promise;
        return { assetId: "stale-asset", created: true, linkedToProject: true, confirmed: true };
    });
    try {
        const { editor, nodesRef } = mountEditor();
        const pending = editor.saveNodeAsset(nodesRef.current[0]!);
        await entered.promise;
        setActiveUserScope("owner-b");
        setActiveUserScope("owner-a");
        gate.resolve();
        await pending;
        expect(nodesRef.current[0]?.metadata?.assetId).toBeUndefined();
    } finally {
        gate.resolve();
        ensure.mockRestore();
        restore();
    }
});

test("unconfirmed save keeps a recoverable draft assetId", async () => {
    const restore = switchScope("owner-a");
    const ensure = spyOn(assetSync, "ensureCanvasNodeAsset").mockResolvedValue({
        assetId: "draft-1",
        created: true,
        linkedToProject: false,
        confirmed: false,
    });
    try {
        const { editor, nodesRef } = mountEditor();
        await editor.saveNodeAsset(nodesRef.current[0]!);
        expect(nodesRef.current[0]?.metadata?.assetId).toBe("draft-1");
        expect(ensure.mock.calls[0]?.[0].source).toBe("canvas-manual");
        expect(ensure.mock.calls[0]?.[0].category).toBeUndefined();
    } finally {
        ensure.mockRestore();
        restore();
    }
});

test("ordinary save error after A to B to A does not write a replacement assetId", async () => {
    const restore = switchScope("owner-a");
    const entered = deferred();
    const gate = deferred();
    const ensure = spyOn(assetSync, "ensureCanvasNodeAsset").mockImplementation(async () => {
        entered.resolve();
        await gate.promise;
        throw new Error("网络中断");
    });
    try {
        const { editor, nodesRef } = mountEditor();
        const pending = editor.saveNodeAsset(nodesRef.current[0]!);
        await entered.promise;
        setActiveUserScope("owner-b");
        setActiveUserScope("owner-a");
        gate.resolve();
        await pending;
        expect(nodesRef.current[0]?.metadata?.assetId).toBeUndefined();
    } finally {
        gate.resolve();
        ensure.mockRestore();
        restore();
    }
});

test("ordinary save error while still owned does not write assetId", async () => {
    const restore = switchScope("owner-a");
    const ensure = spyOn(assetSync, "ensureCanvasNodeAsset").mockRejectedValue(new Error("素材库不可用"));
    try {
        const { editor, nodesRef } = mountEditor();
        await editor.saveNodeAsset(nodesRef.current[0]!);
        expect(nodesRef.current[0]?.metadata?.assetId).toBeUndefined();
    } finally {
        ensure.mockRestore();
        restore();
    }
});
