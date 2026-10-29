import { configureApiRuntime } from "@/services/api/request";

export type DesktopRuntimeConfig = {
    baseURL: string;
    launchToken: string;
    uiBootstrapToken?: string;
};

export const DESKTOP_UPDATE_STATUSES = ["disabled", "idle", "checking", "available", "downloading", "ready", "installing", "error"] as const;

export type DesktopUpdateStatus = (typeof DESKTOP_UPDATE_STATUSES)[number];

export type DesktopUpdateState = {
	phase?: "downloading" | "verifying" | "extracting" | "preparing" | "restarting";
	completedFiles?: number;
	totalFiles?: number;
    installPrepared?: boolean;
    status: DesktopUpdateStatus;
    currentVersion: string;
    latestVersion: string;
    releaseNotes: string;
    downloadedBytes: number;
    totalBytes: number;
    bytesPerSecond: number;
    reconnecting: boolean;
    error: string;
};

export type DesktopRuntimeBinding = {
    ConsumeSkillLink?: () => Promise<string>;
    OpenSkillMarketURL?: (url: string) => Promise<void>;
	DepthComponentStatus?: (refresh: boolean) => Promise<DepthComponentState>;
	DownloadDepthComponents?: () => Promise<DepthComponentState>;
	PauseDepthComponentDownload?: () => Promise<DepthComponentState>;
	ReferenceStorageSettings?: () => Promise<ReferenceStorageConfig>;
	SaveReferenceStorage?: (config: ReferenceStorageConfig & { secretAccessKey: string }) => Promise<ReferenceStorageConfig>;
	UploadReferenceMedia?: (ids: string[]) => Promise<Record<string,string>>;
	ReferenceUploadStatus?: () => Promise<{ label: string; phase: "preparing" | "transferring" | "processing"; loadedBytes: number; totalBytes: number; bytesPerSecond: number; startedAt: number; updatedAt: number }>;
	TestReferenceStorage?: () => Promise<void>;
	StorageSettings?: () => Promise<DesktopStorageUsage>;
	ChooseStorageDirectory?: () => Promise<string>;
	MigrateStorage?: (target: string) => Promise<DesktopStorageUsage>;
	StorageMigrationStatus?: () => Promise<DesktopMigrationProgress>;
	CleanupPreviousStorage?: () => Promise<DesktopStorageUsage>;
    RuntimeConfig: () => Promise<DesktopRuntimeConfig>;
    SaveOwnedMedia?: (fileName: string, resourceID: string) => Promise<boolean>;
    SaveOwnedArtifact?: (fileName: string, data: string) => Promise<boolean>;
    SaveOwnedArchive?: (fileName: string, entries: Array<{ name: string; resourceId?: string; data?: string }>) => Promise<boolean>;
    UpdateStatus?: () => Promise<DesktopUpdateState>;
	OpenUpdateLogDirectory?: () => Promise<void>;
    CheckForUpdate?: () => Promise<DesktopUpdateState>;
    DownloadUpdate?: () => Promise<DesktopUpdateState>;
    InstallUpdate?: () => Promise<void>;
    ConfirmUpdateStartup?: () => Promise<void>;
    OpenBeefTVX?: () => Promise<void>;
    OpenBeefTVWebsite?: () => Promise<void>;
    OpenBeefTVGitHub?: () => Promise<void>;
};

export type DesktopStorageUsage = { dataDir: string; usedBytes: number; freeBytes: number; previousDir?: string; previousBytes?: number };
export type DesktopMigrationProgress = { phase: "preparing" | "transferring" | "processing" | "done"; detail: string; loadedBytes: number; totalBytes: number; completedFiles: number; totalFiles: number };
export type DepthComponentState = {
    status: "not_installed" | "downloading" | "installing" | "ready" | "paused" | "error" | "unsupported";
    variant: string;
    dataDir: string;
    downloadBytes: number;
    requiredBytes: number;
    freeBytes: number;
    downloadedBytes: number;
    error?: string;
};
export type ReferenceStorageConfig = { enabled: boolean; endpoint: string; bucket: string; region: string; accessKeyId: string; publicBaseURL: string; hasSecret: boolean };

declare global {
    interface Window {
        go?: {
            main?: {
                DesktopApp?: DesktopRuntimeBinding;
            };
        };
    }
}

export function getDesktopAppBinding(): DesktopRuntimeBinding | undefined {
    return window.go?.main?.DesktopApp;
}

export type DesktopUpdateBinding = Pick<DesktopRuntimeBinding, "UpdateStatus" | "CheckForUpdate" | "DownloadUpdate" | "InstallUpdate">;

export function getDesktopUpdateBinding(): DesktopUpdateBinding | undefined {
    const electron = (window as Window & { doubaoUpdater?: DesktopUpdateBinding }).doubaoUpdater;
    return electron ?? getDesktopAppBinding();
}

let nativeFetch: typeof fetch | undefined;

function isDesktopRuntimeConfig(value: unknown): value is DesktopRuntimeConfig {
    if (!value || typeof value !== "object") return false;
    const candidate = value as Partial<DesktopRuntimeConfig>;
    return /^http:\/\/127\.0\.0\.1:\d+\/api$/u.test(candidate.baseURL ?? "") && Boolean(candidate.launchToken);
}

export function configureDesktopRuntime(config: DesktopRuntimeConfig) {
    const baseURL = config.baseURL.replace(/\/+$/u, "");
    configureApiRuntime(baseURL, config.launchToken, config.uiBootstrapToken);
    if (!nativeFetch) nativeFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        if (request.url === baseURL || request.url.startsWith(`${baseURL}/`)) {
            const headers = new Headers(request.headers);
            headers.set("X-Desktop-Token", config.launchToken);
            return nativeFetch!(new Request(request, { headers }));
        }
        return nativeFetch!(request);
    }) as typeof fetch;
}

export async function bootstrapDesktopRuntime() {
    const binding = window.go?.main?.DesktopApp;
    let config: DesktopRuntimeConfig | undefined;
    if (binding) {
        try {
            const candidate = await binding.RuntimeConfig();
            if (isDesktopRuntimeConfig(candidate)) config = candidate;
        } catch {
            // Wails can expose the WebView before generated bindings settle.
        }
    }
    if (!config && window.location?.protocol === "wails:") {
        const response = await fetch("/__desktop/runtime-config", { cache: "no-store" });
        if (!response.ok) throw new Error(`Desktop runtime bootstrap failed: ${response.status}`);
        const candidate = await response.json();
        if (isDesktopRuntimeConfig(candidate)) config = candidate;
    }
    if (!config) return false;
    configureDesktopRuntime(config);
    return true;
}
