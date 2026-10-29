package asset

import (
	"net/http"
	"strconv"

	"infinite-canvas/backend/internal/kernel"
)

func UploadInProgress() error {
	err := kernel.NewAppError(http.StatusConflict, "相同素材正在上传，请稍后重试")
	err.Retryable = true
	return err
}

func UploadQuotaAttributionUncertain() error {
	return kernel.NewAppError(http.StatusConflict, "旧上传记录无法确认用量，已暂停自动恢复。已有数据和用量记录已保留。")
}

func UploadConflict() error {
	return kernel.NewAppError(http.StatusConflict, "上传幂等标识已用于其他文件")
}

func MissingUpload() error {
	return kernel.BadAuthRequest("请选择要上传的文件")
}

func ResourceNotReady() error {
	return kernel.BadAuthRequest("资源尚未上传完成")
}

func ResourceNotLocal() error {
	return kernel.BadAuthRequest("资源不在本地存储中")
}

func ResourceMissing() error {
	return kernel.BadAuthRequest("资源不存在")
}

func UnreadableAssetDocument(kind string) error {
	switch kind {
	case "version":
		return kernel.BadAuthRequest("素材版本数据无法解析，已停止删除以避免误删文件")
	case "representation":
		return kernel.BadAuthRequest("素材表现数据无法解析，已停止删除以避免误删文件")
	default:
		return kernel.BadAuthRequest("素材数据无法解析，已停止删除以避免误删文件")
	}
}

func HistoryReferenced() error {
	return kernel.BadAuthRequest("素材仍被画布历史版本引用，已保留文件")
}

func StillReferenced() error {
	return kernel.BadAuthRequest("素材仍被引用，请先在对应画布、任务或业务记录中解除引用后再删除")
}

func TrashStatusConflict() error {
	return kernel.NewAppError(http.StatusConflict, "素材已不在回收站，未删除")
}

func RemoteImportForbidden() error {
	return kernel.Forbidden("本地工作区不支持通过 URL 导入素材，请先下载到本机后上传")
}

func UploadSessionMissing() error {
	return kernel.NotFound("上传会话不存在或已过期，请重新导入")
}

func UploadSessionBusy() error {
	return kernel.RateLimited("同时进行中的上传过多，请稍后重试")
}

func UploadSessionCompleting() error {
	err := kernel.NewAppError(http.StatusConflict, "上传正在完成，请稍候")
	err.Retryable = true
	return err
}

func UploadSessionRecoveryFailed() error {
	err := kernel.NewAppError(http.StatusServiceUnavailable, "上传会话恢复失败，请稍后重试")
	err.Retryable = true
	return err
}

func UploadSessionIncomplete() error {
	return kernel.BadAuthRequest("上传文件不完整，请重新导入")
}

func UploadChunkIndexInvalid() error {
	return kernel.BadAuthRequest("非法的分片序号")
}

func UploadChunkIncomplete(index int) error {
	return kernel.BadAuthRequest("分片 " + strconv.Itoa(index) + " 上传不完整，请重试")
}

func UploadChunkTooLarge(index int) error {
	return kernel.BadAuthRequest("分片 " + strconv.Itoa(index) + " 超过大小限制")
}
