package kernel

import (
	"errors"
	"strings"
	"syscall"
)

// DiskFullError is used only at local storage boundaries, never on provider bodies.
func DiskFullError(cause error) *AppError {
	if cause == nil {
		return nil
	}
	text := strings.ToLower(cause.Error())
	if !errors.Is(cause, syscall.ENOSPC) && !strings.Contains(text, "no space left on device") && !strings.Contains(text, "not enough space on the disk") && !strings.Contains(text, "database or disk is full") && !strings.Contains(text, "the disk is full") {
		return nil
	}
	return &AppError{Status: 500, Code: 500, Reason: "local_disk_full", Message: "本地磁盘空间不足，无法保存数据。请清理 BeefTV 数据目录所在磁盘；已有生成结果请优先取回原任务，不要重复生成", Cause: cause}
}
