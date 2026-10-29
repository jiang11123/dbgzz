import { getLocalModelConfig, saveLocalModelConfig, type LocalModelConfigPayload } from "@/services/api/workspace";
import type { AiConfig } from "@/stores/use-config-store";

export type ModelConfigPersistenceState = {
    status: "idle" | "hydrating" | "saving" | "saved" | "error";
    revision: number;
    dirty: boolean;
    error: string;
};

type ModelConfigRepositoryDependencies = {
    read: () => Promise<LocalModelConfigPayload>;
    write: (config: AiConfig, expectedRevision: number) => Promise<{ saved: boolean; revision: number }>;
};

export function createModelConfigRepository(dependencies: ModelConfigRepositoryDependencies) {
    let state: ModelConfigPersistenceState = { status: "idle", revision: 0, dirty: false, error: "" };
    let hydrated = false;
    let latestConfig: AiConfig | null = null;
    let generation = 0;
    let drainPromise: Promise<void> | null = null;
    let resolveHydration: (() => void) | null = null;
    const hydrationBarrier = new Promise<void>((resolve) => {
        resolveHydration = resolve;
    });
    const listeners = new Set<(next: ModelConfigPersistenceState) => void>();

    const publish = (patch: Partial<ModelConfigPersistenceState>) => {
        state = { ...state, ...patch };
        listeners.forEach((listener) => listener(state));
    };

    const hydrate = async () => {
        publish({ status: "hydrating", error: "" });
        try {
            const result = await dependencies.read();
            state = { status: "idle", revision: result.revision, dirty: Boolean(latestConfig), error: "" };
            return result;
        } catch (error) {
            publish({ status: "error", error: error instanceof Error ? error.message : "读取模型配置失败" });
            throw error;
        } finally {
            hydrated = true;
            resolveHydration?.();
            resolveHydration = null;
            if (latestConfig) void scheduleDrain();
        }
    };

    const runDrain = async () => {
        const write = async (config: AiConfig, revision: number) => {
            const result = await dependencies.write(config, revision);
            if (!result.saved || !Number.isSafeInteger(result.revision) || result.revision < revision) {
                throw new Error("模型配置保存未得到确认，请重试");
            }
            return result;
        };
        while (hydrated && latestConfig && state.dirty) {
            const config = latestConfig;
            const savingGeneration = generation;
            publish({ status: "saving", error: "" });
            try {
                const result = await write(config, state.revision);
                state = { status: "saved", revision: result.revision, dirty: generation !== savingGeneration, error: "" };
            } catch (error) {
                if (isRevisionConflict(error)) {
                    try {
                        const current = await dependencies.read();
                        state = { ...state, revision: current.revision, status: "saving", dirty: true, error: "" };
                        const retried = await write(config, state.revision);
                        state = { status: "saved", revision: retried.revision, dirty: generation !== savingGeneration, error: "" };
                        continue;
                    } catch (retryError) {
                        error = retryError;
                    }
                }
                publish({ status: "error", dirty: true, error: error instanceof Error ? error.message : "保存模型配置失败" });
                return;
            }
        }
        listeners.forEach((listener) => listener(state));
    };

    const scheduleDrain = (): Promise<void> => {
        if (!hydrated) return hydrationBarrier.then(scheduleDrain);
        if (!drainPromise) {
            drainPromise = runDrain().finally(() => {
                drainPromise = null;
            });
        }
        return drainPromise;
    };

    const commit = (config: AiConfig) => {
        latestConfig = config;
        generation += 1;
        publish({ dirty: true });
        return scheduleDrain();
    };

    return {
        hydrate,
        commit,
        flush: scheduleDrain,
        getState: () => state,
        subscribe: (listener: (next: ModelConfigPersistenceState) => void) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
    };
}

function isRevisionConflict(error: unknown) {
    if (!error || typeof error !== "object") return false;
    const candidate = error as { status?: number; response?: { status?: number } };
    return candidate.status === 409 || candidate.response?.status === 409;
}

function omitManagedBeefAPISecrets(config: AiConfig): AiConfig {
    return {
        ...config,
        channels: config.channels.map((channel) => {
            if (channel.id !== "beefapi" || !channel.pinned) return channel;
            return { ...channel, apiKey: "", secretKey: "" };
        }),
    };
}

const repository = createModelConfigRepository({
    read: getLocalModelConfig,
    write: (config, expectedRevision) => saveLocalModelConfig(omitManagedBeefAPISecrets(config), expectedRevision),
});

export const hydrateModelConfig = repository.hydrate;
export const commitModelConfig = repository.commit;
export const flushModelConfig = repository.flush;
export const getModelConfigPersistenceState = repository.getState;
export const subscribeModelConfigPersistence = repository.subscribe;
