import { useSyncExternalStore } from "react";

import { shouldSuppressAssetViewError } from "@/components/assets/asset-view-session";
import { getActiveUserScopeEpoch, subscribeUserScope } from "@/lib/user-scope";
import { userScopeMatches, type CapturedUserScope } from "@/lib/user-scope-guard";

export function subscribeProjectSettingsGeneration(onStoreChange: () => void) {
    return subscribeUserScope(() => onStoreChange());
}

export function useProjectSettingsGeneration() {
    return useSyncExternalStore(subscribeProjectSettingsGeneration, getActiveUserScopeEpoch, getActiveUserScopeEpoch);
}

export function projectSettingsSessionKey(projectId: string, generation: number) {
    return `${projectId}:${generation}`;
}

export function shouldApplyProjectSettingsMutation(input: {
    entryScope: CapturedUserScope;
    mountedProjectId: string;
    liveProjectId: string;
    mounted: boolean;
    error?: unknown;
}) {
    if (!input.mounted) return false;
    if (input.mountedProjectId !== input.liveProjectId) return false;
    if (!userScopeMatches(input.entryScope)) return false;
    if (input.error !== undefined && shouldSuppressAssetViewError(input.error, input.entryScope)) return false;
    return true;
}
