export type H3DirectorBeat = { offset: number; prompt?: string; end_image_url?: string; audio_url?: string };
export type H3DirectorConfig = {
    prompt: string;
    aspect_ratio?: "16:9" | "9:16" | "1:1";
    resolution?: "480p" | "768p" | "1080p";
    memory?: number;
    seed?: number;
    audio_bitrate?: 96000 | 128000 | 192000;
    image_url?: string;
    end_image_url?: string;
    audio_url?: string;
    script?: H3DirectorBeat[];
};
export type H3DirectorUpdate = { prompt?: string; end_image_url?: string; audio_url?: string; audio_behavior?: "replace" | "queue"; replan?: boolean; script?: H3DirectorBeat[]; script_mode?: "replace" | "append" };
export type H3DirectorPhase = "opening" | "configuring" | "live" | "stopping" | "closed" | "failed";

function prompt(value: string | undefined, required = false) {
    if (value === undefined && !required) return;
    if (typeof value !== "string" || !value.trim() || value.length > 50000) throw new Error("导演提示词须为 1–50000 字");
}
function mediaURL(value: string | undefined) {
    if (value === undefined) return;
    try {
        const url = new URL(value);
        if (url.protocol !== "https:" || url.username || url.password) throw new Error();
    } catch {
        throw new Error("导演参考素材须为 HTTPS 链接");
    }
}
function script(beats: H3DirectorBeat[] | undefined) {
    if (beats === undefined) return;
    if (!Array.isArray(beats) || beats.length < 1 || beats.length > 64) throw new Error("导演脚本须包含 1–64 段");
    let previous = -1,
        lastEnd = -3;
    for (const beat of beats) {
        if (!Number.isSafeInteger(beat.offset) || beat.offset < 0 || beat.offset <= previous) throw new Error("脚本时间须为递增的非负整数秒");
        previous = beat.offset;
        prompt(beat.prompt);
        mediaURL(beat.end_image_url);
        mediaURL(beat.audio_url);
        if (!beat.prompt && !beat.end_image_url && !beat.audio_url) throw new Error("每段脚本须包含提示词、画面或音频");
        if (beat.end_image_url) {
            if (beat.offset - lastEnd < 3) throw new Error("脚本终点画面须至少间隔 3 秒");
            lastEnd = beat.offset;
        }
    }
}

export function h3DirectorConfigure(config: H3DirectorConfig) {
    for (const key of Object.keys(config)) if (!["prompt", "aspect_ratio", "resolution", "memory", "seed", "audio_bitrate", "image_url", "end_image_url", "audio_url", "script"].includes(key)) throw new Error("导演初始化参数不受支持");
    prompt(config.prompt, true);
    mediaURL(config.image_url);
    mediaURL(config.end_image_url);
    mediaURL(config.audio_url);
    script(config.script);
    if (config.script && (config.end_image_url || config.audio_url)) throw new Error("脚本模式须把终点画面和音频放入脚本");
    if (config.memory !== undefined && (!Number.isInteger(config.memory) || config.memory < 1 || config.memory > 50)) throw new Error("导演记忆段数须为 1–50");
    if (config.seed !== undefined && !Number.isSafeInteger(config.seed)) throw new Error("随机种子须为整数");
    if (config.aspect_ratio !== undefined && !["16:9", "9:16", "1:1"].includes(config.aspect_ratio)) throw new Error("导演画面比例不受支持");
    if (config.resolution !== undefined && !["480p", "768p", "1080p"].includes(config.resolution)) throw new Error("导演分辨率不受支持");
    if (config.audio_bitrate !== undefined && ![96000, 128000, 192000].includes(config.audio_bitrate)) throw new Error("导演音频码率不受支持");
    return { type: "configure", protocol_version: 1, prompt_version: 1, aspect_ratio: "16:9", resolution: "768p", memory: 12, ...config };
}

export function validateH3DirectorUpdate(update: H3DirectorUpdate) {
    for (const key of Object.keys(update)) if (!["prompt", "end_image_url", "audio_url", "audio_behavior", "replan", "script", "script_mode"].includes(key)) throw new Error("导演更新参数不受支持");
    prompt(update.prompt);
    mediaURL(update.end_image_url);
    mediaURL(update.audio_url);
    script(update.script);
    if (update.script && (update.prompt || update.end_image_url || update.audio_url)) throw new Error("脚本更新不能同时发送提示词、画面或音频");
    if (!update.script && !update.prompt && !update.end_image_url && !update.audio_url) throw new Error("请填写导演指令或参考素材");
    if (update.replan !== undefined && typeof update.replan !== "boolean") throw new Error("重规划设置无效");
    if (update.audio_behavior !== undefined && !["replace", "queue"].includes(update.audio_behavior)) throw new Error("配音方式无效");
    if (update.script_mode !== undefined && !["replace", "append"].includes(update.script_mode)) throw new Error("脚本方式无效");
    return update;
}

// A session identity and version belong to one live connection. Reopening or
// replaying a paid operation is always a separate user action.
export class H3DirectorControl {
    phase: H3DirectorPhase = "opening";
    private version = 1;
    private configured = false;
    constructor(
        private readonly send: (message: object) => void,
        private readonly onPhase: (phase: H3DirectorPhase) => void = () => {},
    ) {}
    private setPhase(phase: H3DirectorPhase) {
        this.phase = phase;
        this.onPhase(phase);
    }
    configure(config: H3DirectorConfig) {
        if (this.phase !== "opening") throw new Error("当前导演会话已配置");
        const value = h3DirectorConfigure(config);
        this.setPhase("configuring");
        this.send(value);
    }
    accept(message: Record<string, unknown>) {
        if (this.phase === "closed" || this.phase === "failed") return;
        if (message.type === "configured" && message.prompt_version === 1 && this.phase === "configuring") {
            this.configured = true;
            this.setPhase("live");
        }
        if (message.type === "stream_exhausted") this.setPhase("closed");
        if (message.type === "error") this.setPhase("failed");
    }
    update(input: H3DirectorUpdate) {
        if (!this.configured || this.phase !== "live") throw new Error("请等待导演会话准备完成");
        const value = validateH3DirectorUpdate(input);
        if (this.version >= Number.MAX_SAFE_INTEGER) throw new Error("导演指令版本已耗尽");
        this.send({ type: "prompt", prompt_version: ++this.version, ...value });
    }
    stop() {
        if (["closed", "failed", "stopping"].includes(this.phase)) return;
        this.setPhase("stopping");
        this.send({ type: "stop" });
    }
    fail() {
        if (this.phase !== "closed") this.setPhase("failed");
    }
    close() {
        if (this.phase !== "failed") this.setPhase("closed");
    }
}
