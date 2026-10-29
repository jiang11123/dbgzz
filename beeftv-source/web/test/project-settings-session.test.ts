import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { projectSettingsSessionKey, shouldApplyProjectSettingsMutation } from "@/pages/projects/detail/project-settings-session";
import { getActiveUserScope, setActiveUserScope } from "@/lib/user-scope";
import { captureUserScope, UserScopeAbandonedError } from "@/lib/user-scope-guard";

function switchScope(userId: string) {
    const previous = getActiveUserScope();
    setActiveUserScope(userId);
    return () => setActiveUserScope(previous);
}

const read = (path: string) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../src", path), "utf8");

describe("project settings mutation identity", () => {
    test("same mounted project and generation can apply success and ordinary errors", () => {
        const restore = switchScope("owner-a");
        try {
            const entryScope = captureUserScope();
            expect(shouldApplyProjectSettingsMutation({
                entryScope,
                mountedProjectId: "project-a",
                liveProjectId: "project-a",
                mounted: true,
            })).toBe(true);
            expect(shouldApplyProjectSettingsMutation({
                entryScope,
                mountedProjectId: "project-a",
                liveProjectId: "project-a",
                mounted: true,
                error: new Error("保存失败"),
            })).toBe(true);
        } finally {
            restore();
        }
    });

    test("project change does not apply a stale save or toast", () => {
        const restore = switchScope("owner-a");
        try {
            const entryScope = captureUserScope();
            expect(shouldApplyProjectSettingsMutation({
                entryScope,
                mountedProjectId: "project-a",
                liveProjectId: "project-b",
                mounted: true,
            })).toBe(false);
            expect(shouldApplyProjectSettingsMutation({
                entryScope,
                mountedProjectId: "project-a",
                liveProjectId: "project-b",
                mounted: true,
                error: new Error("保存失败"),
            })).toBe(false);
        } finally {
            restore();
        }
    });

    test("A to B to A does not apply callbacks onto the replacement generation", () => {
        const restore = switchScope("owner-a");
        try {
            const entryScope = captureUserScope();
            setActiveUserScope("owner-b");
            setActiveUserScope("owner-a");
            expect(shouldApplyProjectSettingsMutation({
                entryScope,
                mountedProjectId: "project-a",
                liveProjectId: "project-a",
                mounted: true,
            })).toBe(false);
            expect(shouldApplyProjectSettingsMutation({
                entryScope,
                mountedProjectId: "project-a",
                liveProjectId: "project-a",
                mounted: true,
                error: new Error("保存失败"),
            })).toBe(false);
        } finally {
            restore();
        }
    });

    test("unmounted session and abandoned errors do not toast", () => {
        const restore = switchScope("owner-a");
        try {
            const entryScope = captureUserScope();
            expect(shouldApplyProjectSettingsMutation({
                entryScope,
                mountedProjectId: "project-a",
                liveProjectId: "project-a",
                mounted: false,
            })).toBe(false);
            expect(shouldApplyProjectSettingsMutation({
                entryScope,
                mountedProjectId: "project-a",
                liveProjectId: "project-a",
                mounted: true,
                error: new UserScopeAbandonedError(),
            })).toBe(false);
        } finally {
            restore();
        }
    });

    test("session key changes with project and generation", () => {
        expect(projectSettingsSessionKey("project-a", 1)).toBe("project-a:1");
        expect(projectSettingsSessionKey("project-a", 1)).not.toBe(projectSettingsSessionKey("project-a", 2));
        expect(projectSettingsSessionKey("project-a", 1)).not.toBe(projectSettingsSessionKey("project-b", 1));
    });
});

test("settings page remounts on project and generation and binds save, archive, and cover mutations", () => {
    const settings = read("pages/projects/detail/settings.tsx");
    expect(settings).toContain("key={projectSettingsSessionKey(props.detail.project.id, generation)}");
    expect(settings).toContain("const [mountedProjectId] = useState(project.id)");
    expect(settings).toContain("updateProject(input.projectId, input.payload, input.expectedScope)");
    expect(settings).toContain("updateProject(input.projectId, { status: input.status }, input.expectedScope)");
    expect(settings).toContain("coverMutation.mutate({ coverResourceId: \"\", expectedScope: entryScope, projectId: mountedProjectId })");
    expect(settings).toContain("shouldApplyProjectSettingsMutation");
});
