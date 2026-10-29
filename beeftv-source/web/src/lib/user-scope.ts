const ACTIVE_USER_SCOPE_KEY = "infinite-canvas:active-user-scope";
const GUEST_SCOPE = "guest";

let memoryScope: string | undefined;
let activeUserScopeEpoch = 1;

export type UserScopeEpoch = {
    scope: string;
    generation: number;
};

const userScopeListeners = new Set<(epoch: UserScopeEpoch) => void>();

function readStoredUserScope() {
    if (typeof window === "undefined") return "";
    try {
        return window.localStorage?.getItem(ACTIVE_USER_SCOPE_KEY) || "";
    } catch {
        // Desktop shells, privacy modes and test harnesses may expose a window
        // without a usable Storage implementation. Local data must still use a
        // deterministic guest namespace instead of breaking uploads/cache keys.
        return "";
    }
}

export function getActiveUserScope() {
    if (memoryScope !== undefined) return memoryScope;
    return readStoredUserScope() || GUEST_SCOPE;
}

export function getActiveUserScopeEpoch() {
    return activeUserScopeEpoch;
}

// Conversation subscribers and media guards share one identity clock.
export function getUserScopeGeneration() {
    return getActiveUserScopeEpoch();
}

export function captureUserScopeEpoch(scope = getActiveUserScope()): UserScopeEpoch {
    return { scope, generation: getActiveUserScopeEpoch() };
}

export function userScopeEpochMatches(epoch: UserScopeEpoch, live = captureUserScopeEpoch()) {
    return epoch.scope === live.scope && epoch.generation === live.generation;
}

export function subscribeUserScope(listener: (epoch: UserScopeEpoch) => void) {
    userScopeListeners.add(listener);
    return () => {
        userScopeListeners.delete(listener);
    };
}

export function setActiveUserScope(userId?: string | null) {
    const next = userId || GUEST_SCOPE;
    memoryScope = next;
    // Bump even when the scope string repeats so A→B→A cannot reuse a captured identity.
    activeUserScopeEpoch += 1;
    if (typeof window !== "undefined") {
        try {
            window.localStorage?.setItem(ACTIVE_USER_SCOPE_KEY, next);
        } catch {
            // Scope persistence is best effort; callers can continue in guest mode.
        }
    }
    const epoch = captureUserScopeEpoch(next);
    for (const listener of userScopeListeners) {
        try { listener(epoch); }
        catch (error) { console.warn("账号切换订阅处理失败", error); }
    }
}

export function scopedStorageKey(name: string, scope = getActiveUserScope()) {
    return `${name}:user:${scope}`;
}

export const scopedLocalStorage = {
    getItem: (name: string) => {
        if (typeof window === "undefined") return null;
        try {
            return window.localStorage?.getItem(scopedStorageKey(name)) ?? null;
        } catch {
            return null;
        }
    },
    setItem: (name: string, value: string) => {
        if (typeof window === "undefined") return;
        try {
            window.localStorage?.setItem(scopedStorageKey(name), value);
        } catch {
            // UI preferences are optional and must not block local creation.
        }
    },
    removeItem: (name: string) => {
        if (typeof window === "undefined") return;
        try {
            window.localStorage?.removeItem(scopedStorageKey(name));
        } catch {
            // Best effort cleanup when browser storage is unavailable.
        }
    },
};
