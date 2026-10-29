let capabilitySnapshot: WorkspaceCapabilityContract | null = null;

export type WorkspaceCapabilityContract = {
    contractVersion: number;
    profile: "local";
    capabilities: {
        localAssets: boolean;
        providerCalls: boolean;
    };
};

/** Central runtime boundary shared by local workspace UI and hosted sync. */
export function isLocalWorkspaceMode() {
    return true;
}

/**
 * Single capability projection for UI boundaries. Keep the hosted profile
 * available, but make the local-first contract explicit instead of repeating
 * storageMode/username checks throughout pages.
 */
export type WorkspaceCapabilities = { local: true; localAssets: boolean; providerCalls: boolean };

export function workspaceCapabilities(): WorkspaceCapabilities {
    return {
        local: true,
        localAssets: capabilitySnapshot?.capabilities.localAssets ?? true,
        providerCalls: capabilitySnapshot?.capabilities.providerCalls ?? true,
    };
}

export function setWorkspaceCapabilitySnapshot(snapshot: WorkspaceCapabilityContract | null) {
    capabilitySnapshot = snapshot;
}

export function resetWorkspaceMode() {
    capabilitySnapshot = null;
}
