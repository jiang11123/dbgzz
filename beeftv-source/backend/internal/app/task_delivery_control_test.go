package app

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"gorm.io/gorm"
	"infinite-canvas/backend/internal/diagnostics"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/supporttrace"
)

func TestGenerationDownloadCanPauseAndResumeWithoutRegenerating(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	var calls atomic.Int32
	started := make(chan struct{}, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if calls.Add(1) == 1 {
			w.Header().Set("Content-Length", "100")
			w.WriteHeader(200)
			_, _ = w.Write([]byte("partial"))
			w.(http.Flusher).Flush()
			started <- struct{}{}
			<-r.Context().Done()
			return
		}
		w.Header().Set("Content-Type", "image/png")
		image, _ := base64.StdEncoding.DecodeString(strings.SplitN(tinyPNGDataURL, ",", 2)[1])
		_, _ = w.Write(image)
	}))
	defer server.Close()
	svc, db := newGenerationDeliveryMediaService(t, filepath.Join(t.TempDir(), "delivery.db"), t.TempDir())
	defer closeDB(t, db)
	task := seedSucceededTaskAt(t, db, "pause", fmt.Sprintf(`{"images":[{"url":%q}]}`, server.URL+"/image.png"), time.Now())
	done := make(chan error, 1)
	go func() { done <- svc.DeliverSucceededTask(task) }()
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("download did not start")
	}
	if _, err := svc.CancelTask(context.Background(), "other", task.ID); err == nil {
		t.Fatal("foreign cancellation allowed")
	}
	paused, err := svc.CancelTask(context.Background(), task.UserID, task.ID)
	if err != nil || paused.Status != model.TaskStatusSucceeded || paused.Stage != "delivery_paused" {
		t.Fatalf("pause: %+v %v", paused, err)
	}
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("cancel error: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("download not cancelled")
	}
	if err := svc.RecoverIncompleteGenerationDeliveries(64); err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 1 {
		t.Fatal("recovery restarted paused download")
	}
	got, err := svc.Task(task.UserID, task.ID)
	if err != nil || len(got.Outputs) != 1 || got.Outputs[0].MaterializationErrorCode != "delivery_paused" {
		t.Fatalf("projection: %+v %v", got, err)
	}
	// A fresh Service sees the persisted pause too.
	restarted := NewLocal(svc.repo, svc.dataDir)
	if err := restarted.RecoverIncompleteGenerationDeliveries(64); err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 1 {
		t.Fatal("restart lost pause")
	}
	resumed, err := svc.RetryTask(task.UserID, task.ID)
	if err != nil || resumed.Status != model.TaskStatusSucceeded {
		t.Fatalf("resume changed generation state: %+v %v", resumed, err)
	}
	if err := svc.RecoverIncompleteGenerationDeliveries(64); err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 2 {
		t.Fatalf("download calls: %d", calls.Load())
	}
	got, err = svc.Task(task.UserID, task.ID)
	if err != nil || got.Stage != "生成完成" {
		t.Fatalf("resumed delivery kept a downloading stage: %+v %v", got, err)
	}
	var count int64
	db.Model(&model.Task{}).Count(&count)
	if count != 1 {
		t.Fatalf("retry created generation task: %d", count)
	}
}

func TestGenerationDownloadCompletedProjectionClearsStaleStage(t *testing.T) {
	for _, stage := range []string{"正在取回结果", "delivery_paused", "delivery_timed_out", "任务完成"} {
		t.Run(stage, func(t *testing.T) {
			svc, db := newGenerationDeliveryMediaService(t, filepath.Join(t.TempDir(), "delivery.db"), t.TempDir())
			defer closeDB(t, db)
			task := seedSucceededImageTask(t, db, "completed", "{}")
			if err := db.Create(&model.Resource{ID: "res-shared", UserID: task.UserID, Kind: "image", Status: model.ResourceStatusReady, MimeType: "image/png"}).Error; err != nil {
				t.Fatal(err)
			}
			if err := svc.DeliverSucceededTask(task); err != nil {
				t.Fatal(err)
			}
			if err := svc.repo.SetGenerationDeliveryStage(task.UserID, task.ID, stage); err != nil {
				t.Fatal(err)
			}
			task.Stage = stage
			want := "生成完成"
			if stage == "任务完成" {
				want = stage
			}
			got, err := svc.Task(task.UserID, task.ID)
			if err != nil || got.Stage != want || got.ResultState != "READY" {
				t.Fatalf("completed detail: %+v %v", got, err)
			}
			summaries := (taskPresenterAdapter{s: svc}).Summaries([]model.Task{task})
			if len(summaries) != 1 || summaries[0].Stage != want || summaries[0].ResultState != "READY" {
				t.Fatalf("completed summary: %+v", summaries)
			}
			stored, err := svc.repo.Task(task.ID)
			if err != nil || stored.Stage != stage {
				t.Fatalf("projection changed stored task: %+v %v", stored, err)
			}
		})
	}
}

func TestGenerationDownloadDeadlinePausesAndCloseCancels(t *testing.T) {
	for _, action := range []string{"deadline", "close", "drain"} {
		t.Run(action, func(t *testing.T) {
			svc, db := newGenerationDeliveryMediaService(t, filepath.Join(t.TempDir(), "delivery.db"), t.TempDir())
			defer closeDB(t, db)
			task := seedSucceededTaskAt(t, db, action, `{"images":[{"url":"https://example.com/image.png"}]}`, time.Now())
			timeout := time.Minute
			if action == "deadline" {
				timeout = time.Millisecond
			}
			ctx, finish, err := svc.beginGenerationDownload(task.UserID, task.ID+":0", timeout)
			if err != nil {
				t.Fatal(err)
			}
			switch action {
			case "close":
				_ = svc.Close()
			case "drain":
				svc.BeginDrain()
			}
			select {
			case <-ctx.Done():
			case <-time.After(time.Second):
				t.Fatal("context remained active")
			}
			finish(ctx.Err())
			got, err := svc.repo.Task(task.ID)
			if err != nil {
				t.Fatal(err)
			}
			if action == "deadline" && got.Stage != "delivery_timed_out" {
				t.Fatalf("deadline not persisted: %+v", got)
			}
			if action != "deadline" && deliveryPaused(got.Stage) {
				t.Fatal("shutdown must allow recovery next launch")
			}
		})
	}
}

func TestGenerationDownloadCompletionWinsConcurrentPause(t *testing.T) {
	svc, db := newGenerationDeliveryMediaService(t, filepath.Join(t.TempDir(), "delivery.db"), t.TempDir())
	defer closeDB(t, db)
	task := seedSucceededImageTask(t, db, "already-downloaded", "{}")
	if err := db.Create(&model.Resource{ID: "res-shared", UserID: task.UserID, Kind: "image", Status: model.ResourceStatusReady, MimeType: "image/png"}).Error; err != nil {
		t.Fatal(err)
	}
	if _, err := svc.CancelTask(context.Background(), task.UserID, task.ID); err != nil {
		t.Fatal(err)
	}
	// A delivery that read the task before cancellation has already downloaded
	// its bytes and commits its local resource after the stop request.
	if err := svc.DeliverSucceededTask(task); err != nil {
		t.Fatal(err)
	}
	got, err := svc.Task(task.UserID, task.ID)
	if err != nil || deliveryPaused(got.Stage) || got.Outputs[0].MaterializedAssetID == "" {
		t.Fatalf("completed task kept a pause: %+v %v", got, err)
	}
}

func TestGenerationDownloadRecoveryDoesNotResetDeadline(t *testing.T) {
	svc, db := newGenerationDeliveryMediaService(t, filepath.Join(t.TempDir(), "delivery.db"), t.TempDir())
	defer closeDB(t, db)
	task := seedSucceededTaskAt(t, db, "deadline-recovery", `{"images":[{"url":"https://example.com/image.png"}]}`, time.Now())
	ctx, finish, err := svc.beginGenerationDownload(task.UserID, task.ID+":0", time.Millisecond)
	if err != nil {
		t.Fatal(err)
	}
	deadline, _ := ctx.Deadline()
	finish(context.Canceled)
	next, finishNext, err := svc.beginGenerationDownload(task.UserID, task.ID+":0", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	defer finishNext(context.Canceled)
	nextDeadline, _ := next.Deadline()
	if !nextDeadline.Equal(deadline) {
		t.Fatal("background retry extended total download budget")
	}
	select {
	case <-next.Done():
	case <-time.After(time.Second):
		t.Fatal("recovery ignored original deadline")
	}
}

func TestGenerationDownloadAllowedAfterWorkerRestart(t *testing.T) {
	svc, db := newGenerationDeliveryMediaService(t, filepath.Join(t.TempDir(), "delivery.db"), t.TempDir())
	defer closeDB(t, db)
	svc.StartWorker()
	if err := svc.StopWorker(context.Background()); err != nil {
		t.Fatal(err)
	}
	svc.StartWorker()
	defer svc.StopWorker(context.Background())
	task := seedSucceededTaskAt(t, db, "restart-download", `{}`, time.Now())
	ctx, finish, err := svc.beginGenerationDownload(task.UserID, task.ID+":0", time.Minute)
	if err != nil {
		t.Fatalf("worker restarted but download remained disabled: %v", err)
	}
	defer finish(context.Canceled)
	if ctx.Err() != nil {
		t.Fatalf("restarted context: %v", ctx.Err())
	}
}

func TestDownloadShutdownDoesNotWaitForDiagnosticCheckpoint(t *testing.T) {
	svc, db := newGenerationDeliveryMediaService(t, filepath.Join(t.TempDir(), "delivery.db"), t.TempDir())
	defer closeDB(t, db)
	task := seedSucceededTaskAt(t, db, "diagnostic-stall", `{}`, time.Now())
	entered, release, queried := make(chan struct{}), make(chan struct{}), make(chan struct{})
	var releaseOnce, queryOnce sync.Once
	unblock := func() { releaseOnce.Do(func() { close(release) }) }
	defer unblock()
	go svc.supportTraceOnce.Do(func() { close(entered); <-release })
	<-entered
	if err := db.Callback().Query().After("gorm:query").Register("test:diagnostic-checkpoint-task-read", func(tx *gorm.DB) {
		if tx.Statement.Table == "tasks" {
			queryOnce.Do(func() { close(queried) })
		}
	}); err != nil {
		t.Fatal(err)
	}
	defer db.Callback().Query().Remove("test:diagnostic-checkpoint-task-read")
	started := make(chan error, 1)
	go func() {
		_, finish, err := svc.beginGenerationDownload(task.UserID, task.ID+":0", time.Minute)
		if finish != nil {
			finish(context.Canceled)
		}
		started <- err
	}()
	<-queried
	stopped := make(chan struct{})
	go func() { svc.stopGenerationDownloads(); close(stopped) }()
	select {
	case <-stopped:
	case <-time.After(time.Second):
		t.Error("shutdown waited for diagnostic storage")
	}
	unblock()
	if err := <-started; !errors.Is(err, context.Canceled) {
		t.Fatalf("download admitted after shutdown: %v", err)
	}
}

func TestRefusedDownloadAdmissionIsNotFailureOrRecoveryInActualBundle(t *testing.T) {
	svc, db := newGenerationDeliveryMediaService(t, filepath.Join(t.TempDir(), "delivery.db"), t.TempDir())
	defer closeDB(t, db)
	defer svc.closeSupportTrace()
	task := seedSucceededTaskAt(t, db, "admission-stopped", `{}`, time.Now())
	_, finish := svc.SupportTrace().Start(context.Background(), "generation.download", supporttrace.Fields{UserID: task.UserID, TaskID: task.ID})
	finish("upstream_download_failed")
	var queries atomic.Int32
	if err := db.Callback().Query().After("gorm:query").Register("test:stop-admission-after-checkpoint", func(tx *gorm.DB) {
		if tx.Statement.Table == "tasks" && queries.Add(1) == 2 {
			svc.deliveryClosed = true
		}
	}); err != nil {
		t.Fatal(err)
	}
	defer db.Callback().Query().Remove("test:stop-admission-after-checkpoint")
	if _, _, err := svc.beginGenerationDownload(task.UserID, task.ID+":0", time.Minute); !errors.Is(err, context.Canceled) {
		t.Fatalf("admitted after shutdown: %v", err)
	}
	bundle, err := svc.ExportDiagnosticBundle(task.UserID, DiagnosticExportRequest{TaskID: task.ID})
	if err != nil {
		t.Fatal(err)
	}
	findings, err := diagnostics.AnalyzeBundle(bundle.Data)
	if err != nil {
		t.Fatal(err)
	}
	confirmed, stopped := 0, false
	for _, finding := range findings {
		if finding.Stage == "result_download" && finding.Status == "confirmed" {
			confirmed++
			if finding.Reason != "upstream_download_failed" {
				t.Fatalf("refused admission became failure: %+v", finding)
			}
		}
		if finding.Reason == "download_not_started" && finding.Status == "inconclusive" {
			stopped = true
		}
	}
	if confirmed != 1 || !stopped {
		t.Fatalf("original failure lost or admission misreported: %+v", findings)
	}
}

func TestGenerationDownloadCompletionBetweenPauseReadAndWriteWins(t *testing.T) {
	svc, db := newGenerationDeliveryMediaService(t, filepath.Join(t.TempDir(), "delivery.db"), t.TempDir())
	defer closeDB(t, db)
	task := seedSucceededImageTask(t, db, "complete-before-pause-write", "{}")
	if err := db.Create(&model.Resource{ID: "res-shared", UserID: task.UserID, Kind: "image", Status: model.ResourceStatusReady, MimeType: "image/png"}).Error; err != nil {
		t.Fatal(err)
	}
	var completed atomic.Bool
	if err := db.Callback().Query().After("gorm:query").Register("test:complete-before-pause-write", func(tx *gorm.DB) {
		if tx.Statement.Table == "results" && completed.CompareAndSwap(false, true) {
			if err := svc.DeliverSucceededTask(task); err != nil {
				t.Errorf("concurrent completion: %v", err)
			}
		}
	}); err != nil {
		t.Fatal(err)
	}
	defer db.Callback().Query().Remove("test:complete-before-pause-write")
	if _, err := svc.CancelTask(context.Background(), task.UserID, task.ID); err != nil {
		t.Fatal(err)
	}
	got, err := svc.Task(task.UserID, task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !completed.Load() || deliveryPaused(got.Stage) || got.Outputs[0].MaterializedAssetID == "" {
		t.Fatalf("completion lost to stale pause: %+v", got)
	}
}

func TestPausedGenerationDownloadRetryDuringDrainReturns503(t *testing.T) {
	svc, db := newGenerationDeliveryMediaService(t, filepath.Join(t.TempDir(), "delivery.db"), t.TempDir())
	defer closeDB(t, db)
	task := seedSucceededTaskAt(t, db, "paused-drain", `{"images":[{"url":"https://example.com/image.png"}]}`, time.Now())
	if _, err := svc.CancelTask(context.Background(), task.UserID, task.ID); err != nil {
		t.Fatal(err)
	}
	svc.BeginDrain()
	if _, err := svc.RetryTask(task.UserID, task.ID); !isAppErrorStatus(err, 503) {
		t.Fatalf("resume during drain: %v", err)
	}
}
