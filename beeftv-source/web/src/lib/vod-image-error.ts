import type { GenerationErrorCategory } from "./generation-error";

type VODCopy = { category: GenerationErrorCategory; reason: string; action: string; uncertain: boolean };
const copies: Record<string, VODCopy> = {
    capacity: { category: "concurrency", reason: "图片服务当前繁忙", action: "请稍后再试", uncertain: false },
    rate: { category: "throttled", reason: "图片服务请求过于频繁", action: "请稍后再试", uncertain: false },
    channel_auth: { category: "permission", reason: "当前图片服务未通过授权", action: "请联系支持检查渠道权限后再试", uncertain: false },
    channel_config: { category: "permission", reason: "当前图片服务配置有误", action: "请联系支持检查服务配置后再试", uncertain: false },
    input_missing: { category: "input_inaccessible", reason: "参考素材不存在或已无法访问", action: "请检查并更换参考素材后重新生成", uncertain: false },
    invalid_params: { category: "invalid_params", reason: "图片生成参数不符合要求", action: "请检查模型、尺寸、格式和数量后再试", uncertain: false },
    invalid_media: { category: "invalid_params", reason: "参考素材格式不受当前模型支持", action: "请转换图片格式后更换参考素材", uncertain: false },
    duplicate: { category: "submission_uncertain", reason: "检测到已有相同的图片任务", action: "请先查看原任务结果，不要重复提交", uncertain: true },
    create_unknown: { category: "submission_uncertain", reason: "尚未确认图片任务是否创建成功", action: "请联系支持核对原任务，不要重复提交", uncertain: true },
    task_internal: { category: "async_failed", reason: "图片任务因模型服务内部错误而失败", action: "请保留排查信息并联系支持核对结果，再决定是否重新生成", uncertain: false },
    task_failed: { category: "async_failed", reason: "模型未能完成这次图片生成", action: "请保留排查信息并联系支持核对原因，再决定是否重新生成", uncertain: false },
    task_timeout: { category: "timeout", reason: "图片任务执行超时", action: "请联系支持查询原任务结果，不要立即重新生成", uncertain: true },
    cancelled: { category: "cancelled", reason: "图片任务已取消", action: "如仍需生成，请确认后重新提交", uncertain: false },
    query_failed: { category: "submission_uncertain", reason: "暂时无法查询图片任务结果", action: "请稍后查看原任务，不要重复提交", uncertain: true },
    query_rejected: { category: "submission_uncertain", reason: "原图片任务查询被服务拒绝", action: "请联系支持修复查询，不要重复提交", uncertain: true },
    query_missing: { category: "submission_uncertain", reason: "暂时无法找到原图片任务", action: "请联系支持核对任务记录，不要重复提交", uncertain: true },
    query_auth: { category: "submission_uncertain", reason: "图片服务暂时无权查询原任务", action: "请联系支持检查渠道权限并恢复查询，不要重复提交", uncertain: true },
    unknown: { category: "submission_uncertain", reason: "图片任务结果尚未确认", action: "请先查看原任务或联系支持核对，不要重复提交", uncertain: true },
    partial: { category: "partial_success", reason: "部分图片已生成，任务未全部完成", action: "请联系支持取回图片，再决定是否补做", uncertain: true },
    results_missing: { category: "results_missing", reason: "图片任务已结束，但未返回可用图片", action: "请联系支持核对原任务，不要重复提交", uncertain: true },
    download_failed: { category: "download_failed", reason: "图片已生成，但下载失败", action: "请联系支持取回原图片，不要重新生成", uncertain: true },
    request_large: { category: "input_too_large", reason: "图片请求的数据量超过服务上限", action: "请减少参考素材或压缩图片后再试", uncertain: false },
    unsupported: { category: "model_missing", reason: "当前图片服务不支持这次请求", action: "请联系支持检查模型、接口和地域设置", uncertain: false },
    response_large: { category: "submission_uncertain", reason: "图片服务返回的数据超过接口上限", action: "请联系支持取回结果，不要重复提交", uncertain: true },
    source_busy: { category: "input_inaccessible", reason: "图片任务所需资源正在被占用", action: "请确认参考素材可用后再试", uncertain: false },
    dry_run: { category: "invalid_params", reason: "本次为服务检查，未执行图片生成", action: "请联系支持检查渠道配置后再试", uncertain: false },
    moderation: { category: "moderation_input", reason: "提示词或参考素材未通过内容安全审核", action: "请调整提示词或参考素材后重新生成", uncertain: false },
};
const codes: Record<string, Record<string, string>> = {
    "create": {
        "FailedOperation": "create_unknown",
        "FailedOperation.InvalidVodUser": "channel_config",
        "InternalError": "create_unknown",
        "InvalidParameter": "invalid_params",
        "InvalidParameterValue.FileId": "input_missing",
        "InvalidParameterValue.SessionContextTooLong": "channel_config",
        "InvalidParameterValue.SessionId": "duplicate",
        "InvalidParameterValue.SessionIdTooLong": "channel_config",
        "InvalidParameterValue.SubAppId": "channel_config",
        "LimitExceeded.Quota": "capacity",
        "UnauthorizedOperation": "channel_auth",
        "ActionOffline": "unsupported",
        "AuthFailure": "channel_auth",
        "AuthFailure.InvalidAuthorization": "channel_auth",
        "AuthFailure.InvalidSecretId": "channel_auth",
        "AuthFailure.MFAFailure": "channel_auth",
        "AuthFailure.SecretIdNotFound": "channel_auth",
        "AuthFailure.SignatureExpire": "channel_auth",
        "AuthFailure.SignatureFailure": "channel_auth",
        "AuthFailure.TokenFailure": "channel_auth",
        "AuthFailure.UnauthorizedOperation": "channel_auth",
        "DryRunOperation": "dry_run",
        "InvalidAction": "unsupported",
        "InvalidParameterValue": "invalid_params",
        "InvalidRequest": "invalid_params",
        "IpInBlacklist": "channel_auth",
        "IpNotInWhitelist": "channel_auth",
        "LimitExceeded": "capacity",
        "MissingParameter": "invalid_params",
        "NoSuchProduct": "unsupported",
        "NoSuchVersion": "unsupported",
        "RequestLimitExceeded": "rate",
        "RequestLimitExceeded.GlobalRegionUinLimitExceeded": "rate",
        "RequestLimitExceeded.IPLimitExceeded": "rate",
        "RequestLimitExceeded.UinLimitExceeded": "rate",
        "RequestSizeLimitExceeded": "request_large",
        "ResourceInUse": "source_busy",
        "ResourceInsufficient": "capacity",
        "ResourceNotFound": "input_missing",
        "ResourceUnavailable": "capacity",
        "ResponseSizeLimitExceeded": "response_large",
        "ServiceUnavailable": "capacity",
        "UnknownParameter": "invalid_params",
        "UnsupportedOperation": "unsupported",
        "UnsupportedProtocol": "unsupported",
        "UnsupportedRegion": "unsupported",
        "InvalidParameter.VoilationContent": "moderation",
        "InvalidParameter.ViolationContent": "moderation",
        "ContentModerationFailed": "moderation"
    },
    "task": {
        "RequestLimitExceeded": "capacity",
        "InvalidParameter.VoilationContent": "moderation",
        "InvalidParameter.ViolationContent": "moderation",
        "InvalidParameterValue": "invalid_params",
        "FailedOperation": "capacity",
        "InternalError": "task_internal",
        "InvalidParameter": "invalid_params",
        "InvalidParameter.MediaFormat": "invalid_media",
        "ContentModerationFailed": "moderation",
        "ResourceInsufficient": "capacity",
        "ModelGenerateFailed": "task_failed",
        "ResourceNotFound": "input_missing",
        "OperationCanceled": "cancelled",
        "TaskTimeout": "task_timeout"
    }
};

// The stage owns ambiguous VOD codes. Read only the error text supplied by the caller.
function genericVODCode(code: string) {
    const normalized = code.toLowerCase().trim().replace(/-/g, "_").replace(/\s+/g, "_");
    return ["", "unknown", "failed", "badrequest", "api_error", "upstream_error", "upstream_rejected", "invalid_request", "invalid_request_error", "invalid_parameter", "invalidparameter", "invalid_argument", "bad_response", "bad_response_body"].includes(normalized) || /^\d{3}$/.test(normalized);
}

export function vodImageErrorCopy(code: string, text: string): (VODCopy & { providerCode?: string; fromCode: boolean; retryable: boolean }) | undefined {
    if (code === "access_denied" && text.startsWith("你的请求触发了上游内容安全策略，类别：内容安全")) return { ...copies.moderation, fromCode: true, retryable: false };
    let key = code.startsWith("vod_image_") ? code.slice(10) : "";
    let providerCode = code;
    if (!Object.hasOwn(copies, key)) {
        for (const [candidate, copy] of Object.entries(copies)) {
            if (text.startsWith(copy.reason + "。" + copy.action + "。") && (genericVODCode(code) || code === copy.category || (code === "image_result_unknown" && copy.uncertain))) { key = candidate; break; }
        }
    }
    if (!Object.hasOwn(copies, key)) {
        const match = text.trim().match(/^VOD (?:(image task failed) \[([A-Za-z][A-Za-z0-9_.]*|)\]|([A-Za-z][A-Za-z0-9_.]*)):/);
        if (!match) return;
        // An authoritative outer error must never be overridden by nested text.
        if (!genericVODCode(code)) return;
        const stage = match[1] ? "task" : "create";
        providerCode = match[2] || match[3] || "";
        key = Object.hasOwn(codes[stage], providerCode) ? codes[stage][providerCode] : (stage === "task" ? "task_failed" : "create_unknown");
        if (stage === "task" && ["", "ModelGenerateFailed"].includes(providerCode) && /\brejected (?:by the|as a result of (?:our|the)) safety system\b/i.test(text)) key = "moderation";
    }
    const copy = Object.hasOwn(copies, key) ? copies[key] : undefined;
    if (!copy) return;
    return { ...copy, providerCode: providerCode || undefined, fromCode: true, retryable: false };
}

