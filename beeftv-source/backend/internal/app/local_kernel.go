package app

import (
	"context"
	"time"
)

// LocalKernel is the intentionally narrow desktop-facing surface of Service.
// Method values prevent interface reflection from retaining the full Service
// method set, while keeping that linker concern out of the composition root.
// Task list/create belong on the task domain; this kernel only exposes request
// limiting and worker lifecycle.
type LocalKernel struct {
	allowRequest      func(context.Context, string, int, time.Duration) (bool, error)
	requestRetryAfter func(context.Context, string, time.Duration) time.Duration
	startWorker       func()
	stopWorker        func(context.Context) error
	close             func() error
}

func NewLocalKernel(service *Service) *LocalKernel {
	return &LocalKernel{
		allowRequest:      service.AllowRequest,
		requestRetryAfter: service.RequestRetryAfter,
		startWorker:       service.StartWorker,
		stopWorker:        service.StopWorker,
		close:             service.Close,
	}
}

func (k *LocalKernel) AllowRequest(ctx context.Context, key string, limit int, window time.Duration) (bool, error) {
	return k.allowRequest(ctx, key, limit, window)
}

func (k *LocalKernel) RequestRetryAfter(ctx context.Context, key string, window time.Duration) time.Duration {
	return k.requestRetryAfter(ctx, key, window)
}

func (k *LocalKernel) StartWorker() { k.startWorker() }

func (k *LocalKernel) StopWorker(ctx context.Context) error { return k.stopWorker(ctx) }

func (k *LocalKernel) Close() error { return k.close() }
