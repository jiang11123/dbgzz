import { useQuery } from "@tanstack/react-query";
import { assetLibraryQueryKey } from "@/components/assets/asset-view-session";
import { captureUserScope } from "@/lib/user-scope-guard";
import { loadWorkspaceAssetLibraryPage } from "@/services/workspace-asset-read";
import { useAssetStore, type Asset } from "@/stores/use-asset-store";

/** Canvas entry points share the personal library's canonical read boundary. */
export function usePersonalAssetLibrary() {
    const scope = captureUserScope();
    const hydrated = useAssetStore((state) => state.hydrated);
    const revision = useAssetStore((state) => state.assets.map((asset) => `${asset.id}:${asset.updatedAt}:${asset.status}`).join("|"));
    const query = useQuery({
        queryKey: assetLibraryQueryKey(scope, "canvas-personal-library", revision),
        enabled: hydrated,
        queryFn: async ({ signal }) => {
            const assets: Asset[] = [];
            for (let page = 1; ; page += 1) {
                const result = await loadWorkspaceAssetLibraryPage({ page, pageSize: 100, status: "active", expectedScope: scope, signal });
                assets.push(...result.assets);
                if (!result.hasMore) break;
            }
            return [...new Map(assets.filter((asset) => asset.status !== "archived" && asset.kind !== "entity").map((asset) => [asset.id, asset])).values()];
        },
        staleTime: 5000,
        refetchInterval: 5000,
    });
    return query.data || [];
}
