package app

import (
	"context"
	"sync"
	"testing"
	"time"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/platform"
	"infinite-canvas/backend/internal/repository"
	"infinite-canvas/backend/internal/taskruntime"
)

func TestStartWorkerRepeatedIsIdempotentAndRestartable(t *testing.T) {
	s, _ := retiredAgentProductService(t)
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = s.StopWorker(ctx)
	})

	s.StartWorker()
	s.StartWorker()
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			s.StartWorker()
			_ = s.taskWorker().runtime.StartLoop()
		}()
	}
	wg.Wait()
	if s.taskWorker().runtime.StartLoop() {
		t.Fatal("StartLoop should be idempotent while the shared worker is running")
	}

	stopCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	if err := s.StopWorker(stopCtx); err != nil {
		t.Fatal(err)
	}
	cancel()

	s.StartWorker()
	if s.taskWorker().runtime.StartLoop() {
		t.Fatal("StartLoop after Stop/StartWorker should already be running")
	}
	stopCtx, cancel = context.WithTimeout(context.Background(), 3*time.Second)
	if err := s.StopWorker(stopCtx); err != nil {
		t.Fatal(err)
	}
	cancel()
	if _, started := s.taskWorker().runtime.Start(); !started {
		t.Fatal("shared worker restart should start the dispatch loop again")
	}
}

func TestUnknownAcceptedRouteIsNotResubmittedAfterLeaseExpiry(t *testing.T) {
	s, db, hits := newLegacyAgentProbe(t)
	s.coordinator = platform.NewLocalCoordinator()
	s.workerID = "worker-unknown"
	past := time.Now().Add(-time.Minute)
	task := model.Task{
		ID:             "unknown-accepted",
		UserID:         "user",
		Type:           "canvas_text",
		Status:         model.TaskStatusRunning,
		Stage:          "调用生成模型",
		LeaseOwner:     "dead-worker",
		LeaseExpiresAt: &past,
		Attempts:       1,
		InputJSON:      `{"mode":"text","prompt":"不要重发","config":{"channelId":"channel","model":"text-test"}}`,
		CreatedAt:      time.Now().Add(-time.Minute),
		UpdatedAt:      time.Now().Add(-time.Minute),
	}
	attempt := model.RouteAttempt{
		ID:            "unknown-attempt",
		TaskID:        task.ID,
		AttemptNumber: 1,
		Status:        "dispatching",
		DispatchState: "submission_unknown",
		StartedAt:     time.Now().Add(-time.Minute),
	}
	if err := db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&attempt).Error; err != nil {
		t.Fatal(err)
	}

	err := s.ProcessNextTask()
	if err == nil || !isRouteDispatchUncertain(err) {
		t.Fatalf("expected route receipt fence, err=%v", err)
	}
	if hits.Load() != 0 {
		t.Fatalf("unknown accepted work submitted upstream %d times", hits.Load())
	}
	var attempts int64
	if err := db.Model(&model.RouteAttempt{}).Where("task_id = ?", task.ID).Count(&attempts).Error; err != nil {
		t.Fatal(err)
	}
	if attempts != 1 {
		t.Fatalf("created a new route attempt: %d", attempts)
	}
	stored, err := s.repo.Task(task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.Status != model.TaskStatusFailed {
		t.Fatalf("status=%s", stored.Status)
	}

	restarted := &Service{repo: repository.New(db), dataDir: s.dataDir, mode: serviceModeLocal, coordinator: platform.NewLocalCoordinator(), workerID: "restarted-worker"}
	if err := restarted.ProcessNextTask(); err != nil {
		t.Fatalf("restart claimed a terminal unknown task: %v", err)
	}
	if hits.Load() != 0 {
		t.Fatalf("restart submitted upstream %d times", hits.Load())
	}
	if err := db.Model(&model.RouteAttempt{}).Where("task_id = ?", task.ID).Count(&attempts).Error; err != nil {
		t.Fatal(err)
	}
	if attempts != 1 {
		t.Fatalf("restart created a new route attempt: %d", attempts)
	}
	if (taskruntime.Outcome{Kind: taskruntime.KindUncertain, ProviderAccepted: true}).Resubmittable() {
		t.Fatal("classification helper must not call unknown accepted work resubmittable")
	}
}
