/**
 * 豆包账号视频模型 id：doubao-gateway::doubao-video-account-2。
 * 工作站为每个豆包账号在「豆包账号」渠道里登记一个视频模型；豆包页面里的视频模型
 * （Seedance 2.5 / 2.0 …）是节点上的独立选项，不拆成多个模型。
 * 旧版本曾把页面模型编码进 id（doubao-video-account-2--seedance-2-0-mini），仍然认得。
 */
export function isDoubaoVideoModel(model: string | undefined): boolean {
    return /(?:^|::)doubao-video-account-\d+(?:--|$)/.test(model || "");
}

/** 豆包页面里的视频模型，与旧豆包节点保持一致。 */
export const DOUBAO_VIDEO_MODEL_OPTIONS = ["Seedance 2.5", "Seedance 2.0", "Seedance 2.0 Fast", "Seedance 2.0 Mini"] as const;
export const DEFAULT_DOUBAO_VIDEO_MODEL = DOUBAO_VIDEO_MODEL_OPTIONS[0];

/** 协议包 doubao-gateway-video 的 provider id；providerOptions 按它分命名空间。 */
export const DOUBAO_VIDEO_PROTOCOL = "doubao-gateway-video";

/** 节点保存的选择可能来自旧数据或被改坏，只接受已知的豆包视频模型。 */
export function normalizeDoubaoVideoModel(value: unknown): string {
    return typeof value === "string" && (DOUBAO_VIDEO_MODEL_OPTIONS as readonly string[]).includes(value) ? value : DEFAULT_DOUBAO_VIDEO_MODEL;
}

/**
 * 提交任务时附带的 provider 选项：协议把 providerOptions.doubao-gateway-video.video_model
 * 映射成网关的 video_model。不是豆包模型时不附带任何内容。
 */
export function doubaoVideoProviderOptions(model: string | undefined, chosen: unknown): { providerOptions?: Record<string, Record<string, string>> } {
    if (!isDoubaoVideoModel(model)) return {};
    return { providerOptions: { [DOUBAO_VIDEO_PROTOCOL]: { video_model: normalizeDoubaoVideoModel(chosen) } } };
}
