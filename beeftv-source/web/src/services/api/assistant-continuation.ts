import { http } from "./request";
import { ensureAgentUiSession, type AssistantGenerationProposal, type AssistantPermissionMode } from "./agent-assistant";

export type AssistantContinuation = { id: string; canvasId: string; sessionId: string; proposalId: string; sourceTurnId: string; requestId: string; turnId: string; message: string; permissionMode: AssistantPermissionMode; state: "waiting" | "claimed" | "running" | "done" | "cancelled"; taskIds: string[]; nodeIds: string[] };
export type AssistantSubmissionManifest = { sourceNodeId: string; submissions: { operationId: string; outputNodeIds: string[] }[] };
async function headers() { return { headers: { "X-Beeftv-Ui-Session": await ensureAgentUiSession() } }; }
export async function armAssistantContinuation(canvasId: string, sessionId: string, sourceTurnId: string, proposal: AssistantGenerationProposal) {
    return http.post<AssistantContinuation>("/assistant/continuations", { canvasId, sessionId, sourceTurnId, proposalId: proposal.proposalId, kind: proposal.kind, nodeIds: proposal.nodeIds }, await headers());
}
export async function registerAssistantSubmission(id: string, manifest: AssistantSubmissionManifest) {
    return http.post(`/assistant/continuations/${encodeURIComponent(id)}/manifest`, manifest, await headers());
}
export async function listAssistantContinuations(canvasId: string, sessionId: string) {
    return http.get<AssistantContinuation[]>("/assistant/continuations", { ...await headers(), params: { canvasId, sessionId } });
}
export async function claimAssistantContinuation(id: string) {
    return http.post<AssistantContinuation>(`/assistant/continuations/${encodeURIComponent(id)}/claim`, {}, await headers());
}
export async function cancelAssistantContinuations(canvasId: string, sessionId: string) {
    return http.post("/assistant/continuations/cancel", { canvasId, sessionId }, await headers());
}
