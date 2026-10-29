package diagnostics

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"io"
	"strings"
	"testing"
	"time"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

func TestExportRecordsKeepFailureEvidenceAndLocalReason(t *testing.T) {
	row := sanitizeTask(model.Task{ID: "task-disk", FailureDiagnostics: &model.TaskFailureDiagnostics{
		Source: "local_result", Stage: "本地结果处理", ExecutionResult: "completed", RequestID: "req-12345678", ProviderTaskID: "task_12345678",
		Summary: `write C:\Users\private\video: There is not enough space on the disk`,
	}})
	body, err := json.Marshal(row)
	if err != nil {
		t.Fatal(err)
	}
	text := string(body)
	for _, expected := range []string{"failureDiagnostics", "local_result", "req-12345678", "task_12345678", "not enough space on the disk"} {
		if !strings.Contains(text, expected) {
			t.Fatalf("missing %s: %s", expected, text)
		}
	}
	if strings.Contains(text, "private") {
		t.Fatal("private path leaked")
	}
	event := sanitizeClientEvent(ClientEvent{Reason: "local_credential_failed", RequestID: "req-credential-test", Message: "工作区密钥文件不存在"})
	if event.Reason != "local_credential_failed" || event.RequestID != "req-credential-test" || event.Message != "工作区密钥文件不存在" {
		t.Fatalf("lost admission evidence: %#v", event)
	}
}

func TestExportIncludesIndependentEnvironmentEvidence(t *testing.T) {
	db, err := gorm.Open(sqlite.Open("file:diagnostics-environment?mode=memory&cache=shared"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&model.Task{}, &model.TaskLog{}, &model.ApiCallLog{}); err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	svc := New(Dependencies{DataDir: dir, Store: repository.New(db)})
	var req ExportRequest
	if err := json.Unmarshal([]byte(`{"runtime":{"capabilities":{"secureRandom":true,"storageWritable":false,"secret":"never-export-me"}}}`), &req); err != nil {
		t.Fatal(err)
	}
	bundle, err := svc.Export("user-1", req)
	if err != nil {
		t.Fatal(err)
	}
	files := readTestZIP(t, bundle.Data)
	if !strings.Contains(files["context/environment.json"], `"catalog"`) || !strings.Contains(files["context/environment.json"], `"storage-write"`) {
		t.Fatal("missing native evidence")
	}
	if !strings.Contains(files["context/runtime.json"], `"storageWritable": false`) {
		t.Fatal("missing client capability")
	}
	if strings.Contains(files["context/runtime.json"], `"h264"`) {
		t.Fatal("uncollected capability was inferred false")
	}
	for _, contents := range files {
		if strings.Contains(contents, dir) || strings.Contains(contents, "never-export-me") {
			t.Fatal("environment leaked unapproved fields")
		}
	}
}

func TestExportRedactsSensitiveValuesFromFixture(t *testing.T) {
	db, err := gorm.Open(sqlite.Open("file:diagnostics-test?mode=memory&cache=shared"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&model.Task{}, &model.TaskLog{}, &model.ApiCallLog{}); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	if err := db.Create(&model.Task{
		ID: "task-1", UserID: "user-1", TraceID: "trace-1", RequestID: "req-1", ProjectID: "project-1", Type: "video_generate",
		Status: model.TaskStatusFailed, Error: "authorization: task-secret", Prompt: "secret prompt", CreatedAt: now.Add(-time.Minute), UpdatedAt: now,
	}).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.TaskLog{ID: "task-log-1", UserID: "user-1", TaskID: "task-1", TraceID: "trace-1", Message: "任务失败", Payload: "apiKey=log-secret", CreatedAt: now}).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.ApiCallLog{ID: "api-log-1", UserID: "user-1", TraceID: "trace-1", RequestID: "req-1", TaskID: "task-1", Path: "/v1/generations", RequestBody: "apiKey=body-secret", ResponseBody: "response-secret", UpstreamURL: "https://provider.example/result?signature=secret", Error: "token=api-secret", CreatedAt: now}).Error; err != nil {
		t.Fatal(err)
	}

	svc := New(Dependencies{Store: repository.New(db), Brand: staticBrand{name: "BeefTV", slug: "beeftv"}})
	bundle, err := svc.Export("user-1", ExportRequest{
		From: now.Add(-2 * time.Minute).Format(time.RFC3339Nano), To: now.Add(time.Minute).Format(time.RFC3339Nano), TaskID: "task-1",
		Description: "页面报错", ClientEvents: []ClientEvent{{ID: "event-1", Message: "cookie=client-secret", TraceID: "trace-1"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	files := readTestZIP(t, bundle.Data)
	manifest := files["manifest.json"]
	if !strings.Contains(manifest, `"bundleId": "`+bundle.BundleID+`"`) {
		t.Fatalf("manifest = %s", manifest)
	}
	all := strings.Join([]string{manifest, files["client/events.jsonl"], files["backend/tasks.jsonl"], files["backend/task-logs.jsonl"], files["backend/upstream-calls.jsonl"]}, "\n")
	for _, secret := range []string{"task-secret", "secret prompt", "log-secret", "body-secret", "response-secret", "api-secret", "signature=secret", "client-secret"} {
		if strings.Contains(all, secret) {
			t.Fatalf("diagnostic bundle leaked %q: %s", secret, all)
		}
	}
	if strings.Contains(files["backend/upstream-calls.jsonl"], "requestBody") || strings.Contains(files["backend/upstream-calls.jsonl"], "result?signature") {
		t.Fatalf("upstream call contains excluded payload or query: %s", files["backend/upstream-calls.jsonl"])
	}
}

func TestExportRedactsModelConfigSummary(t *testing.T) {
	db, err := gorm.Open(sqlite.Open("file:diagnostics-config?mode=memory&cache=shared"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&model.Task{}, &model.TaskLog{}, &model.ApiCallLog{}); err != nil {
		t.Fatal(err)
	}
	body := []byte(`{
		"imageModel": "studio::image-y",
		"textModel": "studio::chat-x",
		"assistantModel": "studio::chat-x",
		"channels": [
			{
				"id": "studio", "name": "工作室渠道", "apiFormat": "openai", "scope": "user", "enabled": true,
				"baseUrl": "https://api.example.com/v1?token=query-secret",
				"apiKey": "sk-secret-key", "secretKey": "secret-key-value",
				"headers": [{"name": "X-Key", "value": "header-value"}],
				"models": ["chat-x", "image-y"],
				"modelProfiles": [
					{"model": "chat-x", "capability": "text", "protocol": "chat-completion"},
					{"model": "image-y", "capability": "image", "protocol": "openai-image"}
				]
			}
		]
	}`)
	now := time.Now().UTC()
	svc := New(Dependencies{Store: repository.New(db), Brand: staticBrand{name: "BeefTV", slug: "beeftv"}, Config: stubModelConfig{body: body}})
	bundle, err := svc.Export("user-1", ExportRequest{From: now.Add(-time.Minute).Format(time.RFC3339Nano), To: now.Format(time.RFC3339Nano)})
	if err != nil {
		t.Fatal(err)
	}
	files := readTestZIP(t, bundle.Data)
	summary, ok := files["context/model-config.json"]
	if !ok {
		t.Fatal("missing context/model-config.json")
	}
	for _, secret := range []string{"sk-secret-key", "secret-key-value", "header-value", "query-secret", "https://api.example.com/v1"} {
		if strings.Contains(summary, secret) {
			t.Fatalf("model config leaked %q: %s", secret, summary)
		}
	}
	for _, want := range []string{`"baseUrlHost": "api.example.com"`, `"protocol": "chat-completion"`, `"protocol": "openai-image"`, `"capability": "text"`, `"modelCount": 2`} {
		if !strings.Contains(summary, want) {
			t.Fatalf("model config missing %q: %s", want, summary)
		}
	}
}

type stubModelConfig struct{ body []byte }

func (s stubModelConfig) ReadLocalModelConfig() ([]byte, error) { return s.body, nil }

func TestExportRejectsForeignTaskFixture(t *testing.T) {
	db, err := gorm.Open(sqlite.Open("file:diagnostics-ownership-test?mode=memory&cache=shared"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&model.Task{}); err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.Task{ID: "foreign-task", UserID: "user-2", CreatedAt: time.Now(), UpdatedAt: time.Now()}).Error; err != nil {
		t.Fatal(err)
	}
	_, err = New(Dependencies{Store: repository.New(db)}).Export("user-1", ExportRequest{TaskID: "foreign-task"})
	if err == nil || !strings.Contains(err.Error(), "任务不存在或无权访问") {
		t.Fatalf("foreign task error = %v", err)
	}
}

func TestRedactTextRemovesMarkersAndURLQuery(t *testing.T) {
	got := redactText("authorization: super-secret cookie=abc token=xyz https://host.example/path?signature=leak leftover", 4000)
	for _, secret := range []string{"super-secret", "abc", "xyz", "signature=leak"} {
		if strings.Contains(got, secret) {
			t.Fatalf("redactText leaked %q: %s", secret, got)
		}
	}
	if !strings.Contains(got, "https://host.example/path") {
		t.Fatalf("redactText dropped safe URL host: %s", got)
	}
}

func readTestZIP(t *testing.T, data []byte) map[string]string {
	t.Helper()
	archive, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		t.Fatal(err)
	}
	files := make(map[string]string, len(archive.File))
	for _, file := range archive.File {
		reader, err := file.Open()
		if err != nil {
			t.Fatal(err)
		}
		content, readErr := io.ReadAll(reader)
		closeErr := reader.Close()
		if readErr != nil {
			t.Fatal(readErr)
		}
		if closeErr != nil {
			t.Fatal(closeErr)
		}
		files[file.Name] = string(content)
	}
	return files
}
