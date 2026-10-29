package app

import (
	"context"
	"fmt"
)

func (s *Service) PrepareStorageMigration(ctx context.Context) (func(), error) {
	workers := s.backgroundWorkers()
	if !workers.PauseIfIdle() {
		return nil, fmt.Errorf("仍有 %d 个后台任务正在运行，请先在画布任务面板取消或等待完成，再迁移。当前目录未更改，项目和素材仍可使用", workers.ActiveTaskCount())
	}
	if err := s.depthCaptureRuntime().PauseComponentDownload(ctx); err != nil {
		workers.Resume()
		return nil, fmt.Errorf("组件下载尚未暂停，迁移未开始，当前工作区仍可使用。请稍后重试\n\n%w", err)
	}
	return workers.Resume, nil
}
