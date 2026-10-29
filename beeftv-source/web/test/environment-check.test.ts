import { expect, test } from "bun:test";
import { browserChecks, browserCapabilities, probeBrowserStorage } from "../src/services/diagnostics/browser-environment";
import { setActiveUserScope } from "../src/lib/user-scope";

for (const finishOld of ["abort", "timeout", "account-switch"] as const) {
    test(`an older ${finishOld} cannot overwrite the latest storage result`, async () => {
        const previous = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
        const requests: Array<{ onerror?: () => void; onsuccess?: () => void; result?: unknown }> = [];
        Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: {
            open: () => { const request = {}; requests.push(request); return request; },
            deleteDatabase: () => ({}),
        } });
        const controller = new AbortController();
        try {
            const older = probeBrowserStorage(controller.signal);
            if (finishOld === "account-switch") setActiveUserScope("probe-next-account");
            const newer = probeBrowserStorage();
            requests[1].onerror?.();
            const snapshot = await newer;
            expect(snapshot.storageWritable).toBe(false);
            if (finishOld !== "timeout") controller.abort();
            const oldSnapshot = await older;
            let closed = false;
            requests[0].result = { close: () => { closed = true; }, transaction: () => { throw Error("late open must never write"); } };
            requests[0].onsuccess?.();
            expect(closed).toBe(true);
            expect(oldSnapshot.storageTimedOut).toBe(finishOld === "timeout" ? true : undefined);
            expect(browserCapabilities().storageWritable).toBe(false);
            expect(browserCapabilities().storageTimedOut).toBe(false);
            expect(browserChecks({ ...browserCapabilities(), ...snapshot }).find(item => item.id === "indexed-db")?.status).toBe("error");
        } finally {
            controller.abort();
            if (previous) Object.defineProperty(globalThis, "indexedDB", previous);
            else delete (globalThis as { indexedDB?: IDBFactory }).indexedDB;
            setActiveUserScope(null);
        }
    }, 5000);
}

test("missing randomUUID is compatible while missing secure randomness is actionable", () => {
    const capabilities = { secureRandom: true, randomUUID: false, structuredClone: true, indexedDB: true, webGL: true, h264: true, hevc: false };
    expect(browserChecks(capabilities).find(item => item.id === "secure-random")?.status).toBe("pass");
    expect(browserChecks({ ...capabilities, secureRandom: false }).find(item => item.id === "secure-random")?.status).toBe("error");
    expect(browserChecks(capabilities).find(item => item.id === "video-codec")?.status).toBe("pass");
});

test("storage deadline requests cleanup and a late open is closed without writing", async () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
    let removed = 0;
    let closed = 0;
    const request: { onsuccess?: () => void; result?: unknown } = {};
    Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: { open: () => request, deleteDatabase: () => { removed++; return {}; } } });
    try {
        await probeBrowserStorage();
        expect(removed).toBeGreaterThan(0);
        expect(browserCapabilities().storageTimedOut).toBe(true);
        expect(browserChecks().find(item => item.id === "indexed-db")?.status).toBe("warning");
        request.result = { close: () => { closed++; }, transaction: () => { throw Error("late probe must not write"); } };
        request.onsuccess?.();
        expect(closed).toBe(1);
        expect(removed).toBeGreaterThan(1);
    } finally {
        if (previous) Object.defineProperty(globalThis, "indexedDB", previous);
        else delete (globalThis as { indexedDB?: IDBFactory }).indexedDB;
    }
}, 5000);

test("missing browser APIs are independent of optional GPU and HEVC capabilities", () => {
    const checks = browserChecks({ secureRandom: true, randomUUID: true, structuredClone: false, indexedDB: false, webGL: false, h264: false, hevc: false });
    expect(checks.filter(item => item.status === "error").map(item => item.id)).toEqual(["structured-clone", "indexed-db"]);
    expect(checks.filter(item => item.status === "warning").map(item => item.id)).toEqual(["webgl", "video-codec"]);
});
