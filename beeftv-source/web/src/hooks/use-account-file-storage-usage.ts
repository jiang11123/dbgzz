import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { accountFileStorageUsageQueryKey } from "@/lib/account-storage-usage";
import { getAccountFileStorageUsage } from "@/services/api/resources";
import { useAssetStore } from "@/stores/use-asset-store";
import { useUserStore } from "@/stores/use-user-store";
import { isLocalWorkspaceMode } from "@/services/workspace-mode";
import type { AccountFileStorageUsage } from "@/services/api/resources";

export function useAccountFileStorageUsage(enabled = true) {
    const storageMode = useUserStore((state) => state.storageMode);
    const user = useUserStore((state) => state.user);
    const assets = useAssetStore((state) => state.assets);
    const localMode = isLocalWorkspaceMode() || storageMode === "local" || user?.username === "local";
    const localUsage = useMemo<AccountFileStorageUsage>(() => ({
        usedBytes: assets.reduce((total, asset) => total + ("bytes" in asset.data && Number.isFinite(asset.data.bytes) ? Math.max(0, asset.data.bytes) : 0), 0),
        // Keep the local meter useful without pretending it is a server quota.
        totalBytes: 5 * 1024 * 1024 * 1024,
    }), [assets]);
    const query = useQuery({
        queryKey: accountFileStorageUsageQueryKey,
        queryFn: getAccountFileStorageUsage,
        enabled: enabled && !localMode,
        staleTime: 30_000,
        refetchOnMount: "always",
    });
    return localMode ? { ...query, data: localUsage, isPending: false, isError: false } : query;
}
