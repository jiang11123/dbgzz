import { sameCanvasDocument } from "./canvas-content";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";

export type CanvasUnconfirmedReason = "pending" | "blocked" | "inFlight" | "pendingProjection" | "confirmed-diff" | "durable-diff" | "no-baseline";
export type CanvasUnconfirmedState = {
    live?: CanvasProject;
    confirmed?: CanvasProject;
    durable?: CanvasProject;
    pending: boolean;
    blocked: boolean;
    inFlight: boolean;
    pendingProjection: boolean;
};

export function canvasUnconfirmedReason(state: CanvasUnconfirmedState): CanvasUnconfirmedReason | undefined {
    if (!state.live) return undefined;
    if (state.pending) return "pending";
    if (state.blocked) return "blocked";
    if (state.inFlight) return "inFlight";
    if (state.pendingProjection) return "pendingProjection";
    if (state.confirmed) return sameCanvasDocument(state.confirmed, state.live) ? undefined : "confirmed-diff";
    if (state.durable) return sameCanvasDocument(state.durable, state.live) ? undefined : "durable-diff";
    return "no-baseline";
}

const documentFields = ["title", "canvasTitle", "workspaceProjectId", "projectId", "folderId", "starterMode", "nodes", "connections", "chatSessions", "activeChatId", "directorScenes", "timeline"] as const;
const metadataFields = ["prompt", "composerContent", "content", "storageKey", "assetId", "mimeType", "bytes", "naturalWidth", "naturalHeight", "durationMs", "nodeRole", "resultOrigin", "status", "taskId", "taskStatus", "taskStage", "taskProgress", "taskUpdatedAt", "taskCompletedAt", "taskFailureDiagnostics", "generationEffectKeys", "model", "size", "count", "quality", "videoSeconds", "references", "resourceReloadAvailable", "videoPreview", "hasAudio", "generateAudio", "watermark"] as const;

const nodeFields = ["createdAt", "updatedAt", "type", "title", "width", "height", "position", "parentId"] as const;

function diagnosticProject(value: Record<string, unknown>) { return value as unknown as CanvasProject; }
function diagnosticDifferent(left: unknown, right: unknown) {
    return !sameCanvasDocument(diagnosticProject({ id: "diagnostic", nodes: [{ value: left }] }), diagnosticProject({ id: "diagnostic", nodes: [{ value: right }] }));
}

/** Diagnostics emit only fixed field names. Unknown keys and all field values stay private. */
export function canvasUnconfirmedDiagnostic(state: CanvasUnconfirmedState) {
    const reason = canvasUnconfirmedReason(state);
    if (!reason) return undefined;
    const fields: string[] = [], changedNodes: string[] = [], changedMetadata: string[] = [];
    const base = reason === "confirmed-diff" ? state.confirmed : reason === "durable-diff" ? state.durable : undefined;
    if (base && state.live) {
        for (const field of documentFields) {
            if (!sameCanvasDocument(diagnosticProject({ id: "diagnostic", [field]: base[field] }), diagnosticProject({ id: "diagnostic", [field]: state.live[field] }))) fields.push(field);
        }
        const before = new Map((Array.isArray(base.nodes) ? base.nodes : []).filter(Boolean).map(node => [node.id, node]));
        const liveNodes = (Array.isArray(state.live.nodes) ? state.live.nodes : []).filter(Boolean);
        for (const field of nodeFields) {
            if (liveNodes.some(node => {
                const old = before.get(node.id);
                return old && diagnosticDifferent((old as unknown as Record<string, unknown>)[field], (node as unknown as Record<string, unknown>)[field]);
            })) changedNodes.push(field);
        }
        for (const field of metadataFields) {
            if (liveNodes.some(node => {
                const old = before.get(node.id);
                if (!old) return false;
                return diagnosticDifferent((old.metadata as unknown as Record<string, unknown> | undefined)?.[field], (node.metadata as unknown as Record<string, unknown> | undefined)?.[field]);
            })) changedMetadata.push(field);
        }
    }
    return { reason, fields, nodeFields: changedNodes, metadataFields: changedMetadata };
}
