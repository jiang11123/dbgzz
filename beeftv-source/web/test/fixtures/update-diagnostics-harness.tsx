import { createRoot } from "react-dom/client";
import { App, ConfigProvider, theme } from "antd";
import { WorkspaceSidebarUpdate } from "../../src/components/layout/workspace-sidebar-update";

const params = new URLSearchParams(location.search);
const dark = params.has("dark");
if (dark) document.documentElement.classList.add("dark");
Object.assign(window, { openedLogs: 0, exported: 0, go: { main: { DesktopApp: {
    OpenUpdateLogDirectory: async () => {
        if (params.has("open-fails")) throw new Error("fixture");
        (window as any).openedLogs++;
    },
} } } });
createRoot(document.getElementById("root")!).render(
    <ConfigProvider theme={{ algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm }}>
        <App><aside style={{ width: params.has("collapsed") ? 56 : 220, margin: 16 }}>
            <WorkspaceSidebarUpdate collapsed={params.has("collapsed")} />
        </aside></App>
    </ConfigProvider>,
);
