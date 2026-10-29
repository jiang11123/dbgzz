import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { listTaskLogs, queryGenerationTask, type GenerationTask, type TaskLog } from "@/services/api/task-center";

/** Local workspaces also have durable tasks in the desktop backend. */
export function useTaskDetails(taskId: string | undefined, scope: string) {
    const client = useQueryClient();
    useEffect(() => {
        const onCancelled = (event: Event) => {
            const task = (event as CustomEvent<{ task?: GenerationTask }>).detail?.task;
            if (task && task.id === taskId) {
                const queryKey = ["task-details", scope, taskId];
                // Keep the cancellation receipt even if the following log read fails.
                client.setQueryData<{ task: GenerationTask; logs: TaskLog[] }>(queryKey, (current) => ({ task, logs: current?.logs ?? [] }));
                void client.invalidateQueries({ queryKey });
            }
        };
        window.addEventListener("canvas:task-cancelled", onCancelled);
        return () => window.removeEventListener("canvas:task-cancelled", onCancelled);
    }, [client, scope, taskId]);
    return useQuery({
        queryKey: ["task-details", scope, taskId],
        enabled: Boolean(taskId) && !taskId!.startsWith("local:"),
        queryFn: async ({ signal }) => {
            const [task, logs] = await Promise.all([
                queryGenerationTask(taskId!, { signal }),
                listTaskLogs(taskId!, { signal }),
            ]);
            return { task, logs };
        },
        refetchInterval: (query) => {
            const status = query.state.data?.task.status;
            return query.state.error || !status || status === "queued" || status === "running" ? 2_000 : false;
        },
        retry: false,
        gcTime: 0,
    });
}
