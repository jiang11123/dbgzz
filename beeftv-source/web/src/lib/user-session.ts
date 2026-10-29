import { localForageStorage } from "@/lib/localforage-storage";
import { normalizeLocalAsset, normalizeLocalCanvasProject } from "@/lib/local-workspace-migration";
import { scopedLocalStorage, setActiveUserScope } from "@/lib/user-scope";
import { CANVAS_HISTORY_STORE_KEY, useCanvasHistoryStore } from "@/stores/canvas/use-canvas-history-store";
import { CANVAS_STORE_KEY, flushCanvasStorePersistence, useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { captureUserScope } from "@/lib/user-scope-guard";
import { ASSET_STORE_KEY, flushAssetStorePersistence, useAssetStore } from "@/stores/use-asset-store";
import { preserveLegacyCacheOnlyAssetDrafts, usesWorkspaceAssetLibraryApi } from "@/services/workspace-asset-read";
import { CONFIG_STORE_KEY, defaultConfig, isSystemProxyBaseUrl, normalizeConfigSnapshot, useConfigStore, type AiConfig } from "@/stores/use-config-store";
import { CREATION_PREFERENCES_STORE_KEY, useCreationPreferencesStore } from "@/stores/use-creation-preferences-store";
import { PLUGIN_STORE_KEY, usePluginStore } from "@/stores/use-plugin-store";
import { defaultFeatureAvailability, useUserStore } from "@/stores/use-user-store";
import type { WorkspaceBootstrapPayload } from "@/services/api/workspace";
import { setWorkspaceCapabilitySnapshot } from "@/services/workspace-mode";
import { withGenerationConsumersPaused } from "@/services/generation-consumer-lifecycle";

/**
 * Hydrate the one implicit local workspace. This is deliberately not an auth
 * session: it only selects the persistence namespace and restores local stores.
 */
export async function applyUserSession(payload: WorkspaceBootstrapPayload) {
    // Drain old result writers before changing the persistence namespace or stores.
    return withGenerationConsumersPaused(() => hydrateLocalWorkspace(payload));
}

async function hydrateLocalWorkspace(payload: WorkspaceBootstrapPayload) {
    useUserStore.getState().setHydrated(false);
    setWorkspaceCapabilitySnapshot({
        contractVersion: payload.contractVersion,
        profile: "local",
        capabilities: payload.capabilities,
    });

    try {
        await Promise.all([flushCanvasStorePersistence(), flushAssetStorePersistence()]);
        setActiveUserScope(payload.workspace.id);

        const [persistedCanvas, persistedCanvasHistory, persistedAssets, persistedPlugins] = await Promise.all([
            localForageStorage.getItem(CANVAS_STORE_KEY),
            localForageStorage.getItem(CANVAS_HISTORY_STORE_KEY),
            localForageStorage.getItem(ASSET_STORE_KEY),
            localForageStorage.getItem(PLUGIN_STORE_KEY),
        ]);
        const persistedConfig = scopedLocalStorage.getItem(CONFIG_STORE_KEY);
        const persistedCreationPreferences = scopedLocalStorage.getItem(CREATION_PREFERENCES_STORE_KEY);

        usePluginStore.setState({ hydrated: false, runtimeStatuses: {}, pluginStates: {} });
        useUserStore.getState().setUser(payload.user);
        useUserStore.getState().setStorageMode("local");
        useUserStore.getState().setRuntimeLimits(payload.runtimeLimits);
        useUserStore.getState().setFeatures({ ...defaultFeatureAvailability, ...payload.features });

        await Promise.all([
            useCanvasStore.persist.rehydrate(),
            useCanvasHistoryStore.persist.rehydrate(),
            useAssetStore.persist.rehydrate(),
            useConfigStore.persist.rehydrate(),
            usePluginStore.persist.rehydrate(),
            useCreationPreferencesStore.persist.rehydrate(),
        ]);

        useConfigStore.getState().replaceConfig(localWorkspaceConfig(useConfigStore.getState().config));
        useCanvasStore.setState((state) => ({ projects: state.projects.map(normalizeLocalCanvasProject) }));
        useAssetStore.setState((state) => ({ assets: state.assets.map(normalizeLocalAsset) }));

        // Zustand keeps the previous in-memory value when a scoped snapshot is
        // absent, so every empty local namespace must be reset explicitly.
        if (!persistedCanvas) useCanvasStore.setState({ projects: [] });
        if (!persistedCanvasHistory) useCanvasHistoryStore.setState({ deletedProjects: [] });
        if (!persistedAssets) useAssetStore.setState({ assets: [] });
        if (usesWorkspaceAssetLibraryApi()) {
            try {
                await preserveLegacyCacheOnlyAssetDrafts(captureUserScope());
            } catch {
                // 查询失败不能当成「库是空的」。素材页会单独展示读取失败。
            }
        }
        if (!persistedPlugins) usePluginStore.setState({ installations: [], runtimeStatuses: {}, pluginStates: {} });
        if (!persistedCreationPreferences) useCreationPreferencesStore.setState({ preferences: {} });
        if (!persistedConfig) useConfigStore.getState().replaceConfig(localWorkspaceConfig(defaultConfig));
    } finally {
        useUserStore.getState().setHydrated(true);
    }
}

/** Strip legacy hosted channel snapshots before local provider config is used. */
export function localWorkspaceConfig(config: AiConfig): AiConfig {
    return normalizeConfigSnapshot({
        config: {
            ...config,
            channels: config.channels.filter((channel) => channel.scope !== "system" && !isSystemProxyBaseUrl(channel.baseUrl)),
            runningHub: { ...defaultConfig.runningHub },
        },
    }).config;
}
