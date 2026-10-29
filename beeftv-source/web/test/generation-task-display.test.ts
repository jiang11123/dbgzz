import { expect, test } from "bun:test";
import { generationTaskShowsProgress, generationTaskStageLabel, generationTaskStatusLabel } from "@/lib/generation-task-display";

for (const [stage, label] of [["delivery_paused", "已暂停取回结果"], ["delivery_timed_out", "下载超时，可继续取回原结果"]]) {
    test(`${stage} keeps generation success separate from result delivery`, () => {
        const task = { status: "succeeded" as const, stage };
        expect(generationTaskStatusLabel(task)).toBe("待取回结果");
        expect(generationTaskStageLabel(task)).toBe(label);
        expect(generationTaskShowsProgress(task)).toBe(false);
    });
}
