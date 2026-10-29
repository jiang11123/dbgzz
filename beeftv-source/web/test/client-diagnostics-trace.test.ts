import { afterAll, expect, test } from "bun:test";
import type { AxiosRequestConfig, AxiosResponse } from "axios";
import { apiClient, http } from "@/services/api/request";
import { getClientDiagnosticEvents, getClientDiagnosticSnapshot, getDiagnosticTraceId, initializeClientDiagnostics, recordDiagnosticEvent, setDiagnosticUserScope, taskDiagnosticHeaders } from "@/services/diagnostics/client-diagnostics";
import { parseDiagnosticTraceparent } from "@/services/diagnostics/diagnostic-trace";
import { installLocalForageStoreFactoryForTests } from "@/lib/localforage-storage";

const originalWindow = globalThis.window;
const originalAdapter = apiClient.defaults.adapter;
afterAll(() => { apiClient.defaults.adapter = originalAdapter; globalThis.window = originalWindow; installLocalForageStoreFactoryForTests(); });
const traceA = "a".repeat(32), traceB = "b".repeat(32);

test("concurrent task creation preserves explicit W3C context and binds each task to its own trace", async () => {
    const records = new Map<string, unknown>();
    installLocalForageStoreFactoryForTests(() => ({ ready: async () => {}, getItem: async (key: string) => records.get(key) ?? null, setItem: async (key: string, value: unknown) => { records.set(key, value); return value; } }) as any);
    Object.assign(globalThis, { window: { addEventListener() {}, location: { pathname: "/canvas", href: "http://localhost/canvas", origin: "http://localhost" }, localStorage: { getItem: () => null } } });
    initializeClientDiagnostics();
    setDiagnosticUserScope("trace-concurrency");
    const pending = new Map<string, { config: AxiosRequestConfig; finish(): void }>();
    apiClient.defaults.adapter = config => new Promise<AxiosResponse>(resolve => {
        const data = JSON.parse(config.data as string);
        pending.set(data.clientOperationId, { config, finish: () => resolve({ config, status: 200, statusText: "OK", headers: { "x-canvas-trace-id": data.clientOperationId === "op-A" ? traceA : traceB }, data: { code: 0, data: { id: data.clientOperationId === "op-A" ? "task-A" : "task-B" } } }) });
    });
    const a = http.post("/tasks", { clientOperationId: "op-A", projectId: "canvas-A" }, { headers: { traceparent: `00-${traceA}-${"1".repeat(16)}-01`, "X-Canvas-Trace-ID": traceB } });
    const b = http.post("/tasks", { clientOperationId: "op-B", projectId: "canvas-B" }, { headers: { "X-Canvas-Trace-ID": traceB } });
    await new Promise(resolve => setTimeout(resolve, 0));
    const read = (op: string, key: string) => (pending.get(op)!.config.headers as any).get(key);
    expect(read("op-A", "traceparent")).toBe(`00-${traceA}-${"1".repeat(16)}-01`);
    expect(read("op-A", "X-Canvas-Trace-ID")).toBe(traceA);
    expect(parseDiagnosticTraceparent(read("op-B", "traceparent"))?.traceId).toBe(traceB);
    pending.get("op-B")!.finish(); await b; pending.get("op-A")!.finish(); await a;
    expect(getDiagnosticTraceId("task-A")).toBe(traceA); expect(getDiagnosticTraceId("task-B")).toBe(traceB);
    expect(taskDiagnosticHeaders("task-A")["X-Canvas-Trace-ID"]).toBe(traceA);
    const events = getClientDiagnosticEvents().filter(event => event.taskId);
    expect(events.find(event => event.taskId === "task-A")).toMatchObject({ traceId: traceA, canvasId: "canvas-A", clientOperationId: "op-A" });
    expect(events.find(event => event.taskId === "task-B")).toMatchObject({ traceId: traceB, canvasId: "canvas-B", clientOperationId: "op-B" });
});

test("old-scope responses are discarded and diagnostic endpoints do not record their own export", async () => {
    setDiagnosticUserScope("trace-before-switch");
    let complete!: () => void;
    apiClient.defaults.adapter = config => new Promise(resolve => { complete = () => resolve({ config, status: 200, statusText: "OK", headers: {}, data: { code: 0, data: {} } }); });
    const request = http.get("/tasks/task-private"); await new Promise(resolve => setTimeout(resolve, 0));
    setDiagnosticUserScope("trace-new-owner"); complete(); await request;
    expect(getClientDiagnosticEvents()).toEqual([]);
    apiClient.defaults.adapter = async config => ({ config, status: 200, statusText: "OK", headers: {}, data: { code: 0, data: {} } });
    await http.post("/diagnostics/preview", { description: "private" });
    expect(getClientDiagnosticEvents()).toEqual([]);
});

test("exported events contain structural media facts while dropping URLs, prompts and path contents", async () => {
    setDiagnosticUserScope("trace-redaction");
    recordDiagnosticEvent({ level: "error", category: "runtime", message: "decode https://secret.example/private-signed.mp4?key=canary prompt=hidden prompt", stack: "/Users/person/private-canary/file.js", nodeId: "node-1", media: { phase: "playback_failed", errorCode: 3, width: 864, height: 496 } });
    const event = (await getClientDiagnosticSnapshot()).events[0];
    expect(event.media).toMatchObject({ phase: "playback_failed", errorCode: 3 });
    expect(JSON.stringify(event)).not.toMatch(/secret\.example|private-canary|hidden prompt|canary/);
});
