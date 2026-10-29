export function parseSpeechAudioEvents(text: string): { url?: string; chunks: ArrayBuffer[] } {
    const chunks: ArrayBuffer[] = [];
    let done = false;
    let url: string | undefined;
    for (const frame of text.split(/\r?\n\r?\n/)) {
        const raw = frame.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n").trim();
        if (!raw || raw === "[DONE]") continue;
        const event = JSON.parse(raw) as { type?: string; audio?: string; audio_url?: string; error?: unknown };
        if (event.error || event.type === "error") throw new Error("音乐生成失败，请查看任务详情");
        if (event.type === "speech.audio.delta") {
            if (done || typeof event.audio !== "string") throw new Error("音频事件无效");
            const decoded = atob(event.audio);
            chunks.push(Uint8Array.from(decoded, (char) => char.charCodeAt(0)).buffer);
        }
        if (event.type === "speech.audio.done") {
            if (done) throw new Error("收到重复的音频完成事件");
            done = true;
            if (event.audio_url !== undefined) {
                if (typeof event.audio_url !== "string") throw new Error("音频结果地址无效");
                const parsed = new URL(event.audio_url);
                if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || chunks.length) throw new Error("音频结果地址无效");
                url = event.audio_url;
            }
        }
    }
    if (!done) throw new Error("音乐生成连接中断，未收到完成结果；请先检查原任务，避免重复付费");
    if (!url && !chunks.some((chunk) => chunk.byteLength)) throw new Error("音乐生成结果为空");
    return { url, chunks };
}
