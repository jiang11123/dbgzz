package depthcapture

import (
	"context"
	"errors"
	"fmt"
	"time"

	"infinite-canvas/backend/internal/depthruntime"
	"infinite-canvas/backend/internal/desktopstorage"
)

type ComponentState struct {
	Status          string `json:"status"`
	Variant         string `json:"variant"`
	DataDir         string `json:"dataDir"`
	DownloadBytes   int64  `json:"downloadBytes"`
	RequiredBytes   int64  `json:"requiredBytes"`
	FreeBytes       uint64 `json:"freeBytes"`
	DownloadedBytes int64  `json:"downloadedBytes"`
	Error           string `json:"error,omitempty"`
}

// ComponentStatus may fetch small release metadata, but never installs or runs a component.
func (s *Service) ComponentStatus(ctx context.Context, refresh ...bool) (ComponentState, error) {
	s.componentMu.Lock()
	if len(refresh) > 0 && refresh[0] && s.componentCancel == nil {
		s.componentState = ComponentState{}
	}
	state := s.componentState
	fallbackCPU := s.componentFallbackCPU
	s.componentMu.Unlock()
	if state.Status != "" {
		free, err := desktopstorage.FreeBytes(s.dataDir)
		if err != nil {
			return state, err
		}
		s.componentMu.Lock()
		s.componentState.FreeBytes = free
		state = s.componentState
		s.componentMu.Unlock()
		return state, nil
	}
	state = ComponentState{Status: "not_installed", DataDir: s.dataDir, Variant: "mps"}
	if !Supported(s.goos, s.goarch) {
		state.Status = "unsupported"
		state.Error = ErrUnsupportedOS.Error()
		return state, nil
	}
	if s.goos == "windows" {
		state.Variant = "cpu"
		if !fallbackCPU && s.nvidia(ctx) {
			state.Variant = "cuda"
		}
	}
	platform := PlatformID(s.goos)
	if _, err := depthruntime.Inspect(ctx, s.dataDir, platform, state.Variant); err == nil {
		state.Status = "ready"
	} else {
		options, err := s.componentOptions(platform, state.Variant)
		if err != nil {
			return state, err
		}
		plan, err := depthruntime.DownloadPlan(ctx, options)
		if err != nil {
			return state, err
		}
		state.DownloadBytes = plan.DownloadBytes
		state.RequiredBytes = plan.RequiredBytes
		state.FreeBytes = plan.FreeBytes
	}
	s.componentMu.Lock()
	defer s.componentMu.Unlock()
	if s.componentState.Status == "" {
		s.componentState = state
	}
	return s.componentState, nil
}

// A failed CUDA probe changes the next consent screen to the required CPU
// package. It must not silently download that additional package in a task.
func (s *Service) requireCPUComponents() {
	s.componentMu.Lock()
	defer s.componentMu.Unlock()
	s.componentFallbackCPU = true
	if s.componentCancel == nil {
		s.componentState = ComponentState{}
	}
}

// StartComponentDownload is called only by the user's download action. It owns
// one cancellable operation per workspace, independent of generation tasks.
func (s *Service) StartComponentDownload(ctx context.Context) (ComponentState, error) {
	state, err := s.ComponentStatus(ctx)
	if err != nil {
		return state, err
	}
	if state.Status == "unsupported" {
		return state, ErrUnsupportedOS
	}
	if state.Status == "ready" {
		return state, nil
	}
	options, err := s.componentOptions(PlatformID(s.goos), state.Variant)
	if err != nil {
		return state, err
	}
	options.ApprovedPlan = &depthruntime.Plan{DownloadBytes: state.DownloadBytes, RequiredBytes: state.RequiredBytes}
	s.componentMu.Lock()
	defer s.componentMu.Unlock()
	if s.componentClosed {
		return s.componentState, errors.New("工作区正在关闭，请稍后再下载")
	}
	if s.componentCancel != nil {
		return s.componentState, nil
	}
	downloadCtx, cancel := context.WithTimeout(context.Background(), 2*time.Hour)
	done := make(chan struct{})
	// A simultaneous metadata refresh may have invalidated the cached snapshot.
	// Preserve the exact plan this download was confirmed against.
	s.componentState = state
	s.componentCancel = cancel
	s.componentDone = done
	s.componentState.Status = "downloading"
	s.componentState.Error = ""
	s.componentState.DownloadedBytes = 0
	var component string
	var completed, previousTotal int64
	options.Progress = func(next string, progress depthruntime.Progress) {
		s.componentMu.Lock()
		defer s.componentMu.Unlock()
		if next == "extracting" {
			s.componentState.Status = "installing"
			return
		}
		if next != component {
			completed += previousTotal
			component = next
		}
		previousTotal = progress.Total
		s.componentState.Status = "downloading"
		s.componentState.DownloadedBytes = completed + progress.Downloaded
	}
	go func() {
		defer cancel()
		_, installErr := s.ensure(downloadCtx, options)
		s.componentMu.Lock()
		defer s.componentMu.Unlock()
		s.componentCancel = nil
		if installErr == nil {
			s.componentState.Status = "ready"
			s.componentState.DownloadedBytes = s.componentState.DownloadBytes
			s.componentState.Error = ""
		} else if downloadCtx.Err() != nil {
			s.componentState.Status = "paused"
			s.componentState.Error = "下载已暂停，已下载的文件会保留。点击继续下载即可续传。"
		} else if installErr != nil {
			s.componentState.Status = "error"
			s.componentState.Error = fmt.Sprintf("组件安装未完成：%v", installErr)
		}
		close(done)
	}()
	return s.componentState, nil
}

func (s *Service) PauseComponentDownload(ctx context.Context) error {
	s.componentMu.Lock()
	cancel, done := s.componentCancel, s.componentDone
	if cancel != nil {
		cancel()
	}
	s.componentMu.Unlock()
	if cancel == nil {
		return nil
	}
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (s *Service) CloseComponents(ctx context.Context) error {
	s.componentMu.Lock()
	s.componentClosed = true
	s.componentMu.Unlock()
	return s.PauseComponentDownload(ctx)
}
