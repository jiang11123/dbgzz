package repository

import (
	"context"
	"infinite-canvas/backend/internal/model"
	"time"
)

// Called only after acquiring the desktop workspace lock, before workers start.
// Interrupted local inference is resumable by an explicit retry, never at startup.
func (r *Repository) PauseDepthCapturesAfterRestart(ctx context.Context) error {
	now := time.Now()
	return r.db.WithContext(ctx).Model(&model.Task{}).
		Where("type = ? AND status IN ?", model.TaskTypeDepthCapture, []model.TaskStatus{model.TaskStatusQueued, model.TaskStatusRunning}).
		Updates(map[string]any{"status": model.TaskStatusFailed, "stage": "已暂停，等待手动继续", "error": "应用已重新启动，深度捕捉已暂停。请确认组件已安装，再点击重试继续。", "lease_owner": "", "lease_expires_at": nil, "next_poll_at": nil, "completed_at": now, "updated_at": now}).Error
}
