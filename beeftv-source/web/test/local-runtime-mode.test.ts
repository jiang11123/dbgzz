import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { isLocalRuntimeModeForSession } from "../src/lib/runtime-mode";

const imageStorage = readFileSync(new URL("../src/services/image-storage.ts", import.meta.url), "utf8");
const fileStorage = readFileSync(new URL("../src/services/file-storage.ts", import.meta.url), "utf8");

test("local-first runtime treats the pre-hydration remote default as local", () => {
    expect(isLocalRuntimeModeForSession({ storageMode: "remote", user: null }, true)).toBe(true);
});

test("hosted runtime can still opt into remote persistence", () => {
    expect(isLocalRuntimeModeForSession({ storageMode: "remote", user: { username: "alice" } }, false)).toBe(false);
});

test("explicit local session remains local when the build flag is disabled", () => {
    expect(isLocalRuntimeModeForSession({ storageMode: "local", user: { username: "local" } }, false)).toBe(true);
});

test("upload boundaries use the shared runtime decision", () => {
    expect(imageStorage).toContain("usesBrowserLocalResourceStore");
    expect(fileStorage).toContain("usesBrowserLocalResourceStore");
    expect(imageStorage).toContain("const localRuntime = isLocalRuntimeMode();");
    expect(fileStorage).toContain("if (usesBrowserLocalResourceStore())");
    expect(imageStorage).toContain("The desktop Go resource service is local storage");
    expect(fileStorage).toContain("The native desktop Go resource service is the canonical local store");
    expect(imageStorage).not.toContain("if (!localOnly) try");
    expect(fileStorage).not.toContain("if (!localOnly) try");
});
