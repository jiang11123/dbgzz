import { useState } from "react";
import { createRoot } from "react-dom/client";
import { App, ConfigProvider, theme } from "antd";
import { createReferenceLinkResolver } from "../../src/components/generation-reference-links";

function Harness() {
    const { modal } = App.useApp();
    const [result, setResult] = useState("idle");
    const start = async () => {
        const resolver = createReferenceLinkResolver(modal);
        const refs = [{ key: "image:0", label: "参考图片 1", name: "角色参考图.png" }, { key: "video:0", label: "参考视频 1", name: "参考动作.mp4" }];
        const [first, second] = await Promise.all([resolver(refs), resolver(refs)]);
        setResult(first === second && first ? "confirmed" : "cancelled");
    };
    return <><button onClick={() => void start()}>生成</button><output>{result}</output></>;
}
const dark = new URLSearchParams(location.search).has("dark");
createRoot(document.getElementById("root")!).render(<ConfigProvider theme={{ algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm, token: { motion: false } }}><App><Harness /></App></ConfigProvider>);
