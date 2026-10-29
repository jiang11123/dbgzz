import { isDoubaoVideoModel } from "@/lib/doubao-video-model";
import { doubaoCancelVideoTask } from "@/services/api/doubao-gateway";
import { queryGenerationTask, type GenerationTask } from "@/services/api/task-center";

/**
 * 后端只会向 Gemini Veo、火山 Ark 这类写死支持的协议转发取消。节点上取消豆包视频任务时，
 * 这里顺手让本地网关取消对应的豆包任务，避免它继续占着账号、消耗额度。
 * 尽力而为：失败不影响后端任务的取消结果。
 */
export async function cancelDoubaoGatewayTask(task: Pick<GenerationTask, "id" | "model" | "providerRequestId">): Promise<void> {
    if (!isDoubaoVideoModel(task.model)) return;
    try {
        const gatewayTaskId = task.providerRequestId || (await queryGenerationTask(task.id)).providerRequestId;
        if (gatewayTaskId) await doubaoCancelVideoTask(gatewayTaskId);
    } catch {
        // 网关不可达或任务已结束时忽略
    }
}
