/** Declared beside a canvas action; the workflow library reads this metadata. */
export type CanvasWorkflowContribution = {
    operationId?: string;
    outputType?: "image" | "video" | "audio" | "text";
    mode?: "recipe" | "manual";
    reason?: string;
};
