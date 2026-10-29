import { nanoid } from "nanoid";
import { creationRuns, type CreationRun, type CreationSubmission } from "./api/creation-runs";
import { prepareBackendToolGenerationTask, parseBackendGenerationResult, runBackendToolGenerationTask } from "./api/generation-task";
import { waitForGenerationTask } from "./api/task-center";
import { getActiveUserScope } from "@/lib/user-scope";

type Request = Parameters<typeof runBackendToolGenerationTask>[0];
// This boundary persists and executes local tool tasks. Pipeline code never bypasses the durable submission guard.
export class ApprovedToolExecution {
    private run?: CreationRun;
    private owner = `plugin:${nanoid()}`;
    private scope = getActiveUserScope();
    private heartbeat?: ReturnType<typeof setInterval>;
    private disposed = false;
    private stopReason?: string;
    private ready?: Promise<void>;
    private controller = new AbortController();

    constructor(private options: {
        clientKey: string; runId?: string; identity: Record<string, string>;
        signal: AbortSignal; onRun: (id: string) => void;
    }, private api = creationRuns, private waitTask = waitForGenerationTask) {
        options.signal.addEventListener("abort", this.abort, { once: true });
    }

    private assertLive() {
        if (this.disposed || this.options.signal.aborted || this.scope !== getActiveUserScope() || this.controller.signal.aborted) throw new DOMException(this.stopReason || "分析已停止，请重新打开后继续", "AbortError");
    }
    private guard() { return { owner: this.owner, executionEpoch: this.run!.executionEpoch }; }
    private initialize() {
        return this.ready ||= (async () => {
            this.assertLive();
            const detail = this.options.runId ? await this.api.get(this.options.runId, this.controller.signal) : await this.api.create({ clientKey: this.options.clientKey, state: this.options.identity }, this.controller.signal);
            this.assertLive();
            if (Object.entries(this.options.identity).some(([key, value]) => detail.run.state[key] !== value)) throw new Error("原分析的图片、节点或模型已变化，请开始新的分析");
            this.run = await this.api.claim(detail.run.id, { expectedEpoch: detail.run.executionEpoch, owner: this.owner }, this.controller.signal);
            this.assertLive();
            this.options.onRun(this.run.id);
            this.heartbeat = setInterval(() => {
                if (this.disposed) return;
                void (async () => { this.assertLive(); await this.api.heartbeat(this.run!.id, this.guard(), this.controller.signal); })().catch(() => this.abort(new Error("分析连接已中断，请重新打开后继续")));
            }, 15_000);
        })();
    }

    execute = async (request: Request) => {
        // A control failure stops sibling stages; model failures keep the
        // pipeline's existing partial-result handling.
        const task = await this.submit(request).catch((error: unknown) => {
            this.abort(error);
            throw new DOMException(error instanceof Error ? error.message : "分析提交失败，请重新打开后继续", "AbortError");
        });
        if (this.scope === getActiveUserScope()) request.onTaskCreated?.(task);
        this.assertLive();
        const completed = await this.waitTask(task.id, { initialTask: task, signal: this.controller.signal, onTextDelta: request.onDelta });
        this.assertLive();
        const result = parseBackendGenerationResult(completed);
        return { content: result.text || "", toolCalls: result.toolCalls || [], ...(result.reasoning ? { reasoning: result.reasoning } : {}) };
    };

    private async submit(request: Request) {
        await this.initialize();
        this.assertLive();
        const stage = request.metadata?.stage;
        if (!stage) throw new Error("分析阶段缺少稳定标识");
        let submission = await this.api.prepare(this.run!.id, { ...this.guard(), itemKey: `stage:${stage}`, request: prepareBackendToolGenerationTask(request) }, this.controller.signal);
        this.assertLive();
        if (submission.revokedAt) {
            const detail = await this.api.get(this.run!.id, this.controller.signal);
            submission = detail.submissions.find((item) => item.requestHash === submission.requestHash && !item.revokedAt) || submission;
            if (submission.revokedAt) throw new Error("原执行记录已失效，无法恢复此阶段");
        }
        this.assertLive();
        if (!submission.taskId && !submission.approvedAt) {
            const result = await this.api.approve(this.run!.id, { ...this.guard(), submissionIds: [submission.id] }, this.controller.signal);
            const approved = result.submissions.find((item) => item.id === submission.id && item.approvedAt);
            if (!approved) throw new Error("本地任务准入回执不完整");
            submission = approved;
        }
        this.assertLive();
        return this.api.execute(this.run!.id, { ...this.guard(), submissionId: submission.id }, this.controller.signal);
    }

    private abort = (reason?: unknown) => {
        if (!this.controller.signal.aborted && reason instanceof Error) this.stopReason = reason.message;
        this.controller.abort();
        if (this.heartbeat) clearInterval(this.heartbeat);
    };
    dispose() {
        this.disposed = true; this.abort();
        if (this.heartbeat) clearInterval(this.heartbeat);
        this.options.signal.removeEventListener("abort", this.abort);
        if (this.run && this.scope === getActiveUserScope()) void this.api.release(this.run.id, this.guard()).catch(() => { /* Lease expiry releases an offline owner. */ });
    }
}
