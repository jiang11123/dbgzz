import { useEffect, useRef } from "react";

import { getActiveUserScope } from "@/lib/user-scope";

export type CanvasOwnerEpoch = {
    canvasId: string;
    userScope: string;
    lifetime: number;
};

export class CanvasOwnerAbandonedError extends Error {
    constructor() {
        super("canvas-owner-abandoned");
        this.name = "CanvasOwnerAbandonedError";
    }
}

let nextCanvasOwnerLifetime = 1;

export type CanvasOwnerLifetime = {
    capture(canvasId: string, userScope?: string): CanvasOwnerEpoch;
    invalidate(): void;
    current(): number;
    matches(owner: CanvasOwnerEpoch, liveCanvasId: string, liveUserScope?: string): boolean;
    userMatches(owner: CanvasOwnerEpoch, liveUserScope?: string): boolean;
    canPersist(owner: CanvasOwnerEpoch, liveCanvasId: string, liveUserScope?: string): boolean;
};

export function createCanvasOwnerLifetime(): CanvasOwnerLifetime {
    let lifetime = nextCanvasOwnerLifetime++;
    return {
        capture(canvasId, userScope = getActiveUserScope()) {
            return { canvasId, userScope, lifetime };
        },
        invalidate() {
            lifetime = nextCanvasOwnerLifetime++;
        },
        current() {
            return lifetime;
        },
        matches(owner, liveCanvasId, liveUserScope) {
            return canvasOwnerEpochMatches(owner, liveCanvasId, liveUserScope, lifetime);
        },
        userMatches(owner, liveUserScope) {
            return canvasOwnerUserMatches(owner, liveUserScope);
        },
        canPersist(owner, liveCanvasId, liveUserScope) {
            return canvasOwnerCanPersist(owner, liveCanvasId, liveUserScope, lifetime);
        },
    };
}

export function captureCanvasOwnerEpoch(canvasId: string, userScope = getActiveUserScope(), lifetime = 0): CanvasOwnerEpoch {
    return { canvasId, userScope, lifetime };
}

export function canvasOwnerUserMatches(owner: CanvasOwnerEpoch, liveUserScope?: string) {
    return owner.userScope === (liveUserScope ?? getActiveUserScope());
}

export function canvasOwnerEpochMatches(owner: CanvasOwnerEpoch, liveCanvasId: string, liveUserScope?: string, liveLifetime?: number) {
    return owner.lifetime === (liveLifetime ?? owner.lifetime)
        && Boolean(owner.canvasId)
        && owner.canvasId === liveCanvasId
        && canvasOwnerUserMatches(owner, liveUserScope);
}

/**
 * Same-user canvas navigation may finish the captured canvas in storage.
 * Account change must not send another write. Back-navigation / remount of the
 * same canvas must not persist a stale snapshot over the new page lifetime.
 */
export function canvasOwnerCanPersist(owner: CanvasOwnerEpoch, liveCanvasId: string, liveUserScope?: string, liveLifetime?: number) {
    if (!canvasOwnerUserMatches(owner, liveUserScope)) return false;
    if (owner.lifetime === (liveLifetime ?? owner.lifetime)) return true;
    return Boolean(owner.canvasId) && owner.canvasId !== liveCanvasId;
}

/** Page React state is current while this canvas lifetime is open; after a switch, read the original canvas from storage. Never read another account's colliding canvas id. */
export function readOwnedCanvasNodes<T>(input: {
    owner: CanvasOwnerEpoch;
    liveCanvasId: string;
    pageNodes: T[];
    storedNodes?: T[] | null;
    liveUserScope?: string;
    liveLifetime?: number;
}): T[] {
    if (!canvasOwnerUserMatches(input.owner, input.liveUserScope)) return [];
    if (canvasOwnerEpochMatches(input.owner, input.liveCanvasId, input.liveUserScope, input.liveLifetime)) return input.pageNodes;
    return input.storedNodes ?? [];
}

export function useCanvasOwnerLifetime(canvasId: string) {
    const userScope = getActiveUserScope();
    const lifetimeRef = useRef<CanvasOwnerLifetime | null>(null);
    if (!lifetimeRef.current) lifetimeRef.current = createCanvasOwnerLifetime();
    const lifetime = lifetimeRef.current;
    const identityRef = useRef({ canvasId, userScope });
    if (identityRef.current.canvasId !== canvasId || identityRef.current.userScope !== userScope) {
        identityRef.current = { canvasId, userScope };
        lifetime.invalidate();
    }
    const mountedRef = useRef(true);
    useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
            lifetime.invalidate();
        };
    }, [lifetime]);
    return { lifetime, mountedRef, userScope };
}

export async function runOwnedCanvasCreatedNodes<T>(input: {
    owner: CanvasOwnerEpoch;
    getLiveCanvasId: () => string;
    getLiveUserScope?: () => string;
    getLiveLifetime?: () => number;
    create: () => Promise<T[]>;
    apply: (created: T[]) => void;
}): Promise<"committed" | "abandoned"> {
    const created = await input.create();
    if (!canvasOwnerEpochMatches(input.owner, input.getLiveCanvasId(), input.getLiveUserScope?.(), input.getLiveLifetime?.())) return "abandoned";
    input.apply(created);
    return "committed";
}

/**
 * Gates page callbacks only. work() senders (ensureAsset HTTP) keep the live
 * auth token; callers must not start another ensure after the user scope changes.
 */
export async function runOwnedCanvasPageCommit<T>(input: {
    owner: CanvasOwnerEpoch;
    getLiveCanvasId: () => string;
    getLiveUserScope?: () => string;
    getLiveLifetime?: () => number;
    work: () => Promise<T>;
    onCommit: (result: T) => void;
}): Promise<"committed" | "abandoned"> {
    const result = await input.work();
    if (!canvasOwnerEpochMatches(input.owner, input.getLiveCanvasId(), input.getLiveUserScope?.(), input.getLiveLifetime?.())) return "abandoned";
    input.onCommit(result);
    return "committed";
}

/** Check user scope before each ensure. In-flight ensureAsset still sends with live auth. */
export async function runOwnedCanvasEnsureQueue<T, R>(input: {
    owner: CanvasOwnerEpoch;
    getLiveUserScope?: () => string;
    items: T[];
    ensure: (item: T) => Promise<R>;
}): Promise<R[]> {
    const results: R[] = [];
    for (const item of input.items) {
        if (!canvasOwnerUserMatches(input.owner, input.getLiveUserScope?.())) break;
        results.push(await input.ensure(item));
    }
    return results;
}
