import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";

import { listGenerationTasks, type GenerationTask } from "@/services/api/task-center";

export function shouldEnableCanvasActiveTaskQuery(enabled: boolean, projectId: string) {
    return enabled && Boolean(projectId);
}

export function useCanvasActiveTasks(projectId: string, enabled: boolean) {
    const query = useQuery<GenerationTask[]>({
        queryKey: ["canvas-active-tasks", projectId],
        // Agent 的持久化执行仍复用任务队列生命周期，但不应占据画布右上角的“生成任务”浮层。
        // 保留这页中的全部生成任务，面板支持滚动，数量与实际任务一致。
        queryFn: () => listGenerationTasks(30, { projectId, activeOnly: true }).then((tasks) => tasks.filter((task) => !isRetiredAgentTask(task))),
        enabled: shouldEnableCanvasActiveTaskQuery(enabled, projectId),
        refetchInterval: (current) => (current.state.data?.length ? 2_000 : 10_000),
        refetchOnWindowFocus: true,
    });

    useEffect(() => {
        const handleTaskChanged = (event: Event) => {
            const task = (event as CustomEvent<{ task?: GenerationTask }>).detail?.task;
            if (task?.projectId === projectId) void query.refetch();
        };
        window.addEventListener("canvas:task-created", handleTaskChanged);
        window.addEventListener("canvas:task-cancelled", handleTaskChanged);
        window.addEventListener("canvas:task-updated", handleTaskChanged);
        return () => {
            window.removeEventListener("canvas:task-created", handleTaskChanged);
            window.removeEventListener("canvas:task-cancelled", handleTaskChanged);
            window.removeEventListener("canvas:task-updated", handleTaskChanged);
        };
    }, [projectId, query.refetch]);

    return {
        tasks: query.data || [],
        loading: query.isLoading,
        refreshing: query.isFetching,
        refetch: query.refetch,
    };
}

// 旧内置 Agent 已退场；历史库里的 Agent 任务不再属于画布活动任务。
function isRetiredAgentTask(task: GenerationTask) {
    return task.operation?.startsWith("cloud_agent") === true;
}
