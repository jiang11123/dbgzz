import { useCallback, useEffect, useRef, useState } from "react";

import { DoubaoGatewayError, fetchDoubaoAccounts, type DoubaoGatewayAccount } from "@/services/api/doubao-gateway";

const POLL_INTERVAL_MS = 15_000;

export type DoubaoAccountsState = {
    accounts: DoubaoGatewayAccount[];
    loading: boolean;
    /** 手动刷新进行中（不阻塞已有列表展示）。 */
    refreshing: boolean;
    gatewayOffline: boolean;
    error?: string;
    refresh: () => Promise<void>;
};

/**
 * 豆包账号列表：打开即拉取 + 15s 轮询 + 手动刷新。
 * 账号在豆包工作站侧扫码登录后，轮询会让所有下拉选择器在数十秒内自动出现新账号。
 */
export function useDoubaoAccounts(): DoubaoAccountsState {
    const [accounts, setAccounts] = useState<DoubaoGatewayAccount[]>([]);
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [gatewayOffline, setGatewayOffline] = useState(false);
    const [error, setError] = useState<string | undefined>(undefined);
    const mountedRef = useRef(true);

    const refresh = useCallback(async () => {
        setRefreshing(true);
        try {
            const next = await fetchDoubaoAccounts();
            if (!mountedRef.current) return;
            setAccounts(next);
            setGatewayOffline(false);
            setError(undefined);
        } catch (cause) {
            if (!mountedRef.current) return;
            setGatewayOffline(cause instanceof DoubaoGatewayError && cause.statusCode === 0);
            setError(cause instanceof Error ? cause.message : String(cause));
        } finally {
            if (mountedRef.current) {
                setLoading(false);
                setRefreshing(false);
            }
        }
    }, []);

    useEffect(() => {
        mountedRef.current = true;
        void refresh();
        const timer = window.setInterval(() => void refresh(), POLL_INTERVAL_MS);
        return () => {
            mountedRef.current = false;
            window.clearInterval(timer);
        };
    }, [refresh]);

    return { accounts, loading, refreshing, gatewayOffline, error, refresh };
}

/** 账号健康状态的展示文案与颜色（antd Badge status）。 */
export function doubaoAccountStatusMeta(status: string): { label: string; color: string } {
    switch (status) {
        case "healthy":
            return { label: "在线", color: "#52c41a" };
        case "cooling":
            return { label: "冷却中", color: "#faad14" };
        case "quota_exhausted":
            return { label: "额度用尽", color: "#faad14" };
        case "captcha":
            return { label: "需人机验证", color: "#fa8c16" };
        case "logged_out":
            return { label: "未登录", color: "#ff4d4f" };
        default:
            return { label: status, color: "#8c8c8c" };
    }
}
