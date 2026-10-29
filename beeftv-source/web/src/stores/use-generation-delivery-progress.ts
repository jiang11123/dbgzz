import { create } from "zustand";

import type { GenerationTaskDeliveryProgress } from "@/services/api/task-center";

// Live "fetching the result" progress per task. It is transient UI state: it
// is never written into node metadata, because node metadata is persisted with
// canvas commits and would turn every progress tick into a save.
type GenerationDeliveryProgressState = {
    byTask: Record<string, GenerationTaskDeliveryProgress>;
    publish: (taskId: string, progress: GenerationTaskDeliveryProgress | undefined) => void;
};

export const useGenerationDeliveryProgress = create<GenerationDeliveryProgressState>((set) => ({
    byTask: {},
    publish: (taskId, progress) =>
        set((state) => {
            if (!progress) {
                if (!(taskId in state.byTask)) return state;
                const { [taskId]: _removed, ...rest } = state.byTask;
                return { byTask: rest };
            }
            return { byTask: { ...state.byTask, [taskId]: progress } };
        }),
}));

export function publishGenerationDeliveryProgress(taskId: string, progress: GenerationTaskDeliveryProgress | undefined) {
    useGenerationDeliveryProgress.getState().publish(taskId, progress);
}
