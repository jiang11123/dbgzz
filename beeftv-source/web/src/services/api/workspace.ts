import { http } from "@/services/api/request";
import type { WorkspaceCapabilityContract } from "@/services/workspace-mode";
import type { AiConfig } from "@/stores/use-config-store";
import type { FeatureAvailability, LocalUser, RuntimeLimits } from "@/stores/use-user-store";

export type LocalWorkspace = {
    id: string;
    name: string;
    owner: "local";
    storage: "sqlite";
};

export type WorkspaceBootstrapPayload = {
    contractVersion: number;
    profile: "local";
    capabilities: WorkspaceCapabilityContract["capabilities"];
    user: LocalUser;
    workspace: LocalWorkspace;
    storageMode: "local";
    runtimeLimits?: RuntimeLimits;
    features?: FeatureAvailability;
};

export function getWorkspaceBootstrap() {
    return http.get<WorkspaceBootstrapPayload>("/workspace/bootstrap");
}

export function getLocalModelConfig() {
	return http.get<LocalModelConfigPayload>("/workspace/model-config");
}

export type LocalModelConfigPayload = {
	config: AiConfig;
	revision: number;
	health: "ready" | "default" | "migrated" | "recovered";
	source: "builtin+local";
};

export function saveLocalModelConfig(config: AiConfig, expectedRevision: number) {
	return http.put<{ saved: boolean; revision: number }>("/workspace/model-config", { config, expectedRevision });
}
