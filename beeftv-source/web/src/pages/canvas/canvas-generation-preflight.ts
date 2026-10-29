/** Only wraps preparation reads, never task creation or paid generation. A late
 * read may finish, but its result cannot resume the submission that timed out. */
export function waitForCanvasPreparation<T>(read: () => Promise<T>, signal: AbortSignal, timeoutMs = 60_000): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        let settled = false;
        let timer: ReturnType<typeof setTimeout>;
        const finish = (complete: () => void) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            signal.removeEventListener("abort", abort);
            complete();
        };
        const abort = () => finish(() => reject(new DOMException("Aborted", "AbortError")));
        if (signal.aborted) return abort();
        signal.addEventListener("abort", abort, { once: true });
        timer = setTimeout(() => {
            const error = new Error("准备生成素材超时，尚未提交生成任务。请检查参考素材后重试。");
            error.name = "CanvasPreparationTimeoutError";
            finish(() => reject(error));
        }, timeoutMs);
        Promise.resolve().then(() => {
            signal.throwIfAborted();
            return read();
        }).then((value) => finish(() => resolve(value)), (error) => finish(() => reject(error)));
    });
}

export function confirmCanvasGeneration(
    open: (callbacks: { onOk: () => void; onCancel: () => void; afterClose: () => void }) => { destroy: () => void },
    signal: AbortSignal,
): Promise<boolean> {
    return new Promise((resolve) => {
        let dialog: { destroy: () => void } | undefined;
        const finish = (accepted: boolean) => {
            signal.removeEventListener("abort", abort);
            resolve(accepted && !signal.aborted);
        };
        const abort = () => { finish(false); dialog?.destroy(); };
        if (signal.aborted) return finish(false);
        signal.addEventListener("abort", abort, { once: true });
        try {
            dialog = open({ onOk: () => finish(true), onCancel: () => finish(false), afterClose: () => finish(false) });
            if (signal.aborted) dialog.destroy();
        } catch (error) {
            signal.removeEventListener("abort", abort);
            throw error;
        }
    });
}
