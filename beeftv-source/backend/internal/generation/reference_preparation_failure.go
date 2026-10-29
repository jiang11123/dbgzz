package generation

import "strings"

var referencePreparationCopies = map[string]struct{ reason, action string }{
	"image_reference_upload_failed": {"参考图片上传失败，本次尚未开始生成", "请稍后重试"},
	"reference_media_upload_failed": {"参考素材上传失败，本次尚未开始生成", "请检查对象存储配置和公开读取权限后重试"},
	"reference_preupload_failed":    {"参考素材上传失败，本次尚未开始生成", "请检查网络或稍后重试"},
}

// Only the complete application-owned copy restores pre-submission evidence.
// A provider's upload error or a bare machine code does not prove it was unsent.
func persistedReferencePreparationFailure(raw string) (Failure, bool) {
	text := strings.TrimSpace(raw)
	requestID, taskID := persistedReferenceIDs(text)
	for code, copy := range referencePreparationCopies {
		failure := Failure{Category: CategoryProviderUnavailable, ProviderCode: code,
			Reason: copy.reason, Action: copy.action, RequestID: requestID, TaskID: taskID, FromCode: true}
		message := failure.UserMessage()
		if text == message || text == strings.TrimSuffix(message, "。") {
			return failure, true
		}
	}
	return Failure{}, false
}

// Manual retry is a deliberate new submission; preparation failures never
// authorize the automatic submission loop to send the same request again.
func (f Failure) BlocksManualRetry() bool {
	copy, ok := referencePreparationCopies[f.ProviderCode]
	if ok && !f.Uncertain && f.Category == CategoryProviderUnavailable && f.Reason == copy.reason && f.Action == copy.action {
		return false
	}
	return f.BlocksAutomaticRetry()
}
