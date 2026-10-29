import { describe, expect, test } from "bun:test";

import { chapterStoryboardApprovalSnapshot, chapterStoryboardRecoveryDecision, chapterTaskIdentity } from "@/pages/projects/detail/project-chapter-ai";
import type { GenerationTask } from "@/services/api/task-center";

describe("章节生成任务刷新恢复", () => {
    test("优先从任务列表的安全客户端上下文识别章节与操作", () => {
        expect(chapterTaskIdentity(task({
            clientContext: {
                domainProjectId: "project-1",
                chapterId: "chapter-1",
                chapterOperation: "characters",
            },
        }))).toEqual({ chapterId: "chapter-1", kind: "characters" });
    });

    test("任务详情可从脱敏输入 metadata 恢复分镜操作", () => {
        expect(chapterTaskIdentity(task({
            inputJson: JSON.stringify({
                metadata: {
                    domainProjectId: "project-1",
                    chapterId: "chapter-2",
                    source: "short-drama-chapter-storyboard",
                },
            }),
        }))).toEqual({ chapterId: "chapter-2", kind: "storyboard" });
    });

    test("无关、缺少章节或损坏的任务输入不会关联章节按钮", () => {
        expect(chapterTaskIdentity(task({ inputJson: "{" }))).toBeNull();
        expect(chapterTaskIdentity(task({ inputJson: JSON.stringify({ metadata: { operation: "chapter_character_breakdown" } }) }))).toBeNull();
        expect(chapterTaskIdentity(task({ inputJson: JSON.stringify({ metadata: { chapterId: "chapter-1", operation: "other" } }) }))).toBeNull();
    });

    test("从任务输入读取原批准快照，拒绝用当前页面版本顶上", () => {
        const current = { revision: 9, shotIds: ["shot-a"] };
        const snapshot = chapterStoryboardApprovalSnapshot(JSON.stringify({
            metadata: {
                domainProjectId: "project-1",
                chapterId: "chapter-1",
                source: "short-drama-chapter-storyboard",
                approvedRevision: 4,
                approvedShotIds: ["shot-a"],
            },
        }));
        expect(snapshot).toEqual({ revision: 4, shotIds: ["shot-a"] });
        expect(snapshot).not.toEqual(current);
    });

    test("刷新后按真实回执分类：已写入跳过，未写入进入核对", () => {
        expect(chapterStoryboardRecoveryDecision({ alreadyApplied: true })).toEqual({ action: "skip" });
        expect(chapterStoryboardRecoveryDecision({ alreadyApplied: false })).toEqual({ action: "review" });
    });

    test("未写入结果即使仍有原批准快照也不会自动写入", () => {
        const snapshot = chapterStoryboardApprovalSnapshot(JSON.stringify({
            metadata: {
                source: "short-drama-chapter-storyboard",
                approvedRevision: 5,
                approvedShotIds: ["shot-a"],
            },
        }));
        expect(snapshot).toEqual({ revision: 5, shotIds: ["shot-a"] });
        expect(chapterStoryboardRecoveryDecision({ alreadyApplied: false })).toEqual({ action: "review" });
    });

    test("恢复路径使用任务身份与冻结快照，不靠时间戳猜测", async () => {
        const source = await Bun.file(new URL("../src/pages/projects/detail/chapters.tsx", import.meta.url)).text();
        const helper = await Bun.file(new URL("../src/pages/projects/detail/project-chapter-ai.ts", import.meta.url)).text();
        const createStoryboard = source.slice(source.indexOf("const createStoryboard"));
        const applyRecovery = source.slice(source.indexOf("const applyPendingStoryboardRecovery"));
        expect(helper).toContain("approvedRevision: input.approvedRevision");
        expect(helper).toContain("approvedShotIds: input.approvedShotIds.slice()");
        expect(helper).toContain("taskId: completed.id");
        expect(helper).toContain("expectedScope: options?.expectedScope");
        expect(source).toContain("listChapterApplyReceipts");
        expect(source).toContain("sourceTaskId");
        expect(source).toContain("captureUserScope");
        expect(source).toContain("queryGenerationTask(task.id, { expectedScope })");
        expect(source).toContain("核对后写入");
        expect(createStoryboard.indexOf("const approvedRevision")).toBeLessThan(createStoryboard.indexOf("confirmStoryboardReplacement"));
        expect(applyRecovery.indexOf("const reviewedRevision")).toBeLessThan(applyRecovery.indexOf("confirmRecoveredStoryboardWrite"));
        expect(source).not.toContain("chapterTaskResultAlreadyApplied");
        expect(source).not.toContain("shot.updatedAt");
        expect(source).not.toMatch(/storeGeneratedStoryboard\([^;]*detail\.project\.revision/);
        expect(source).toContain("error.reason === \"project_unit_shots_changed\"");
        expect(source).toContain("error.reason === \"project_revision_conflict\"");
        expect(source).not.toContain('error.reason === "conflict"');
        expect(source).not.toContain("本章分镜已发生变化，请刷新后重新确认");
        expect(source).not.toContain("项目已被其他操作更新，请重新加载后再保存");
        expect(source).not.toContain("刷新前生成的分镜还在");
    });
});

function task(overrides: Partial<GenerationTask>): GenerationTask {
    return {
        id: "task-1",
        type: "text",
        status: "running",
        prompt: "",
        attempts: 1,
        createdAt: "2026-08-29T00:00:00.000Z",
        updatedAt: "2026-08-29T00:00:00.000Z",
        ...overrides,
    };
}
