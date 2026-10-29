import { create } from "zustand";
import { scopedLocalStorage, subscribeUserScope } from "@/lib/user-scope";

export const onboardingSteps = ["official", "project", "node", "generate", "assets", "return"] as const;
export type OnboardingStep = typeof onboardingSteps[number];
type Progress = {
    status: "new" | "active" | "paused" | "finished";
    step: number;
    skipped: OnboardingStep[];
    projectId?: string;
    nodeId?: string;
    assetId?: string;
    startedAt?: string;
    visitedLibrary?: boolean;
};
const key = "beeftv:first-creation:v1";
const initial: Progress = { status: "new", step: 0, skipped: [] };
function read(): Progress {
    try {
        const value = JSON.parse(scopedLocalStorage.getItem(key) || "null");
        if (!value || !["new", "active", "paused", "finished"].includes(value.status) || !Number.isInteger(value.step) || value.step < 0 || value.step >= onboardingSteps.length) return { ...initial };
        if (value.status === "active" || value.status === "paused") return { ...initial, status: "paused" };
        return { ...initial, ...value, skipped: Array.isArray(value.skipped) ? value.skipped.filter((step: OnboardingStep) => onboardingSteps.includes(step)) : [] };
    } catch { return { ...initial }; }
}
type Store = Progress & {
    begin: () => void;
    pause: () => void;
    advance: (skip?: boolean) => void;
    back: () => void;
    bind: (values: Partial<Pick<Progress, "projectId" | "nodeId" | "assetId" | "visitedLibrary">>) => void;
    restart: () => void;
};
export const useOnboardingStore = create<Store>((set, get) => {
    const save = (patch: Partial<Progress>) => {
        const { status, step, skipped, projectId, nodeId, assetId, startedAt, visitedLibrary } = { ...get(), ...patch };
        const progress = { status, step, skipped, projectId, nodeId, assetId, startedAt, visitedLibrary };
        scopedLocalStorage.setItem(key, JSON.stringify(progress));
        set(progress);
    };
    return {
        ...read(),
        begin: () => save({ status: "active", startedAt: get().startedAt || new Date().toISOString() }),
        pause: () => save({ status: "paused" }),
        advance: (skip = false) => {
            const state = get();
            if (state.status !== "active") return;
            save({ step: Math.min(state.step + 1, onboardingSteps.length - 1), status: state.step === onboardingSteps.length - 1 ? "finished" : "active", skipped: skip ? [...new Set([...state.skipped, onboardingSteps[state.step]])] : state.skipped.filter((item) => item !== onboardingSteps[state.step]) });
        },
        back: () => { if (get().status === "active") save({ step: Math.max(0, get().step - 1) }); },
        bind: (values) => save(values),
        restart: () => save({ ...initial, status: "active", projectId: undefined, nodeId: undefined, assetId: undefined, visitedLibrary: false, startedAt: new Date().toISOString() }),
    };
});
subscribeUserScope(() => useOnboardingStore.setState(read()));
