import { recordDiagnosticEvent } from "@/services/diagnostics/client-diagnostics";

// Evidence for "the default-model dropdown does not open" reports. Each step of
// pressing a picker is written to the client diagnostics buffer, which the
// diagnostics package already exports, so a user's bundle shows whether the
// press reached the select, whether the popup rendered, and what covered it.
// Only structural facts are recorded: counts, timings, element tags/classes.

export type ModelPickerSnapshot = {
    pickerId: string;
    title: string;
    optionCount: number;
    hasValue: boolean;
    unavailable: boolean;
    disabled: boolean;
    buildMs: number;
};

const OPEN_CHECK_DELAY_MS = 600;
const POPUP_SETTLE_MS = 450;
const POPUP_SELECTOR = ".model-default-select-popup";
const openChecks = new Map<string, number>();

type PendingPress = { title: string; startedAt: number; opened: boolean };
let pendingPress: PendingPress | undefined;

export function describeDiagnosticElement(element: Element | null | undefined) {
    if (!element) return "无";
    const tag = element.tagName.toLowerCase();
    const raw = typeof element.className === "string" ? element.className : element.getAttribute("class") || "";
    const classes = raw.split(/\s+/).filter((name) => name.startsWith("ant-") || name.startsWith("model-") || name.startsWith("settings-")).slice(0, 3);
    return classes.length ? `${tag}.${classes.join(".")}` : tag;
}

function visibleOverlayCount(doc: Document, selector: string) {
    return Array.from(doc.querySelectorAll<HTMLElement>(selector)).filter((element) => {
        const style = doc.defaultView?.getComputedStyle(element);
        return style ? style.display !== "none" && style.visibility !== "hidden" : true;
    }).length;
}

function surroundings(doc: Document) {
    const reducedMotion = doc.defaultView?.matchMedia("(prefers-reduced-motion: reduce)").matches;
    return `弹窗 ${visibleOverlayCount(doc, ".ant-modal-wrap")} 个，焦点 ${describeDiagnosticElement(doc.activeElement)}，减少动态效果 ${reducedMotion === undefined ? "未知" : reducedMotion ? "开启" : "关闭"}`;
}

function snapshotText(snapshot: ModelPickerSnapshot) {
    return `选项 ${snapshot.optionCount} 个，${snapshot.unavailable ? "已选模型不可用" : snapshot.hasValue ? "已有选择" : "未选择"}，${snapshot.disabled ? "已禁用" : "可用"}，选项计算 ${Math.round(snapshot.buildMs)}ms`;
}

export function recordModelPickerPress(snapshot: ModelPickerSnapshot, point: { x: number; y: number }, doc: Document = document) {
    const press: PendingPress = { title: snapshot.title, startedAt: performance.now(), opened: false };
    pendingPress = press;
    recordDiagnosticEvent({
        level: "info",
        category: "action",
        code: "MODEL_PICKER_PRESS",
        message: `${snapshot.title} 被点击：${snapshotText(snapshot)}，${surroundings(doc)}`,
    });
    window.setTimeout(() => {
        if (press.opened || pendingPress !== press) return;
        const hit = doc.elementFromPoint(point.x, point.y);
        recordDiagnosticEvent({
            level: "warning",
            category: "action",
            code: "MODEL_PICKER_NOT_OPENED",
            message: `${snapshot.title} 点击后 ${OPEN_CHECK_DELAY_MS}ms 仍未展开：点击位置当前元素 ${describeDiagnosticElement(hit)}，${surroundings(doc)}`,
        });
    }, OPEN_CHECK_DELAY_MS);
}

export function recordModelPickerOpenChange(snapshot: ModelPickerSnapshot, open: boolean, doc: Document = document) {
    window.clearTimeout(openChecks.get(snapshot.pickerId));
    openChecks.delete(snapshot.pickerId);
    const press = pendingPress?.title === snapshot.title ? pendingPress : undefined;
    if (!open) {
        recordDiagnosticEvent({ level: "info", category: "action", code: "MODEL_PICKER_CLOSE", message: `${snapshot.title} 已收起，${surroundings(doc)}` });
        return;
    }
    if (press) press.opened = true;
    const delay = press ? performance.now() - press.startedAt : undefined;
    // Check after the open animation: the popup fades in from opacity 0.
    const timer = window.setTimeout(
        () => {
            openChecks.delete(snapshot.pickerId);
            const popup = doc.querySelector<HTMLElement>(`${POPUP_SELECTOR}-${snapshot.pickerId}`) ?? undefined;
            const visible = popup && popupVisible(doc, popup);
            const trigger = doc.querySelector<HTMLElement>(`[data-model-picker-id="${snapshot.pickerId}"]`);
            const triggerRect = trigger?.getBoundingClientRect();
            const popupRect = popup?.getBoundingClientRect();
            const gap = triggerRect && popupRect ? Math.min(Math.abs(popupRect.top - triggerRect.bottom), Math.abs(triggerRect.top - popupRect.bottom)) : undefined;
            const misaligned = visible && triggerRect && popupRect && gap !== undefined && (gap > 16 || popupRect.right <= triggerRect.left || popupRect.left >= triggerRect.right);
            recordDiagnosticEvent({
                level: visible && !misaligned ? "info" : "warning",
                category: "action",
                code: !visible ? "MODEL_PICKER_POPUP_HIDDEN" : misaligned ? "MODEL_PICKER_POPUP_MISALIGNED" : "MODEL_PICKER_OPEN",
                message: `${snapshot.title} 展开：${snapshotText(snapshot)}，${describePopup(doc, popup)}${triggerRect && gap !== undefined ? `，选择框位于 (${Math.round(triggerRect.left)}, ${Math.round(triggerRect.top)})，菜单间距 ${Math.round(gap)}px${misaligned ? "，菜单位置偏离选择框" : ""}` : ""}，${surroundings(doc)}`,
                durationMs: delay,
            });
        },
        POPUP_SETTLE_MS,
    );
    openChecks.set(snapshot.pickerId, timer);
}

export function recordModelPickerChange(snapshot: ModelPickerSnapshot) {
    recordDiagnosticEvent({ level: "info", category: "action", code: "MODEL_PICKER_CHANGE", message: `${snapshot.title} 已选择新模型` });
}

function popupVisible(doc: Document, popup: HTMLElement) {
    const rect = popup.getBoundingClientRect();
    const style = doc.defaultView?.getComputedStyle(popup);
    return rect.width > 0 && rect.height > 0 && popupInViewport(doc, rect) && (!style || (style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity || 1) > 0.05));
}

function popupInViewport(doc: Document, rect: DOMRect) {
    const view = doc.defaultView;
    return !view || (rect.bottom > 0 && rect.right > 0 && rect.top < view.innerHeight && rect.left < view.innerWidth);
}

function describePopup(doc: Document, popup: HTMLElement | undefined) {
    if (!popup) return "弹层未渲染";
    const rect = popup.getBoundingClientRect();
    const style = doc.defaultView?.getComputedStyle(popup);
    const items = popup.querySelectorAll(".ant-select-item-option").length;
    const view = doc.defaultView;
    const inViewport = popupInViewport(doc, rect);
    const left = Math.max(0, rect.left);
    const right = Math.min(view?.innerWidth ?? rect.right, rect.right);
    const top = Math.max(0, rect.top);
    const bottom = Math.min(view?.innerHeight ?? rect.bottom, rect.bottom);
    const center = inViewport ? doc.elementFromPoint((left + right) / 2, top + Math.min((bottom - top) / 2, 16)) : null;
    const covered = !inViewport ? "窗口外，无法检测遮挡" : !center ? "无法检测遮挡" : !popup.contains(center) ? `被 ${describeDiagnosticElement(center)} 遮挡` : "未被遮挡";
    return `弹层 ${Math.round(rect.width)}×${Math.round(rect.height)} 位于 (${Math.round(rect.left)}, ${Math.round(rect.top)})，${inViewport ? "在窗口内" : "在窗口外"}，透明度 ${style?.opacity ?? "?"}，层级 ${style?.zIndex ?? "?"}，已渲染选项 ${items} 个，${covered}`;
}

// A layer left above the pickers (a stuck mask, tooltip or popover) takes the
// press before the select sees it, so the picker itself records nothing. Watch
// presses at document level and report the element that actually received a
// press landing inside a picker's box.
export function watchModelPickerBlockers(root: HTMLElement, doc: Document = document) {
    const onPointerDown = (event: PointerEvent) => {
        const target = event.target instanceof Element ? event.target : null;
        for (const picker of Array.from(root.querySelectorAll<HTMLElement>(".model-default-select"))) {
            const rect = picker.getBoundingClientRect();
            if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) continue;
            if (target && picker.contains(target)) return;
            recordDiagnosticEvent({
                level: "warning",
                category: "action",
                code: "MODEL_PICKER_BLOCKED",
                message: `${picker.getAttribute("aria-label") || picker.querySelector("[aria-label]")?.getAttribute("aria-label") || "模型选择框"} 的点击被 ${describeDiagnosticElement(target)} 接走，${surroundings(doc)}`,
            });
            return;
        }
    };
    doc.addEventListener("pointerdown", onPointerDown, true);
    return () => doc.removeEventListener("pointerdown", onPointerDown, true);
}

// "Deleting a channel does nothing" reports: record whether the confirm opened,
// whether 删除 was confirmed, and whether the channel actually left the list.
export function recordChannelDeleteConfirmOpen(open: boolean) {
    recordDiagnosticEvent({ level: "info", category: "action", code: open ? "CHANNEL_DELETE_CONFIRM_OPEN" : "CHANNEL_DELETE_CONFIRM_CLOSE", message: open ? "删除渠道确认框已打开" : "删除渠道确认框已关闭" });
}

export function recordChannelDelete(result: { scope?: string; before: number; after: number }) {
    const removed = result.before - result.after;
    recordDiagnosticEvent({
        level: removed === 1 ? "info" : "warning",
        category: "action",
        code: removed === 1 ? "CHANNEL_DELETED" : "CHANNEL_DELETE_NOOP",
        message: `确认删除渠道：作用范围 ${result.scope || "个人"}，渠道数 ${result.before} → ${result.after}`,
    });
}
