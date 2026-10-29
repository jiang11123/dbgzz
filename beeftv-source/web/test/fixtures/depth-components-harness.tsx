import { createRoot } from "react-dom/client";
import { useState } from "react";
import { App, Button, ConfigProvider, theme } from "antd";
import { DepthComponentsPanel, confirmDepthComponents } from "../../src/components/depth-components-panel";
import type { DepthComponentState } from "../../src/services/desktop-runtime";

const params = new URLSearchParams(location.search);
document.documentElement.classList.toggle("dark", params.has("dark"));
document.body.classList.add("app-user-overlays");
document.body.style.background = "var(--background)";
document.body.style.color = "var(--foreground)";
let state: DepthComponentState = { status: params.has("installed") ? "ready" : "not_installed", variant: "cuda", dataDir: "C:\\Users\\Creator\\AppData\\Roaming\\BeefTV", downloadBytes: 3.5 * 1024 ** 3, requiredBytes: 14 * 1024 ** 3, freeBytes: (params.has("low-space") ? 2.3 : 40) * 1024 ** 3, downloadedBytes: 0 };
const calls = { downloads: 0, pauses: 0, tasks: 0 };
Object.assign(window, { depthHarness: {
    calls,
    ready: () => { state = { ...state, status: "ready", downloadedBytes: state.downloadBytes }; },
    fail: () => { state = { ...state, status: "error", error: "下载连接中断，已下载文件保留。请重试。" }; },
} });
window.go = { main: { DesktopApp: {
    RuntimeConfig: async () => ({ baseURL: "http://127.0.0.1:9999/api", launchToken: "fixture" }),
    DepthComponentStatus: async () => ({ ...state }),
    DownloadDepthComponents: async () => { calls.downloads++; state = { ...state, status: "downloading", downloadedBytes: 464 * 1024 ** 2, error: "" }; return { ...state }; },
    PauseDepthComponentDownload: async () => { calls.pauses++; state = { ...state, status: "paused", error: "下载已暂停，已下载的文件会保留。点击继续下载即可续传。" }; return { ...state }; },
} } };
function Harness() {
    const { modal } = App.useApp();
    const [result, setResult] = useState("");
    return <main className="settings-section space-y-4" style={{ padding: 24, maxWidth: 840, margin: "16px auto" }}>
        <h2>深度捕捉组件</h2>
        <DepthComponentsPanel />
        <Button onClick={async () => { if (await confirmDepthComponents(modal)) { calls.tasks++; setResult("深度任务已创建"); } else setResult("已返回，未创建任务"); }}>使用深度动作捕捉</Button>
        <output>{result}</output>
    </main>;
}
createRoot(document.getElementById("root")!).render(<ConfigProvider theme={{ algorithm: params.has("dark") ? theme.darkAlgorithm : theme.defaultAlgorithm, token: { motion: false } }}><App><Harness /></App></ConfigProvider>);
