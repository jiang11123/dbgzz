package app

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync/atomic"
	"testing"
	"time"

	"infinite-canvas/backend/internal/generation"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/outbound"
)

// In-generation result downloads report under the executing BeefTV task, so one
// projection covers both phases.
func TestTaskDeliveryPortRecordsUnderTaskIdentityAndClears(t *testing.T) {
	svc := &Service{}
	port := appTaskDeliveryPort{service: svc, taskID: "task-9"}

	port.ReportDelivery(outbound.ResumableProgress{DownloadedBytes: 512, TotalBytes: 2048, BytesPerSecond: 100, Attempt: 1, State: "downloading"})
	got := svc.deliveryProgressRegistry().forTask("task-9")
	if got == nil || len(got.Outputs) != 1 {
		t.Fatalf("progress not projected: %#v", got)
	}
	output := got.Outputs[0]
	if output.UpdatedAt <= 0 {
		t.Fatal("download snapshot has no sampling timestamp")
	}
	if output.OutputIndex != 0 || output.DownloadedBytes != 512 || output.TotalBytes != 2048 || output.State != "downloading" {
		t.Fatalf("unexpected projection: %+v", output)
	}

	port.ReportDelivery(outbound.ResumableProgress{TotalBytes: -1, Attempt: 2, State: "waiting"})
	if got := svc.deliveryProgressRegistry().forTask("task-9"); got == nil || got.Outputs[0].State != "waiting" {
		t.Fatalf("waiting report did not replace the entry: %+v", got)
	}
	if other := svc.deliveryProgressRegistry().forTask("task-10"); other != nil {
		t.Fatalf("progress leaked into another task: %+v", other)
	}

	port.ClearDelivery()
	if got := svc.deliveryProgressRegistry().forTask("task-9"); got != nil {
		t.Fatalf("progress not cleared: %+v", got)
	}
}

// Exercise the real provider submit/poll/content path and the task API's
// projection together, with different provider and workspace identities.
func TestVideoDeliveryStreamIsVisibleOnWorkspaceTask(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	svc, db := openDBRuntimeMatrix(t, t.TempDir())
	defer closeDBRuntimeMatrix(t, svc, db)
	const taskID = "workspace-video"
	const providerID = "provider-video"
	now := time.Now()
	expires := now.Add(time.Minute)
	task := model.Task{ID: taskID, UserID: "local", Type: "canvas_video", Status: model.TaskStatusRunning, Stage: "正在取回生成结果", LeaseOwner: "delivery-fixture", LeaseExpiresAt: &expires, CreatedAt: now, UpdatedAt: now}
	if err := db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	body := bytes.Repeat([]byte("v"), 20*(32<<10))
	var creates, downloads atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method + " " + r.URL.Path {
		case "POST /v1/videos":
			creates.Add(1)
			_, _ = fmt.Fprintf(w, `{"id":%q}`, providerID)
		case "GET /v1/videos/" + providerID:
			_, _ = w.Write([]byte(`{"status":"completed"}`))
		case "GET /v1/videos/" + providerID + "/content":
			if downloads.Add(1) <= 2 {
				w.Header().Set("Retry-After", "5")
				http.Error(w, `{"error":{"code":"video_delivery_pending"}}`, http.StatusServiceUnavailable)
				return
			}
			w.Header().Set("Content-Type", "video/mp4")
			w.Header().Set("Content-Length", strconv.Itoa(len(body)))
			for offset := 0; offset < len(body); offset += 32 << 10 {
				_, _ = w.Write(body[offset : offset+(32<<10)])
				w.(http.Flusher).Flush()
				time.Sleep(60 * time.Millisecond)
			}
		default:
			t.Errorf("unexpected provider call %s %s", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()
	ctx := generation.WithEndpoints(context.Background(), generation.Endpoints{BeefAPIVideoBaseURL: server.URL})
	ctx = generation.WithRuntime(ctx, generation.Runtime{Delivery: appTaskDeliveryPort{service: svc, taskID: taskID}, Stages: appTaskStagePort{service: svc, task: task}})
	policy := generation.DefaultVideoPollPolicy()
	sawWaiting := false
	policy.Sleep = func(_ context.Context, delay time.Duration) error {
		if downloads.Load() == 2 {
			got, err := svc.Task("local", taskID)
			if err != nil {
				return err
			}
			if got.Delivery == nil || got.Delivery.Outputs[0].State != "waiting" || delay != 5*time.Second {
				return fmt.Errorf("pending projection=%+v delay=%v", got.Delivery, delay)
			}
			sawWaiting = true
		}
		return nil
	}
	done := make(chan error, 1)
	go func() {
		result, err := generation.RunVideoTaskWithPolicy(ctx, generation.Input{Mode: "video", Prompt: "fixture", Config: generation.Config{BaseURL: server.URL, APIKey: "test-key", InterfaceType: "newapi", Model: "seedance-2.0-fast", VideoSeconds: "5", VQuality: "480P", Size: "16:9"}}, policy)
		if err == nil {
			video, _ := result["video"].(map[string]interface{})
			dataURL, _ := video["dataUrl"].(string)
			_, data, decodeErr := generation.DecodeProviderDataURL(dataURL)
			if decodeErr != nil || !bytes.Equal(data, body) {
				err = fmt.Errorf("downloaded payload mismatch: %v", decodeErr)
			}
		}
		done <- err
	}()
	sawTransfer := false
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	timeout := time.After(10 * time.Second)
	for {
		select {
		case err := <-done:
			if err != nil {
				t.Fatal(err)
			}
			if !sawWaiting || !sawTransfer || creates.Load() != 1 {
				t.Fatalf("waiting=%v transfer=%v submissions=%d", sawWaiting, sawTransfer, creates.Load())
			}
			if svc.deliveryProgressRegistry().forTask(taskID) != nil {
				t.Fatal("progress not cleared")
			}
			var phases []model.TaskLog
			if err := db.Where("task_id = ? AND payload LIKE ?", taskID, `{"phase":"result_transfer_%"}`).Order("created_at").Find(&phases).Error; err != nil {
				t.Fatal(err)
			}
			if len(phases) < 2 || phases[0].Payload != `{"phase":"result_transfer_start"}` || phases[len(phases)-1].Payload != `{"phase":"result_transfer_end"}` {
				t.Fatalf("transfer timing boundaries missing: %+v", phases)
			}
			return
		case <-ticker.C:
			got, err := svc.Task("local", taskID)
			if err != nil {
				t.Fatal(err)
			}
			if svc.deliveryProgressRegistry().forTask(providerID) != nil {
				t.Fatal("provider identity leaked")
			}
			if got.Delivery == nil {
				continue
			}
			// Check the wire names consumed by the frontend, not just Go fields.
			wire, err := json.Marshal(got)
			if err != nil {
				t.Fatal(err)
			}
			var projected struct {
				Delivery struct {
					Outputs []struct {
						Downloaded int64 `json:"downloadedBytes"`
						Total      int64 `json:"totalBytes"`
						Speed      int64 `json:"bytesPerSecond"`
					} `json:"outputs"`
				} `json:"delivery"`
			}
			if err := json.Unmarshal(wire, &projected); err != nil {
				t.Fatal(err)
			}
			if len(projected.Delivery.Outputs) == 1 {
				p := projected.Delivery.Outputs[0]
				if p.Downloaded > 0 && p.Downloaded < int64(len(body)) && p.Total == int64(len(body)) && p.Speed > 0 {
					sawTransfer = true
				}
			}
		case <-timeout:
			t.Fatal("stream did not complete")
		}
	}
}

// Video downloads pass the provider's task id to the generation layer. Progress
// must still land on the BeefTV task the user sees, never the provider id.
func TestVideoDownloadProgressUsesBeefTVTaskIDNotProviderID(t *testing.T) {
	const beefTaskID = "beeftv-task-1"
	const providerTaskID = "task_WvIGYZ_provider"
	svc := &Service{}
	ctx := generation.WithRuntime(context.Background(), generation.Runtime{
		Delivery: appTaskDeliveryPort{service: svc, taskID: beefTaskID},
	})
	policy := generation.DefaultVideoPollPolicy()
	policy.MaxDownloadTries = 1

	data, mimeType, err := generation.RunVideoDownload(ctx, providerTaskID, policy, func(context.Context) ([]byte, string, error) {
		progress := svc.deliveryProgressRegistry().forTask(beefTaskID)
		if progress == nil || len(progress.Outputs) != 1 || progress.Outputs[0].State != "downloading" {
			t.Fatalf("progress not visible on the BeefTV task while downloading: %+v", progress)
		}
		if leaked := svc.deliveryProgressRegistry().forTask(providerTaskID); leaked != nil {
			t.Fatalf("progress keyed by provider id: %+v", leaked)
		}
		return []byte("video"), "video/mp4", nil
	})
	if err != nil || string(data) != "video" || mimeType != "video/mp4" {
		t.Fatalf("download = %q %q %v", data, mimeType, err)
	}
	if after := svc.deliveryProgressRegistry().forTask(beefTaskID); after != nil {
		t.Fatalf("progress not cleared after download: %+v", after)
	}
}
