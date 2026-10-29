import type { AgentToolCall, AssistantMediaFacts } from "@/services/api/agent-assistant";
import type { CanvasNodeData } from "@/types/canvas";

const seconds = (ms: number) => String(ms / 1000);
const range = ({ startMs, endMs }: { startMs: number; endMs: number }) => `${seconds(startMs)}–${seconds(endMs)} 秒`;
const labels: Record<AssistantMediaFacts["mode"], string> = { frames: "静态抽帧区间", video: "视频片段读取", audio: "音频片段读取", check: "客观检测" };

function wholeIntervalSilent(facts: AssistantMediaFacts) {
    if (!facts.hasAudio || facts.source.endMs <= facts.source.startMs) return false;
    let end = facts.source.startMs;
    for (const interval of [...(facts.silenceIntervals || [])].sort((a, b) => a.startMs - b.startMs)) {
        if (interval.startMs > end) return false;
        end = Math.max(end, interval.endMs);
    }
    return end >= facts.source.endMs;
}

export function CanvasAssistantMediaFacts({ calls, nodes = [] }: { calls: AgentToolCall[]; nodes?: CanvasNodeData[] }) {
    const groups = new Map<string, AssistantMediaFacts[]>();
    for (const call of calls) {
        if (call.isError !== false || !["media.overview", "media.inspect", "media.check"].includes(call.tool)) continue;
        for (const facts of call.mediaEvidence ?? (call.mediaFacts ? [call.mediaFacts] : [])) {
            const key = JSON.stringify([facts.source.resourceId, facts.source.version]);
            let group = groups.get(key);
            if (!group) {
                group = [];
                groups.set(key, group);
            }
            if (!group.some(item => JSON.stringify(item) === JSON.stringify(facts))) group.push(facts);
        }
    }
    if (!groups.size) return null;
    return <div className="canvas-assistant-card" aria-label="媒体检查记录">
        <strong>媒体检查记录</strong>
        <span className="canvas-assistant-meta">记录实际读取的片段和检测结果，不代表质量已通过。</span>
        {[...groups].map(([key, group], groupIndex) => {
            const title = nodes.find(node => node.id === group[0].source.nodeId)?.title;
            return <div key={key} data-media-fact-group={key}>
                <strong>{title ? `${title} · ` : ""}检查记录 {groupIndex + 1}</strong>
                {group.map((facts, index) => <div key={index} className="canvas-assistant-meta">
                    <div>{labels[facts.mode]}：{range(facts.source)} · 全长 {seconds(facts.durationMs)} 秒</div>
                    {facts.mode === "check" ? <>
                        {!facts.hasAudio ? <div>没有音轨</div> : wholeIntervalSilent(facts) ? <div>该检测区间全段静音</div>
                            : facts.silenceIntervals?.length ? <div>静音区间：{facts.silenceIntervals.map(range).join("、")}</div> : null}
                        {facts.meanDb !== undefined ? <div>平均音量：{facts.meanDb} dB</div> : null}
                        {facts.peakDb !== undefined ? <div>峰值音量：{facts.peakDb} dB</div> : null}
                    </> : null}
                </div>)}
            </div>;
        })}
    </div>;
}
