import { useEffect, useState } from "react";

import { getActiveUserScopeEpoch, subscribeUserScope } from "@/lib/user-scope";
import { resolveResourceVideoPlayback } from "@/services/resource-video-playback";

// All video surfaces share request ownership, decode fallback and Blob URL disposal.
export function useResourceVideoPlayback(storageKey: string, fallback: string, active = true) {
    const [url, setUrl] = useState("");
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");
    const [compatible, setCompatible] = useState(false);
    const [compatibleTarget, setCompatibleTarget] = useState("");
    const [loadedIdentity, setLoadedIdentity] = useState("");
    const [retryEpoch, setRetryEpoch] = useState(0);
    const [scopeEpoch, setScopeEpoch] = useState(getActiveUserScopeEpoch);
    const identity = JSON.stringify([storageKey, fallback, scopeEpoch]);
    const needsCompatible = compatibleTarget === identity;
    useEffect(() => subscribeUserScope((epoch) => setScopeEpoch(epoch.generation)), []);
    useEffect(() => { if (!active) setCompatibleTarget(""); }, [active]);

    useEffect(() => {
        let cancelled = false;
        const controller = new AbortController();
        let ownedUrl = "";
        setLoadedIdentity(identity);
        setError("");
        setCompatible(false);
        setUrl("");
        setLoading(active);
        if (!active) return;
        void resolveResourceVideoPlayback(storageKey, fallback, controller.signal, needsCompatible)
            .then((resolved) => {
                if (cancelled) return;
                if (typeof resolved !== "string") {
                    ownedUrl = URL.createObjectURL(resolved.blob);
                    setCompatible(resolved.compatible);
                    setUrl(ownedUrl);
                } else setUrl(resolved);
            })
            .catch((error) => {
                if (!cancelled) setError(error instanceof Error ? error.message : "视频加载失败，请重新打开");
            })
            .finally(() => { if (!cancelled) setLoading(false); });
        return () => { cancelled = true; controller.abort(); if (ownedUrl) URL.revokeObjectURL(ownedUrl); };
    }, [active, fallback, storageKey, identity, needsCompatible, retryEpoch]);

    const requestCompatible = () => {
        if (needsCompatible || (loadedIdentity === identity && compatible) || !storageKey.startsWith("resource:")) return false;
        setCompatibleTarget(identity);
        return true;
    };
    const current = active && loadedIdentity === identity;
    return { url: current ? url : "", loading: active && (!current || loading), error: current ? error : "",
        compatible: current && compatible, requestCompatible, retryEpoch,
        retry: () => { setError(""); setRetryEpoch((value) => value + 1); },
        fail: () => setError("视频暂时无法播放，请重新读取预览。") };
}
