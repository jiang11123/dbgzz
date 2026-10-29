export function createChannelCatalogRequests() {
    const active = new Map<string, AbortController>();
    const cancel = (id: string) => {
        active.get(id)?.abort();
        active.delete(id);
    };
    return {
        start(id: string) {
            cancel(id);
            const request = new AbortController();
            active.set(id, request);
            return request;
        },
        current: (id: string, request: AbortController) => active.get(id) === request && !request.signal.aborted,
        finish(id: string, request: AbortController) {
            if (active.get(id) === request) active.delete(id);
        },
        cancel,
        cancelAll() {
            for (const id of active.keys()) cancel(id);
        },
    };
}
