import { useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "antd";
import { MemoryRouter } from "react-router";

import { AssetLibraryPickerModal } from "../../src/components/assets/asset-library-picker-modal";
import { setActiveUserScope } from "../../src/lib/user-scope";
import { assertUserScope, type CapturedUserScope } from "../../src/lib/user-scope-guard";
import { http } from "../../src/services/api/request";
import { useUserStore } from "../../src/stores/use-user-store";
import AssetsPage from "../../src/pages/assets/index";
import { saveLocalMedia } from "@/services/local-media-repository";

type HarnessWindow = Window & {
    __assetViewHarness?: {
        writes: string[];
        toasts: string[];
        switchABA: () => Promise<void>;
        seedLocalVideo: () => Promise<string>;
    };
};

const harnessWindow = window as HarnessWindow;

useUserStore.setState({
    hydrated: true,
    storageMode: "remote",
    user: {
        id: "owner-a",
        username: "remote-user",
        displayName: "账号 A",
        role: "user",
        status: "active",
    },
});
setActiveUserScope("owner-a");

const queryClient = new QueryClient({
    defaultOptions: {
        queries: { retry: false, refetchOnWindowFocus: false },
        mutations: { retry: false },
    },
});

function recordToast(node: Node) {
    const text = node.textContent?.trim();
    if (text) harnessWindow.__assetViewHarness!.toasts.push(text);
}

function watchToasts() {
    const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                if (!(node instanceof HTMLElement)) continue;
                if (node.classList.contains("ant-message-notice") || node.querySelector?.(".ant-message-notice")) {
                    recordToast(node);
                }
            }
        }
    });
    observer.observe(document.body, { childList: true, subtree: true });
}

async function switchABA() {
    await fetch("/harness/switch", { method: "POST" });
    setActiveUserScope("owner-b");
    setActiveUserScope("owner-a");
}

harnessWindow.__assetViewHarness = { writes: [], toasts: [], switchABA,
    seedLocalVideo: () => saveLocalMedia("video:owner-a:local-fixture", new Blob(["persisted-local-video"], { type: "video/mp4" })),
};

function Harness() {
    const { message } = App.useApp();
    const [pickerOpen, setPickerOpen] = useState(true);
    return (
        <>
            <div style={{ position: "fixed", top: 0, left: 0, zIndex: 11000, display: "flex", gap: 8, padding: 8 }}>
                <button type="button" onClick={() => void switchABA()}>switch-aba</button>
                <button type="button" onClick={() => setPickerOpen(true)}>open-picker</button>
            </div>
            <AssetsPage />
            <AssetLibraryPickerModal
                open={pickerOpen}
                remoteLibrary
                items={[]}
                mediaKinds={["image", "video", "audio", "text"]}
                categoryLabels={{ all: "全部素材", image: "图片" }}
                eyebrow="账号世代夹具"
                title="素材选择"
                confirmLabel={() => "确认选用"}
                emptyTitle="没有可引用的素材"
                emptyDescription="当前账号还没有素材。"
                onClose={() => setPickerOpen(false)}
                onConfirm={async (ids: string[], expectedScope: CapturedUserScope) => {
                    assertUserScope(expectedScope);
                    await http.post("/harness/confirm", { ids }, { expectedScope });
                    assertUserScope(expectedScope);
                    harnessWindow.__assetViewHarness!.writes.push("confirm");
                    message.success("已加入项目");
                }}
            />
        </>
    );
}

watchToasts();
createRoot(document.getElementById("root")!).render(
    <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/assets"]}>
            <App>
                <Harness />
            </App>
        </MemoryRouter>
    </QueryClientProvider>,
);
