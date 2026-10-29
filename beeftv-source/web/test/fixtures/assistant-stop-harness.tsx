import { createRoot } from "react-dom/client";
import { useCanvasAssistant } from "@/pages/canvas/use-canvas-assistant";
import { setActiveUserScope } from "@/lib/user-scope";
import { hydrateModelConfig } from "@/services/model-config-repository";

await hydrateModelConfig();
if (location.search.includes("scope-test")) { document.cookie = "test-user=A"; setActiveUserScope("user-A"); }


function Harness() {
    const assistant = useCanvasAssistant({ canvasId: "c1" });
    return <main>
        <button onClick={() => void assistant.restartHost()}>刷新状态</button>
        <output data-testid="status-reason">{assistant.status?.reason || ""}</output>
        <button onClick={() => { document.cookie = "test-user=B"; setActiveUserScope("user-B"); }}>切换用户</button>
        <button onClick={() => void assistant.send("补充A", [])}>补充</button>
        <output data-testid="session">{assistant.sessionId || ""}</output>
        <output data-testid="supplements">{assistant.supplements.map(item => item.text + ":" + item.status).join(",")}</output>
        <button onClick={() => void assistant.send("只创建草案", [])}>开始</button>
        <button onClick={() => void assistant.stop()}>停止</button>
        <button onClick={() => assistant.retryLast()}>重试</button>
        <output data-testid="can-retry">{String(assistant.canRetry)}</output>
        <button onClick={() => void assistant.reloadHistory()}>重新读取</button>
        <output data-testid="pending">{assistant.pendingUserText || ""}</output>
        <output data-testid="streamed">{assistant.streamed}</output>
        <output data-testid="error">{assistant.error || ""}</output>
        <output data-testid="history-error">{assistant.historyError || ""}</output>
        <output data-testid="streaming">{String(assistant.streaming)}</output>
        <output data-testid="awaiting">{String(assistant.awaitingReceipt)}</output>
        <output data-testid="lifecycle">{assistant.lifecycleNotice || ""}</output>
        <output data-testid="history">{assistant.turns.map(turn => turn.reply).join("\n")}</output>
    </main>;
}
createRoot(document.getElementById("root")!).render(<Harness />);
