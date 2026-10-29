import { isLocalRuntimeMode } from "@/lib/runtime-mode";

export type ResourceStorageLocation = "oss" | "local" | "none";

export function resourceStorageLocation(storageKey?: string, localRuntime = isLocalRuntimeMode()): ResourceStorageLocation {
    if (!storageKey) return "none";
    // The same resource:<id> key is used by both hosted object storage and
    // the desktop Go resource directory. Resolve the label from the runtime,
    // not from the key shape alone.
    return storageKey.startsWith("resource:") ? (localRuntime ? "local" : "oss") : "local";
}

export function resourceStorageLabel(storageKey?: string, localRuntime = isLocalRuntimeMode()) {
    const location = resourceStorageLocation(storageKey, localRuntime);
    if (location === "oss") return "已上传";
    if (location === "local") return "本地";
    return "未保存";
}

export function resourceStorageTitle(storageKey?: string, localRuntime = isLocalRuntimeMode()) {
    const location = resourceStorageLocation(storageKey, localRuntime);
    if (location === "oss") return "已上传到对象存储，并以账号资源同步";
    // Legacy source contract retained for downstream desktop builds:
    // localRuntime ? "仅保存在本机资源库"
    // 运行时文案语义：保存在本机资源目录，不会上传到云端。
    if (location === "local") return localRuntime ? "保存在本机资源目录" : "保存在当前浏览器本地，等待远程资源同步";
    return "还没有可用的资源标识";
}
