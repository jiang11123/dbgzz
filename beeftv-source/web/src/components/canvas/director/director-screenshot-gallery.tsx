import { Image } from "antd";
import { useEffect, useState } from "react";

import { resolveImageUrl } from "@/services/image-storage";
import type { DirectorScreenshot } from "@/types/director";

export function DirectorScreenshotGallery({ screenshots, title = "相机截图", compact = false }: { screenshots: DirectorScreenshot[]; title?: string; compact?: boolean }) {
    return <section aria-label="相机截图" className={compact ? "space-y-2" : "space-y-2 border-t pt-3"} style={compact ? undefined : { borderColor: "var(--director-sequencer-border)" }}>
        <h3 className="text-sm font-medium">{title}</h3>
        {screenshots.length ? <div className="grid grid-cols-2 gap-2">{screenshots.map((screenshot) => <ScreenshotCard key={screenshot.id} screenshot={screenshot} compact={compact} />)}</div> : <p className="text-xs opacity-55">暂无截图</p>}
    </section>;
}

function ScreenshotCard({ screenshot, compact }: { screenshot: DirectorScreenshot; compact: boolean }) {
    const [url, setUrl] = useState(screenshot.url);
    useEffect(() => {
        let active = true;
        void resolveImageUrl(screenshot.storageKey, screenshot.url, { cacheMiss: true }).then((resolved) => { if (active) setUrl(resolved); }).catch(() => {});
        return () => { active = false; };
    }, [screenshot.storageKey, screenshot.url]);
    return <div className={compact ? "min-w-0 max-w-28 overflow-hidden" : "min-w-0 overflow-hidden rounded-lg border"} style={compact ? undefined : { borderColor: "var(--director-sequencer-border)" }}>
        <Image src={url} alt={screenshot.name} width="100%" className={compact ? "aspect-square rounded-lg object-cover" : "aspect-video object-cover"} preview={{ mask: "查看" }} />
        <span className={`block truncate py-1 text-xs ${compact ? "opacity-60" : "px-2"}`} title={screenshot.name}>{screenshot.name}</span>
    </div>;
}
