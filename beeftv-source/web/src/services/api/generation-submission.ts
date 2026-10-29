import { ApiError } from "./request";
import type { CreateTaskInput, GenerationTask } from "./task-center";

export class GenerationSubmissionUnknownError extends Error {
    readonly code = "submission_uncertain";
    constructor(readonly operationId: string, cause: unknown) {
        super("提交结果尚未确认，请继续查询原任务，暂勿重新生成", { cause });
        this.name = "GenerationSubmissionUnknownError";
    }
}

export function submissionAcceptanceUnknown(error: unknown): boolean {
    return !(error instanceof ApiError) || !error.status || error.status === 408 || error.status >= 500;
}

/** Replay this frozen command only. Recovery after reload uses the read-only receipt API. */
export async function submitGenerationCommand(input: CreateTaskInput, operationId: string, submit: (input: CreateTaskInput) => Promise<GenerationTask>, find?: () => Promise<GenerationTask | undefined>, isCurrent: () => boolean = () => true) {
    const frozen = structuredClone(input);
    try {
        return await submit(frozen);
    } catch (error) {
        if (!find || !submissionAcceptanceUnknown(error)) throw error;
        try {
            const accepted = await find();
            if (accepted) return accepted;
        } catch {
            throw new GenerationSubmissionUnknownError(operationId, error);
        }
        if (!isCurrent()) throw new GenerationSubmissionUnknownError(operationId, error);
        try {
            return await submit(frozen);
        } catch (replayError) {
            // Even a rejection of the replay cannot disprove acceptance of the first request.
            try {
                const accepted = await find();
                if (accepted) return accepted;
            } catch { /* Keep the original identity when the receipt cannot be read. */ }
            throw new GenerationSubmissionUnknownError(operationId, replayError);
        }
    }
}
