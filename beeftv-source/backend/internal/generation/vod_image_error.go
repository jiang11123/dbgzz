package generation

import "strings"

var vodImageCopies = map[string]Failure{
	"capacity":        {Category: FailureCategory("concurrency"), Reason: "图片服务当前繁忙", Action: "请稍后再试", Uncertain: false},
	"rate":            {Category: FailureCategory("throttled"), Reason: "图片服务请求过于频繁", Action: "请稍后再试", Uncertain: false},
	"channel_auth":    {Category: FailureCategory("permission"), Reason: "当前图片服务未通过授权", Action: "请联系支持检查渠道权限后再试", Uncertain: false},
	"channel_config":  {Category: FailureCategory("permission"), Reason: "当前图片服务配置有误", Action: "请联系支持检查服务配置后再试", Uncertain: false},
	"input_missing":   {Category: FailureCategory("input_inaccessible"), Reason: "参考素材不存在或已无法访问", Action: "请检查并更换参考素材后重新生成", Uncertain: false},
	"invalid_params":  {Category: FailureCategory("invalid_params"), Reason: "图片生成参数不符合要求", Action: "请检查模型、尺寸、格式和数量后再试", Uncertain: false},
	"invalid_media":   {Category: FailureCategory("invalid_params"), Reason: "参考素材格式不受当前模型支持", Action: "请转换图片格式后更换参考素材", Uncertain: false},
	"duplicate":       {Category: FailureCategory("submission_uncertain"), Reason: "检测到已有相同的图片任务", Action: "请先查看原任务结果，不要重复提交", Uncertain: true},
	"create_unknown":  {Category: FailureCategory("submission_uncertain"), Reason: "尚未确认图片任务是否创建成功", Action: "请联系支持核对原任务，不要重复提交", Uncertain: true},
	"task_internal":   {Category: FailureCategory("async_failed"), Reason: "图片任务因模型服务内部错误而失败", Action: "请保留排查信息并联系支持核对结果，再决定是否重新生成", Uncertain: false},
	"task_failed":     {Category: FailureCategory("async_failed"), Reason: "模型未能完成这次图片生成", Action: "请保留排查信息并联系支持核对原因，再决定是否重新生成", Uncertain: false},
	"task_timeout":    {Category: FailureCategory("timeout"), Reason: "图片任务执行超时", Action: "请联系支持查询原任务结果，不要立即重新生成", Uncertain: true},
	"cancelled":       {Category: FailureCategory("cancelled"), Reason: "图片任务已取消", Action: "如仍需生成，请确认后重新提交", Uncertain: false},
	"query_failed":    {Category: FailureCategory("submission_uncertain"), Reason: "暂时无法查询图片任务结果", Action: "请稍后查看原任务，不要重复提交", Uncertain: true},
	"query_rejected":  {Category: FailureCategory("submission_uncertain"), Reason: "原图片任务查询被服务拒绝", Action: "请联系支持修复查询，不要重复提交", Uncertain: true},
	"query_missing":   {Category: FailureCategory("submission_uncertain"), Reason: "暂时无法找到原图片任务", Action: "请联系支持核对任务记录，不要重复提交", Uncertain: true},
	"query_auth":      {Category: FailureCategory("submission_uncertain"), Reason: "图片服务暂时无权查询原任务", Action: "请联系支持检查渠道权限并恢复查询，不要重复提交", Uncertain: true},
	"unknown":         {Category: FailureCategory("submission_uncertain"), Reason: "图片任务结果尚未确认", Action: "请先查看原任务或联系支持核对，不要重复提交", Uncertain: true},
	"partial":         {Category: FailureCategory("partial_success"), Reason: "部分图片已生成，任务未全部完成", Action: "请联系支持取回图片，再决定是否补做", Uncertain: true},
	"results_missing": {Category: FailureCategory("results_missing"), Reason: "图片任务已结束，但未返回可用图片", Action: "请联系支持核对原任务，不要重复提交", Uncertain: true},
	"download_failed": {Category: FailureCategory("download_failed"), Reason: "图片已生成，但下载失败", Action: "请联系支持取回原图片，不要重新生成", Uncertain: true},
	"request_large":   {Category: FailureCategory("input_too_large"), Reason: "图片请求的数据量超过服务上限", Action: "请减少参考素材或压缩图片后再试", Uncertain: false},
	"unsupported":     {Category: FailureCategory("model_missing"), Reason: "当前图片服务不支持这次请求", Action: "请联系支持检查模型、接口和地域设置", Uncertain: false},
	"response_large":  {Category: FailureCategory("submission_uncertain"), Reason: "图片服务返回的数据超过接口上限", Action: "请联系支持取回结果，不要重复提交", Uncertain: true},
	"source_busy":     {Category: FailureCategory("input_inaccessible"), Reason: "图片任务所需资源正在被占用", Action: "请确认参考素材可用后再试", Uncertain: false},
	"dry_run":         {Category: FailureCategory("invalid_params"), Reason: "本次为服务检查，未执行图片生成", Action: "请联系支持检查渠道配置后再试", Uncertain: false},
	"moderation":      {Category: FailureCategory("moderation_input"), Reason: "提示词或参考素材未通过内容安全审核", Action: "请调整提示词或参考素材后重新生成", Uncertain: false},
}

var vodImageStageCodes = map[string]map[string]string{
	"create": {
		"FailedOperation":                                   "create_unknown",
		"FailedOperation.InvalidVodUser":                    "channel_config",
		"InternalError":                                     "create_unknown",
		"InvalidParameter":                                  "invalid_params",
		"InvalidParameterValue.FileId":                      "input_missing",
		"InvalidParameterValue.SessionContextTooLong":       "channel_config",
		"InvalidParameterValue.SessionId":                   "duplicate",
		"InvalidParameterValue.SessionIdTooLong":            "channel_config",
		"InvalidParameterValue.SubAppId":                    "channel_config",
		"LimitExceeded.Quota":                               "capacity",
		"UnauthorizedOperation":                             "channel_auth",
		"ActionOffline":                                     "unsupported",
		"AuthFailure":                                       "channel_auth",
		"AuthFailure.InvalidAuthorization":                  "channel_auth",
		"AuthFailure.InvalidSecretId":                       "channel_auth",
		"AuthFailure.MFAFailure":                            "channel_auth",
		"AuthFailure.SecretIdNotFound":                      "channel_auth",
		"AuthFailure.SignatureExpire":                       "channel_auth",
		"AuthFailure.SignatureFailure":                      "channel_auth",
		"AuthFailure.TokenFailure":                          "channel_auth",
		"AuthFailure.UnauthorizedOperation":                 "channel_auth",
		"DryRunOperation":                                   "dry_run",
		"InvalidAction":                                     "unsupported",
		"InvalidParameterValue":                             "invalid_params",
		"InvalidRequest":                                    "invalid_params",
		"IpInBlacklist":                                     "channel_auth",
		"IpNotInWhitelist":                                  "channel_auth",
		"LimitExceeded":                                     "capacity",
		"MissingParameter":                                  "invalid_params",
		"NoSuchProduct":                                     "unsupported",
		"NoSuchVersion":                                     "unsupported",
		"RequestLimitExceeded":                              "rate",
		"RequestLimitExceeded.GlobalRegionUinLimitExceeded": "rate",
		"RequestLimitExceeded.IPLimitExceeded":              "rate",
		"RequestLimitExceeded.UinLimitExceeded":             "rate",
		"RequestSizeLimitExceeded":                          "request_large",
		"ResourceInUse":                                     "source_busy",
		"ResourceInsufficient":                              "capacity",
		"ResourceNotFound":                                  "input_missing",
		"ResourceUnavailable":                               "capacity",
		"ResponseSizeLimitExceeded":                         "response_large",
		"ServiceUnavailable":                                "capacity",
		"UnknownParameter":                                  "invalid_params",
		"UnsupportedOperation":                              "unsupported",
		"UnsupportedProtocol":                               "unsupported",
		"UnsupportedRegion":                                 "unsupported",
		"InvalidParameter.VoilationContent":                 "moderation",
		"InvalidParameter.ViolationContent":                 "moderation",
		"ContentModerationFailed":                           "moderation",
	},
	"task": {
		"RequestLimitExceeded":              "capacity",
		"InvalidParameter.VoilationContent": "moderation",
		"InvalidParameter.ViolationContent": "moderation",
		"InvalidParameterValue":             "invalid_params",
		"FailedOperation":                   "capacity",
		"InternalError":                     "task_internal",
		"InvalidParameter":                  "invalid_params",
		"InvalidParameter.MediaFormat":      "invalid_media",
		"ContentModerationFailed":           "moderation",
		"ResourceInsufficient":              "capacity",
		"ModelGenerateFailed":               "task_failed",
		"ResourceNotFound":                  "input_missing",
		"OperationCanceled":                 "cancelled",
		"TaskTimeout":                       "task_timeout",
	},
}

// VOD's creation and task codes have different meanings. Outer structured errors
// stay authoritative; saved messages are recognized only by our complete copy.
func genericVODCode(code string) bool {
	code = normalizeCode(code)
	return genericProviderCode(code) || code == "bad_response" || code == "bad_response_body"
}

func vodImageErrorCopy(code, text string) (Failure, bool) {
	if code == "access_denied" && strings.HasPrefix(text, "你的请求触发了上游内容安全策略，类别：内容安全") {
		copy := vodImageCopies["moderation"]
		copy.FromCode = true
		return copy, true
	}
	key := ""
	if strings.HasPrefix(code, "vod_image_") {
		key = strings.TrimPrefix(code, "vod_image_")
	}
	providerCode := code
	if _, ok := vodImageCopies[key]; !ok {
		key = ""
		for candidate, copy := range vodImageCopies {
			if strings.HasPrefix(text, copy.Reason+"。"+copy.Action+"。") && (genericVODCode(code) || code == string(copy.Category) || code == "image_result_unknown" && copy.Uncertain) {
				key = candidate
				break
			}
		}
	}
	if key == "" {
		if !genericVODCode(code) {
			return Failure{}, false
		}
		stage := "create"
		rest := strings.TrimSpace(text)
		if strings.HasPrefix(rest, "VOD image task failed [") {
			stage = "task"
			rest = strings.TrimPrefix(rest, "VOD image task failed [")
			value, _, ok := strings.Cut(rest, "]:")
			if !ok {
				return Failure{}, false
			}
			providerCode = value
		} else if strings.HasPrefix(rest, "VOD ") {
			value, _, ok := strings.Cut(strings.TrimPrefix(rest, "VOD "), ":")
			if !ok || strings.ContainsAny(value, " []") {
				return Failure{}, false
			}
			providerCode = value
		} else {
			return Failure{}, false
		}
		key = vodImageStageCodes[stage][providerCode]
		if stage == "task" && (providerCode == "" || providerCode == "ModelGenerateFailed") && (strings.Contains(strings.ToLower(text), "rejected by the safety system") || strings.Contains(strings.ToLower(text), "rejected as a result of our safety system") || strings.Contains(strings.ToLower(text), "rejected as a result of the safety system")) {
			key = "moderation"
		}
		if key == "" {
			if stage == "task" {
				key = "task_failed"
			} else {
				key = "create_unknown"
			}
		}
	}
	copy, ok := vodImageCopies[key]
	if !ok {
		return Failure{}, false
	}
	copy.ProviderCode = sanitizeProviderCode(providerCode)
	copy.Structured = true
	copy.FromCode = true
	return copy, true
}
