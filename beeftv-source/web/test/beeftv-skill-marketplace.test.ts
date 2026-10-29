import { expect, test } from "bun:test";
import { canSubmitPublication, needsPublicationTargetCorrection, requirementLabel, publicationStatus, unsupportedRequirements } from "../src/pages/skills/market-copy";

async function source(path: string) {
    return Bun.file(new URL(path, import.meta.url)).text();
}

test("implemented skill route is discoverable while reference experiments remain hidden", async () => {
    const [router, sidebar] = await Promise.all([
        source("../src/router.tsx"),
        source("../src/components/layout/workspace-sidebar-nav.tsx"),
    ]);
    expect(router).toContain('{ path: "/skill", element: <Navigate to="/skills" replace /> }');
    expect(router).toContain('{ path: "/skills", element: deferred(<SkillsPage />) }');
    expect(router).not.toContain("SkillsReferencePage");
    expect(sidebar).toContain('toolItem("skills", "/skills")');
});

test("public submission requires this preview and a separate user confirmation", () => {
    for (const status of ["awaiting_upload_confirmation", "uploading", "needs_preview", "submitted", "published", "rejected"]) {
        expect(canSubmitPublication({ status, preview: { revision: 2 } }, true)).toBe(false);
    }
    expect(canSubmitPublication({ status: "awaiting_submit_confirmation" }, true)).toBe(false);
    expect(canSubmitPublication({ status: "awaiting_submit_confirmation", preview: {} }, false)).toBe(false);
    expect(canSubmitPublication({ status: "awaiting_submit_confirmation", preview: {} }, true)).toBe(true);
});

test("unknown capabilities and publication states never look accepted", () => {
    expect(requirementLabel("model.audio")).toBe("音频理解模型");
    expect(requirementLabel("needs secret")).toContain("未确认");
    expect(publicationStatus("new-unknown-state")).toBe("状态待刷新");
    expect(publicationStatus("rejected")).toBe("需要修改");
});

test("legacy publication requirements stay visible until the author explicitly removes them", () => {
    const original = ["text", "model.audio", "future"];
    expect(unsupportedRequirements(original)).toEqual(["text", "future"]);
    expect(original).toEqual(["text", "model.audio", "future"]);
    expect(unsupportedRequirements([])).toEqual([]);
    expect(unsupportedRequirements(["beeftv.canvas", "model.image", "model.video", "model.audio"])).toEqual([]);
});

test("ambiguous legacy publication IDs require explicit correction before upload", () => {
    const base = { skillId: "local-one", metadata: { name: "text", description: "text", versionLabel: "1.0.0", license: "MIT", sourceUrl: "", requirements: [], showcase: [] } };
    expect(needsPublicationTargetCorrection(base)).toBe(false);
    expect(needsPublicationTargetCorrection({ ...base, metadata: { ...base.metadata, skillId: "local-one" } })).toBe(true);
    expect(needsPublicationTargetCorrection({ ...base, metadata: { ...base.metadata, skillId: "real-cloud-one" } })).toBe(true);
    expect(needsPublicationTargetCorrection({ ...base, publicationTarget: "existing", marketSkillId: "real-cloud-one", metadata: { ...base.metadata, skillId: "real-cloud-one" } })).toBe(false);
    expect(needsPublicationTargetCorrection({ ...base, publicationTarget: "existing", marketSkillId: "local-one", metadata: { ...base.metadata, skillId: "local-one" } })).toBe(true);
    expect(needsPublicationTargetCorrection({ ...base, publicationTarget: "new", submissionId: "draft-one", metadata: { ...base.metadata, skillId: "assigned-cloud-one" } })).toBe(false);
});
