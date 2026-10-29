import { expect, test } from "bun:test";
import { ApprovedToolExecution } from "../src/services/approved-tool-execution";
import { creationRuns, type CreationRun, type CreationSubmission } from "../src/services/api/creation-runs";
import { createModelChannel, defaultConfig } from "../src/stores/use-config-store";
import type { GenerationTask } from "../src/services/api/task-center";

const identity = { kind: "art-critique", nodeId: "node", sourceFingerprint: "image", model: "model" };
const config = { ...defaultConfig, model: "system::model", channels: [createModelChannel({ id: "system", scope: "system", models: ["model"], interfaceType: "chat-completion" })] };
const request = (stage: string) => ({ config, prompt: stage, messages: [{ role: "user" as const, content: "review" }], tools: [], toolChoice: "auto" as const, metadata: { source: "art-critique", stage } });
const submission = (id: string, stage: string, taskId?: string): CreationSubmission => ({ id, runId: "run", itemKey: `stage:${stage}`, requestHash: stage, taskId, execution: { model: "model", configHash: id } });

function harness(initial: CreationSubmission[] = [], state = identity) {
    let submissions = initial;
    let run: CreationRun = { id: "run", userId: "local", revision: 1, executionEpoch: 0, executionOwner: "", status: "idle", state, createdAt: "", updatedAt: "" };
    const approvals: string[][] = [], executions: string[] = [], waits: string[] = [];
    const api = { ...creationRuns,
        create: async () => ({ run, submissions }),
        get: async () => ({ run, submissions }),
        claim: async (_id: string, input: { owner: string }) => (run = { ...run, executionEpoch: run.executionEpoch + 1, executionOwner: input.owner }),
        release: async () => ({ released: true }),
        prepare: async (_id: string, input: { itemKey: string }) => {
            const existing = submissions.find((item) => item.itemKey === input.itemKey);
            if (existing) return existing;
            const created = submission(`submission-${submissions.length}`, input.itemKey.replace("stage:", ""));
            submissions.push(created);
            return created;
        },
        approve: async (_id: string, input: { submissionIds: string[] }) => {
            approvals.push(input.submissionIds);
            submissions = submissions.map((item) => input.submissionIds.includes(item.id) ? { ...item, approvedAt: "2026-01-01" } : item);
            return { submissions: submissions.filter((item) => input.submissionIds.includes(item.id)) };
        },
        execute: async (_id: string, input: { submissionId: string }) => {
            executions.push(input.submissionId);
            const item = submissions.find((entry) => entry.id === input.submissionId)!;
            return { id: item.taskId || `task-${item.id}` } as GenerationTask;
        },
    } as typeof creationRuns;
    const controller = new AbortController();
    const execution = new ApprovedToolExecution({ clientKey: "test", ...(submissions.length ? { runId: "run" } : {}), identity, signal: controller.signal, onRun: () => {} }, api, async (id) => {
        waits.push(id);
        return { id, status: "succeeded", resultJson: JSON.stringify({ text: "report" }) } as GenerationTask;
    });
    return { execution, controller, approvals, executions, waits };
}

test("local tool execution persists, admits, executes, and observes one task", async () => {
    const h = harness();
    try {
        expect((await h.execution.execute(request("scene"))).content).toBe("report");
        expect(h.approvals).toEqual([["submission-0"]]);
        expect(h.executions).toEqual(["submission-0"]);
        expect(h.waits).toEqual(["task-submission-0"]);
    } finally { h.execution.dispose(); }
});

test("restart reuses a previously submitted provider task", async () => {
    const h = harness([submission("existing", "scene", "provider-task")]);
    try {
        await h.execution.execute(request("scene"));
        expect(h.approvals).toEqual([]);
        expect(h.executions).toEqual(["existing"]);
        expect(h.waits).toEqual(["provider-task"]);
    } finally { h.execution.dispose(); }
});

test("changed local execution identity is rejected", async () => {
    const h = harness([submission("existing", "scene")], { ...identity, model: "different" });
    try { await expect(h.execution.execute(request("scene"))).rejects.toThrow("已变化"); }
    finally { h.execution.dispose(); }
});

test("abort prevents a new local provider submission", async () => {
    const h = harness();
    h.controller.abort();
    try {
        await expect(h.execution.execute(request("scene"))).rejects.toThrow();
        expect(h.executions).toEqual([]);
    } finally { h.execution.dispose(); }
});
