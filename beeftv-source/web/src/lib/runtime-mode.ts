import { useUserStore } from "@/stores/use-user-store";
import { apiBaseURL } from "@/services/api/request";

export type RuntimeSessionLike = {
    storageMode?: "local" | "remote";
    user?: { username?: string } | null;
};

/**
 * Pure runtime-mode decision used by persistence and upload boundaries.
 * Local-first is the default for the desktop build; hosted mode must opt out
 * explicitly with VITE_CANVAS_LOCAL_MODE=false.
 */
export function isLocalRuntimeModeForSession(session: RuntimeSessionLike, localFirstBuild: boolean) {
    return localFirstBuild || session.storageMode === "local" || session.user?.username === "local";
}

export function isLocalRuntimeMode() {
    return isLocalRuntimeModeForSession(
        useUserStore.getState(),
        import.meta.env.VITE_CANVAS_LOCAL_MODE !== "false",
    );
}

/** True only after Wails has configured the loopback Go API. */
export function isNativeDesktopRuntime() {
    return (typeof window !== "undefined" && window.location?.protocol === "wails:")
        || /^http:\/\/127\.0\.0\.1:\d+\/api$/u.test(String(apiBaseURL));
}
