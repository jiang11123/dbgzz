import type { GenerationTask } from "@/services/api/task-center";

export const taskDiscoveryLimit = 100;

/** Backend state wins even when a stale canvas snapshot has a later timestamp. */
export function mergeTaskHistory(local: GenerationTask[], backend: GenerationTask[]): GenerationTask[] {
    const byId = new Map<string, GenerationTask>();
    for (const source of [local, backend]) {
        const newest = new Map<string, GenerationTask>();
        for (const task of source) {
            const previous = newest.get(task.id);
            if (!previous || previous.updatedAt < task.updatedAt) newest.set(task.id, task);
        }
        for (const task of newest.values()) byId.set(task.id, task);
    }
    return [...byId.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id));
}

export async function discoverBackendTasks(
    read: (limit: number, options?: { activeOnly?: boolean }) => Promise<GenerationTask[]>,
    previous: GenerationTask[],
) {
    const [recent, active] = await Promise.allSettled([
        read(taskDiscoveryLimit),
        read(taskDiscoveryLimit, { activeOnly: true }),
    ]);
    const stale = recent.status === "rejected" ? previous : active.status === "rejected"
        ? previous.filter((task) => task.status === "queued" || task.status === "running") : [];
    const fresh = mergeTaskHistory([], [
        ...(active.status === "fulfilled" ? active.value : []),
        ...(recent.status === "fulfilled" ? recent.value : []),
    ]);
    return {
        tasks: mergeTaskHistory(stale, fresh),
        incomplete: recent.status === "rejected" || active.status === "rejected",
    };
}
