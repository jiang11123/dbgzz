import { nanoid } from "nanoid";
import { creationRuns, type CreationSubmission } from "./api/creation-runs";
import type { CreateTaskInput } from "./api/task-center";

// Both the node composer and Agent submit the same locally admitted task.
export async function submitStoryboardTask(request: CreateTaskInput, options: {
    signal: AbortSignal;
    assertCurrent: () => void;
    confirm: (submission: CreationSubmission) => Promise<boolean>;
}, api = creationRuns) {
    const { signal, assertCurrent } = options;
    const detail = await api.create({ clientKey: `storyboard:${nanoid()}`, canvasId: request.projectId, state: { kind: "storyboard" } }, signal);
    const run = await api.claim(detail.run.id, { expectedEpoch: detail.run.executionEpoch, owner: `storyboard:${nanoid()}` }, signal);
    const guard = { executionEpoch: run.executionEpoch, owner: run.executionOwner };
    let connectionError: unknown;
    const heartbeat = setInterval(() => {
        void api.heartbeat(run.id, guard, signal).catch((error) => { connectionError = error; });
    }, 15_000);
    try {
        const submission = await api.prepare(run.id, { ...guard, itemKey: "storyboard", request }, signal);
        if (!await options.confirm(submission)) return undefined;
        signal.throwIfAborted();
        if (connectionError) throw connectionError;
        assertCurrent();
		const approved = await api.approve(run.id, { ...guard, submissionIds: [submission.id] }, signal);
        if (!approved.submissions.some((item) => item.id === submission.id && item.approvedAt)) throw new Error("本地任务准入回执不完整，尚未提交拆镜任务");
        signal.throwIfAborted();
        assertCurrent();
        return await api.execute(run.id, { ...guard, submissionId: submission.id }, signal);
    } finally {
        clearInterval(heartbeat);
        void api.release(run.id, guard).catch(() => { /* Offline leases expire on the server. */ });
    }
}
