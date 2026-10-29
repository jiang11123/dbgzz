import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
    captureCanvasOwnerEpoch,
    canvasOwnerCanPersist,
    canvasOwnerEpochMatches,
    canvasOwnerUserMatches,
    createCanvasOwnerLifetime,
    readOwnedCanvasNodes,
} from "@/pages/canvas/canvas-owner-epoch";

test("matches exact canvas and user, and reads stored nodes after a switch", () => {
    const owner = captureCanvasOwnerEpoch("canvas-a", "user-a");
    expect(canvasOwnerEpochMatches(owner, "canvas-a", "user-a")).toBe(true);
    expect(canvasOwnerEpochMatches(owner, "canvas-a", "user-b")).toBe(false);
    expect(canvasOwnerEpochMatches(owner, "canvas-b", "user-a")).toBe(false);
    expect(readOwnedCanvasNodes({
        owner,
        liveCanvasId: "canvas-b",
        liveUserScope: "user-a",
        pageNodes: [{ id: "new" }],
        storedNodes: [{ id: "original" }],
    })).toEqual([{ id: "original" }]);
    expect(readOwnedCanvasNodes({
        owner,
        liveCanvasId: "canvas-a",
        liveUserScope: "user-a",
        pageNodes: [{ id: "page" }],
        storedNodes: [{ id: "original" }],
    })).toEqual([{ id: "page" }]);
});

test("does not read another account's colliding canvas id from storage", () => {
    const owner = captureCanvasOwnerEpoch("canvas-a", "user-a");
    expect(canvasOwnerUserMatches(owner, "user-b")).toBe(false);
    expect(readOwnedCanvasNodes({
        owner,
        liveCanvasId: "canvas-a",
        liveUserScope: "user-b",
        pageNodes: [{ id: "new-account" }],
        storedNodes: [{ id: "colliding-store" }],
    })).toEqual([]);
});

test("page lifetime rejects remount and back-navigation while same-user canvas navigation may still persist", () => {
    const lifetime = createCanvasOwnerLifetime();
    const owner = lifetime.capture("canvas-a", "user-a");
    expect(lifetime.matches(owner, "canvas-a", "user-a")).toBe(true);
    expect(lifetime.canPersist(owner, "canvas-a", "user-a")).toBe(true);

    lifetime.invalidate();
    expect(lifetime.matches(owner, "canvas-a", "user-a")).toBe(false);
    expect(lifetime.canPersist(owner, "canvas-a", "user-a")).toBe(false);
    expect(lifetime.canPersist(owner, "canvas-b", "user-a")).toBe(true);
    expect(canvasOwnerCanPersist(owner, "canvas-b", "user-b", lifetime.current())).toBe(false);

    lifetime.invalidate();
    expect(lifetime.matches(owner, "canvas-a", "user-a")).toBe(false);
    expect(lifetime.canPersist(owner, "canvas-a", "user-a")).toBe(false);
});

test("StrictMode remount resets mounted and invalidates the page lifetime", () => {
    const source = readFileSync(resolve(import.meta.dir, "../src/pages/canvas/canvas-owner-epoch.ts"), "utf8");
    const setup = source.indexOf("mountedRef.current = true");
    const cleanup = source.indexOf("mountedRef.current = false");
    expect(setup).toBeGreaterThan(-1);
    expect(cleanup).toBeGreaterThan(setup);
    expect(source.slice(setup, cleanup + 80)).toContain("lifetime.invalidate()");
});
