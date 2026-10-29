/**
 * Backspace that no text field consumes is a "history back" in some webviews
 * (WKWebView in the desktop shell). The app uses a hash router, so one stray
 * Backspace on a focused button or on the page body silently leaves the
 * current screen. Text-editing targets keep their native Backspace.
 */

// Input types where Backspace edits a value. Buttons, checkboxes, ranges,
// colors and files have no text to delete.
const TEXT_INPUT_TYPES = new Set([
    "",
    "text",
    "search",
    "email",
    "url",
    "tel",
    "password",
    "number",
    "date",
    "datetime-local",
    "month",
    "time",
    "week",
]);

const EDITABLE_ANCESTOR_SELECTOR = "[contenteditable]:not([contenteditable='false']), [role='textbox']";

type TargetLike = {
    tagName?: unknown;
    type?: unknown;
    isContentEditable?: unknown;
    getAttribute?: (name: string) => string | null;
    closest?: (selector: string) => unknown;
};

/**
 * True when Backspace on this event target edits text and must keep its
 * native behavior. Duck-typed so it works across realms and in tests.
 */
export function isTextEditableTarget(target: unknown): boolean {
    if (!target || typeof target !== "object") return false;
    const node = target as TargetLike;
    const tagName = typeof node.tagName === "string" ? node.tagName.toUpperCase() : "";
    if (tagName === "TEXTAREA" || tagName === "SELECT") return true;
    if (tagName === "INPUT") {
        const rawType = typeof node.type === "string" ? node.type : typeof node.getAttribute === "function" ? node.getAttribute("type") : "";
        return TEXT_INPUT_TYPES.has((rawType || "").toLowerCase());
    }
    if (node.isContentEditable === true) return true;
    if (typeof node.closest === "function") return Boolean(node.closest(EDITABLE_ANCESTOR_SELECTOR));
    return false;
}

type KeyEventLike = {
    key: string;
    target: unknown;
};

/** Backspace that would otherwise fall through to the webview's history back. */
export function shouldBlockBackspaceNavigation(event: KeyEventLike): boolean {
    return event.key === "Backspace" && !isTextEditableTarget(event.target);
}

type ListenerTarget = Pick<Document, "addEventListener" | "removeEventListener">;

let installed: { target: ListenerTarget; listener: (event: KeyboardEvent) => void } | null = null;

/**
 * Install the app-wide guard once. Capture phase: React's synthetic
 * stopPropagation (e.g. on the node toolbar) halts native propagation at the
 * root, so a bubble listener on document would never see those keys.
 * Only preventDefault is called; other keydown listeners still run.
 */
export function installBackspaceNavigationGuard(target: ListenerTarget | undefined = typeof document === "undefined" ? undefined : document): () => void {
    if (!target) return () => undefined;
    if (installed) return uninstallBackspaceNavigationGuard;
    const listener = (event: KeyboardEvent) => {
        if (shouldBlockBackspaceNavigation(event)) event.preventDefault();
    };
    target.addEventListener("keydown", listener, true);
    installed = { target, listener };
    return uninstallBackspaceNavigationGuard;
}

export function uninstallBackspaceNavigationGuard() {
    if (!installed) return;
    installed.target.removeEventListener("keydown", installed.listener, true);
    installed = null;
}
