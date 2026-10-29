/**
 * 豆包账号图片模型 id：doubao-gateway::doubao-image-account-2。
 * 每个豆包账号登记一个图片模型；豆包页面里的图片模型（Seedream 4.5 / 4.0 / 3.0）
 * 是节点上的独立选项，不拆成多个模型。
 */
export function isDoubaoImageModel(model: string | undefined): boolean {
    return /(?:^|::)doubao-image-account-\d+$/.test(model || "");
}

/** 豆包页面里的图片模型，与旧豆包节点保持一致。 */
export const DOUBAO_IMAGE_MODEL_OPTIONS = ["Seedream 4.5", "Seedream 4.0", "Seedream 3.0"] as const;
export const DEFAULT_DOUBAO_IMAGE_MODEL = DOUBAO_IMAGE_MODEL_OPTIONS[0];

/** 协议包 doubao-gateway-image 的 provider id；providerOptions 按它分命名空间。 */
export const DOUBAO_IMAGE_PROTOCOL = "doubao-gateway-image";

/** 节点保存的选择可能来自旧数据或被改坏，只接受已知的豆包图片模型。 */
export function normalizeDoubaoImageModel(value: unknown): string {
    return typeof value === "string" && (DOUBAO_IMAGE_MODEL_OPTIONS as readonly string[]).includes(value) ? value : DEFAULT_DOUBAO_IMAGE_MODEL;
}

/**
 * 提交任务时附带的 provider 选项：协议把 providerOptions.doubao-gateway-image.image_model
 * 映射成网关的 image_model。不是豆包图片模型时不附带任何内容。
 */
export function doubaoImageProviderOptions(model: string | undefined, chosen: unknown): { providerOptions?: Record<string, Record<string, string>> } {
    if (!isDoubaoImageModel(model)) return {};
    return { providerOptions: { [DOUBAO_IMAGE_PROTOCOL]: { image_model: normalizeDoubaoImageModel(chosen) } } };
}
