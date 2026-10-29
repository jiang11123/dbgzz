package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"infinite-canvas/backend/internal/generation"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/outbound"
	"infinite-canvas/backend/internal/protocol"
	"infinite-canvas/backend/internal/provider/workflow"
)

func recoveryTestAdapter(t *testing.T) protocol.Adapter {
	t.Helper()
	body, err := os.ReadFile("../../../plugin-packages/newapi-video-generations-v1/manifest.json")
	if err != nil {
		t.Fatal(err)
	}
	adapter, err := protocol.LoadManifest(body)
	if err != nil {
		t.Fatal(err)
	}
	return adapter
}

func TestVideoRecoveryLostReceiptNeverResubmits(t *testing.T) {
	allowLoopbackProviderTest(t)
	var creates, polls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			creates.Add(1)
			_, _ = io.Copy(io.Discard, r.Body)
			conn, _, _ := w.(http.Hijacker).Hijack()
			_ = conn.Close()
			return
		}
		polls.Add(1)
	}))
	defer server.Close()
	result, err := runProtocolAdapterTaskWithPolicy(context.Background(), canvasGenerationInput{Mode: "video", Prompt: "test", Config: providerConfig{BaseURL: server.URL, Model: "seedance-2.0-mini", InterfaceType: "newapi-channel-2"}}, recoveryTestAdapter(t), fastVideoPollPolicy())
	var unknown providerSubmissionUnknownError
	if creates.Load() != 1 || polls.Load() != 0 || result != nil || !errors.As(err, &unknown) {
		t.Fatalf("creates=%d polls=%d result=%v err=%v", creates.Load(), polls.Load(), result, err)
	}
	if !persistedFailureBlocksRetry(persistableTaskFailureMessage(err), "submission_unknown") {
		t.Fatal("lost receipt permits a paid retry")
	}
}

func TestVideoRecoverySubmissionClassification(t *testing.T) {
	for _, err := range []error{providerHTTPError{StatusCode: 429}, providerHTTPError{StatusCode: 404}, providerCircuitOpenError{}, context.Canceled} {
		var unknown providerSubmissionUnknownError
		if errors.As(uncertainVideoSubmission(context.Background(), err), &unknown) {
			t.Fatalf("known rejection wrapped: %v", err)
		}
	}
	for _, err := range []error{io.EOF, io.ErrUnexpectedEOF, context.DeadlineExceeded, providerHTTPError{StatusCode: 524}} {
		var unknown providerSubmissionUnknownError
		if !errors.As(uncertainVideoSubmission(context.Background(), err), &unknown) {
			t.Fatalf("lost receipt not protected: %v", err)
		}
	}
}

func TestVideoRecoverySocketResetNeverResubmits(t *testing.T) {
	allowLoopbackProviderTest(t)
	var creates, polls, downloads atomic.Int32
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			creates.Add(1)
			_, _ = io.WriteString(w, `{"code":"success","data":{"task_id":"original-paid-task","status":"IN_PROGRESS"}}`)
			return
		}
		if r.URL.Path == "/result.mp4" {
			downloads.Add(1)
			w.Header().Set("Content-Type", "video/mp4")
			_, _ = w.Write([]byte("test-video"))
			return
		}
		n := polls.Add(1)
		if n == 1 {
			conn, _, err := w.(http.Hijacker).Hijack()
			if err != nil {
				t.Error(err)
				return
			}
			// Abort TCP with RST: on Windows the client receives WSAECONNRESET.
			_ = conn.(*net.TCPConn).SetLinger(0)
			_ = conn.Close()
			return
		}
		if r.URL.Path != "/v1/video/generations/original-paid-task" {
			t.Errorf("unexpected task query: %s", r.URL.Path)
		}
		_, _ = fmt.Fprintf(w, `{"code":"success","data":{"task_id":"original-paid-task","status":"SUCCESS","result_url":%q}}`, server.URL+"/result.mp4")
	}))
	defer server.Close()
	input := canvasGenerationInput{Mode: "video", Prompt: "test", Config: providerConfig{BaseURL: server.URL, Model: "seedance-2.0-mini", InterfaceType: "newapi-channel-2"}}
	result, err := runProtocolAdapterTaskWithPolicy(context.Background(), input, recoveryTestAdapter(t), fastVideoPollPolicy())
	if err != nil || result == nil || creates.Load() != 1 || polls.Load() != 2 || downloads.Load() != 1 {
		t.Fatalf("creates=%d polls=%d downloads=%d result=%v err=%v", creates.Load(), polls.Load(), downloads.Load(), result, err)
	}
}

func TestVideoRecoveryDownloadDisconnectKeepsOriginalTask(t *testing.T) {
	for _, alwaysBroken := range []bool{false, true} {
		t.Run(fmt.Sprint(alwaysBroken), func(t *testing.T) {
			allowLoopbackProviderTest(t)
			var creates, polls, downloads atomic.Int32
			var server *httptest.Server
			server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				if r.Method == http.MethodPost {
					creates.Add(1)
					_, _ = io.WriteString(w, `{"code":"success","data":{"task_id":"original-paid-task","status":"IN_PROGRESS"}}`)
					return
				}
				if r.URL.Path == "/result.mp4" {
					n := downloads.Add(1)
					if alwaysBroken || n == 1 {
						conn, _, _ := w.(http.Hijacker).Hijack()
						_ = conn.Close()
						return
					}
					w.Header().Set("Content-Type", "video/mp4")
					_, _ = w.Write([]byte("test-video"))
					return
				}
				if r.URL.Path != "/v1/video/generations/original-paid-task" {
					t.Error("download renewal changed original task identity")
				}
				polls.Add(1)
				_, _ = fmt.Fprintf(w, `{"code":"success","data":{"task_id":"original-paid-task","status":"SUCCESS","result_url":%q}}`, server.URL+"/result.mp4")
			}))
			defer server.Close()
			input := canvasGenerationInput{Mode: "video", Prompt: "test", Config: providerConfig{BaseURL: server.URL, Model: "seedance-2.0-mini", InterfaceType: "newapi-channel-2"}}
			result, err := runProtocolAdapterTaskWithPolicy(context.Background(), input, recoveryTestAdapter(t), fastVideoPollPolicy())
			if creates.Load() != 1 || polls.Load() < 1 || polls.Load() > 4 || downloads.Load() < 2 || (alwaysBroken && polls.Load() < 2) {
				t.Fatalf("creates=%d polls=%d downloads=%d", creates.Load(), polls.Load(), downloads.Load())
			}
			if !alwaysBroken {
				if err != nil || result == nil {
					t.Fatalf("failed to recover: %v", err)
				}
				return
			}
			started := time.Now()
			task := model.Task{ID: "local", Type: "canvas_video", ProviderRequestID: "original-paid-task", StartedAt: &started}
			body, _ := json.Marshal(input)
			svc := &Service{}
			if err == nil || !svc.shouldDeferVideoProviderTask(task, string(body), err) {
				t.Fatalf("download result abandoned: %v", err)
			}
			started = started.Add(-25 * time.Hour)
			if svc.shouldDeferVideoProviderTask(task, string(body), err) {
				t.Fatal("automatic recovery is unbounded")
			}
			if svc.shouldDeferVideoProviderTask(task, string(body), context.Canceled) {
				t.Fatal("cancelled task resurrected")
			}
		})
	}
}

func TestVideoRecoveryBeefAPIQueryUsesOnlyGet(t *testing.T) {
	allowLoopbackProviderTest(t)
	var queries, downloads atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Errorf("unsafe method %s", r.Method)
			w.WriteHeader(400)
			return
		}
		if r.Header.Get("Authorization") != "Bearer test-key" {
			t.Error("missing query authentication")
		}
		if r.URL.Path == "/v1/videos/original/content" {
			downloads.Add(1)
			w.Header().Set("Content-Type", "video/mp4")
			_, _ = w.Write([]byte("test-video"))
			return
		}
		queries.Add(1)
		_, _ = io.WriteString(w, `{"data":{"id":"original","status":"completed"}}`)
	}))
	defer server.Close()
	result, _, err := queryBeefAPIVideoResult(context.Background(), canvasGenerationInput{Config: providerConfig{BaseURL: server.URL + "/v1", APIKey: "test-key"}}, "original")
	if err != nil || result == nil || queries.Load() != 1 || downloads.Load() != 1 {
		t.Fatalf("result=%v err=%v queries=%d downloads=%d", result, err, queries.Load(), downloads.Load())
	}
}

func TestVideoRecoveryBeefAPIRejectsDifferentTaskBeforeDownload(t *testing.T) {
	allowLoopbackProviderTest(t)
	var queries, downloads, creates atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			creates.Add(1)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		if r.URL.Path == "/v1/videos/original/content" {
			downloads.Add(1)
			return
		}
		queries.Add(1)
		_, _ = io.WriteString(w, `{"id":"original","data":{"task_id":"different","status":"completed"}}`)
	}))
	defer server.Close()
	result, _, err := queryBeefAPIVideoResult(context.Background(), canvasGenerationInput{Config: providerConfig{BaseURL: server.URL + "/v1", APIKey: "test-key"}}, "original")
	if err == nil || result != nil || queries.Load() != 1 || downloads.Load() != 0 || creates.Load() != 0 {
		t.Fatalf("result=%v err=%v queries=%d downloads=%d creates=%d", result, err, queries.Load(), downloads.Load(), creates.Load())
	}
}

func TestVideoRecoveryTaskLogsExplainFailureWithoutRawPayload(t *testing.T) {
	svc, db := newTimelineTaskTestService(t)
	log := model.TaskLog{ID: "log-recovery", UserID: "owner", TaskID: "task-recovery", Level: "error", Message: "任务处理失败", Payload: "视频结果下载失败：EOF https://private.example/result?token=secret-value"}
	if err := db.Create(&log).Error; err != nil {
		t.Fatal(err)
	}
	logs, err := svc.TaskLogs("owner", "task-recovery")
	if err != nil || len(logs) != 1 {
		t.Fatalf("logs=%v err=%v", logs, err)
	}
	if !strings.Contains(logs[0].Summary, "任务处理失败") || logs[0].Message != "" || logs[0].Payload != "" || strings.Contains(logs[0].Summary, "secret-value") {
		t.Fatalf("unsafe or missing summary: %#v", logs[0])
	}
	other, err := svc.TaskLogs("other-user", "task-recovery")
	if err != nil || len(other) != 0 {
		t.Fatal("logs crossed ownership")
	}
}

func TestFailedBeefAPIVideoRecoveryUsesFreshBackupAndKeepsOriginalTask(t *testing.T) {
	allowLoopbackProviderTest(t)
	payload, err := os.ReadFile("testdata/reference-fragmented-30fps.mp4")
	if err != nil {
		t.Fatal(err)
	}
	var creates, polls, primary, backups, mediaDownloads atomic.Int32
	media := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "" || r.Header.Get("X-Gateway-Secret") != "" || r.Header.Get("X-Beeftv-Video-Delivery") != "" {
			t.Error("gateway credentials reached external media")
		}
		if r.URL.Path == "/tos.mp4" {
			primary.Add(1)
			w.WriteHeader(http.StatusForbidden)
			return
		}
		mediaDownloads.Add(1)
		w.Header().Set("Content-Type", "application/octet-stream")
		_, _ = w.Write(payload)
	}))
	defer media.Close()
	gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			creates.Add(1)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		if r.Header.Get("Authorization") != "Bearer test-key" || r.Header.Get("X-Gateway-Secret") != "private-value" {
			t.Error("gateway request lost authentication")
		}
		if r.URL.Path == "/v1/videos/original" {
			polls.Add(1)
			_ = json.NewEncoder(w).Encode(map[string]any{"status": "completed", "metadata": map[string]any{"url": media.URL + "/tos.mp4?signature=expired"}})
			return
		}
		if r.URL.Path != "/v1/videos/original/content" || r.URL.Query().Get("delivery") != "backup" {
			t.Errorf("unexpected recovery route %s", r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
			return
		}
		n := backups.Add(1)
		if n == 1 {
			w.Header().Set("Retry-After", "1")
			w.WriteHeader(http.StatusServiceUnavailable)
			_, _ = w.Write([]byte(`{"error":{"code":"video_delivery_pending"}}`))
			return
		}
		http.Redirect(w, r, media.URL+"/cos.mp4?signature=fresh", http.StatusFound)
	}))
	defer gateway.Close()
	svc, db := openDBRuntimeMatrix(t, t.TempDir())
	defer closeDBRuntimeMatrix(t, svc, db)
	input := canvasGenerationInput{Mode: "video", Prompt: "test", Config: providerConfig{
		BaseURL: gateway.URL, APIKey: "test-key", Model: "unlisted-future-video", InterfaceType: "newapi",
		Headers: []outbound.OutboundHeader{{Name: "X-Gateway-Secret", Value: "private-value"}},
	}}
	inputJSON, err := json.Marshal(input)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	task := model.Task{ID: "original-local-task", UserID: "local", Type: "canvas_video", Status: model.TaskStatusFailed, ProviderRequestID: "original", InputJSON: string(inputJSON), CreatedAt: now, UpdatedAt: now}
	if err := db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	ctx := generation.WithEndpoints(context.Background(), generation.Endpoints{BeefAPIVideoBaseURL: gateway.URL})
	recovered, err := svc.QueryFailedVideoTask(ctx, task.UserID, task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !recovered.Recovered || recovered.Task.ID != task.ID || recovered.Task.ProviderRequestID != "original" || recovered.Task.Status != model.TaskStatusSucceeded || creates.Load() != 0 || polls.Load() != 1 || primary.Load() != 1 || backups.Load() != 2 || mediaDownloads.Load() != 1 {
		t.Fatalf("recovered=%+v creates=%d polls=%d primary=%d backups=%d media=%d", recovered, creates.Load(), polls.Load(), primary.Load(), backups.Load(), mediaDownloads.Load())
	}
	var stored model.Task
	if err := db.First(&stored, "id = ?", task.ID).Error; err != nil {
		t.Fatal(err)
	}
	if strings.Contains(stored.ResultJSON, "signature=") {
		t.Fatal("recovery persisted a signed media URL")
	}
	var resources []model.Resource
	if err := db.Find(&resources).Error; err != nil || len(resources) != 1 {
		t.Fatalf("resources=%d err=%v", len(resources), err)
	}
	resource := resources[0]
	if resource.Kind != "video" || resource.MimeType != "video/mp4" || !strings.HasSuffix(resource.ObjectKey, ".mp4") || resource.Width != 640 || resource.Height != 640 {
		t.Fatalf("recovered MP4 was not saved as a video: %+v", resource)
	}
	if recovered.Task.ResultState != "READY" || len(recovered.Task.Outputs) != 1 || recovered.Task.Outputs[0].ResourceID != resource.ID || recovered.Task.Outputs[0].MaterializedAssetID == "" {
		t.Fatalf("recovery did not expose the ready materialized resource: state=%s outputs=%+v", recovered.Task.ResultState, recovered.Task.Outputs)
	}
	data, err := os.ReadFile(filepath.Join(svc.dataDir, "resources", filepath.FromSlash(resource.ObjectKey)))
	if err != nil || !bytes.Equal(data, payload) {
		t.Fatalf("stored media differs: bytes=%d err=%v", len(data), err)
	}
}

func TestFailedThirdPartyVideoRecoveryRenewsOriginalTaskAndMaterializes(t *testing.T) {
	allowLoopbackProviderTest(t)
	payload, err := os.ReadFile("testdata/reference-fragmented-30fps.mp4")
	if err != nil {
		t.Fatal(err)
	}
	var expired atomic.Int32
	media := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		expired.Add(1)
		if r.Header.Get("Authorization") != "" || r.Header.Get("x-goog-api-key") != "" {
			t.Error("provider credential leaked to media")
		}
		w.WriteHeader(http.StatusForbidden)
	}))
	defer media.Close()
	var polls, downloads atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.Header.Get("x-goog-api-key") != "provider-fixture" || r.Header.Get("Authorization") != "" || r.URL.Query().Get("delivery") != "" || r.Header.Get("X-Beeftv-Video-Delivery") != "" {
			t.Error("third-party recovery changed auth or attempted generation/BeefAPI backup")
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		if r.URL.Path == "/fresh.mp4" {
			downloads.Add(1)
			w.Header().Set("Content-Type", "application/octet-stream")
			_, _ = w.Write(payload)
			return
		}
		if r.URL.Path != "/v1beta/original" {
			t.Errorf("wrong original task query %s", r.URL.Path)
		}
		n := polls.Add(1)
		url := media.URL + "?signature=expired"
		if n > 1 {
			url = "/fresh.mp4"
		}
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"name": "original", "done": true, "response": map[string]interface{}{"generatedVideos": []interface{}{map[string]interface{}{"video": map[string]interface{}{"uri": url}}}}})
	}))
	defer provider.Close()
	svc, db := openDBRuntimeMatrix(t, t.TempDir())
	defer closeDBRuntimeMatrix(t, svc, db)
	inputJSON, err := json.Marshal(canvasGenerationInput{Mode: "video", Config: providerConfig{BaseURL: provider.URL, APIKey: "provider-fixture", APIFormat: "openai", InterfaceType: "gemini-veo", Model: "unlisted-future-video"}})
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	task := model.Task{ID: "failed-original-third-party", UserID: "local", Type: "canvas_video", Status: model.TaskStatusFailed, ProviderRequestID: "original", InputJSON: string(inputJSON), CreatedAt: now, UpdatedAt: now}
	if err := db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	result, err := svc.QueryFailedVideoTask(context.Background(), task.UserID, task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !result.Recovered || result.Task.ID != task.ID || result.Task.ProviderRequestID != "original" || result.Task.ResultState != "READY" || len(result.Task.Outputs) != 1 || result.Task.Outputs[0].MaterializedAssetID == "" || polls.Load() != 2 || downloads.Load() != 1 || expired.Load() != 1 {
		t.Fatalf("recovered=%v state=%s polls=%d downloads=%d expired=%d", result.Recovered, result.Task.ResultState, polls.Load(), downloads.Load(), expired.Load())
	}
	var resource model.Resource
	if err := db.First(&resource, "id = ?", result.Task.Outputs[0].ResourceID).Error; err != nil || resource.Kind != "video" || resource.MimeType != "video/mp4" {
		t.Fatalf("resource kind=%s mime=%s err=%v", resource.Kind, resource.MimeType, err)
	}
	data, err := os.ReadFile(filepath.Join(svc.dataDir, "resources", filepath.FromSlash(resource.ObjectKey)))
	if err != nil || !bytes.Equal(data, payload) {
		t.Fatalf("saved video differs: bytes=%d err=%v", len(data), err)
	}
}

func TestFailedRunningHubVideoRecoveryRenewsOriginalTaskAndMaterializes(t *testing.T) {
	allowLoopbackProviderTest(t)
	payload, err := os.ReadFile("testdata/reference-fragmented-30fps.mp4")
	if err != nil {
		t.Fatal(err)
	}
	var polls, reads atomic.Int32
	media := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := reads.Add(1)
		if r.Header.Get("Authorization") != "" || r.Header.Get("X-Private-Channel") != "" || r.URL.Query().Get("apiKey") != "" {
			t.Error("workflow credentials leaked to media")
		}
		if n == 1 {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		w.Header().Set("Content-Type", "application/octet-stream")
		_, _ = w.Write(payload)
	}))
	defer media.Close()
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/task/openapi/outputs" || r.URL.Query().Get("delivery") != "" {
			t.Error("manual recovery entered a generation/schema/BeefAPI backup path")
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		var body map[string]interface{}
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["taskId"] != "original" || body["apiKey"] != "provider-key" {
			t.Error("original workflow query identity/auth lost")
		}
		polls.Add(1)
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"code": 0, "data": []interface{}{map[string]interface{}{"fileUrl": media.URL + "/video?apiKey=provider-key&signature=media-signature"}}})
	}))
	defer provider.Close()
	svc, db := openDBRuntimeMatrix(t, t.TempDir())
	defer closeDBRuntimeMatrix(t, svc, db)
	center, err := newPluginRuntime(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := center.setEnabled(WorkflowPluginRunningHub, true); err != nil {
		t.Fatal(err)
	}
	svc.pluginRuntime = center
	inputJSON, err := json.Marshal(canvasGenerationInput{Mode: "video", Config: providerConfig{BaseURL: provider.URL, APIKey: "provider-key", InterfaceType: "runninghub-workflow-video", Headers: []outbound.OutboundHeader{{Name: "X-Private-Channel", Value: "private-fixture"}}}})
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	task := model.Task{ID: "failed-original-workflow", UserID: "local", Type: "canvas_video", Status: model.TaskStatusFailed, ProviderRequestID: "original", InputJSON: string(inputJSON), CreatedAt: now, UpdatedAt: now}
	if err := db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	result, err := svc.QueryFailedVideoTask(context.Background(), task.UserID, task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !result.Recovered || result.Task.ID != task.ID || result.Task.ProviderRequestID != "original" || result.Task.ResultState != "READY" || len(result.Task.Outputs) != 1 || result.Task.Outputs[0].MaterializedAssetID == "" || polls.Load() != 2 || reads.Load() != 2 {
		t.Fatalf("recovered=%v state=%s polls=%d reads=%d", result.Recovered, result.Task.ResultState, polls.Load(), reads.Load())
	}
	var resource model.Resource
	if err := db.First(&resource, "id = ?", result.Task.Outputs[0].ResourceID).Error; err != nil || resource.Kind != "video" || resource.MimeType != "video/mp4" {
		t.Fatalf("resource kind=%s mime=%s err=%v", resource.Kind, resource.MimeType, err)
	}
	data, err := os.ReadFile(filepath.Join(svc.dataDir, "resources", filepath.FromSlash(resource.ObjectKey)))
	if err != nil || !bytes.Equal(data, payload) {
		t.Fatalf("saved video differs: bytes=%d err=%v", len(data), err)
	}
}

func TestFailedHandwrittenVideoRecoveryQueriesOriginalTaskWithoutCreating(t *testing.T) {
	allowLoopbackProviderTest(t)
	payload, err := os.ReadFile("testdata/reference-fragmented-30fps.mp4")
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name, model, interfaceType, shape           string
		pending, wrongTask, wrongRenew, unsupported bool
	}{
		{name: "empty interface generic nested result", model: "unlisted-future-video", shape: "nested"},
		{name: "empty interface Seedance metadata", model: "seedance-2.0-mini", shape: "metadata"},
		{name: "empty interface Grok nested result", model: "grok-imagine-video", shape: "nested"},
		{name: "empty interface Ark Plan", model: "unlisted-future-video", shape: "ark"},
		{name: "legacy Ark Plan interface", model: "unlisted-future-video", interfaceType: "legacy-agent-plan", shape: "ark"},
		{name: "pending original remains failed locally", model: "unlisted-future-video", shape: "nested", pending: true},
		{name: "wrong initial task refused", model: "unlisted-future-video", shape: "nested", wrongTask: true},
		{name: "wrong task after URL expiry refused", model: "unlisted-future-video", shape: "nested", wrongRenew: true},
		{name: "missing explicit official Ark plugin refused", model: "unlisted-future-video", interfaceType: "volcengine-ark-agent-plan-video", shape: "ark", unsupported: true},
		{name: "missing explicit official video plugin refused", model: "unlisted-future-video", interfaceType: "minimax-video", shape: "nested", unsupported: true},
		{name: "missing custom plugin refused", model: "unlisted-future-video", interfaceType: "removed-custom-video-plugin", shape: "nested", unsupported: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var polls, creates, downloads, expiredReads atomic.Int32
			expired := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				expiredReads.Add(1)
				if r.Header.Get("Authorization") != "" || r.Header.Get("X-Private-Channel") != "" {
					t.Error("provider credentials leaked to external original media")
				}
				w.WriteHeader(http.StatusForbidden)
			}))
			defer expired.Close()
			var provider *httptest.Server
			provider = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodGet {
					creates.Add(1)
					t.Error("manual original-task retrieval attempted a write")
					w.WriteHeader(http.StatusBadRequest)
					return
				}
				if r.Header.Get("Authorization") != "Bearer provider-fixture" || r.Header.Get("X-Private-Channel") != "private-fixture" || r.URL.Query().Get("delivery") != "" || r.Header.Get("X-Beeftv-Video-Delivery") != "" {
					t.Error("legacy original-task retrieval changed provider authentication")
				}
				if r.URL.Path == "/fresh.mp4" {
					downloads.Add(1)
					w.Header().Set("Content-Type", "application/octet-stream")
					_, _ = w.Write(payload)
					return
				}
				wantPath := "/v1/videos/original"
				if tc.shape == "ark" {
					wantPath = "/api/plan/v3/contents/generations/tasks/original"
				}
				if r.URL.Path != wantPath {
					t.Errorf("unexpected original task path %s", r.URL.Path)
					w.WriteHeader(http.StatusNotFound)
					return
				}
				n := polls.Add(1)
				id, status, rawURL := "original", "succeeded", expired.URL+"/original.mp4"
				if n > 1 {
					rawURL = provider.URL + "/fresh.mp4"
				}
				if tc.pending {
					status = "processing"
				}
				if tc.wrongTask || (tc.wrongRenew && n > 1) {
					id = "another-task"
				}
				state := map[string]interface{}{"id": id, "status": status}
				switch tc.shape {
				case "ark":
					state["content"] = map[string]interface{}{"video_url": rawURL}
				case "metadata":
					state["status"] = "processing"
					state["metadata"] = map[string]interface{}{"generation_status": status, "url": rawURL}
				default:
					state["result"] = map[string]interface{}{"video": map[string]interface{}{"url": rawURL}}
					state = map[string]interface{}{"data": state}
				}
				_ = json.NewEncoder(w).Encode(state)
			}))
			defer provider.Close()
			svc, db := openDBRuntimeMatrix(t, t.TempDir())
			defer closeDBRuntimeMatrix(t, svc, db)
			if tc.unsupported {
				svc.pluginRuntime = pluginRuntimeFromRecords(map[string]pluginRecord{})
			}
			baseURL := provider.URL
			if tc.shape == "ark" {
				baseURL += "/api/plan/v3"
			}
			inputJSON, err := json.Marshal(canvasGenerationInput{Mode: "video", Config: providerConfig{BaseURL: baseURL, APIKey: "provider-fixture", APIFormat: "openai", InterfaceType: tc.interfaceType, Model: tc.model, Headers: []outbound.OutboundHeader{{Name: "X-Private-Channel", Value: "private-fixture"}}}})
			if err != nil {
				t.Fatal(err)
			}
			now := time.Now()
			task := model.Task{ID: "failed-handwritten-original", UserID: "local", Type: "canvas_video", Status: model.TaskStatusFailed, ProviderRequestID: "original", InputJSON: string(inputJSON), CreatedAt: now, UpdatedAt: now}
			if err := db.Create(&task).Error; err != nil {
				t.Fatal(err)
			}
			result, queryErr := svc.QueryFailedVideoTask(context.Background(), task.UserID, task.ID)
			var savedTask model.Task
			if err := db.First(&savedTask, "id = ?", task.ID).Error; err != nil {
				t.Fatal(err)
			}
			if creates.Load() != 0 || savedTask.ID != task.ID || savedTask.ProviderRequestID != task.ProviderRequestID {
				t.Fatalf("original task changed or created: creates=%d task=%s provider=%s", creates.Load(), savedTask.ID, savedTask.ProviderRequestID)
			}
			var wrongReceiptCount int64
			if err := db.Model(&model.ApiCallLog{}).Where("task_id = ? AND provider_request_id <> ?", task.ID, task.ProviderRequestID).Count(&wrongReceiptCount).Error; err != nil || wrongReceiptCount != 0 {
				t.Fatalf("original request identity changed in audit receipts: count=%d err=%v", wrongReceiptCount, err)
			}
			if tc.unsupported || tc.wrongTask || tc.wrongRenew || tc.pending {
				if (tc.pending && (queryErr != nil || result == nil || result.Recovered)) || (!tc.pending && queryErr == nil) || savedTask.Status != model.TaskStatusFailed || downloads.Load() != 0 || (tc.unsupported && polls.Load() != 0) {
					t.Fatalf("rejected/pending original: result=%v err=%v status=%s polls=%d downloads=%d", result, queryErr, savedTask.Status, polls.Load(), downloads.Load())
				}
				var resourceCount int64
				if err := db.Model(&model.Resource{}).Count(&resourceCount).Error; err != nil || resourceCount != 0 {
					t.Fatalf("unconfirmed original materialized: resources=%d err=%v", resourceCount, err)
				}
				return
			}
			if queryErr != nil || result == nil || !result.Recovered || result.Task.ID != task.ID || result.Task.ResultState != "READY" || len(result.Task.Outputs) != 1 || result.Task.Outputs[0].MaterializedAssetID == "" || polls.Load() != 2 || downloads.Load() != 1 || expiredReads.Load() != 1 {
				t.Fatalf("original recovery result=%v err=%v polls=%d downloads=%d expired=%d", result, queryErr, polls.Load(), downloads.Load(), expiredReads.Load())
			}
			var resource model.Resource
			if err := db.First(&resource, "id = ?", result.Task.Outputs[0].ResourceID).Error; err != nil || resource.Kind != "video" || resource.MimeType != "video/mp4" {
				t.Fatalf("saved video kind=%s mime=%s err=%v", resource.Kind, resource.MimeType, err)
			}
			data, err := os.ReadFile(filepath.Join(svc.dataDir, "resources", filepath.FromSlash(resource.ObjectKey)))
			if err != nil || !bytes.Equal(data, payload) {
				t.Fatalf("saved original bytes changed: bytes=%d err=%v", len(data), err)
			}
		})
	}
}

func TestVideoRequestReceiptPreservesOriginalIdentityExceptCreate(t *testing.T) {
	allowLoopbackProviderTest(t)
	for _, kind := range []string{"create", "poll", "workflow-poll", "download"} {
		t.Run(kind, func(t *testing.T) {
			var requests atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				requests.Add(1)
				id := "wrong-response-task"
				if kind == "create" {
					id = "created-original-task"
					if r.Method != http.MethodPost || r.URL.Path != "/v1/videos" {
						t.Error("fixture did not exercise create")
					}
				}
				w.Header().Set("Content-Type", "application/json")
				_ = json.NewEncoder(w).Encode(map[string]interface{}{"id": id, "status": "completed"})
			}))
			defer server.Close()
			svc, db := openDBRuntimeMatrix(t, t.TempDir())
			defer closeDBRuntimeMatrix(t, svc, db)
			providerID := "original"
			if kind == "create" {
				providerID = ""
			}
			now := time.Now()
			task := model.Task{ID: "receipt-video-task", UserID: "local", Type: "canvas_video", Status: model.TaskStatusFailed, ProviderRequestID: providerID, CreatedAt: now, UpdatedAt: now}
			if err := db.Create(&task).Error; err != nil {
				t.Fatal(err)
			}
			ctx := withProviderAnalytics(context.Background(), svc, task)
			config := providerConfig{BaseURL: server.URL, APIKey: "provider-fixture"}
			var requestErr error
			var state map[string]interface{}
			switch kind {
			case "create":
				requestErr = generation.PostJSON(ctx, config, "/videos", map[string]interface{}{"model": "fixture"}, &state)
			case "poll":
				_, requestErr = generation.ExecuteProtocolRequest(generation.WithRequestKind(ctx, "poll"), config, protocol.RequestSpec{Method: http.MethodGet, Path: "/v1/videos/original"})
			case "workflow-poll":
				_, _, requestErr = (workflowRequestExecutor{}).Execute(withProviderRequestKind(ctx, "poll"), workflow.Request{Kind: "poll", Method: http.MethodPost, URL: server.URL + "/task/openapi/outputs", ContentType: "application/json", Body: []byte(`{"taskId":"original"}`)})
			case "download":
				_, _, requestErr = generation.GetProviderExternalBinary(generation.WithRequestKind(ctx, "download"), config, server.URL+"/v1/videos/original/content")
			}
			if requestErr != nil || requests.Load() != 1 {
				t.Fatalf("receipt fixture requests=%d err=%v", requests.Load(), requestErr)
			}
			wantID, wantKind := "original", kind
			if kind == "create" {
				wantID = "created-original-task"
			} else if kind == "workflow-poll" {
				wantKind = "poll"
			}
			var savedTask model.Task
			if err := db.First(&savedTask, "id = ?", task.ID).Error; err != nil || savedTask.ProviderRequestID != wantID {
				t.Fatalf("persisted task identity=%s want=%s err=%v", savedTask.ProviderRequestID, wantID, err)
			}
			var logs []model.ApiCallLog
			if err := db.Where("task_id = ?", task.ID).Find(&logs).Error; err != nil || len(logs) != 1 || logs[0].ProviderRequestID != wantID || logs[0].RequestKind != wantKind {
				t.Fatalf("receipt identity differs: logs=%v want=%s kind=%s err=%v", logs, wantID, wantKind, err)
			}
		})
	}
}
