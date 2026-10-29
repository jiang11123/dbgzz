import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as React from "react";

import { useCanvasKeyboard } from "../src/pages/canvas/use-canvas-keyboard";

// Behavior test without a DOM renderer: run the hook once with a minimal React
// dispatcher (useEffect runs immediately), install fake window/document/Element
// globals, and dispatch fake KeyboardEvents to the captured window listener.

type Listener = (event: KeyboardEvent) => void;
type Internals = { H: unknown };

const internals = (React as unknown as { __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: Internals }).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
const globalNames = ["window", "document", "Element", "HTMLInputElement", "HTMLTextAreaElement", "HTMLSelectElement"] as const;
const g = globalThis as Record<string, unknown>;

class FakeElement {
    constructor(readonly tagName: string, private readonly ancestorSelectors: string[] = []) {}
    readonly isContentEditable = false;
    getAttribute() { return null; }
    closest(selector: string) {
        return selector.split(",").some((part) => this.ancestorSelectors.includes(part.trim())) ? this : null;
    }
}
class FakeInput extends FakeElement { readonly type = "text"; }
class FakeTextArea extends FakeElement {}
class FakeSelect extends FakeElement {}

let saved: Record<string, unknown> = {};
let keydownListeners: Listener[] = [];
let directorMounted = false;
let cleanup: (() => void) | undefined;
let deleted: Array<Set<string>> = [];

function mountHook() {
    const previous = internals.H;
    internals.H = {
        useEffect(create: () => (() => void) | void) {
            const result = create();
            cleanup = typeof result === "function" ? result : undefined;
        },
    };
    try {
        const noop = () => undefined;
        useCanvasKeyboard({
            nodesRef: { current: [] },
            selectedNodeIdsRef: { current: new Set(["n1"]) },
            selectedConnectionId: null,
            setSelectedNodeIds: noop,
            setSelectedConnectionId: noop,
            setContextMenu: noop,
            setShortcutRequestNonce: noop,
            setInfoNodeId: noop,
            setCropNodeId: noop,
            setMaskEditNodeId: noop,
            setAnnotationNodeId: noop,
            saveCanvasProject: noop,
            zoomToActualSize: noop,
            fitCanvasContent: noop,
            fitCanvasSelection: noop,
            undoCanvas: noop,
            redoCanvas: noop,
            cancelSelectionBox: noop,
            copySelectedNodes: noop,
            pasteCopiedNodes: () => false,
            restoreCopiedNodesFromText: () => false,
            shouldPreferCopiedNodes: () => false,
            pasteSystemClipboard: () => false,
            deleteNodes: (ids) => { deleted.push(ids); },
            deleteConnection: noop,
            deselectCanvas: noop,
            zoomCanvasIn: noop,
            zoomCanvasOut: noop,
            autoArrangeCanvasNodes: noop,
            focusMode: false,
            exitFocusMode: noop,
            toggleFocusMode: noop,
            onOpenSearch: noop,
            beginBatchConnection: noop,
        });
    } finally {
        internals.H = previous;
    }
}

function press(key: string, target: unknown) {
    const result = { defaultPrevented: false, propagationStopped: false };
    const event = {
        key,
        code: "",
        target,
        metaKey: false,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
        repeat: false,
        preventDefault: () => { result.defaultPrevented = true; },
        stopPropagation: () => { result.propagationStopped = true; },
    } as unknown as KeyboardEvent;
    for (const listener of keydownListeners) listener(event);
    return result;
}

beforeEach(() => {
    saved = Object.fromEntries(globalNames.map((name) => [name, g[name]]));
    keydownListeners = [];
    directorMounted = false;
    deleted = [];
    g.Element = FakeElement;
    g.HTMLInputElement = FakeInput;
    g.HTMLTextAreaElement = FakeTextArea;
    g.HTMLSelectElement = FakeSelect;
    g.document = { querySelector: (selector: string) => (directorMounted && selector.includes("data-director-workbench") ? {} : null) };
    g.window = {
        addEventListener: (type: string, listener: Listener) => { if (type === "keydown") keydownListeners.push(listener); },
        removeEventListener: (type: string, listener: Listener) => { if (type === "keydown") keydownListeners = keydownListeners.filter((entry) => entry !== listener); },
        getSelection: () => null,
    };
    mountHook();
});

afterEach(() => {
    cleanup?.();
    cleanup = undefined;
    for (const name of globalNames) {
        if (saved[name] === undefined) delete g[name];
        else g[name] = saved[name];
    }
});

describe("canvas Backspace never falls through to webview history back", () => {
    test("Backspace on a node toolbar button is default-prevented but still propagates", () => {
        for (const key of ["Backspace", "Delete"]) {
            const result = press(key, new FakeElement("BUTTON", [".canvas-node-toolbar", "[data-canvas-no-zoom]"]));
            expect(result).toEqual({ defaultPrevented: true, propagationStopped: false });
        }
        expect(press("Backspace", new FakeElement("BUTTON", [".canvas-node-toolbar-menu"]))).toEqual({ defaultPrevented: true, propagationStopped: false });
        expect(deleted).toHaveLength(0);
    });

    test("Backspace inside a [data-canvas-no-zoom] control is default-prevented but still propagates", () => {
        expect(press("Backspace", new FakeElement("BUTTON", ["[data-canvas-no-zoom]"]))).toEqual({ defaultPrevented: true, propagationStopped: false });
        expect(deleted).toHaveLength(0);
    });

    test("Backspace while the director workbench is mounted is default-prevented and left to the director", () => {
        directorMounted = true;
        expect(press("Backspace", new FakeElement("BUTTON"))).toEqual({ defaultPrevented: true, propagationStopped: false });
        expect(deleted).toHaveLength(0);
    });

    test("Backspace on the canvas still deletes the selection and consumes the key", () => {
        expect(press("Backspace", new FakeElement("DIV"))).toEqual({ defaultPrevented: true, propagationStopped: true });
        expect(deleted.map((ids) => [...ids])).toEqual([["n1"]]);
    });

    test("Backspace in text fields keeps its native behavior", () => {
        expect(press("Backspace", new FakeInput("INPUT"))).toEqual({ defaultPrevented: false, propagationStopped: false });
        expect(press("Backspace", new FakeTextArea("TEXTAREA"))).toEqual({ defaultPrevented: false, propagationStopped: false });
        expect(press("Backspace", new FakeElement("SPAN", ["[contenteditable]:not([contenteditable='false'])", "[contenteditable='true']"]))).toEqual({ defaultPrevented: false, propagationStopped: false });
        expect(deleted).toHaveLength(0);
    });

    test("other keys on the toolbar are untouched", () => {
        expect(press("Enter", new FakeElement("BUTTON", [".canvas-node-toolbar"]))).toEqual({ defaultPrevented: false, propagationStopped: false });
    });
});
