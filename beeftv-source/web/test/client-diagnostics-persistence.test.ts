import { expect, test } from "bun:test";
import { createDiagnosticEventStore } from "@/services/diagnostics/diagnostic-event-store";
import type { ClientDiagnosticEvent } from "@/services/diagnostics/client-diagnostics";

const now = Date.parse("2026-10-21T06:00:00Z");
const event = (id: string, overrides: Partial<ClientDiagnosticEvent> = {}): ClientDiagnosticEvent => ({ id, timestamp: new Date(now).toISOString(), launchId: "launch-1", sessionId: "launch-1", level: "error", category: "task", message: "bind refused", ...overrides });
function harness(extra: Partial<Parameters<typeof createDiagnosticEventStore>[0]> = {}) {
    const values = new Map<string, string>();
    const storage = (scope: string) => ({ getItem: async (name: string) => values.get(`${scope}/${name}`), setItem: async (name: string, value: string) => { values.set(`${scope}/${name}`, value); } });
    const make = (launchId = "launch-1") => createDiagnosticEventStore({ storage, sanitize: value => value, now: () => now, launchId, ...extra });
    return { make, storage, values };
}

test("restart hydration merges previous launch with events recorded before hydration; export waits for the write", async () => {
    const h = harness();
    const first = h.make(); first.setScope("owner"); first.record(event("first"));
    expect((await first.snapshot()).coverage.persisted).toBe(true);
    const restarted = h.make("launch-2"); restarted.setScope("owner"); restarted.record(event("second", { launchId: "launch-2" }));
    const exported = await restarted.snapshot();
    expect(exported.events.map(item => item.id)).toEqual(["first", "second"]);
    expect(exported.coverage).toMatchObject({ status: "available", sessionCount: 2, exportedCount: 2, persisted: true });
    const third = h.make(); third.setScope("owner");
    expect((await third.snapshot()).events.length).toBe(2);
});

test("pending hydration and writes stay owned during A-B-A switches; stale exports fail", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const values = new Map<string, string>();
    const store = createDiagnosticEventStore({ launchId: "one", now: () => now, sanitize: value => value, storage: scope => ({ getItem: async () => { if (scope === "A") await gate; return null; }, setItem: async (_name, value) => { values.set(scope, value); } }) });
    store.setScope("A"); store.record(event("A1")); const stale = store.snapshot().then(() => "unexpected_success", error => error.message);
    store.setScope("B"); store.record(event("B1"));
    expect((await store.snapshot()).events.map(item => item.id)).toEqual(["B1"]);
    store.setScope("A"); store.record(event("A2")); release(); expect(await stale).toContain("账号已切换");
    expect((await store.snapshot()).events.map(item => item.id)).toEqual(["A1", "A2"]);
    expect(values.get("A")).not.toContain("B1"); expect(values.get("B")).not.toContain("A1");
});

test("limits preserve decisive events over successful polling and persist loss counts", async () => {
    const h = harness(); const store = h.make(); store.setScope("owner");
    store.record(event("decisive", { code: "generation_bind_refused" }));
    for (let n = 0; n < 600; n++) store.record(event(`poll-${n}`, { category: "request", level: "info", message: "GET /tasks" }));
    const snapshot = await store.snapshot();
    expect(snapshot.events.length).toBe(500); expect(snapshot.events[0].id).toBe("decisive");
    expect(snapshot.coverage).toMatchObject({ status: "partial", droppedCount: 101 });
    const second = h.make(); second.setScope("owner");
    expect((await second.snapshot()).coverage.droppedCount).toBe(101);
});

test("byte and age limits report missing evidence instead of claiming a complete bundle", async () => {
    const h = harness(); const store = h.make(); store.setScope("owner");
    store.record(event("old", { timestamp: new Date(now - 25 * 3600_000).toISOString() }));
    for (let n = 0; n < 100; n++) store.record(event(`large-${n}`, { message: "中".repeat(3000) }));
    const snapshot = await store.snapshot();
    expect(snapshot.coverage.expiredCount).toBe(1); expect(snapshot.coverage.droppedCount).toBeGreaterThan(0);
    expect(new TextEncoder().encode(JSON.stringify(snapshot.events)).byteLength).toBeLessThanOrEqual(snapshot.coverage.maxBytes);
});

test("storage errors remain visible, do not prevent export and are retained after the next successful write", async () => {
    let fail = true; const h = harness();
    const store = h.make();
    const errorStore = createDiagnosticEventStore({ launchId: "one", now: () => now, sanitize: value => value, storage: scope => ({ getItem: async () => { throw new Error("read denied"); }, setItem: async (name, value) => { if (fail) throw new Error("quota"); return h.storage(scope).setItem(name, value); } }) });
    errorStore.setScope("owner"); errorStore.record(event("error"));
    expect((await errorStore.snapshot()).coverage).toMatchObject({ status: "partial", readErrorCount: 1, writeErrorCount: 1, persisted: false });
    fail = false; errorStore.record(event("recovered"));
    expect((await errorStore.snapshot()).coverage).toMatchObject({ writeErrorCount: 1, persisted: true });
    store.setScope("owner"); expect((await store.snapshot()).coverage.writeErrorCount).toBe(1);
});

test("an unavailable driver cannot hang preview or export forever", async () => {
    const never = () => new Promise<string>(() => {});
    const store = createDiagnosticEventStore({ launchId: "one", sanitize: value => value, timeoutMs: 10, storage: () => ({ getItem: never, setItem: never }) });
    store.setScope("owner"); store.record(event("kept", { timestamp: new Date().toISOString() }));
    const snapshot = await store.snapshot();
    expect(snapshot.events.length).toBe(1);
    expect(snapshot.coverage).toMatchObject({ status: "partial", readErrorCount: 1, writeErrorCount: 0, persisted: false });
});

test("a late timed-out physical write cannot overwrite a newer snapshot", async () => {
    let complete!: () => void;
    let first = true;
    let persisted = "";
    const store = createDiagnosticEventStore({ launchId: "one", sanitize: value => value, now: () => now, timeoutMs: 10, storage: () => ({ getItem: async () => null, setItem: async (_name, value) => { if (first) { first = false; await new Promise<void>(resolve => { complete = resolve; }); } persisted = value; } }) });
    store.setScope("owner"); store.record(event("one"));
    expect((await store.snapshot()).coverage.persisted).toBe(false);
    store.record(event("two")); complete();
    await new Promise(resolve => setTimeout(resolve, 0));
    const snapshot = await store.snapshot();
    expect(snapshot.coverage.persisted).toBe(true);
    expect(JSON.parse(persisted).events.map((item: ClientDiagnosticEvent) => item.id)).toEqual(["one", "two"]);
    expect(JSON.parse(persisted).writeErrorCount).toBe(1);
});

test("a late hydration merges original history before allowing any replacement write", async () => {
    let complete!: (value: string) => void;
    let writes = 0;
    let persisted = "";
    const store = createDiagnosticEventStore({ launchId: "new", sanitize: value => value, now: () => now, timeoutMs: 10, storage: () => ({ getItem: () => new Promise<string>(resolve => { complete = resolve; }), setItem: async (_name, value) => { writes++; persisted = value; } }) });
    store.setScope("owner"); store.record(event("new"));
    expect((await store.snapshot()).coverage).toMatchObject({ readErrorCount: 1, persisted: false });
    expect(writes).toBe(0);
    complete(JSON.stringify({ version: 1, events: [event("original")], droppedCount: 2, expiredCount: 0, readErrorCount: 0, writeErrorCount: 0 }));
    await new Promise(resolve => setTimeout(resolve, 0));
    const snapshot = await store.snapshot();
    expect(snapshot.events.map(item => item.id)).toEqual(["original", "new"]);
    expect(snapshot.coverage).toMatchObject({ readErrorCount: 1, droppedCount: 2, persisted: true });
    expect(JSON.parse(persisted).events.length).toBe(2);
});
