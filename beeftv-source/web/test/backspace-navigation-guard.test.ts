import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { installBackspaceNavigationGuard, isTextEditableTarget, shouldBlockBackspaceNavigation, uninstallBackspaceNavigationGuard } from "../src/lib/backspace-navigation-guard";

// Duck-typed DOM stand-ins: `matches` lists the selector parts this node or an ancestor satisfies.
function node(tagName: string, options: { type?: string; isContentEditable?: boolean; matches?: string[] } = {}) {
    const matches = new Set(options.matches || []);
    return {
        tagName,
        type: options.type,
        isContentEditable: options.isContentEditable ?? false,
        getAttribute: (name: string) => (name === "type" ? options.type ?? null : null),
        closest(selector: string) {
            return selector.split(",").some((part) => matches.has(part.trim())) ? this : null;
        },
    };
}

describe("Backspace navigation guard predicate", () => {
    test("text inputs, textareas and selects keep native Backspace", () => {
        for (const type of ["text", "search", "email", "url", "tel", "password", "number", "date", "time", "", undefined]) {
            expect(isTextEditableTarget(node("INPUT", { type }))).toBe(true);
        }
        expect(isTextEditableTarget(node("textarea"))).toBe(true);
        expect(isTextEditableTarget(node("SELECT"))).toBe(true);
    });

    test("non-text inputs do not edit text", () => {
        for (const type of ["button", "submit", "checkbox", "radio", "range", "color", "file", "reset", "image"]) {
            expect(isTextEditableTarget(node("INPUT", { type }))).toBe(false);
        }
    });

    test("contenteditable and textbox roles, including descendants, keep native Backspace", () => {
        expect(isTextEditableTarget(node("DIV", { isContentEditable: true }))).toBe(true);
        expect(isTextEditableTarget(node("SPAN", { matches: ["[contenteditable]:not([contenteditable='false'])"] }))).toBe(true);
        expect(isTextEditableTarget(node("DIV", { matches: ["[role='textbox']"] }))).toBe(true);
    });

    test("buttons, toolbar controls, body and non-elements are not text targets", () => {
        expect(isTextEditableTarget(node("BUTTON", { matches: [".canvas-node-toolbar", "[data-canvas-no-zoom]"] }))).toBe(false);
        expect(isTextEditableTarget(node("BODY"))).toBe(false);
        expect(isTextEditableTarget(null)).toBe(false);
        expect(isTextEditableTarget(undefined)).toBe(false);
        expect(isTextEditableTarget({})).toBe(false);
        expect(isTextEditableTarget("input")).toBe(false);
    });

    test("only Backspace outside text targets is blocked", () => {
        expect(shouldBlockBackspaceNavigation({ key: "Backspace", target: node("BUTTON") })).toBe(true);
        expect(shouldBlockBackspaceNavigation({ key: "Backspace", target: node("BODY") })).toBe(true);
        expect(shouldBlockBackspaceNavigation({ key: "Backspace", target: node("INPUT", { type: "text" }) })).toBe(false);
        expect(shouldBlockBackspaceNavigation({ key: "Backspace", target: node("TEXTAREA") })).toBe(false);
        expect(shouldBlockBackspaceNavigation({ key: "a", target: node("BUTTON") })).toBe(false);
        expect(shouldBlockBackspaceNavigation({ key: "Delete", target: node("BUTTON") })).toBe(false);
    });
});

describe("installBackspaceNavigationGuard", () => {
    test("installs one capture-phase keydown listener that only calls preventDefault", () => {
        const listeners: Array<{ type: string; listener: (event: KeyboardEvent) => void; capture: unknown }> = [];
        const target = {
            addEventListener: (type: string, listener: (event: KeyboardEvent) => void, capture: unknown) => listeners.push({ type, listener, capture }),
            removeEventListener: (type: string, listener: (event: KeyboardEvent) => void) => {
                const index = listeners.findIndex((entry) => entry.type === type && entry.listener === listener);
                if (index >= 0) listeners.splice(index, 1);
            },
        } as unknown as Document;
        try {
            installBackspaceNavigationGuard(target);
            installBackspaceNavigationGuard(target);
            expect(listeners).toHaveLength(1);
            expect(listeners[0]!.type).toBe("keydown");
            expect(listeners[0]!.capture).toBe(true);

            const dispatch = (key: string, eventTarget: unknown) => {
                const calls = { preventDefault: 0, stopPropagation: 0 };
                listeners[0]!.listener({ key, target: eventTarget, preventDefault: () => { calls.preventDefault += 1; }, stopPropagation: () => { calls.stopPropagation += 1; } } as unknown as KeyboardEvent);
                return calls;
            };
            expect(dispatch("Backspace", node("BUTTON"))).toEqual({ preventDefault: 1, stopPropagation: 0 });
            expect(dispatch("Backspace", node("INPUT", { type: "text" }))).toEqual({ preventDefault: 0, stopPropagation: 0 });
            expect(dispatch("Backspace", node("DIV", { isContentEditable: true }))).toEqual({ preventDefault: 0, stopPropagation: 0 });
            expect(dispatch("Enter", node("BUTTON"))).toEqual({ preventDefault: 0, stopPropagation: 0 });
        } finally {
            uninstallBackspaceNavigationGuard();
        }
        expect(listeners).toHaveLength(0);
    });

    test("is installed once at app startup", () => {
        const application = readFileSync(resolve(import.meta.dir, "../src/application.tsx"), "utf8");
        expect(application).toContain('import { installBackspaceNavigationGuard } from "@/lib/backspace-navigation-guard";');
        expect(application).toContain("\ninstallBackspaceNavigationGuard();\n");
    });
});
