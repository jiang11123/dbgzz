import { http, type HttpRequestConfig } from "./request";

export type WorkflowMediaType = "image" | "video" | "audio" | "text";
export type WorkflowNodeRole = "input" | "constant" | "operation" | "generation" | "depth";
export type WorkflowOperation = {
    unavailableReason?: string;
    id: string; version: number; name: string; outputType: WorkflowMediaType;
    inputs: Array<{ id: string; label: string; mediaType: WorkflowMediaType; required: boolean; multiple: boolean }>;
    fields: Array<{ key: string; label: string; type: string; min?: number; max?: number; options?: Array<{ label: string; value: string; capabilities?: { video?: { ratios?: string[]; resolutions?: string[]; defaultRatio?: string; defaultResolution?: string; references?: { maxVideos?: number; maxVideoTotalDurationSeconds?: number } } } }> }>;
};
export type WorkflowValue = { resourceId?: string; text?: string };
export type WorkflowNode = WorkflowValue & {
    id: string;
    title: string;
    mediaType: WorkflowMediaType;
    role: WorkflowNodeRole;
    sourceTaskId?: string;
    videoDurationSourceNodeId?: string;
    useDefault?: boolean;
    operationId?: string;
    operationVersion?: number;
    config?: Record<string, string | number | boolean>;
};
export type WorkflowDefinition = {
    version: 1;
    nodes: WorkflowNode[];
    edges: Array<{ fromNodeId: string; toNodeId: string; fromPort?: string; toPort?: string; order?: number }>;
    outputNodeIds: string[];
    positions?: Record<string, { x: number; y: number }>;
    editorLayoutVersion?: number;
    presentationVersion?: number;
};
export type CanvasWorkflow = {
    id: string;
    name: string;
    description: string;
    definition: WorkflowDefinition;
    createdAt: string;
    updatedAt: string;
    revision?: number;
};
export type WorkflowOutput = WorkflowValue & { nodeId: string; mediaType: WorkflowMediaType };
export type WorkflowRun = {
    id: string;
    templateId: string;
    templateName: string;
    templateRevision?: number;
    status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
    error?: string;
    steps: Array<WorkflowValue & { nodeId: string; title: string; status: "pending" | "running" | "waiting_selection" | "succeeded" | "failed" | "cancelled"; taskId?: string; error?: string; candidates?: WorkflowValue[] }>;
    outputs: WorkflowOutput[];
    createdAt: string;
    updatedAt: string;
};

const workflowPath = (id: string) => `/canvas-workflows/${encodeURIComponent(id)}`;
const runPath = (id: string) => `/canvas-workflow-runs/${encodeURIComponent(id)}`;

export const listCanvasWorkflows = (config?: HttpRequestConfig) => http.get<{ workflows: CanvasWorkflow[] }>("/canvas-workflows", config);
export const saveCanvasWorkflow = (input: { name: string; description: string; definition: WorkflowDefinition }, config?: HttpRequestConfig) => http.post<CanvasWorkflow>("/canvas-workflows", input, config);
export const deleteCanvasWorkflow = (id: string, config?: HttpRequestConfig) => http.delete(workflowPath(id), config);
export const listWorkflowRuns = (id: string, config?: HttpRequestConfig) => http.get<{ runs: WorkflowRun[] }>(`${workflowPath(id)}/runs`, config);
export const startWorkflowRun = (id: string, input: { clientOperationId: string; templateRevision?: number; inputs: Record<string, WorkflowValue> }, config?: HttpRequestConfig) => http.post<WorkflowRun>(`${workflowPath(id)}/runs`, input, config);
export const getWorkflowRun = (id: string, config?: HttpRequestConfig) => http.get<WorkflowRun>(runPath(id), config);
export const selectWorkflowImage = (id: string, input: { nodeId: string; resourceId: string }, config?: HttpRequestConfig) => http.post<WorkflowRun>(`${runPath(id)}/select-image`, input, config);
export const retryWorkflowRun = (id: string, config?: HttpRequestConfig) => http.post<WorkflowRun>(`${runPath(id)}/retry`, {}, config);
export const cancelWorkflowRun = (id: string, config?: HttpRequestConfig) => http.post<WorkflowRun>(`${runPath(id)}/cancel`, {}, config);
export const getWorkflowEditor = (id: string, revision?: number, config?: HttpRequestConfig) => http.get<{ workflow: CanvasWorkflow; operations: WorkflowOperation[] }>(`${workflowPath(id)}/editor`, { ...config, params: revision ? { revision } : undefined });
export const updateCanvasWorkflow = (id: string, input: { name: string; description: string; definition: WorkflowDefinition; expectedRevision: number }, config?: HttpRequestConfig) => http.put<CanvasWorkflow>(workflowPath(id), input, config);
export const validateCanvasWorkflow = (definition: WorkflowDefinition, config?: HttpRequestConfig, context?: { templateId: string; templateRevision: number }) => http.post<{ valid: boolean; definition: WorkflowDefinition }>("/canvas-workflows/validate", { definition, ...context }, config);
export const listWorkflowOperations = (config?: HttpRequestConfig) => http.get<{ operations: WorkflowOperation[] }>("/canvas-workflow-operations", config);
