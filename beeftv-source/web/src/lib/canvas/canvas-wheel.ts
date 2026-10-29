type WheelInput = Pick<WheelEvent, "deltaX" | "deltaY" | "deltaMode" | "ctrlKey" | "metaKey" | "shiftKey">;

export function canvasWheelIntent(event: WheelInput, previous: { intent: "pan" | "zoom"; at: number } | null, now: number): "pan" | "zoom" {
    if (event.ctrlKey || event.metaKey) return "zoom";
    if (event.shiftKey || Math.abs(event.deltaX) > 0) return "pan";
    if (previous && now - previous.at < 200) return previous.intent;
    const magnitude = Math.abs(event.deltaY);
    // 常见滚轮包含 60/80/100/120 像素；同一连续手势不逐事件切换动作。
    return event.deltaMode !== 0 || (magnitude >= 40 && magnitude % 20 === 0) ? "zoom" : "pan";
}
