import { afterEach, expect, test } from "bun:test";

import {
    resetWorkspaceMode,
    setWorkspaceCapabilitySnapshot,
    workspaceCapabilities,
} from "../src/services/workspace-mode";

afterEach(() => resetWorkspaceMode());

test("workspace capabilities expose only the local runtime contract", () => {
    setWorkspaceCapabilitySnapshot({
        contractVersion: 1,
        profile: "local",
        capabilities: {
            localAssets: true,
            providerCalls: true,
        },
    });

    expect(workspaceCapabilities()).toEqual({
        local: true,
        localAssets: true,
        providerCalls: true,
    });
});

test("workspace capabilities use safe local defaults before bootstrap", () => {
    expect(workspaceCapabilities()).toEqual({
        local: true,
        localAssets: true,
        providerCalls: true,
    });
});
