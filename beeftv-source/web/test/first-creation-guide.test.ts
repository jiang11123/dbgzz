import { beforeEach, expect, test } from "bun:test";
import { onboardingSteps, useOnboardingStore } from "../src/stores/use-onboarding-store";

beforeEach(() => useOnboardingStore.getState().restart());

test("closing pauses without losing the current step and linked work", () => {
    const guide = useOnboardingStore.getState();
    guide.advance();
    guide.bind({ projectId: "practice", nodeId: "image" });
    guide.pause();
    guide.advance(true);
    expect(useOnboardingStore.getState().step).toBe(1);
    expect(useOnboardingStore.getState().projectId).toBe("practice");
    guide.begin();
    expect(useOnboardingStore.getState().status).toBe("active");
    expect(useOnboardingStore.getState().nodeId).toBe("image");
});

test("every step can be skipped and the final step ends the guide", () => {
    for (const step of onboardingSteps) {
        expect(onboardingSteps[useOnboardingStore.getState().step]).toBe(step);
        useOnboardingStore.getState().advance(true);
    }
    expect(useOnboardingStore.getState().status).toBe("finished");
    expect(useOnboardingStore.getState().skipped).toEqual([...onboardingSteps]);
    useOnboardingStore.getState().advance(true);
    expect(useOnboardingStore.getState().skipped).toHaveLength(onboardingSteps.length);
});

test("back preserves real work and stops at the first step", () => {
    const guide = useOnboardingStore.getState();
    guide.bind({ projectId: "practice", nodeId: "image" });
    guide.advance(true);
    guide.back();
    guide.back();
    expect(useOnboardingStore.getState().step).toBe(0);
    expect(useOnboardingStore.getState().projectId).toBe("practice");
    expect(useOnboardingStore.getState().nodeId).toBe("image");
    guide.pause();
    guide.back();
    expect(useOnboardingStore.getState().status).toBe("paused");
});

test("revisiting and completing a step clears its previous skip", () => {
    const guide = useOnboardingStore.getState();
    guide.advance(true);
    guide.back();
    guide.advance(false);
    expect(useOnboardingStore.getState().skipped).toEqual([]);
    expect(useOnboardingStore.getState().step).toBe(1);
});

test("restarting clears lesson bindings without deleting real projects or assets", () => {
    useOnboardingStore.getState().bind({ projectId: "practice", nodeId: "image", assetId: "asset", visitedLibrary: true });
    useOnboardingStore.getState().advance(true);
    useOnboardingStore.getState().restart();
    const state = useOnboardingStore.getState();
    expect(state.step).toBe(0);
    expect(state.skipped).toEqual([]);
    expect(state.projectId).toBeUndefined();
    expect(state.assetId).toBeUndefined();
    expect(state.visitedLibrary).toBe(false);
});
