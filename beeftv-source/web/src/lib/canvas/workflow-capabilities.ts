import type { ReactNode } from "react";
import { listNodeDefinitions } from "@/lib/canvas/node-registry";
import { listImageWorkflowTools } from "@/components/canvas/canvas-image-toolbar-tools";
import { getToolbarTools, type ToolContext } from "@/lib/canvas/tool-registry";
import type { CanvasNodeData } from "@/types/canvas";
import type { WorkflowMediaType, WorkflowOperation } from "@/services/api/canvas-workflows";

export type WorkflowCapability = {
    id: string; name: string; icon: ReactNode; group: string;
    mode: "direct" | "recipe" | "manual" | "unavailable";
    operation?: WorkflowOperation; outputType?: WorkflowMediaType; reason?: string;
};

/** Only advertise first-release operations with backend execution adapters. */
export function listCanvasWorkflowCapabilities(operations: WorkflowOperation[]): WorkflowCapability[] {
    const firstRelease = new Set(["image.select", "image.describe", "image.ai-upscale", "video.ai-upscale", "image.crop", "image.resize", "video.frame", "video.audio", "video.trim", "video.merge", "video.crop", "video.depth"]);
    const sample: CanvasNodeData = {id:"workflow-menu",type:"image",title:"",position:{x:0,y:0},width:300,height:240};
    const imageTools = listImageWorkflowTools(sample);
    const names = new Map(imageTools.filter(tool => tool.workflow.operationId).map(tool => [tool.workflow.operationId!, tool.label]));
    const reverse = imageTools.find(tool => tool.id === "image.reversePrompt");
    if (reverse) names.set("image.describe", reverse.label);
    const upscale = listNodeDefinitions().find(node => node.type === "upscale")?.label;
    if (upscale) { names.set("image.ai-upscale", upscale); names.set("video.ai-upscale", upscale); }
    const context = {node:sample,nodeMetadata:{},selectedCount:2,selectedVideoCount:2,workspaceMode:"professional"} as ToolContext;
    for (const toolbar of ["node-hover","selection"] as const) {
        for (const tool of getToolbarTools(toolbar)) {
            if (!tool.workflow?.operationId) continue;
            const label = tool.displayLabel || tool.label;
            names.set(tool.workflow.operationId, (typeof label === "function" ? label(context) : label).replace(/（\d+）$/, ""));
        }
    }
    return operations.filter(operation => firstRelease.has(operation.id)).map(operation => ({
        id: `operation.${operation.id}`, name: names.get(operation.id) || operation.name,
        icon: listNodeDefinitions().find(node => node.type === operation.outputType)?.icon,
        group: operation.id.startsWith("video.") ? "视频处理" : "图片处理",
        mode: operation.unavailableReason ? "unavailable" : "direct",
        operation: {...operation, name:names.get(operation.id) || operation.name}, outputType: operation.outputType, reason:operation.unavailableReason,
    }));
}
