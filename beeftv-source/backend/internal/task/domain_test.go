package task

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"infinite-canvas/backend/internal/generation"
	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

type memStore struct {
	mu     sync.Mutex
	tasks  map[string]model.Task
	byOp   map[string]string
	failDB atomic.Bool
	logs   []model.TaskLog
}

func newMemStore() *memStore {
	return &memStore{tasks: map[string]model.Task{}, byOp: map[string]string{}}
}

func opKey(userID, key string) string { return userID + "\x00" + key }

func (m *memStore) TaskForUser(userID, id string) (*model.Task, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	task, ok := m.tasks[id]
	if !ok || task.UserID != userID {
		return nil, errors.New("record not found")
	}
	copied := task
	return &copied, nil
}

func (m *memStore) TaskByClientOperation(userID, key string) (*model.Task, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	id, ok := m.byOp[opKey(userID, key)]
	if !ok {
		return nil, nil
	}
	task := m.tasks[id]
	copied := task
	return &copied, nil
}

func (m *memStore) ActiveTaskCount(userID string) (int64, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var n int64
	for _, task := range m.tasks {
		if task.UserID == userID && (task.Status == model.TaskStatusQueued || task.Status == model.TaskStatusRunning) {
			n++
		}
	}
	return n, nil
}

func (m *memStore) CreateWithLimit(task *model.Task, limit int) error {
	return m.CreateAdmitted(task, limit)
}

func (m *memStore) CreateAdmitted(task *model.Task, limit int) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.failDB.Load() {
		return errors.New("disk I/O error")
	}
	if task.ClientOperationID != nil && strings.TrimSpace(*task.ClientOperationID) != "" {
		if id, ok := m.byOp[opKey(task.UserID, *task.ClientOperationID)]; ok {
			return &repository.ClientOperationReplay{Task: m.tasks[id]}
		}
	}
	var active int
	for _, existing := range m.tasks {
		if existing.UserID == task.UserID && (existing.Status == model.TaskStatusQueued || existing.Status == model.TaskStatusRunning) {
			active++
		}
	}
	if active >= limit {
		return repository.ErrActiveTaskLimit
	}
	copied := *task
	m.tasks[copied.ID] = copied
	if copied.ClientOperationID != nil && strings.TrimSpace(*copied.ClientOperationID) != "" {
		m.byOp[opKey(copied.UserID, *copied.ClientOperationID)] = copied.ID
	}
	return nil
}

func (m *memStore) Retry(userID string, prepared *model.Task, limit int) (*model.Task, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	task, ok := m.tasks[prepared.ID]
	if !ok || task.UserID != userID {
		return nil, errors.New("record not found")
	}
	if task.Status != model.TaskStatusFailed && task.Status != model.TaskStatusCancelled {
		return nil, repository.ErrTaskNotRetryable
	}
	var active int
	for _, existing := range m.tasks {
		if existing.UserID == userID && (existing.Status == model.TaskStatusQueued || existing.Status == model.TaskStatusRunning) {
			active++
		}
	}
	if active >= limit {
		return nil, repository.ErrActiveTaskLimit
	}
	task.Status = model.TaskStatusQueued
	task.Stage = "等待队列调度"
	task.Progress = 5
	task.Error = ""
	task.InputJSON = prepared.InputJSON
	task.Model = prepared.Model
	task.Provider = prepared.Provider
	m.tasks[task.ID] = task
	copied := task
	return &copied, nil
}

func (m *memStore) CancelIfStatus(userID, id string, expected model.TaskStatus, now time.Time) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	task, ok := m.tasks[id]
	if !ok || task.UserID != userID || task.Status != expected {
		return false, nil
	}
	task.Status = model.TaskStatusCancelled
	task.Stage = "任务已取消"
	task.Error = "任务已取消"
	task.CompletedAt = &now
	m.tasks[id] = task
	return true, nil
}

func (m *memStore) List(userID string, limit int, projectID string, activeOnly bool) ([]model.Task, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []model.Task
	for _, task := range m.tasks {
		if task.UserID != userID {
			continue
		}
		if projectID != "" && task.ProjectID != projectID {
			continue
		}
		if activeOnly && task.Status != model.TaskStatusQueued && task.Status != model.TaskStatusRunning {
			continue
		}
		out = append(out, task)
	}
	if limit > 0 && len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}

func (m *memStore) Logs(userID, id string) ([]model.TaskLog, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]model.TaskLog(nil), m.logs...), nil
}

func (m *memStore) LatestProviderRequestID(taskID string) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	task, ok := m.tasks[taskID]
	if !ok {
		return "", errors.New("record not found")
	}
	return task.ProviderRequestID, nil
}

type passCatalog struct{}

func (passCatalog) Select(_ string, req SelectRequest) (SelectResult, error) {
	return SelectResult{Input: req.Input}, nil
}
func (passCatalog) PrepareRetry(*model.Task, map[string]any) error { return nil }
func (passCatalog) RequireCustomChannels(map[string]any) error     { return nil }
func (passCatalog) ValidateCapability(map[string]any) error        { return nil }
func (passCatalog) HasExecutableVideoConfig(map[string]any) bool   { return true }

type staticPolicy struct{ limit int }

func (p staticPolicy) ActiveTaskLimit() (int, error) { return p.limit, nil }

type drainRuntime struct {
	draining atomic.Bool
	stopped  atomic.Value
	dispatch atomic.Int32
}

func (r *drainRuntime) IsDraining() bool { return r.draining.Load() }
func (r *drainRuntime) StopLocalWait(taskID string) {
	r.stopped.Store(taskID)
}
func (r *drainRuntime) Dispatch(fn func()) bool {
	r.dispatch.Add(1)
	go fn()
	return true
}

type imageGuard struct{ err error }

func (g imageGuard) ValidateRetry(*model.Task) error { return g.err }

type failClass struct {
	block      bool
	moderation bool
	category   generation.FailureCategory
	message    string
}

func (f failClass) BlocksRetry(string, string) bool                    { return f.block }
func (f failClass) IsModeration(string) bool                           { return f.moderation }
func (f failClass) Category(string, string) generation.FailureCategory { return f.category }
func (f failClass) UserMessage(string) string {
	if f.message != "" {
		return f.message
	}
	return "任务失败"
}

type flagReplay struct{}

func (flagReplay) IsRequest(input map[string]any) bool {
	value, ok := input["replay"]
	if !ok {
		return false
	}
	switch v := value.(type) {
	case bool:
		return v
	case string:
		return strings.EqualFold(strings.TrimSpace(v), "true")
	default:
		return false
	}
}

func (flagReplay) Finalize(string, model.TaskStatus) error { return nil }

type allowMedia struct{}

type blockedTransportMedia struct{ allowMedia }

func (blockedTransportMedia) ValidateTransport(string, map[string]any) error {
	return &kernel.AppError{Status: 400, Code: 400, Reason: "reference_media_requires_url", Message: "当前渠道需要在线素材链接：参考图片 1无法直接读取"}
}

func TestMediaTransportRejectedBeforeQueueAndOnFreshRetry(t *testing.T) {
	store := newMemStore()
	svc := domainService(store, func(d *Dependencies) { d.Media = blockedTransportMedia{} })
	_, err := svc.CreateTask("user", imageReq("draw", "transport-test"))
	if err == nil || len(store.tasks) != 0 {
		t.Fatalf("task queued: err=%v tasks=%d", err, len(store.tasks))
	}
	store.tasks["failed"] = model.Task{ID: "failed", UserID: "user", Type: "canvas_image", Status: model.TaskStatusFailed, InputJSON: `{"mode":"image"}`}
	if _, err := svc.Retry("user", "failed"); err == nil {
		t.Fatal("retry queued")
	}
	if store.tasks["failed"].Status != model.TaskStatusFailed {
		t.Fatal("rejected retry changed task")
	}
}

func (allowMedia) ContainsInlineData(map[string]any) bool         { return false }
func (allowMedia) ValidateTransport(string, map[string]any) error { return nil }

type rejectMedia struct{}

func (rejectMedia) ContainsInlineData(map[string]any) bool         { return true }
func (rejectMedia) ValidateTransport(string, map[string]any) error { return nil }

type allowProjects struct{}

func (allowProjects) EnsureActive(string, string) error { return nil }

type scopeProjects struct{ err error }

func (p scopeProjects) EnsureActive(string, string) error { return p.err }

type passSecrets struct{}

func (passSecrets) ResolveManaged(input map[string]any) (map[string]any, error) {
	return input, nil
}
func (passSecrets) Protect(map[string]any) error { return nil }
func (passSecrets) DecryptInputJSON(raw string) (string, error) {
	return raw, nil
}

type poisonCatalog struct{ passCatalog }

func (poisonCatalog) Select(_ string, req SelectRequest) (SelectResult, error) {
	return SelectResult{Input: map[string]any{
		"replay": true,
		"prompt": req.Input["prompt"],
		"bad":    make(chan int),
	}}, nil
}

type captureProvider struct {
	mu   sync.Mutex
	ids  []string
	err  error
	wait chan struct{}
}

func (p *captureProvider) RequestCancel(_ context.Context, task *model.Task) error {
	p.mu.Lock()
	p.ids = append(p.ids, task.ID)
	p.mu.Unlock()
	if p.wait != nil {
		<-p.wait
	}
	return p.err
}

type identityPresent struct{}

func (identityPresent) Task(task model.Task) *model.Task { copied := task; return &copied }
func (identityPresent) Summaries(tasks []model.Task) []Summary {
	out := make([]Summary, 0, len(tasks))
	for _, task := range tasks {
		out = append(out, Summary{ID: task.ID, Status: task.Status, Type: task.Type, Prompt: task.Prompt})
	}
	return out
}
func (identityPresent) Logs(logs []model.TaskLog) []model.TaskLog { return logs }

func domainService(store *memStore, extra func(*Dependencies)) *Service {
	runtime := &drainRuntime{}
	deps := Dependencies{
		Catalog:    passCatalog{},
		Secrets:    passSecrets{},
		Media:      allowMedia{},
		Projects:   allowProjects{},
		Policy:     staticPolicy{limit: 8},
		Persist:    store,
		Runtime:    runtime,
		Images:     imageGuard{},
		Failures:   failClass{},
		TextReplay: flagReplay{},
		Present:    identityPresent{},
		NewID: func() string {
			return kernel.NewID()
		},
		Now: time.Now,
	}
	if extra != nil {
		extra(&deps)
	}
	return NewService(store, deps)
}

func imageReq(prompt, op string) CreateRequest {
	return CreateRequest{
		Type: "canvas_image", Prompt: prompt, ProjectID: "canvas-1",
		Input: map[string]any{"metadata": map[string]any{"clientOperationId": op}},
	}
}

func textReplayReq(prompt, op string) CreateRequest {
	input := map[string]any{"replay": true, "mode": "text", "prompt": prompt}
	if op != "" {
		input["metadata"] = map[string]any{"clientOperationId": op}
	}
	return CreateRequest{Type: "canvas_text", Prompt: prompt, ProjectID: "canvas-1", Input: input}
}

func TestCreateRequestOmitsTrustedAdmissionFields(t *testing.T) {
	raw, err := json.Marshal(CreateRequest{Prompt: "p", Type: "canvas_image", AdmissionID: "trusted", PrepareOnly: true})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "trusted") || strings.Contains(string(raw), "Admission") || strings.Contains(strings.ToLower(string(raw)), "prepare") {
		t.Fatalf("trusted fields leaked into JSON: %s", raw)
	}
}

func TestConcurrentDuplicateAdmissionReplaysSameTask(t *testing.T) {
	store := newMemStore()
	started := make(chan struct{})
	var entered atomic.Int32
	svc := domainService(store, func(deps *Dependencies) {
		deps.Persist = delayedPersist{inner: store, started: started, entered: &entered}
	})
	req := imageReq("a cat", "proposal:gp-1:node-1")
	var first, second *model.Task
	var err1, err2 error
	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); first, err1 = svc.CreateTask("user", req) }()
	go func() { defer wg.Done(); second, err2 = svc.CreateTask("user", req) }()
	<-started
	<-started
	close(started)
	wg.Wait()
	if err1 != nil || err2 != nil {
		t.Fatalf("create errors: %v %v", err1, err2)
	}
	if first.ID == "" || first.ID != second.ID {
		t.Fatalf("concurrent admit ids = %q %q", first.ID, second.ID)
	}
	listed, err := store.List("user", 10, "", false)
	if err != nil || len(listed) != 1 {
		t.Fatalf("stored tasks = %d err=%v", len(listed), err)
	}
}

type delayedPersist struct {
	inner   *memStore
	started chan struct{}
	entered *atomic.Int32
}

func (d delayedPersist) CreateAdmitted(task *model.Task, limit int) error {
	d.started <- struct{}{}
	if d.entered.Add(1) == 1 {
		time.Sleep(20 * time.Millisecond)
	}
	return d.inner.CreateAdmitted(task, limit)
}

func TestMismatchedClientOperationPayloadIsConflict(t *testing.T) {
	store := newMemStore()
	svc := domainService(store, nil)
	req := imageReq("a cat", "proposal:gp-1:node-1")
	created, err := svc.CreateTask("user", req)
	if err != nil {
		t.Fatal(err)
	}
	_, err = svc.CreateTask("user", imageReq("a dog", "proposal:gp-1:node-1"))
	if err == nil || !strings.Contains(err.Error(), "不同内容") {
		t.Fatalf("conflict error = %v", err)
	}
	var appErr *kernel.AppError
	if !errors.As(err, &appErr) || appErr.Status != 409 {
		t.Fatalf("conflict status = %v", err)
	}
	listed, _ := store.List("user", 10, "", false)
	if len(listed) != 1 || listed[0].ID != created.ID {
		t.Fatalf("conflict created a task: %+v", listed)
	}
}

func TestDBFaultDoesNotAcceptATask(t *testing.T) {
	store := newMemStore()
	store.failDB.Store(true)
	svc := domainService(store, nil)
	_, err := svc.CreateTask("user", imageReq("a cat", "proposal:gp-1:node-2"))
	if err == nil {
		t.Fatal("expected storage failure")
	}
	var appErr *kernel.AppError
	if !errors.As(err, &appErr) || appErr.Reason != LocalStorageFailedReason {
		t.Fatalf("error = %v", err)
	}
	if !strings.Contains(err.Error(), "尚未提交生成") {
		t.Fatalf("user message = %v", err)
	}
	listed, _ := store.List("user", 10, "", false)
	if len(listed) != 0 {
		t.Fatalf("accepted tasks after DB fault: %+v", listed)
	}
}

func TestForeignOwnerCannotReplayOrMutate(t *testing.T) {
	store := newMemStore()
	svc := domainService(store, nil)
	created, err := svc.CreateTask("owner", imageReq("a cat", "proposal:gp-1:node-3"))
	if err != nil {
		t.Fatal(err)
	}
	replay, err := svc.CreateTask("intruder", imageReq("a cat", "proposal:gp-1:node-3"))
	if err != nil {
		t.Fatal(err)
	}
	if replay.ID == created.ID {
		t.Fatal("foreign caller reused another owner's client operation")
	}
	if _, err := svc.Get("intruder", created.ID); err == nil {
		t.Fatal("foreign caller read another owner's task")
	}
	if _, err := svc.Retry("intruder", created.ID); err == nil {
		t.Fatal("foreign caller retried another owner's task")
	}
	if _, err := svc.Cancel(context.Background(), "intruder", created.ID); err == nil {
		t.Fatal("foreign caller cancelled another owner's task")
	}
}

func TestRetiredOperationsAreRejectedAndHistoryKept(t *testing.T) {
	store := newMemStore()
	svc := domainService(store, nil)
	for _, req := range []CreateRequest{
		{Type: "canvas_text", Operation: "cloud_agent", Prompt: "帮我改画布"},
		{Type: "canvas_text", Operation: "agent_memory_compact", Prompt: "压缩"},
		{Type: "canvas_text", Prompt: "帮我改画布", Input: map[string]any{"cloudAgent": map[string]any{"version": 1}}},
	} {
		if _, err := svc.CreateTask("user", req); err == nil || !strings.Contains(err.Error(), "已下线") {
			t.Fatalf("retired create error = %v for %#v", err, req)
		}
	}
	if listed, _ := store.List("user", 10, "", false); len(listed) != 0 {
		t.Fatalf("retired create wrote tasks: %+v", listed)
	}
	now := time.Now()
	legacy := model.Task{
		ID: "legacy-agent-failed", UserID: "user", Type: "canvas_text", Operation: RetiredCloudAgentPrefix,
		Status: model.TaskStatusFailed, Error: "上一版失败原因", Prompt: "帮我改画布", CreatedAt: now, UpdatedAt: now,
	}
	store.tasks[legacy.ID] = legacy
	if _, err := svc.Retry("user", legacy.ID); err == nil || !strings.Contains(err.Error(), "已下线") {
		t.Fatalf("retired retry error = %v", err)
	}
	stored, _ := store.TaskForUser("user", legacy.ID)
	if stored.Status != model.TaskStatusFailed || stored.Error != "上一版失败原因" {
		t.Fatalf("historical row mutated: %+v", stored)
	}
	trusted, err := svc.CreateTask("user", CreateRequest{
		Type: "canvas_text", Operation: "cloud_agent", Prompt: "internal", AdmissionID: "trusted-id",
	})
	if err != nil {
		t.Fatalf("trusted admission should bypass public retired gate: %v", err)
	}
	if trusted.ID != "trusted-id" {
		t.Fatalf("admission id = %s", trusted.ID)
	}
}

func TestDrainRejectsCreateAndRetry(t *testing.T) {
	store := newMemStore()
	runtime := &drainRuntime{}
	runtime.draining.Store(true)
	svc := domainService(store, func(deps *Dependencies) { deps.Runtime = runtime })
	_, err := svc.CreateTask("user", imageReq("a cat", "proposal:gp-1:drain"))
	if !isStatus(err, 503) {
		t.Fatalf("create drain error = %v", err)
	}
	if listed, _ := store.List("user", 10, "", false); len(listed) != 0 {
		t.Fatal("drain created a task")
	}
	_, err = svc.Retry("user", "missing")
	if !isStatus(err, 503) {
		t.Fatalf("retry drain error = %v", err)
	}
}

func TestRetryUnknownAcceptanceAndImageReceiptStayOnOriginalTask(t *testing.T) {
	store := newMemStore()
	svc := domainService(store, func(deps *Dependencies) {
		deps.Images = imageGuard{err: kernel.BadAuthRequest("图片请求可能已经生成，请保留任务记录并联系支持查询结果，不要重复提交")}
		deps.Failures = failClass{block: true, category: generation.CategorySubmissionUncertain}
	})
	task := model.Task{
		ID: "img-1", UserID: "user", Type: "canvas_image", Status: model.TaskStatusFailed,
		Stage: "submission_unknown", Error: "提交结果尚未确认", Prompt: "cat",
	}
	store.tasks[task.ID] = task
	if _, err := svc.Retry("user", task.ID); err == nil || !strings.Contains(err.Error(), "不要重复提交") && !strings.Contains(err.Error(), "尚未确认") {
		t.Fatalf("retry unknown acceptance error = %v", err)
	}
	stored, _ := store.TaskForUser("user", task.ID)
	if stored.Status != model.TaskStatusFailed {
		t.Fatalf("retry mutated uncertain task: %+v", stored)
	}
}

func TestCancelStopsLocalWaitAndDoesNotMintProviderRequest(t *testing.T) {
	store := newMemStore()
	runtime := &drainRuntime{}
	provider := &captureProvider{wait: make(chan struct{})}
	svc := domainService(store, func(deps *Dependencies) {
		deps.Runtime = runtime
		deps.Provider = provider
	})
	task := model.Task{
		ID: "run-1", UserID: "user", Type: "canvas_image", Status: model.TaskStatusRunning,
		ProviderRequestID: "upstream-1", Prompt: "cat",
	}
	store.tasks[task.ID] = task
	cancelled, err := svc.Cancel(context.Background(), "user", task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if cancelled.Status != model.TaskStatusCancelled {
		t.Fatalf("status = %s", cancelled.Status)
	}
	if runtime.stopped.Load() != "run-1" {
		t.Fatalf("local wait not stopped: %v", runtime.stopped.Load())
	}
	close(provider.wait)
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		provider.mu.Lock()
		n := len(provider.ids)
		provider.mu.Unlock()
		if n == 1 {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	provider.mu.Lock()
	defer provider.mu.Unlock()
	if len(provider.ids) != 1 || provider.ids[0] != "run-1" {
		t.Fatalf("provider cancel = %#v", provider.ids)
	}
}

func TestCancelRejectedForTerminalUnknownAcceptance(t *testing.T) {
	store := newMemStore()
	svc := domainService(store, nil)
	task := model.Task{
		ID: "failed-unknown", UserID: "user", Type: "canvas_image", Status: model.TaskStatusFailed,
		Stage: "submission_unknown", ProviderRequestID: "upstream-9",
	}
	store.tasks[task.ID] = task
	_, err := svc.Cancel(context.Background(), "user", task.ID)
	if err == nil || !strings.Contains(err.Error(), "无法取消") {
		t.Fatalf("cancel error = %v", err)
	}
	stored, _ := store.TaskForUser("user", task.ID)
	if stored.Status != model.TaskStatusFailed || stored.ProviderRequestID != "upstream-9" {
		t.Fatalf("terminal task mutated: %+v", stored)
	}
}

func TestPrepareOnlyDoesNotPersist(t *testing.T) {
	store := newMemStore()
	svc := domainService(store, nil)
	task, err := svc.CreateTask("user", CreateRequest{Type: "canvas_image", Prompt: "quote", PrepareOnly: true})
	if err != nil {
		t.Fatal(err)
	}
	if task.ID == "" || task.Status != model.TaskStatusQueued {
		t.Fatalf("prepared = %+v", task)
	}
	if listed, _ := store.List("user", 10, "", false); len(listed) != 0 {
		t.Fatalf("prepare-only persisted: %+v", listed)
	}
}

func TestTextReplayReplaysSameClientOperation(t *testing.T) {
	store := newMemStore()
	svc := domainService(store, nil)
	req := textReplayReq("hello", "proposal:text:node-1")
	first, err := svc.CreateTask("user", req)
	if err != nil {
		t.Fatal(err)
	}
	if first.Status != model.TaskStatusTextReplay {
		t.Fatalf("status = %s", first.Status)
	}
	if first.ClientOperationID == nil || *first.ClientOperationID != "proposal:text:node-1" || first.ClientOperationHash == "" {
		t.Fatalf("client operation not stored: %+v", first)
	}
	replay, err := svc.CreateTask("user", req)
	if err != nil {
		t.Fatal(err)
	}
	if replay.ID != first.ID {
		t.Fatalf("replay id = %s want %s", replay.ID, first.ID)
	}
	_, err = svc.CreateTask("user", textReplayReq("other", "proposal:text:node-1"))
	if err == nil || !strings.Contains(err.Error(), "不同内容") {
		t.Fatalf("conflict error = %v", err)
	}
	listed, _ := store.List("user", 10, "", false)
	if len(listed) != 1 || listed[0].ID != first.ID {
		t.Fatalf("stored tasks = %+v", listed)
	}
}

func TestConcurrentTextReplayAdmissionReplaysSameTask(t *testing.T) {
	store := newMemStore()
	started := make(chan struct{})
	var entered atomic.Int32
	svc := domainService(store, func(deps *Dependencies) {
		deps.Persist = delayedPersist{inner: store, started: started, entered: &entered}
	})
	req := textReplayReq("hello", "proposal:text:node-concurrent")
	var first, second *model.Task
	var err1, err2 error
	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); first, err1 = svc.CreateTask("user", req) }()
	go func() { defer wg.Done(); second, err2 = svc.CreateTask("user", req) }()
	<-started
	<-started
	close(started)
	wg.Wait()
	if err1 != nil || err2 != nil {
		t.Fatalf("create errors: %v %v", err1, err2)
	}
	if first.ID == "" || first.ID != second.ID {
		t.Fatalf("concurrent admit ids = %q %q", first.ID, second.ID)
	}
	listed, err := store.List("user", 10, "", false)
	if err != nil || len(listed) != 1 {
		t.Fatalf("stored tasks = %d err=%v", len(listed), err)
	}
	if listed[0].Status != model.TaskStatusTextReplay || listed[0].ClientOperationHash == "" {
		t.Fatalf("stored replay = %+v", listed[0])
	}
}

func TestTextReplayRejectsForeignDeletedArchivedScope(t *testing.T) {
	cases := []struct {
		name string
		err  error
	}{
		{"foreign", kernel.Forbidden("无权使用该项目")},
		{"deleted", kernel.NotFound("项目不存在")},
		{"archived", kernel.BadAuthRequest("项目已归档，无法创建生成任务")},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			store := newMemStore()
			svc := domainService(store, func(deps *Dependencies) {
				deps.Projects = scopeProjects{err: tc.err}
			})
			_, err := svc.CreateTask("user", textReplayReq("hello", "proposal:text:"+tc.name))
			if err == nil || err.Error() != tc.err.Error() {
				t.Fatalf("error = %v want %v", err, tc.err)
			}
			if listed, _ := store.List("user", 10, "", false); len(listed) != 0 {
				t.Fatalf("persisted after %s: %+v", tc.name, listed)
			}
		})
	}
}

func TestTextReplayPrepareOnlyDoesNotPersist(t *testing.T) {
	store := newMemStore()
	svc := domainService(store, nil)
	task, err := svc.CreateTask("user", CreateRequest{
		Type: "canvas_text", Prompt: "quote", PrepareOnly: true, ProjectID: "canvas-1",
		Input: map[string]any{"replay": true, "metadata": map[string]any{"clientOperationId": "proposal:text:prepare"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if task.Status != model.TaskStatusTextReplay || task.ClientOperationID == nil || task.ClientOperationHash == "" {
		t.Fatalf("prepared replay = %+v", task)
	}
	if listed, _ := store.List("user", 10, "", false); len(listed) != 0 {
		t.Fatalf("prepare-only persisted: %+v", listed)
	}
}

func TestTextReplayRejectsUnserializableInput(t *testing.T) {
	store := newMemStore()
	svc := domainService(store, func(deps *Dependencies) { deps.Catalog = poisonCatalog{} })
	_, err := svc.CreateTask("user", textReplayReq("hello", "proposal:text:poison"))
	if err == nil || !strings.Contains(err.Error(), "序列化任务输入失败") {
		t.Fatalf("marshal error = %v", err)
	}
	if listed, _ := store.List("user", 10, "", false); len(listed) != 0 {
		t.Fatalf("persisted unserializable input: %+v", listed)
	}
}

func TestLegacyCanvasTextWithoutReplayStaysQueued(t *testing.T) {
	store := newMemStore()
	svc := domainService(store, nil)
	task, err := svc.CreateTask("user", CreateRequest{
		Type: "canvas_text", Prompt: "hello", ProjectID: "canvas-1",
		Input: map[string]any{"mode": "text", "textOptions": map[string]any{"stream": true}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if task.Status != model.TaskStatusQueued {
		t.Fatalf("legacy text status = %s", task.Status)
	}
	stored, err := store.TaskForUser("user", task.ID)
	if err != nil || stored.Status != model.TaskStatusQueued {
		t.Fatalf("stored = %+v err=%v", stored, err)
	}
}

func TestAdmitFailsClosedWhenSecurityCollaboratorsMissing(t *testing.T) {
	ports := []struct {
		name  string
		clear func(*Dependencies)
	}{
		{"catalog", func(d *Dependencies) { d.Catalog = nil }},
		{"secrets", func(d *Dependencies) { d.Secrets = nil }},
		{"media", func(d *Dependencies) { d.Media = nil }},
		{"projects", func(d *Dependencies) { d.Projects = nil }},
		{"policy", func(d *Dependencies) { d.Policy = nil }},
		{"runtime", func(d *Dependencies) { d.Runtime = nil }},
		{"textReplay", func(d *Dependencies) { d.TextReplay = nil }},
	}
	for _, tc := range ports {
		t.Run(tc.name, func(t *testing.T) {
			store := newMemStore()
			svc := domainService(store, tc.clear)
			_, err := svc.CreateTask("user", imageReq("a cat", "proposal:gp-1:"+tc.name))
			if err == nil || !strings.Contains(err.Error(), "任务服务不可用") {
				t.Fatalf("%s missing error = %v", tc.name, err)
			}
			if listed, _ := store.List("user", 10, "", false); len(listed) != 0 {
				t.Fatalf("%s missing persisted: %+v", tc.name, listed)
			}
		})
	}
}

func TestPersistedOutputsFailClosedWithoutPresenter(t *testing.T) {
	store := newMemStore()
	svc := domainService(store, func(deps *Dependencies) { deps.Present = nil })
	created, err := svc.CreateTask("user", imageReq("a cat", "proposal:gp-1:present"))
	if err == nil || created != nil || !strings.Contains(err.Error(), "任务服务不可用") {
		t.Fatalf("create without presenter = %v %v", created, err)
	}
	if listed, _ := store.List("user", 10, "", false); len(listed) != 0 {
		t.Fatalf("create persisted before present: %+v", listed)
	}
	store.tasks["secret-1"] = model.Task{
		ID: "secret-1", UserID: "user", Type: "canvas_image", Status: model.TaskStatusQueued,
		InputJSON: `{"apiKey":"sk-live","headers":{"Authorization":"Bearer secret"}}`,
	}
	got, err := svc.Get("user", "secret-1")
	if err == nil || got != nil {
		t.Fatalf("get leaked task = %+v err=%v", got, err)
	}
	if got != nil && strings.Contains(got.InputJSON, "sk-live") {
		t.Fatal("get returned raw credentials")
	}
	summaries, err := svc.TasksWithOptions("user", ListOptions{Limit: 10})
	if err == nil || summaries != nil {
		t.Fatalf("list without presenter = %#v err=%v", summaries, err)
	}
	logs, err := svc.Logs("user", "secret-1")
	if err == nil || logs != nil {
		t.Fatalf("logs without presenter = %#v err=%v", logs, err)
	}
}

func TestPrepareOnlyDoesNotRequirePresenterOrPersist(t *testing.T) {
	store := newMemStore()
	svc := domainService(store, func(deps *Dependencies) {
		deps.Present = nil
		deps.Persist = nil
	})
	task, err := svc.CreateTask("user", CreateRequest{Type: "canvas_image", Prompt: "quote", PrepareOnly: true})
	if err != nil {
		t.Fatal(err)
	}
	if task.Status != model.TaskStatusQueued || task.InputJSON == "" {
		t.Fatalf("prepared = %+v", task)
	}
	if listed, _ := store.List("user", 10, "", false); len(listed) != 0 {
		t.Fatalf("prepare-only persisted: %+v", listed)
	}
}

func TestRetryFailsClosedWhenCollaboratorsMissing(t *testing.T) {
	ports := []struct {
		name  string
		clear func(*Dependencies)
	}{
		{"runtime", func(d *Dependencies) { d.Runtime = nil }},
		{"images", func(d *Dependencies) { d.Images = nil }},
		{"failures", func(d *Dependencies) { d.Failures = nil }},
		{"secrets", func(d *Dependencies) { d.Secrets = nil }},
		{"catalog", func(d *Dependencies) { d.Catalog = nil }},
		{"policy", func(d *Dependencies) { d.Policy = nil }},
		{"projects", func(d *Dependencies) { d.Projects = nil }},
		{"present", func(d *Dependencies) { d.Present = nil }},
	}
	for _, tc := range ports {
		t.Run(tc.name, func(t *testing.T) {
			store := newMemStore()
			store.tasks["fail-1"] = model.Task{
				ID: "fail-1", UserID: "user", Type: "canvas_image", Status: model.TaskStatusFailed,
				InputJSON: `{"prompt":"cat"}`, Prompt: "cat",
			}
			svc := domainService(store, tc.clear)
			_, err := svc.Retry("user", "fail-1")
			if err == nil || !strings.Contains(err.Error(), "任务服务不可用") {
				t.Fatalf("%s missing retry error = %v", tc.name, err)
			}
			stored, _ := store.TaskForUser("user", "fail-1")
			if stored.Status != model.TaskStatusFailed {
				t.Fatalf("%s missing mutated retry: %+v", tc.name, stored)
			}
		})
	}
}

func TestTextReplayInlineMediaRejected(t *testing.T) {
	store := newMemStore()
	svc := domainService(store, func(deps *Dependencies) { deps.Media = rejectMedia{} })
	_, err := svc.CreateTask("user", textReplayReq("hello", "proposal:text:media"))
	if err == nil || !strings.Contains(err.Error(), "内嵌媒体") {
		t.Fatalf("media error = %v", err)
	}
	if listed, _ := store.List("user", 10, "", false); len(listed) != 0 {
		t.Fatalf("inline media persisted: %+v", listed)
	}
}

func isStatus(err error, status int) bool {
	var appErr *kernel.AppError
	return errors.As(err, &appErr) && appErr.Status == status
}
