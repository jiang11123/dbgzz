import { http } from "@/services/api/request";
import { getWorkspaceBootstrap } from "@/services/api/workspace";
import { listWorkspaceAssetsPage } from "@/services/api/workspace-assets";
import { getDesktopAppBinding } from "@/services/desktop-runtime";
import { useAssetStore } from "@/stores/use-asset-store";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";

export async function confirmDesktopUpdateStartup(): Promise<boolean> {
    const confirm = getDesktopAppBinding()?.ConfirmUpdateStartup;
    // The stores' public `hydrated` flags also become true on read errors.
    const cacheReady = () => useAssetStore.persist.hasHydrated() && useCanvasStore.persist.hasHydrated();
    if (!confirm || !cacheReady()) return false;
    // Startup can render cached data after a backend read failed. Confirm the
    // canonical workspace and both libraries before discarding recovery files.
    const [workspace, canvases, assets] = await Promise.all([
        getWorkspaceBootstrap(),
        http.get<{ projects: unknown[] }>("/canvas-projects", { params: { page: 1, pageSize: 1 }, timeout: 5000 }),
        listWorkspaceAssetsPage({ page: 1, pageSize: 1 }, { timeout: 5000 }),
    ]);
    if (workspace.profile !== "local" || !Array.isArray(canvases.projects) || !Array.isArray(assets.assets) || !cacheReady()) return false;
    await confirm();
    return true;
}
