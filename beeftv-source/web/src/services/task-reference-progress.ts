import { subscribeUserScope } from "@/lib/user-scope";
import { userScopeMatches, type CapturedUserScope } from "@/lib/user-scope-guard";
import type { GenerationTask } from "@/services/api/task-center";
import { startOperation } from "@/stores/use-operation-progress";
import { generationTaskNodeId } from "@/lib/canvas/canvas-generation-task-identity";

const observations = new Map<string, ReturnType<typeof startOperation>>();
const latestRequests = new Map<string, number>();
let requestSequence = 0;
export const beginTaskReferenceObservation = () => ++requestSequence;
subscribeUserScope(() => { observations.clear(); latestRequests.clear(); });

export function publishTaskReferenceProgress(task: GenerationTask, owner: CapturedUserScope, request = beginTaskReferenceObservation()) {
    if (!userScopeMatches(owner)) return;
    const key = owner.userScope + ":" + owner.epoch + ":" + task.id;
    if (request < (latestRequests.get(key) ?? 0)) return;
    latestRequests.set(key, request);
    let observation = observations.get(key);
    const progress = task.referenceProgress;
    const nodeId = generationTaskNodeId(task);
    const target = task.projectId && nodeId ? { projectId: task.projectId, nodeId, taskId: task.id } : undefined;
    if (progress && task.status === "running") {
        if (!observation) {
            observation = startOperation("上传参考素材", { owner, target });
            observations.set(key, observation);
        }
        observation.update({ ...progress, detail: (progress.phase === "transferring" ? "正在上传" : progress.phase === "processing" ? "正在确认" : "正在准备") + progress.label });
    } else if (observation) {
        if (target) observation.dismiss();
        else if (task.status === "failed") observation.fail("生成任务未完成，请查看任务详情");
        else if (task.status === "succeeded") observation.done("参考素材已确认");
        // A missing snapshot can also be a retry or a lost worker lease.
        // Only a confirmed terminal success is enough to show completion.
        else observation.dismiss();
        observations.delete(key);
    }
}
