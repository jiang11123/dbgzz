import { browserCapabilities } from "./browser-environment";

type RequiredCapabilities = { secureRandom: boolean; structuredClone: boolean; indexedDB: boolean };

// This module must remain independent of React, stores and backend bootstrap:
// importing those first can fail before an unsupported runtime sees the notice.
export async function startCheckedWorkspace(load: () => Promise<unknown>, capabilities: RequiredCapabilities = browserCapabilities()) {
    const missing = Object.entries(capabilities).filter(([key, supported]) => ["secureRandom", "structuredClone", "indexedDB"].includes(key) && !supported).map(([key]) => key);
    if (missing.length) {
        showFailure("capability", capabilities);
        return false;
    }
    try {
        await load();
        return true;
    } catch {
        showFailure("workspace", capabilities);
        return false;
    }
}

function showFailure(stage: "capability" | "workspace", capabilities: RequiredCapabilities) {
    const root = document.getElementById("root");
    if (!root) return;
    const section = document.createElement("section");
    section.setAttribute("role", "alert");
    section.style.cssText = "box-sizing:border-box;max-width:36rem;margin:10vh auto;padding:24px;font:16px/1.6 system-ui,sans-serif;overflow-wrap:anywhere";
    const heading = document.createElement("h1");
    heading.textContent = stage === "capability" ? "运行环境需要更新" : "工作区暂时无法打开";
    const detail = document.createElement("p");
    detail.textContent = stage === "capability" ? "当前环境缺少必要能力，请检查浏览器存储权限，或更新浏览器和系统 WebView 后重试。" : "请重启应用，或确认后端服务可用后重试。仍无法打开时，请把下方排查信息提供给支持人员。";
    const button = document.createElement("button");
    button.textContent = "重新加载";
    button.onclick = () => location.reload();
    const evidence = document.createElement("pre");
    evidence.style.cssText = "white-space:pre-wrap;font-size:12px";
    evidence.textContent = JSON.stringify({ stage, capabilities: { secureRandom: capabilities.secureRandom, structuredClone: capabilities.structuredClone, indexedDB: capabilities.indexedDB } }, null, 2);
    for (const element of [heading, detail, button, evidence]) section.appendChild(element);
    while (root.firstChild) root.removeChild(root.firstChild);
    root.appendChild(section);
}
