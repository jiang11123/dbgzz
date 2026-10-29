// Temporary advisory for the two verified WhatsToken routes. Native Ark,
// Fast and Mini retain their own contract.
export function seedanceTaskRetryWarning(inputJson?: string, model?: string) {
    try {
        const input = JSON.parse(inputJson || "{}");
        const p = input.videoParameters;
        if (!p?.affectedChannel) return undefined;
        return seedanceReferenceRatioWarning({ model: p.model || model || "", credentialRef: "beefapi-enterprise", videoCount: p.videoCount, ratio: p.size, operation: input.metadata?.videoEditOperation });
    } catch { return undefined; }
}

export function seedanceReferenceRatioWarning(input: { model: string; baseUrl?: string; credentialRef?: string; videoCount: number; ratio: string; operation?: string }) {
    if (!input.videoCount || !["seedance-2.0", "seedance-2.0-official2", "seedance-2.5", "seedance-2.5-official"].includes(input.model)) return undefined;
    if (["inpaint", "replace_element", "style_transfer", "extend"].includes(input.operation || "")) return undefined;
    if (!input.ratio || ["adaptive", "auto"].includes(input.ratio)) return undefined;
    let host = "";
    try { host = new URL(input.baseUrl || "").hostname.toLowerCase(); } catch { /* Managed credentials may not expose a URL. */ }
    if (input.credentialRef !== "beefapi-enterprise" && !["beeftv.app", "enterprise.beefapi.com", "whatstoken.ai", "www.whatstoken.ai"].includes(host)) return undefined;
    return {
        title: "输出比例可能与设置不一致",
        content: `当前模型带参考视频生成时，可能不会按设置的 ${input.ratio} 输出。继续生成仍会计费，比例不符不会自动退款。你也可以更换模型，或移除参考视频后再生成。`,
        okText: "接受风险并生成",
        cancelText: "返回调整",
    };
}
