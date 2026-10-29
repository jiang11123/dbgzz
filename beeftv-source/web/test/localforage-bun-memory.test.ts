import { expect, test } from "bun:test";
import localforage from "localforage";
import { BUN_MEMORY_DRIVER } from "./helpers/localforage-bun-memory";
import "@/lib/localforage-storage";

async function runStorageProbe(source: string) {
    const child = Bun.spawn([process.execPath, "-e", source], { cwd: import.meta.dir + "/..", stdout: "pipe", stderr: "pipe" });
    // The parent timer still runs if a child regresses into the microtask loop.
    const watchdog = setTimeout(() => child.kill("SIGKILL"), 3000);
    try {
        const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
        expect({ status, stderr }).toEqual({ status: 0, stderr: "" });
        return stdout.trim();
    } finally {
        clearTimeout(watchdog);
        if (child.exitCode === null) child.kill("SIGKILL");
    }
}

test("Bun preload initializes methods after module configuration and before test spies", async () => {
    expect(localforage.config()).toMatchObject({ name: "infinite-canvas", storeName: "app_state" });
    const read = localforage.getItem;
    await localforage.ready();
    expect(localforage.getItem).toBe(read);
});

test("Bun memory driver opens real localforage methods and partitions by database and store", async () => {
    const originalWindow = globalThis.window;
    const first = localforage.createInstance({ name: "memory-driver-sharing", storeName: "first" });
    const reopened = localforage.createInstance({ name: "memory-driver-sharing", storeName: "first" });
    const otherStore = localforage.createInstance({ name: "memory-driver-sharing", storeName: "second" });
    const otherDatabase = localforage.createInstance({ name: "memory-driver-other", storeName: "first" });
    await first.ready();
    expect(first.driver()).toBe(BUN_MEMORY_DRIVER);
    const value = { title: "saved", bytes: new Uint8Array([1, 2]) };
    expect(await first.setItem("record", value)).toEqual(value);
    value.title = "mutated";
    const read = await reopened.getItem<typeof value>("record");
    expect(read).toEqual({ title: "saved", bytes: new Uint8Array([1, 2]) });
    read!.title = "read mutation";
    expect((await first.getItem<typeof value>("record"))?.title).toBe("saved");
    expect(await otherStore.getItem("record")).toBeNull();
    expect(await otherDatabase.getItem("record")).toBeNull();
    expect(globalThis.window).toBe(originalWindow);
});

test("Bun memory driver preserves null, undefined, callbacks and early iteration stops", async () => {
    const store = localforage.createInstance({ name: "memory-driver-methods", storeName: "values" });
    expect(await store.getItem("missing")).toBeNull();
    expect(await store.setItem("undefined", undefined)).toBeNull();
    expect(await store.setItem("null", null)).toBeNull();
    expect(await store.getItem("undefined")).toBeNull();
    let called = false;
    const writing = store.setItem("value", 7, (error, value) => {
        expect(error).toBeNull();
        expect(value).toBe(7);
        called = true;
    });
    expect(called).toBe(false);
    await writing;
    expect(called).toBe(true);
    expect(await store.length()).toBe(3);
    expect(await store.keys()).toEqual(["undefined", "null", "value"]);
    expect(await store.key(2)).toBe("value");
    expect(await store.key(-1)).toBeNull();
    expect(await store.key(3)).toBeNull();
    const seen: Array<[unknown, string, number]> = [];
    expect(await store.iterate((value, key, index) => { seen.push([value, key, index]); })).toBeUndefined();
    expect(seen).toEqual([[null, "undefined", 1], [null, "null", 2], [7, "value", 3]]);
    for (const stop of [false, 0, "", null]) {
        let visits = 0;
        expect(await store.iterate(() => { visits++; return stop; })).toBe(stop);
        expect(visits).toBe(1);
    }
    await store.removeItem("null");
    expect(await store.keys()).toEqual(["undefined", "value"]);
    await store.clear();
    expect(await store.length()).toBe(0);
});

test("an explicitly unavailable driver rejects ready and read/write without recursive starvation", async () => {
    const source = `import localforage from "localforage";
        import "./test/helpers/localforage-bun-memory.ts";
        const store = localforage.createInstance({ driver: "missing-driver" });
        for (const operation of [() => store.ready(), () => store.getItem("key"), () => store.setItem("key", "value")]) {
            try { await operation(); throw new Error("unexpected storage success"); }
            catch (error) { if (error.message !== "No available storage method found.") throw error; }
        }
        console.log("ready/read/write rejected");`;
    expect(await runStorageProbe(source)).toBe("ready/read/write rejected");
});

test("loading the driver preserves the real facade's default database and store configuration", async () => {
    const source = `import localforage from "localforage";
        import "./test/helpers/localforage-bun-memory.ts";
        await import("./src/lib/localforage-storage.ts");
        const config = localforage.config();
        if (config.name !== "infinite-canvas" || config.storeName !== "app_state") {
            throw new Error("facade configuration was applied after storage opened: " + JSON.stringify(config));
        }
        await localforage.setItem("default-partition", "saved");
        const reopened = localforage.createInstance({ name: "infinite-canvas", storeName: "app_state" });
        if (await reopened.getItem("default-partition") !== "saved") throw new Error("default instance used another partition");
        console.log("facade default partition preserved");`;
    expect(await runStorageProbe(source)).toBe("facade default partition preserved");
});
