import { describe, expect, test } from "bun:test";

import { CANVAS_OWNER_CHANGED_PROPOSAL_MESSAGE, executeAssistantProposal } from "@/pages/canvas/canvas-assistant-proposal-execution";
import { rebaseInsertedCanvasNode, runOwnedCanvasHistoryInsert } from "@/pages/canvas/canvas-generation-orchestration";
import { captureCanvasOwnerEpoch, canvasOwnerEpochMatches, createCanvasOwnerLifetime, readOwnedCanvasNodes, runOwnedCanvasCreatedNodes, runOwnedCanvasEnsureQueue, runOwnedCanvasPageCommit } from "@/pages/canvas/canvas-owner-epoch";
import { applyArchivedCanvasNodeAssets, CANVAS_HANDOFF_PERSIST_FAILED_MESSAGE, commitOwnedCanvasAssetHandoff, rebaseCreatedCanvasNodes } from "@/pages/canvas/canvas-resource-handoff-commit";
import { defaultConfig } from "@/stores/use-config-store";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import type { GenerationTask } from "@/services/api/task-center";

function deferred<T = void>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

function node(id: string, metadata: Partial<NonNullable<CanvasNodeData["metadata"]>> = {}): CanvasNodeData {
    return {
        id,
        type: CanvasNodeType.Image,
        title: id,
        position: { x: 0, y: 0 },
        width: 720,
        height: 405,
        metadata,
    };
}

function historyTask(): GenerationTask {
    return {
        id: "task-history",
        type: "canvas_image",
        status: "succeeded",
        prompt: "历史图片",
        resultJson: JSON.stringify({ mode: "image", images: [{ dataUrl: "data:image/png;base64,abc", storageKey: "resource:history" }] }),
        createdAt: "2026-10-01T00:00:00.000Z",
        updatedAt: "2026-10-01T00:00:00.000Z",
    } as GenerationTask;
}

async function applyHistoryNode(nodes: CanvasNodeData[], task: GenerationTask, targetNodeId: string) {
    const current = nodes.find((item) => item.id === targetNodeId) || nodes[0];
    if (!current) return { nodes, updated: false, nodeId: "", node: null };
    const next = {
        ...current,
        metadata: {
            ...current.metadata,
            content: "/api/resources/history/file",
            storageKey: "resource:history",
            status: "success" as const,
            taskId: task.id,
        },
    };
    return { nodes: [next], updated: true, nodeId: next.id, node: next };
}

describe("history insert ownership", () => {
    test("rebases onto edits made while the resource is loading, then skips page commit after a canvas switch", async () => {
        const owner = captureCanvasOwnerEpoch("canvas-a", "user-a");
        let liveCanvasId = "canvas-a";
        let liveNodes = [node("draft", { content: "before" })];
        let pageNodes = liveNodes;
        const persisted: CanvasNodeData[][] = [];
        const ensureGate = deferred();
        const persistStarted = deferred<CanvasNodeData[]>();
        const persistGate = deferred();

        const pending = runOwnedCanvasHistoryInsert({
            owner,
            getLiveCanvasId: () => liveCanvasId,
            getLiveUserScope: () => "user-a",
            task: historyTask(),
            projectId: "canvas-a",
            domainProjectId: "project-1",
            center: { x: 100, y: 80 },
            nodes: liveNodes,
            assets: [],
            readLiveNodes: () => readOwnedCanvasNodes({
                owner,
                liveCanvasId,
                liveUserScope: "user-a",
                pageNodes: liveNodes,
                storedNodes: [node("stored-original")],
            }),
            persist: async (nextNodes: CanvasNodeData[]) => {
                persistStarted.resolve(nextNodes);
                await persistGate.promise;
                persisted.push(nextNodes);
            },
            ensureAsset: async () => {
                await ensureGate.promise;
                return { assetId: "asset-history" };
            },
            applyResult: applyHistoryNode,
            onCommit: (inserted: CanvasNodeData) => {
                pageNodes = rebaseInsertedCanvasNode(pageNodes, inserted);
            },
        });
        liveNodes = [node("draft", { content: "edited-during-io" }), node("extra-draft")];
        pageNodes = liveNodes;
        ensureGate.resolve();
        const snapshot = await persistStarted.promise;
        liveCanvasId = "canvas-b";
        persistGate.resolve();
        expect(await pending).toBe("abandoned");
        expect(snapshot.slice(0, 2).map((item) => `${item.id}:${item.metadata?.content || ""}`)).toEqual([
            "draft:edited-during-io",
            "extra-draft:",
        ]);
        expect(snapshot.at(-1)?.metadata?.assetId).toBe("asset-history");
        expect(persisted).toEqual([snapshot]);
        expect(pageNodes.map((item) => item.id)).toEqual(["draft", "extra-draft"]);
        expect(canvasOwnerEpochMatches(owner, liveCanvasId, "user-a")).toBe(false);
    });

    test("commits a functional rebase after persist so later page edits survive", async () => {
        const owner = captureCanvasOwnerEpoch("canvas-a", "user-a");
        let liveNodes = [node("keep")];
        let pageNodes = liveNodes;
        const persistGate = deferred();
        const pending = runOwnedCanvasHistoryInsert({
            owner,
            getLiveCanvasId: () => "canvas-a",
            getLiveUserScope: () => "user-a",
            task: historyTask(),
            projectId: "canvas-a",
            center: { x: 10, y: 10 },
            nodes: liveNodes,
            assets: [],
            readLiveNodes: () => liveNodes,
            persist: async () => {
                await persistGate.promise;
            },
            ensureAsset: async () => ({ assetId: "asset-history" }),
            applyResult: applyHistoryNode,
            onCommit: (inserted) => {
                pageNodes = rebaseInsertedCanvasNode(pageNodes, inserted);
            },
        });
        pageNodes = [...pageNodes, node("typed-during-persist")];
        persistGate.resolve();
        expect(await pending).toBe("committed");
        expect(pageNodes.map((item) => item.id)).toEqual(["keep", "typed-during-persist", pageNodes.at(-1)!.id]);
        expect(pageNodes.at(-1)?.metadata?.assetId).toBe("asset-history");
    });

    test("abandons before ensureAsset and persist when the account switches during applyResult, even if the canvas id collides", async () => {
        const owner = captureCanvasOwnerEpoch("canvas-a", "user-a");
        let liveUser = "user-a";
        const applyGate = deferred();
        let ensureCalls = 0;
        let persistCalls = 0;
        let readCalls = 0;
        let committed = false;
        const pending = runOwnedCanvasHistoryInsert({
            owner,
            getLiveCanvasId: () => "canvas-a",
            getLiveUserScope: () => liveUser,
            task: historyTask(),
            projectId: "canvas-a",
            center: { x: 10, y: 10 },
            nodes: [node("keep")],
            assets: [],
            readLiveNodes: () => {
                readCalls += 1;
                return [node("other-account")];
            },
            persist: async () => {
                persistCalls += 1;
            },
            ensureAsset: async () => {
                ensureCalls += 1;
                return { assetId: "asset-history" };
            },
            applyResult: async (nodes, task, targetNodeId) => {
                await applyGate.promise;
                return applyHistoryNode(nodes, task, targetNodeId);
            },
            onCommit: () => {
                committed = true;
            },
        });
        liveUser = "user-b";
        applyGate.resolve();
        expect(await pending).toBe("abandoned");
        expect(ensureCalls).toBe(0);
        expect(persistCalls).toBe(0);
        expect(readCalls).toBe(0);
        expect(committed).toBe(false);
    });

    test("does not persist after ensureAsset when the account switches mid-flight", async () => {
        const owner = captureCanvasOwnerEpoch("canvas-a", "user-a");
        let liveUser = "user-a";
        const ensureGate = deferred();
        let persistCalls = 0;
        let committed = false;
        const pending = runOwnedCanvasHistoryInsert({
            owner,
            getLiveCanvasId: () => "canvas-a",
            getLiveUserScope: () => liveUser,
            task: historyTask(),
            projectId: "canvas-a",
            center: { x: 10, y: 10 },
            nodes: [node("keep")],
            assets: [],
            readLiveNodes: () => [node("other-account")],
            persist: async () => {
                persistCalls += 1;
            },
            ensureAsset: async () => {
                await ensureGate.promise;
                return { assetId: "asset-history" };
            },
            applyResult: applyHistoryNode,
            onCommit: () => {
                committed = true;
            },
        });
        liveUser = "user-b";
        ensureGate.resolve();
        expect(await pending).toBe("abandoned");
        expect(persistCalls).toBe(0);
        expect(committed).toBe(false);
    });
});

describe("handoff ownership", () => {
    test("keeps concurrent drafts, persists before consuming the URL, and stays retryable after a failed persist", async () => {
        const owner = captureCanvasOwnerEpoch("canvas-a", "user-a");
        const created = [node("created", { assetId: "asset-1" })];
        let liveNodes = [node("existing"), ...created];
        let pageNodes = liveNodes;
        let searchParams = new URLSearchParams({ mode: "handoff", asset: "asset-1" });
        let attemptKey = "canvas-a:asset-1:image";
        const persistGate = deferred();
        const first = commitOwnedCanvasAssetHandoff({
            owner,
            getLiveCanvasId: () => "canvas-a",
            getLiveUserScope: () => "user-a",
            searchParams,
            createdNodes: created,
            readLiveNodes: () => liveNodes,
            persist: async () => {
                await persistGate.promise;
            },
            applyCreated: (nodes) => {
                pageNodes = rebaseCreatedCanvasNodes(pageNodes, nodes);
            },
            consumeUrl: (next) => {
                searchParams = next;
            },
            resetAttempt: () => {
                attemptKey = "";
            },
        });
        liveNodes = [...liveNodes, node("draft-during-load")];
        pageNodes = liveNodes;
        persistGate.reject(new Error("sqlite unavailable"));
        expect(await first).toBe("failed");
        expect(searchParams.get("mode")).toBe("handoff");
        expect(searchParams.get("asset")).toBe("asset-1");
        expect(attemptKey).toBe("");

        const persisted: CanvasNodeData[][] = [];
        const retry = await commitOwnedCanvasAssetHandoff({
            owner,
            getLiveCanvasId: () => "canvas-a",
            getLiveUserScope: () => "user-a",
            searchParams,
            createdNodes: created,
            readLiveNodes: () => liveNodes,
            persist: async (nodes) => {
                persisted.push(nodes);
            },
            applyCreated: (nodes) => {
                pageNodes = rebaseCreatedCanvasNodes(pageNodes, nodes);
            },
            consumeUrl: (next) => {
                searchParams = next;
            },
            resetAttempt: () => {
                attemptKey = "";
            },
        });
        expect(retry).toBe("committed");
        expect(searchParams.get("mode")).toBeNull();
        expect(persisted[0].map((item) => item.id)).toEqual(["existing", "draft-during-load", "created"]);
        expect(pageNodes.map((item) => item.id)).toEqual(["existing", "draft-during-load", "created"]);
    });

    test("applyCreated rebases created nodes onto drafts typed during persist", async () => {
        const owner = captureCanvasOwnerEpoch("canvas-a", "user-a");
        const created = [node("created", { assetId: "asset-1" })];
        let pageNodes = [node("existing"), ...created];
        const persistGate = deferred();
        const pending = commitOwnedCanvasAssetHandoff({
            owner,
            getLiveCanvasId: () => "canvas-a",
            getLiveUserScope: () => "user-a",
            searchParams: new URLSearchParams({ mode: "handoff", asset: "asset-1" }),
            createdNodes: created,
            readLiveNodes: () => pageNodes,
            persist: async () => {
                await persistGate.promise;
            },
            applyCreated: (nodes) => {
                pageNodes = rebaseCreatedCanvasNodes(pageNodes, nodes);
            },
            consumeUrl: () => {},
            resetAttempt: () => {},
        });
        pageNodes = [...pageNodes, node("typed-during-persist")];
        persistGate.resolve();
        expect(await pending).toBe("committed");
        expect(pageNodes.map((item) => item.id)).toEqual(["existing", "typed-during-persist", "created"]);
    });

    test("persists the original canvas after a switch and does not consume the new canvas URL", async () => {
        const owner = captureCanvasOwnerEpoch("canvas-a", "user-a");
        const created = [node("created", { assetId: "asset-1" })];
        let liveCanvasId = "canvas-a";
        const searchParams = new URLSearchParams({ mode: "handoff", asset: "asset-1" });
        const insertGate = deferred();
        const persisted: string[][] = [];
        const pending = (async () => {
            await insertGate.promise;
            return commitOwnedCanvasAssetHandoff({
                owner,
                getLiveCanvasId: () => liveCanvasId,
                getLiveUserScope: () => "user-a",
                searchParams,
                createdNodes: created,
                readLiveNodes: () => readOwnedCanvasNodes({
                    owner,
                    liveCanvasId,
                    liveUserScope: "user-a",
                    pageNodes: [node("new-canvas")],
                    storedNodes: [node("original"), ...created],
                }),
                persist: async (nodes) => {
                    persisted.push(nodes.map((item) => item.id));
                },
                applyCreated: () => {
                    throw new Error("must not mutate the new canvas");
                },
                consumeUrl: () => {
                    throw new Error("must not consume the new canvas URL");
                },
                resetAttempt: () => {},
            });
        })();
        liveCanvasId = "canvas-b";
        insertGate.resolve();
        expect(await pending).toBe("abandoned");
        expect(persisted).toEqual([["original", "created"]]);
        expect(searchParams.get("mode")).toBe("handoff");
    });

    test("abandons before persist when the account switches during node load, even if the canvas id collides", async () => {
        const owner = captureCanvasOwnerEpoch("canvas-a", "user-a");
        const created = [node("created", { assetId: "asset-1" })];
        let liveUser = "user-a";
        let persistCalls = 0;
        let readCalls = 0;
        let applied = false;
        const loadGate = deferred<CanvasNodeData[]>();
        const pending = (async () => {
            const createdNodes = await loadGate.promise;
            return commitOwnedCanvasAssetHandoff({
                owner,
                getLiveCanvasId: () => "canvas-a",
                getLiveUserScope: () => liveUser,
                searchParams: new URLSearchParams({ mode: "handoff", asset: "asset-1" }),
                createdNodes,
                readLiveNodes: () => {
                    readCalls += 1;
                    return [node("other-account")];
                },
                persist: async () => {
                    persistCalls += 1;
                },
                applyCreated: () => {
                    applied = true;
                },
                consumeUrl: () => {
                    throw new Error("must not consume URL after account switch");
                },
                resetAttempt: () => {},
            });
        })();
        liveUser = "user-b";
        loadGate.resolve(created);
        expect(await pending).toBe("abandoned");
        expect(persistCalls).toBe(0);
        expect(readCalls).toBe(0);
        expect(applied).toBe(false);
    });

    test("failed persist reports an actionable error and does not let an old attempt clear a newer key", async () => {
        const owner = captureCanvasOwnerEpoch("canvas-a", "user-a");
        const created = [node("created", { assetId: "asset-1" })];
        let attemptKey = "first";
        const persistGate = deferred();
        const errors: unknown[] = [];
        const first = commitOwnedCanvasAssetHandoff({
            owner,
            getLiveCanvasId: () => "canvas-a",
            getLiveUserScope: () => "user-a",
            attemptKey: "first",
            getAttemptKey: () => attemptKey,
            searchParams: new URLSearchParams({ mode: "handoff", asset: "asset-1" }),
            createdNodes: created,
            readLiveNodes: () => created,
            persist: async () => {
                await persistGate.promise;
            },
            applyCreated: () => {
                throw new Error("must not apply after persist failure");
            },
            consumeUrl: () => {
                throw new Error("must not consume URL after persist failure");
            },
            resetAttempt: () => {
                attemptKey = "";
            },
            onPersistError: (error) => {
                errors.push(error);
            },
        });
        attemptKey = "second";
        persistGate.reject(new Error("sqlite unavailable"));
        expect(await first).toBe("failed");
        expect(attemptKey).toBe("second");
        expect((errors[0] as Error).message).toBe("sqlite unavailable");
        expect(CANVAS_HANDOFF_PERSIST_FAILED_MESSAGE).toBe("画布保存失败，请稍后重试");
    });

    test("retry control starts a second persist without remounting, and does not auto-loop the failed request", async () => {
        const owner = captureCanvasOwnerEpoch("canvas-a", "user-a");
        const created = [node("created", { assetId: "asset-1" })];
        let attemptKey = "canvas-a:asset-1:image";
        let retryNonce = 0;
        let nonceAtFail = 0;
        let failedKey = "";
        const persistCalls: string[] = [];
        const persistGate = deferred();
        const first = commitOwnedCanvasAssetHandoff({
            owner,
            getLiveCanvasId: () => "canvas-a",
            getLiveUserScope: () => "user-a",
            attemptKey,
            getAttemptKey: () => attemptKey,
            searchParams: new URLSearchParams({ mode: "handoff", asset: "asset-1" }),
            createdNodes: created,
            readLiveNodes: () => created,
            persist: async () => {
                persistCalls.push("first");
                await persistGate.promise;
            },
            applyCreated: () => {},
            consumeUrl: () => {},
            resetAttempt: () => {
                attemptKey = "";
            },
            onPersistError: () => {
                failedKey = "canvas-a:asset-1:image";
                nonceAtFail = retryNonce;
            },
        });
        persistGate.reject(new Error("sqlite unavailable"));
        expect(await first).toBe("failed");
        expect(attemptKey).toBe("");
        expect(failedKey).toBe("canvas-a:asset-1:image");
        expect(retryNonce).toBe(nonceAtFail);

        const { canStartCanvasHandoffAttempt } = await import("@/pages/canvas/canvas-resource-handoff-plan");
        expect(canStartCanvasHandoffAttempt({
            planKey: failedKey,
            currentAttemptKey: attemptKey,
            failedKey,
            retryNonce,
            nonceAtFail,
        })).toBe(false);

        retryNonce += 1;
        failedKey = "";
        expect(canStartCanvasHandoffAttempt({
            planKey: "canvas-a:asset-1:image",
            currentAttemptKey: attemptKey,
            failedKey,
            retryNonce,
            nonceAtFail,
        })).toBe(true);

        const retry = await commitOwnedCanvasAssetHandoff({
            owner,
            getLiveCanvasId: () => "canvas-a",
            getLiveUserScope: () => "user-a",
            attemptKey: "canvas-a:asset-1:image",
            getAttemptKey: () => "canvas-a:asset-1:image",
            searchParams: new URLSearchParams({ mode: "handoff", asset: "asset-1" }),
            createdNodes: created,
            readLiveNodes: () => created,
            persist: async () => {
                persistCalls.push("retry");
            },
            applyCreated: () => {},
            consumeUrl: () => {},
            resetAttempt: () => {},
        });
        expect(retry).toBe("committed");
        expect(persistCalls).toEqual(["first", "retry"]);
    });
});

describe("archive and reload ownership", () => {
    test("does not stamp copied node ids on a different canvas after archive IO", async () => {
        const owner = captureCanvasOwnerEpoch("canvas-a", "user-a");
        let liveCanvasId = "canvas-a";
        const copied = node("shared-id", { content: "same", assetId: "old" });
        let pageNodes = [copied];
        const archiveGate = deferred<{ assetId: string }[]>();
        const pending = runOwnedCanvasPageCommit({
            owner,
            getLiveCanvasId: () => liveCanvasId,
            getLiveUserScope: () => "user-a",
            work: () => archiveGate.promise,
            onCommit: (results) => {
                pageNodes = applyArchivedCanvasNodeAssets(pageNodes, new Map([
                    ["shared-id", { assetId: results[0].assetId, content: "same", previousAssetId: "old" }],
                ]));
            },
        });
        liveCanvasId = "canvas-b";
        pageNodes = [copied];
        archiveGate.resolve([{ assetId: "archived" }]);
        expect(await pending).toBe("abandoned");
        expect(pageNodes[0]?.metadata?.assetId).toBe("old");
    });

    test("does not start the next ensureAsset after an account switch; page commit is callbacks-only", async () => {
        const owner = captureCanvasOwnerEpoch("canvas-a", "user-a");
        let liveUser = "user-a";
        const firstGate = deferred();
        const ensureCalls: string[] = [];
        const pending = runOwnedCanvasEnsureQueue({
            owner,
            getLiveUserScope: () => liveUser,
            items: ["node-a", "node-b"],
            ensure: async (item) => {
                ensureCalls.push(item);
                if (item === "node-a") await firstGate.promise;
                return { id: item };
            },
        });
        liveUser = "user-b";
        firstGate.resolve();
        expect(await pending).toEqual([{ id: "node-a" }]);
        expect(ensureCalls).toEqual(["node-a"]);
    });

    test("rejects stale page completion after remount and A→B→A back-navigation", async () => {
        const lifetime = createCanvasOwnerLifetime();
        const owner = lifetime.capture("canvas-a", "user-a");
        const workGate = deferred<string>();
        let committed: string | null = null;
        const pending = runOwnedCanvasPageCommit({
            owner,
            getLiveCanvasId: () => "canvas-a",
            getLiveUserScope: () => "user-a",
            getLiveLifetime: () => lifetime.current(),
            work: () => workGate.promise,
            onCommit: (value) => {
                committed = value;
            },
        });
        lifetime.invalidate();
        lifetime.invalidate();
        workGate.resolve("stale");
        expect(await pending).toBe("abandoned");
        expect(committed).toBeNull();
    });
});

describe("project asset insert ownership", () => {
    test("does not apply created nodes after an account switch during create", async () => {
        const owner = captureCanvasOwnerEpoch("canvas-a", "user-a");
        let liveUser = "user-a";
        const createGate = deferred<CanvasNodeData[]>();
        let applied = false;
        const pending = runOwnedCanvasCreatedNodes({
            owner,
            getLiveCanvasId: () => "canvas-a",
            getLiveUserScope: () => liveUser,
            create: () => createGate.promise,
            apply: () => {
                applied = true;
            },
        });
        liveUser = "user-b";
        createGate.resolve([node("created")]);
        expect(await pending).toBe("abandoned");
        expect(applied).toBe(false);
    });
});

describe("assistant proposal ownership", () => {
    test("refuses generate after a canvas switch during prepare and never uses a later executor", async () => {
        const owner = captureCanvasOwnerEpoch("canvas-a", "user-a");
        let liveCanvasId = "canvas-a";
        const prepareGate = deferred();
        const image = node("node-1", { prompt: "test image" });
        const proposal = { proposalId: "proposal-1", kind: "image" as const, nodeIds: [image.id], model: "Confirmed", modelKey: "channel::confirmed" };
        const capturedCalls: string[] = [];
        const liveCalls: string[] = [];
        const notices: string[] = [];
        const capturedGenerate = async () => {
            capturedCalls.push("captured");
        };
        let liveGenerate = capturedGenerate;
        const pending = executeAssistantProposal({
            proposal,
            nodes: [image],
            claims: new Set(),
            isHandled: false,
            prepare: async () => {
                await prepareGate.promise;
                return { nodes: [image], connections: [], config: defaultConfig, assets: [], skills: [] };
            },
            generate: (...args) => liveGenerate(...args),
            stillOwns: () => canvasOwnerEpochMatches(owner, liveCanvasId, "user-a"),
            markHandled: () => {},
            notify: (content) => {
                notices.push(content);
            },
        });
        liveCanvasId = "canvas-b";
        liveGenerate = async () => {
            liveCalls.push("live");
        };
        prepareGate.resolve();
        await pending;
        expect(capturedCalls).toEqual([]);
        expect(liveCalls).toEqual([]);
        expect(notices).toEqual([CANVAS_OWNER_CHANGED_PROPOSAL_MESSAGE]);
    });

    test("prepare failures after a canvas switch are not mapped to the generic retry copy", async () => {
        const owner = captureCanvasOwnerEpoch("canvas-a", "user-a");
        let liveCanvasId = "canvas-a";
        const prepareGate = deferred();
        const image = node("node-1", { prompt: "test image" });
        const proposal = { proposalId: "proposal-2", kind: "image" as const, nodeIds: [image.id], model: "Confirmed", modelKey: "channel::confirmed" };
        const notices: string[] = [];
        let submissions = 0;
        const pending = executeAssistantProposal({
            proposal,
            nodes: [image],
            claims: new Set(),
            isHandled: false,
            prepare: async () => {
                await prepareGate.promise;
                throw new Error("offline");
            },
            generate: async () => {
                submissions += 1;
            },
            stillOwns: () => canvasOwnerEpochMatches(owner, liveCanvasId, "user-a"),
            markHandled: () => {},
            notify: (content) => {
                notices.push(content);
            },
        });
        liveCanvasId = "canvas-b";
        prepareGate.resolve();
        await pending;
        expect(submissions).toBe(0);
        expect(notices).toEqual([CANVAS_OWNER_CHANGED_PROPOSAL_MESSAGE]);
    });
});
