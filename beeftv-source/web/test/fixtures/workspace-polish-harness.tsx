import { useState } from "react";
import { createRoot } from "react-dom/client";
import { App, ConfigProvider, theme } from "antd";
import { AppChangelogDialog } from "@/components/layout/app-changelog-dialog";
import { ExpandableSearch } from "@/components/layout/expandable-search";
import "@/styles/workspace-product.css";

function Harness() {
    const [value, setValue] = useState("");
    const [dark, setDark] = useState(false);
    const [notesOpen, setNotesOpen] = useState(false);
    return <ConfigProvider theme={{ algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm }}><App>
        <main style={{ padding: 20, width: "100%", boxSizing: "border-box", background: dark ? "#141414" : "#fff" }}>
            <ExpandableSearch value={value} onChange={setValue} placeholder="搜索项目" />
            <output>{value}</output>
            <button onClick={() => setDark(!dark)}>切换主题</button>
            <button onClick={() => setNotesOpen(true)}>更新日志</button>
            <AppChangelogDialog open={notesOpen} onClose={() => setNotesOpen(false)} />
        </main>
    </App></ConfigProvider>;
}
createRoot(document.getElementById("root")!).render(<Harness />);
