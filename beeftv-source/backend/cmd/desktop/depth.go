package main

import (
	"context"
	"errors"
	"time"

	"infinite-canvas/backend/internal/depthcapture"
)

// Three metadata sources can each consume six seconds before failing over.
const depthComponentCallTimeout = 25 * time.Second

func (a *DesktopApp) depthComponents() (*depthcapture.Service, error) {
	a.mu.RLock()
	defer a.mu.RUnlock()
	runtime := a.runtime()
	if runtime == nil || a.migrating || a.closing {
		return nil, errors.New("工作区正在关闭或迁移，请稍后重试")
	}
	return runtime.DepthComponents(), nil
}

func (a *DesktopApp) DepthComponentStatus(refresh bool) (depthcapture.ComponentState, error) {
	components, err := a.depthComponents()
	if err != nil {
		return depthcapture.ComponentState{}, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), depthComponentCallTimeout)
	defer cancel()
	return components.ComponentStatus(ctx, refresh)
}

func (a *DesktopApp) DownloadDepthComponents() (depthcapture.ComponentState, error) {
	components, err := a.depthComponents()
	if err != nil {
		return depthcapture.ComponentState{}, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), depthComponentCallTimeout)
	defer cancel()
	return components.StartComponentDownload(ctx)
}

func (a *DesktopApp) PauseDepthComponentDownload() (depthcapture.ComponentState, error) {
	components, err := a.depthComponents()
	if err != nil {
		return depthcapture.ComponentState{}, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), depthComponentCallTimeout)
	defer cancel()
	if err := components.PauseComponentDownload(ctx); err != nil {
		return depthcapture.ComponentState{}, err
	}
	return components.ComponentStatus(ctx)
}
