import { describe, expect, spyOn, test } from "bun:test";
import axios from "axios";

import * as imageUtils from "@/lib/image-utils";
import * as runtimeMode from "@/lib/runtime-mode";
import { getActiveUserScope, setActiveUserScope } from "@/lib/user-scope";
import * as userScopeGuard from "@/lib/user-scope-guard";
import { UserScopeAbandonedError } from "@/lib/user-scope-guard";
import { apiClient, http } from "@/services/api/request";
import { getResource, refreshResource, uploadResourceFile } from "@/services/api/resources";
import { uploadImage } from "@/services/image-storage";
import * as blobCache from "@/services/resource-blob-cache";

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

function envelope(resource: { id: string }) {
    return { code: 0, msg: "", data: { resource: { id: resource.id, kind: "image", status: "ready", publicUrl: "", size: 1, mimeType: "image/png" } } };
}

async function withAdapter<T>(adapter: NonNullable<typeof apiClient.defaults.adapter>, run: () => Promise<T>) {
    const previous = apiClient.defaults.adapter;
    apiClient.defaults.adapter = adapter;
    try {
        return await run();
    } finally {
        apiClient.defaults.adapter = previous;
    }
}

describe("HTTP expectedScope dispatch", () => {
    test("does not return an in-flight result after A to B to A", async () => {
        const restore = switchScope("owner-a");
        const expectedScope = userScopeGuard.captureUserScope();
        const entered = deferred();
        const gate = deferred();
        try {
            await withAdapter(async (config) => {
                entered.resolve();
                await gate.promise;
                return { data: { code: 0, data: { assets: [] }, msg: "" }, status: 200, statusText: "OK", headers: {}, config };
            }, async () => {
                const pending = http.get("/assets", { expectedScope });
                await entered.promise;
                setActiveUserScope("owner-b");
                setActiveUserScope("owner-a");
                gate.resolve();
                await expect(pending).rejects.toBeInstanceOf(UserScopeAbandonedError);
            });
        } finally { restore(); }
    });

    test("checks captured scope at send before a new request is constructed", async () => {
        const restore = switchScope("owner-a");
        const expected = userScopeGuard.captureUserScope();
        setActiveUserScope("owner-b");
        let sent = 0;
        try {
            await withAdapter(async () => {
                sent += 1;
                return { data: { code: 0, data: { ok: true }, msg: "" }, status: 200, statusText: "OK", headers: {}, config: {} as never };
            }, async () => {
                await expect(http.post("/resources", {}, { expectedScope: expected })).rejects.toBeInstanceOf(UserScopeAbandonedError);
            });
            expect(sent).toBe(0);
        } finally {
            restore();
        }
    });
});

describe("resource upload scope", () => {
    test("in-flight multipart may finish, but the response does not write the new account cache or start the next request", async () => {
        const restore = switchScope("owner-a");
        const entered = deferred();
        const gate = deferred();
        const urls: string[] = [];
        try {
            await withAdapter(async (config) => {
                urls.push(String(config.url || ""));
                entered.resolve();
                await gate.promise;
                return { data: envelope({ id: "res-inflight" }), status: 200, statusText: "OK", headers: {}, config };
            }, async () => {
                const pending = uploadResourceFile(new Blob(["x"], { type: "image/png" }), "image", { fileName: "x.png" });
                await entered.promise;
                setActiveUserScope("owner-b");
                gate.resolve();
                await expect(pending).rejects.toBeInstanceOf(UserScopeAbandonedError);
                expect(urls).toEqual(["/resources"]);
                let followUp = 0;
                apiClient.defaults.adapter = async (config) => {
                    followUp += 1;
                    throw new axios.AxiosError("missing", "ERR_BAD_REQUEST", config, undefined, {
                        data: { code: 404, data: null, msg: "not found" },
                        status: 404,
                        statusText: "Error",
                        headers: {},
                        config,
                    });
                };
                await expect(getResource("res-inflight")).rejects.toBeTruthy();
                expect(followUp).toBe(1);
            });
        } finally {
            restore();
        }
    });

    test("chunk PUT after an account change is abandoned and does not start complete", async () => {
        const restore = switchScope("owner-a");
        const entered = deferred();
        const sessionGate = deferred();
        const urls: string[] = [];
        const size = 51 * 1024 * 1024;
        try {
            await withAdapter(async (config) => {
                urls.push(String(config.url || ""));
                if (config.url === "/resources/uploads") {
                    entered.resolve();
                    await sessionGate.promise;
                    return { data: { code: 0, data: { uploadId: "session", chunkSize: 32 * 1024 * 1024, chunkCount: 2 }, msg: "" }, status: 200, statusText: "OK", headers: {}, config };
                }
                throw new Error(`unexpected ${config.url}`);
            }, async () => {
                const pending = uploadResourceFile(new Blob([new Uint8Array(size)]), "video", { fileName: "clip.mp4" });
                await entered.promise;
                setActiveUserScope("owner-b");
                sessionGate.resolve();
                await expect(pending).rejects.toBeInstanceOf(UserScopeAbandonedError);
                expect(urls).toEqual(["/resources/uploads"]);
            });
        } finally {
            restore();
        }
    });

    test("429 wait then account change abandons before the retry request", async () => {
        const restore = switchScope("owner-a");
        const waitStarted = deferred();
        const waitGate = deferred();
        const wait = spyOn(userScopeGuard.userScopeRetryWait, "delay").mockImplementation(() => {
            waitStarted.resolve();
            return waitGate.promise;
        });
        const urls: string[] = [];
        const size = 51 * 1024 * 1024;
        try {
            await withAdapter(async (config) => {
                urls.push(String(config.url || ""));
                if (config.url === "/resources/uploads") {
                    throw new axios.AxiosError("rate limited", "ERR_BAD_REQUEST", config, undefined, {
                        data: { code: 429, data: null, msg: "请求过于频繁，请稍后重试" },
                        status: 429,
                        statusText: "Error",
                        headers: { "retry-after": "1" },
                        config,
                    });
                }
                throw new Error(`unexpected ${config.url}`);
            }, async () => {
                const pending = uploadResourceFile(new Blob([new Uint8Array(size)]), "video", { fileName: "clip.mp4" });
                await waitStarted.promise;
                expect(urls).toEqual(["/resources/uploads"]);
                setActiveUserScope("owner-b");
                waitGate.resolve();
                await expect(pending).rejects.toBeInstanceOf(UserScopeAbandonedError);
                expect(urls).toEqual(["/resources/uploads"]);
            });
        } finally {
            wait.mockRestore();
            restore();
        }
    });
});

describe("resource lookup scope", () => {
    test("deferred getResource A to B to A does not write cache or missing state", async () => {
        const restore = switchScope("owner-a");
        const expectedA = userScopeGuard.captureUserScope();
        const entered = deferred();
        const gate = deferred();
        const urls: string[] = [];
        try {
            await withAdapter(async (config) => {
                urls.push(String(config.url || ""));
                entered.resolve();
                await gate.promise;
                return { data: envelope({ id: "res-lookup-aba" }), status: 200, statusText: "OK", headers: {}, config };
            }, async () => {
                const pending = getResource("res-lookup-aba", { expectedScope: expectedA });
                await entered.promise;
                setActiveUserScope("owner-b");
                setActiveUserScope("owner-a");
                gate.resolve();
                await expect(pending).rejects.toBeInstanceOf(UserScopeAbandonedError);
            });
            await expect(getResource("res-lookup-aba", { expectedScope: expectedA })).rejects.toBeInstanceOf(UserScopeAbandonedError);
            let followUp = 0;
            await withAdapter(async (config) => {
                followUp += 1;
                return { data: envelope({ id: "res-lookup-aba" }), status: 200, statusText: "OK", headers: {}, config };
            }, async () => {
                const live = await getResource("res-lookup-aba");
                expect(live.id).toBe("res-lookup-aba");
            });
            expect(followUp).toBe(1);
            expect(urls).toEqual(["/resources/res-lookup-aba"]);
        } finally {
            restore();
        }
    });

    test("in-flight getResource join is limited to the captured epoch", async () => {
        const restore = switchScope("owner-a");
        const expectedA = userScopeGuard.captureUserScope();
        const firstEntered = deferred();
        const firstGate = deferred();
        const otherEntered = deferred();
        let requests = 0;
        try {
            await withAdapter(async (config) => {
                requests += 1;
                if (requests === 1) {
                    firstEntered.resolve();
                    await firstGate.promise;
                } else {
                    otherEntered.resolve();
                }
                return { data: envelope({ id: "res-lookup-join" }), status: 200, statusText: "OK", headers: {}, config };
            }, async () => {
                const first = getResource("res-lookup-join", { expectedScope: expectedA });
                await firstEntered.promise;
                const joined = getResource("res-lookup-join", { expectedScope: expectedA });
                expect(requests).toBe(1);
                setActiveUserScope("owner-b");
                const otherEpoch = getResource("res-lookup-join");
                await otherEntered.promise;
                expect(requests).toBe(2);
                firstGate.resolve();
                await expect(first).rejects.toBeInstanceOf(UserScopeAbandonedError);
                await expect(joined).rejects.toBeInstanceOf(UserScopeAbandonedError);
                expect((await otherEpoch).id).toBe("res-lookup-join");
            });
        } finally {
            firstGate.resolve();
            restore();
        }
    });

    test("abandoned 404 lookup does not remember a missing resource for the original epoch", async () => {
        const restore = switchScope("owner-a");
        const expectedA = userScopeGuard.captureUserScope();
        const entered = deferred();
        const gate = deferred();
        try {
            await withAdapter(async (config) => {
                entered.resolve();
                await gate.promise;
                throw new axios.AxiosError("not found", "ERR_BAD_REQUEST", config, undefined, {
                    data: { code: 404, data: null, msg: "not found" },
                    status: 404,
                    statusText: "Error",
                    headers: {},
                    config,
                });
            }, async () => {
                const pending = getResource("res-lookup-missing", { expectedScope: expectedA });
                await entered.promise;
                setActiveUserScope("owner-b");
                setActiveUserScope("owner-a");
                gate.resolve();
                await expect(pending).rejects.toBeInstanceOf(UserScopeAbandonedError);
            });
            await expect(getResource("res-lookup-missing", { expectedScope: expectedA })).rejects.toBeInstanceOf(UserScopeAbandonedError);
        } finally {
            restore();
        }
    });

    test("cached getResource with a stale captured scope does not return old data", async () => {
        const restore = switchScope("owner-a");
        const expectedA = userScopeGuard.captureUserScope();
        let requests = 0;
        try {
            await withAdapter(async (config) => {
                requests += 1;
                return { data: envelope({ id: "res-stale-cache" }), status: 200, statusText: "OK", headers: {}, config };
            }, async () => {
                expect((await getResource("res-stale-cache", { expectedScope: expectedA })).id).toBe("res-stale-cache");
                expect(requests).toBe(1);
                setActiveUserScope("owner-b");
                setActiveUserScope("owner-a");
                await expect(getResource("res-stale-cache", { expectedScope: expectedA })).rejects.toBeInstanceOf(UserScopeAbandonedError);
                expect(requests).toBe(1);
                expect((await getResource("res-stale-cache")).id).toBe("res-stale-cache");
                expect(requests).toBe(2);
            });
        } finally {
            restore();
        }
    });

    test("aborted signal rejects cached getResource without a new request", async () => {
        const restore = switchScope("owner-a");
        const expectedScope = userScopeGuard.captureUserScope();
        const controller = new AbortController();
        let requests = 0;
        try {
            await withAdapter(async (config) => {
                requests += 1;
                return { data: envelope({ id: "res-cached-abort" }), status: 200, statusText: "OK", headers: {}, config };
            }, async () => {
                expect((await getResource("res-cached-abort", { expectedScope })).id).toBe("res-cached-abort");
                expect(requests).toBe(1);
                controller.abort();
                await expect(getResource("res-cached-abort", { expectedScope, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
                expect(requests).toBe(1);
            });
        } finally {
            restore();
        }
    });

    test("remembered missing lookup does not return to a stale captured scope", async () => {
        const restore = switchScope("owner-a");
        const expectedA = userScopeGuard.captureUserScope();
        let requests = 0;
        try {
            await withAdapter(async (config) => {
                requests += 1;
                throw new axios.AxiosError("not found", "ERR_BAD_REQUEST", config, undefined, {
                    data: { code: 404, data: null, msg: "not found" },
                    status: 404,
                    statusText: "Error",
                    headers: {},
                    config,
                });
            }, async () => {
                await expect(getResource("res-missing-stale", { expectedScope: expectedA })).rejects.toThrow("not found");
                expect(requests).toBe(1);
                await expect(getResource("res-missing-stale", { expectedScope: expectedA })).rejects.toThrow("资源不存在或已被删除");
                expect(requests).toBe(1);
                setActiveUserScope("owner-b");
                setActiveUserScope("owner-a");
                await expect(getResource("res-missing-stale", { expectedScope: expectedA })).rejects.toBeInstanceOf(UserScopeAbandonedError);
                expect(requests).toBe(1);
            });
        } finally {
            restore();
        }
    });

    test("signaled getResource callers do not share an AbortSignal", async () => {
        const restore = switchScope("owner-a");
        const expectedScope = userScopeGuard.captureUserScope();
        const first = new AbortController();
        const second = new AbortController();
        const firstEntered = deferred();
        const firstGate = deferred();
        const secondEntered = deferred();
        const secondGate = deferred();
        let requests = 0;
        try {
            await withAdapter(async (config) => {
                requests += 1;
                const n = requests;
                if (n === 1) {
                    firstEntered.resolve();
                    await firstGate.promise;
                } else {
                    secondEntered.resolve();
                    await secondGate.promise;
                }
                return { data: envelope({ id: "res-signal-independent" }), status: 200, statusText: "OK", headers: {}, config };
            }, async () => {
                const pendingFirst = getResource("res-signal-independent", { expectedScope, signal: first.signal });
                await firstEntered.promise;
                const pendingSecond = getResource("res-signal-independent", { expectedScope, signal: second.signal });
                await secondEntered.promise;
                expect(requests).toBe(2);
                first.abort();
                firstGate.resolve();
                await expect(pendingFirst).rejects.toMatchObject({ name: "AbortError" });
                secondGate.resolve();
                expect((await pendingSecond).id).toBe("res-signal-independent");
            });
        } finally {
            firstGate.resolve();
            secondGate.resolve();
            restore();
        }
    });

    test("deferred refreshResource A to B to A does not write cache", async () => {
        const restore = switchScope("owner-a");
        const expectedA = userScopeGuard.captureUserScope();
        const entered = deferred();
        const gate = deferred();
        try {
            await withAdapter(async (config) => {
                entered.resolve();
                await gate.promise;
                return { data: envelope({ id: "res-refresh-aba" }), status: 200, statusText: "OK", headers: {}, config };
            }, async () => {
                const pending = refreshResource("res-refresh-aba", { expectedScope: expectedA });
                await entered.promise;
                setActiveUserScope("owner-b");
                setActiveUserScope("owner-a");
                gate.resolve();
                await expect(pending).rejects.toBeInstanceOf(UserScopeAbandonedError);
            });
            await expect(getResource("res-refresh-aba", { expectedScope: expectedA })).rejects.toBeInstanceOf(UserScopeAbandonedError);
        } finally {
            restore();
        }
    });
});

describe("uploadImage delayed promises", () => {
    test("account change during fetch does not upload or write caches", async () => {
        const restore = switchScope("owner-a");
        const fetchGate = deferred<Response>();
        const previousFetch = globalThis.fetch;
        const native = spyOn(runtimeMode, "isNativeDesktopRuntime").mockReturnValue(true);
        const decode = spyOn(imageUtils, "readImageMeta");
        const prime = spyOn(blobCache, "primeResourceBlobCache");
        let uploaded = 0;
        globalThis.fetch = (async () => fetchGate.promise) as typeof fetch;
        try {
            await withAdapter(async () => {
                uploaded += 1;
                return { data: envelope({ id: "res-fetch" }), status: 200, statusText: "OK", headers: {}, config: {} as never };
            }, async () => {
                const pending = uploadImage("https://cdn.example/a.png");
                setActiveUserScope("owner-b");
                fetchGate.resolve(new Response(new Blob(["img"], { type: "image/png" })));
                await expect(pending).rejects.toBeInstanceOf(UserScopeAbandonedError);
                expect(uploaded).toBe(0);
                expect(decode).not.toHaveBeenCalled();
                expect(prime).not.toHaveBeenCalled();
            });
        } finally {
            globalThis.fetch = previousFetch;
            decode.mockRestore();
            prime.mockRestore();
            native.mockRestore();
            restore();
        }
    });

    test("account change during decode does not upload or fall back into the new account cache", async () => {
        const restore = switchScope("owner-a");
        const decodeGate = deferred<{ width: number; height: number; mimeType: string }>();
        const native = spyOn(runtimeMode, "isNativeDesktopRuntime").mockReturnValue(true);
        const decode = spyOn(imageUtils, "readImageMeta").mockImplementation(() => decodeGate.promise);
        const prime = spyOn(blobCache, "primeResourceBlobCache");
        let uploaded = 0;
        try {
            await withAdapter(async () => {
                uploaded += 1;
                return { data: envelope({ id: "res-decode" }), status: 200, statusText: "OK", headers: {}, config: {} as never };
            }, async () => {
                const pending = uploadImage(new Blob(["img"], { type: "image/png" }));
                await Promise.resolve();
                setActiveUserScope("owner-b");
                decodeGate.resolve({ width: 8, height: 8, mimeType: "image/png" });
                await expect(pending).rejects.toBeInstanceOf(UserScopeAbandonedError);
                expect(uploaded).toBe(0);
                expect(prime).not.toHaveBeenCalled();
            });
        } finally {
            decode.mockRestore();
            prime.mockRestore();
            native.mockRestore();
            restore();
        }
    });

    test("successful upload that completes after an account change does not prime the new account cache", async () => {
        const restore = switchScope("owner-a");
        const uploadGate = deferred();
        const native = spyOn(runtimeMode, "isNativeDesktopRuntime").mockReturnValue(true);
        const decode = spyOn(imageUtils, "readImageMeta").mockResolvedValue({ width: 8, height: 8, mimeType: "image/png" });
        const prime = spyOn(blobCache, "primeResourceBlobCache").mockResolvedValue("");
        try {
            await withAdapter(async (config) => {
                await uploadGate.promise;
                return { data: envelope({ id: "res-cache" }), status: 200, statusText: "OK", headers: {}, config };
            }, async () => {
                const pending = uploadImage(new Blob(["img"], { type: "image/png" }));
                setActiveUserScope("owner-b");
                uploadGate.resolve();
                await expect(pending).rejects.toBeInstanceOf(UserScopeAbandonedError);
                expect(prime).not.toHaveBeenCalled();
            });
        } finally {
            decode.mockRestore();
            prime.mockRestore();
            native.mockRestore();
            restore();
        }
    });
});
