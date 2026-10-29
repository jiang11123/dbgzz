package app

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"strings"
	"testing"
	"time"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"infinite-canvas/backend/internal/diagnostics"
	"infinite-canvas/backend/internal/generation"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/outbound"
	"infinite-canvas/backend/internal/repository"
)

func TestVideoFailureStagesSurviveWorkerRefreshSQLiteAndDiagnosticZIP(t *testing.T) {
	dns := &outbound.DNSResolutionError{Cause: &net.DNSError{Name: "PRIVATE_HOST", Server: "PRIVATE_RESOLVER", Err: "temporary failure", IsTemporary: true}}
	for _, tc := range []struct {
		name, stage, wantStage, source, reason string
		err                                    error
		status                                 int
	}{
		{"query_dns", "正在查询上游任务", "查询原任务（DNS 解析）", "local_network", "local_network_failed", dns, 0},
		{"download_dns", "正在取回生成结果", "取回生成结果（DNS 解析）", "local_network", "local_network_failed", videoDownloadError{TaskID: "original", Cause: dns}, 0},
		{"supplier_media", "正在查询上游任务", "上游读取参考素材", "upstream_response", "upstream_business_failed", generation.NewRawPayloadError(`{"error":{"code":"504","message":"Failed to download media from the provided URL. context deadline exceeded"}}`), 200},
		{"query_http", "正在查询上游任务", "正在查询上游任务", "upstream_http", "upstream_request_failed", providerHTTPError{StatusCode: 503, Body: `{"error":{"message":"unavailable"}}`}, 503},
		{"submit_http", "正在提交生成任务", "正在提交生成任务", "upstream_http", "upstream_request_failed", providerHTTPError{StatusCode: 503, Body: `{"error":{"message":"unavailable"}}`}, 503},
	} {
		t.Run(tc.name, func(t *testing.T) {
			db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
			if err != nil {
				t.Fatal(err)
			}
			sqlDB, _ := db.DB()
			defer sqlDB.Close()
			if err := db.AutoMigrate(&model.Task{}, &model.TaskLog{}, &model.ApiCallLog{}, &model.CanvasProject{}, &model.AssistantTurn{}, &model.Resource{}, &model.Asset{}, &model.AssetVersion{}, &model.AssetRepresentation{}); err != nil {
				t.Fatal(err)
			}
			now := time.Now().UTC()
			task := model.Task{ID: "owned-task", UserID: "owner", Type: "canvas_video", Status: model.TaskStatusRunning, Stage: "正在连接上游", ProviderRequestID: "original", CreatedAt: now, UpdatedAt: now}
			if err := db.Create(&task).Error; err != nil {
				t.Fatal(err)
			}
			svc := &Service{repo: repository.New(db)}
			if err := (appTaskStagePort{service: svc, task: task}).SetStage(context.Background(), tc.stage); err != nil {
				t.Fatal(err)
			}
			if task.Stage != "正在连接上游" {
				t.Fatal("fixture no longer exercises the stale worker copy")
			}
			if err := svc.refreshTaskProviderState(&task); err != nil || task.Stage != tc.stage {
				t.Fatalf("worker failed to read persisted execution stage: %v / %s", err, task.Stage)
			}
			task.FailureDiagnostics = &model.TaskFailureDiagnostics{Requests: []model.TaskRequestEvidence{{Operation: "query_or_download", Method: "GET", Outcome: "business_error", HTTPStatus: tc.status, RequestID: "owned-request"}}}
			captureTaskFailureDiagnostics(&task, tc.err, "unknown")
			if ok, err := svc.repo.UpdateTaskTerminalState(task.ID, "", model.TaskStatusRunning, model.TaskStatusFailed, "失败", "通用文案", now, task.FailureDiagnostics); !ok || err != nil {
				t.Fatalf("terminal capture: %t %v", ok, err)
			}
			tasks, err := svc.repo.Tasks("owner", 10, "", false)
			if err != nil || len(tasks) != 1 {
				t.Fatalf("task list: %v", err)
			}
			d := taskSummaryForOutput(tasks[0]).FailureDiagnostics
			if d.Source != tc.source || d.Stage != tc.wantStage || d.HTTPStatus != tc.status {
				t.Fatalf("failure stage changed: %+v", d)
			}
			if tc.source == "local_network" && (d.TransportPhase != "dns" || d.ProviderCode != "") {
				t.Fatalf("local DNS was attributed to the supplier: %+v", d)
			}
			bundle, err := diagnostics.New(diagnostics.Dependencies{Store: svc.repo}).Export("owner", diagnostics.ExportRequest{})
			if err != nil {
				t.Fatal(err)
			}
			findings, err := diagnostics.AnalyzeBundle(bundle.Data)
			if err != nil {
				t.Fatal(err)
			}
			found := false
			for _, finding := range findings {
				if finding.Reason == tc.reason && finding.Status == "confirmed" {
					found = true
					if tc.source == "local_network" && finding.Stage != "local_network/dns" {
						t.Fatalf("DNS phase missing from offline analysis: %+v", finding)
					}
					if tc.source == "upstream_response" && finding.Stage != tc.wantStage {
						t.Fatalf("HTTP 200 business failure lost supplier stage: %+v", finding)
					}
				}
			}
			if !found {
				t.Fatalf("offline evidence missing: %+v", findings)
			}
			encoded, _ := json.Marshal(d)
			if strings.Contains(string(encoded), "PRIVATE") {
				t.Fatal("resolver details persisted")
			}
		})
	}
}

func TestOriginalBeefAPITaskDNSDeferralDoesNotNeedHealthyDNS(t *testing.T) {
	svc := &Service{}
	started := time.Now()
	task := model.Task{ID: "owned-task", Type: "canvas_video", ProviderRequestID: "original", StartedAt: &started}
	input, _ := json.Marshal(canvasGenerationInput{Mode: "video", Config: providerConfig{BaseURL: "https://beefapi.com/v1", InterfaceType: "newapi", Model: "seedance-2.0-mini"}})
	previous := net.DefaultResolver
	lookups := 0
	net.DefaultResolver = &net.Resolver{PreferGo: true, Dial: func(context.Context, string, string) (net.Conn, error) {
		lookups++
		return nil, errors.New("offline fixture")
	}}
	t.Cleanup(func() { net.DefaultResolver = previous })
	transient := &outbound.DNSResolutionError{Cause: &net.DNSError{Err: "temporary", IsTemporary: true}}
	if !svc.shouldDeferVideoProviderTask(task, string(input), transient) || lookups != 0 {
		t.Fatal("known original-task recovery depends on another DNS lookup")
	}
	for _, err := range []error{context.Canceled, &outbound.DNSResolutionError{Cause: &net.DNSError{Err: "not found", IsNotFound: true}}, BadAuthRequest("不允许访问链路本地、未指定或组播地址")} {
		if svc.shouldDeferVideoProviderTask(task, string(input), err) {
			t.Fatal("permanent failure, cancellation or security rejection deferred")
		}
	}
	task.ProviderRequestID = ""
	if svc.shouldDeferVideoProviderTask(task, string(input), transient) {
		t.Fatal("recovery without an original ID could submit a new task")
	}
	task.ProviderRequestID = "original"
	expired := started.Add(-25 * time.Hour)
	task.StartedAt = &expired
	if svc.shouldDeferVideoProviderTask(task, string(input), transient) {
		t.Fatal("automatic recovery exceeded its 24-hour bound")
	}
}
