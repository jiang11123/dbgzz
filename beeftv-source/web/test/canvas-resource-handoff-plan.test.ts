import { describe, expect, test } from "bun:test";

import { linkedFolderPresentation, planCanvasHandoffEffect, resolveCanvasAssetHandoffPlan } from "@/pages/canvas/canvas-resource-handoff-plan";
import type { Asset } from "@/stores/use-asset-store";

function imageAsset(id: string): Asset {
    return {
        id,
        kind: "image",
        title: id,
        coverUrl: `/cover-${id}.png`,
        tags: [],
        status: "confirmed",
        source: "creation",
        createdAt: "2026-10-01T00:00:00.000Z",
        updatedAt: "2026-10-01T00:00:00.000Z",
        data: { dataUrl: `/stored-${id}.png`, width: 720, height: 405, bytes: 1, mimeType: "image/png" },
    };
}

describe("resolveCanvasAssetHandoffPlan", () => {
    test("stays idle until the handoff query is ready", () => {
        const searchParams = new URLSearchParams({ mode: "handoff" });
        searchParams.append("asset", "asset-1");
        expect(resolveCanvasAssetHandoffPlan({
            projectLoaded: false,
            assetsHydrated: true,
            mode: "handoff",
            projectId: "canvas-1",
            assets: [imageAsset("asset-1")],
            searchParams,
            currentKey: "",
            nodes: [],
        }).kind).toBe("idle");
        expect(resolveCanvasAssetHandoffPlan({
            projectLoaded: true,
            assetsHydrated: true,
            mode: "edit",
            projectId: "canvas-1",
            assets: [imageAsset("asset-1")],
            searchParams,
            currentKey: "",
            nodes: [],
        }).kind).toBe("idle");
    });

    test("waits while any handoff asset is still missing, then commits uninserted payloads once", () => {
        const searchParams = new URLSearchParams({ mode: "handoff" });
        searchParams.append("asset", "asset-1");
        const waiting = resolveCanvasAssetHandoffPlan({
            projectLoaded: true,
            assetsHydrated: true,
            mode: "handoff",
            projectId: "canvas-1",
            assets: [],
            searchParams,
            currentKey: "",
            nodes: [],
        });
        expect(waiting).toEqual({ kind: "wait", key: "canvas-1:asset-1:missing" });

        const commit = resolveCanvasAssetHandoffPlan({
            projectLoaded: true,
            assetsHydrated: true,
            mode: "handoff",
            projectId: "canvas-1",
            assets: [imageAsset("asset-1")],
            searchParams,
            currentKey: "",
            nodes: [],
        });
        expect(commit.kind).toBe("commit");
        if (commit.kind !== "commit") return;
        expect(commit.payloads).toEqual([
            { kind: "image", dataUrl: "/stored-asset-1.png", storageKey: undefined, title: "asset-1", assetId: "asset-1" },
        ]);

        expect(resolveCanvasAssetHandoffPlan({
            projectLoaded: true,
            assetsHydrated: true,
            mode: "handoff",
            projectId: "canvas-1",
            assets: [imageAsset("asset-1")],
            searchParams,
            currentKey: commit.key,
            nodes: [],
        }).kind).toBe("idle");

        expect(resolveCanvasAssetHandoffPlan({
            projectLoaded: true,
            assetsHydrated: true,
            mode: "handoff",
            projectId: "canvas-1",
            assets: [imageAsset("asset-1")],
            searchParams,
            currentKey: "",
            nodes: [{ metadata: { assetId: "asset-1" } }],
        })).toMatchObject({ kind: "commit", payloads: [] });
    });
});

describe("planCanvasHandoffEffect", () => {
    const searchParams = () => {
        const params = new URLSearchParams({ mode: "handoff" });
        params.append("asset", "asset-1");
        return params;
    };

    test("does not auto-restart a failed persist until the retry nonce changes", () => {
        const params = searchParams();
        const plan = resolveCanvasAssetHandoffPlan({
            projectLoaded: true,
            assetsHydrated: true,
            mode: "handoff",
            projectId: "canvas-1",
            assets: [imageAsset("asset-1")],
            searchParams: params,
            currentKey: "",
            nodes: [],
        });
        expect(plan.kind).toBe("commit");
        const blocked = planCanvasHandoffEffect({
            plan,
            searchParams: params,
            ownerUserScope: "user-a",
            liveUserScope: "user-a",
            currentAttemptKey: "",
            failedKey: plan.kind === "commit" ? plan.key : "",
            retryNonce: 0,
            nonceAtFail: 0,
        });
        expect(blocked.kind).toBe("blocked-until-retry");
        const retried = planCanvasHandoffEffect({
            plan,
            searchParams: params,
            ownerUserScope: "user-a",
            liveUserScope: "user-a",
            currentAttemptKey: "",
            failedKey: "",
            retryNonce: 1,
            nonceAtFail: 0,
        });
        expect(retried.kind).toBe("commit");
    });

    test("consumes a retained handoff URL after an account change instead of reissuing it", () => {
        const params = searchParams();
        const plan = resolveCanvasAssetHandoffPlan({
            projectLoaded: true,
            assetsHydrated: true,
            mode: "handoff",
            projectId: "canvas-1",
            assets: [imageAsset("asset-1")],
            searchParams: params,
            currentKey: "",
            nodes: [],
        });
        const decision = planCanvasHandoffEffect({
            plan,
            searchParams: params,
            ownerUserScope: "user-a",
            liveUserScope: "user-b",
            currentAttemptKey: "",
            failedKey: plan.kind === "commit" ? plan.key : "",
            retryNonce: 0,
            nonceAtFail: 0,
        });
        expect(decision.kind).toBe("consume-foreign");
        if (decision.kind !== "consume-foreign") return;
        expect(decision.searchParams.get("mode")).toBeNull();
        expect(decision.searchParams.get("asset")).toBeNull();
    });

    test("StrictMode re-entry with the same attempt key stays idle, remount with empty refs can start again", () => {
        const params = searchParams();
        const first = resolveCanvasAssetHandoffPlan({
            projectLoaded: true,
            assetsHydrated: true,
            mode: "handoff",
            projectId: "canvas-1",
            assets: [imageAsset("asset-1")],
            searchParams: params,
            currentKey: "",
            nodes: [],
        });
        expect(first.kind).toBe("commit");
        if (first.kind !== "commit") return;
        const strictModeReentry = resolveCanvasAssetHandoffPlan({
            projectLoaded: true,
            assetsHydrated: true,
            mode: "handoff",
            projectId: "canvas-1",
            assets: [imageAsset("asset-1")],
            searchParams: params,
            currentKey: first.key,
            nodes: [],
        });
        expect(planCanvasHandoffEffect({
            plan: strictModeReentry,
            searchParams: params,
            ownerUserScope: "user-a",
            liveUserScope: "user-a",
            currentAttemptKey: first.key,
            failedKey: "",
            retryNonce: 0,
            nonceAtFail: 0,
        }).kind).toBe("idle");

        const remount = resolveCanvasAssetHandoffPlan({
            projectLoaded: true,
            assetsHydrated: true,
            mode: "handoff",
            projectId: "canvas-1",
            assets: [imageAsset("asset-1")],
            searchParams: params,
            currentKey: "",
            nodes: [],
        });
        const remountDecision = planCanvasHandoffEffect({
            plan: remount,
            searchParams: params,
            ownerUserScope: null,
            liveUserScope: "user-a",
            currentAttemptKey: "",
            failedKey: "",
            retryNonce: 0,
            nonceAtFail: 0,
        });
        expect(remountDecision.kind).toBe("commit");
    });
});

describe("linkedFolderPresentation", () => {
    test("keeps known folder style and theme, otherwise uses glass/aurora", () => {
        expect(linkedFolderPresentation({ style: "cinema", theme: "ember" })).toEqual({ style: "cinema", theme: "ember" });
        expect(linkedFolderPresentation({ style: "unknown", theme: "unknown" })).toEqual({ style: "glass", theme: "aurora" });
    });
});
