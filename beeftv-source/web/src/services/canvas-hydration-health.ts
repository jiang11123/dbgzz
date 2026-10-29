type Health = { error: string; loading: boolean };
let state: Health = { error: "", loading: true };
let attempt = 0;
const listeners = new Set<() => void>();
export const getCanvasHydrationHealth = () => state;
export function subscribeCanvasHydrationHealth(listener: () => void) {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}
export function setCanvasHydrationHealth(next: Health) {
    state = next;
    listeners.forEach((listener) => listener());
}
export function beginCanvasHydration() {
    const id = ++attempt;
    setCanvasHydrationHealth({ error: "", loading: true });
    return id;
}
export function finishCanvasHydration(id: number, error = "") {
    if (id === attempt) setCanvasHydrationHealth({ error, loading: false });
}
import { subscribeUserScope } from "@/lib/user-scope";
subscribeUserScope(() => {
    ++attempt;
    setCanvasHydrationHealth({ error: "", loading: true });
});
