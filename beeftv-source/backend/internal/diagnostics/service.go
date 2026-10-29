package diagnostics

import (
	"context"
	"errors"
	"fmt"
	"infinite-canvas/backend/internal/buildinfo"
	"infinite-canvas/backend/internal/environment"
	"infinite-canvas/backend/internal/supporttrace"
	"slices"
	"strings"
	"time"

	"infinite-canvas/backend/internal/kernel"

	"gorm.io/gorm"
)

type Dependencies struct {
	TraceSource       supporttrace.Source
	AssistantEvidence AssistantEvidenceProvider
	DataDir           string
	UpdateLogDir      string
	Store             Store
	Brand             Brand
	Config            ModelConfigProvider
	Now               func() time.Time
	NewID             func() string
}

type Service struct {
	traceSource       supporttrace.Source
	assistantEvidence AssistantEvidenceProvider
	dataDir           string
	updateLogDir      string
	store             Store
	brand             Brand
	config            ModelConfigProvider
	now               func() time.Time
	newID             func() string
}

func New(deps Dependencies) *Service {
	now := deps.Now
	if now == nil {
		now = func() time.Time { return time.Now().UTC() }
	}
	newID := deps.NewID
	if newID == nil {
		newID = kernel.NewID
	}
	brand := deps.Brand
	if brand == nil {
		brand = staticBrand{name: defaultBrandName, slug: defaultBrandSlug}
	}
	return &Service{traceSource: deps.TraceSource, assistantEvidence: deps.AssistantEvidence, dataDir: deps.DataDir, store: deps.Store, brand: brand, config: deps.Config, now: now, newID: newID, updateLogDir: deps.UpdateLogDir}
}

func (s *Service) CheckEnvironment(ctx context.Context, repair bool) environment.Report {
	return environment.Inspect(ctx, s.dataDir, repair)
}

func (s *Service) Preview(userID string, req ExportRequest) (*Preview, error) {
	collection, err := s.collect(userID, req)
	if err != nil {
		return nil, err
	}
	updateBytes := 0
	if collection.UpdateLog != nil {
		updateBytes = len(collection.UpdateLog.Text) + 256
	}
	return &Preview{
		AssistantTurnCount: len(collection.AssistantTurns), AssistantEvidenceCount: len(collection.AssistantEvidence), BackendEventCount: len(collection.BackendEvents), ResourcesCount: len(collection.Resources), Collectors: collection.Collectors,
		UpdateLog:          collection.UpdateLog,
		ClientEventLimit:   maxClientEvents,
		CanvasBindingCount: len(collection.CanvasBindings),
		TaskCount:          len(collection.Tasks), TaskLogCount: len(collection.TaskLogs), APICallCount: len(collection.APICalls),
		EstimatedBytes: int64(2048 + updateBytes + len(collection.CanvasBindings)*600 + len(collection.ClientEvents)*420 + len(collection.Tasks)*620 + len(collection.TaskLogs)*700 + len(collection.APICalls)*520 + len(collection.BackendEvents)*400 + len(collection.AssistantTurns)*300 + len(collection.AssistantEvidence)*400 + len(collection.Resources)*320),
		WillTruncate:   collection.Truncated,
	}, nil
}

func (s *Service) Export(userID string, req ExportRequest) (*Bundle, error) {
	collection, err := s.collect(userID, req)
	if err != nil {
		return nil, err
	}
	bundleID := "DIAG_" + strings.ToUpper(s.newID()[:8])
	manifest := manifest{
		SchemaVersion: SchemaVersion, BundleID: bundleID, GeneratedAt: s.now().UTC(),
		AppVersion: collection.Runtime.AppVersion, BuildCommit: collection.Runtime.BuildCommit,
		TimeRange: timeRange{From: collection.Window.From, To: collection.Window.To},
		TaskID:    collection.TaskID, ProjectID: collection.ProjectID, Description: collection.Description,
		RedactionVersion: RedactionVersion, Truncated: collection.Truncated,
		Collectors: collection.Collectors, Counts: collection.counts(),
	}
	brandName, brandSlug := s.brand.NameAndSlug()
	if strings.TrimSpace(brandName) == "" {
		brandName = defaultBrandName
	}
	if strings.TrimSpace(brandSlug) == "" {
		brandSlug = defaultBrandSlug
	}
	data, err := buildBoundedZIP(brandName, bundleID, manifest, collection, maxBundleBytes)
	if err != nil {
		return nil, err
	}
	if len(data) > maxBundleBytes {
		return nil, kernel.BadAuthRequest("诊断包超过 10 MB，请缩短时间范围后重试")
	}
	fileName := fmt.Sprintf("%s-diagnostics-%s-%s.zip", brandSlug, s.now().UTC().Format("20060102-150405"), bundleID)
	return &Bundle{BundleID: bundleID, FileName: fileName, Data: data}, nil
}

func (s *Service) collect(userID string, req ExportRequest) (*collection, error) {
	if s == nil || s.store == nil || strings.TrimSpace(userID) == "" {
		return nil, kernel.Unauthorized("本地工作区尚未初始化")
	}
	window, err := s.normalizeWindow(req.From, req.To)
	if err != nil {
		return nil, err
	}
	taskID := strings.TrimSpace(req.TaskID)
	projectID := strings.TrimSpace(req.ProjectID)
	if len(taskID) > 96 || len(projectID) > 96 {
		return nil, kernel.BadAuthRequest("诊断上下文无效")
	}
	if taskID != "" {
		task, taskErr := s.store.TaskForUser(userID, taskID)
		if errors.Is(taskErr, gorm.ErrRecordNotFound) {
			return nil, kernel.BadAuthRequest("任务不存在或无权访问")
		}
		if taskErr != nil {
			return nil, taskErr
		}
		if task == nil {
			return nil, kernel.BadAuthRequest("任务不存在或无权访问")
		}
		if projectID != "" && task.ProjectID != projectID {
			return nil, kernel.BadAuthRequest("任务不属于当前项目")
		}
		if projectID == "" {
			projectID = task.ProjectID
		}
	} else if projectID != "" {
		if canvas, err := s.store.CanvasProjectForUser(userID, projectID); err != nil || canvas == nil {
			return nil, kernel.BadAuthRequest("画布不存在或无权访问")
		}
	}
	tasks, tasksErr := s.store.DiagnosticTasks(userID, window.From, window.To, taskID, projectID)
	taskLogs, logsErr := s.store.DiagnosticTaskLogs(userID, window.From, window.To, taskID, projectID)
	apiCalls, callsErr := s.store.DiagnosticAPICallLogs(userID, window.From, window.To, taskID, projectID)
	clientEvents := req.ClientEvents
	truncated := false
	if len(clientEvents) > maxClientEvents {
		clientEvents = clientEvents[len(clientEvents)-maxClientEvents:]
		truncated = true
	}
	collected := &collection{
		Collectors:  map[string]CollectorCoverage{},
		Environment: s.CheckEnvironment(context.Background(), false),
		Window:      window, Description: redactText(req.Description, maxDescription), TaskID: taskID, ProjectID: projectID, Truncated: truncated,
		Runtime: runtimeRecord{
			AppVersion: redactText(req.Runtime.AppVersion, 120), BuildCommit: redactText(req.Runtime.BuildCommit, 120),
			Browser: redactText(req.Runtime.Browser, 240), OS: redactText(req.Runtime.OS, 120), Timezone: redactText(req.Runtime.Timezone, 80),
			Capabilities: req.Runtime.Capabilities,
		},
	}
	collected.setCoverage("tasks", len(tasks), 100, tasksErr)
	collected.setCoverage("taskLogs", len(taskLogs), 2000, logsErr)
	collected.setCoverage("upstreamCalls", len(apiCalls), 1000, callsErr)
	if tasksErr != nil {
		tasks = nil
	}
	if logsErr != nil {
		taskLogs = nil
	}
	if callsErr != nil {
		apiCalls = nil
	}
	if len(tasks) > 100 {
		tasks = tasks[:100]
	}
	if len(taskLogs) > 2000 {
		taskLogs = taskLogs[:2000]
	}
	if len(apiCalls) > 1000 {
		apiCalls = apiCalls[:1000]
	}
	// Queries retain the newest page; export oldest-to-newest so byte-budget
	// reduction removes older bulk evidence first.
	slices.Reverse(tasks)
	slices.Reverse(taskLogs)
	slices.Reverse(apiCalls)
	if taskID != "" {
		for _, name := range []string{"tasks", "taskLogs", "upstreamCalls"} {
			coverage := collected.Collectors[name]
			coverage.Scope = "task_history"
			collected.Collectors[name] = coverage
		}
	}
	build := buildinfo.Current()
	if unknownBuild(collected.Runtime.AppVersion) {
		collected.Runtime.AppVersion = build.Version
	}
	if unknownBuild(collected.Runtime.BuildCommit) {
		collected.Runtime.BuildCommit = build.Commit
	}
	for _, event := range clientEvents {
		if !clientEventInScope(event, window, taskID, projectID) {
			continue
		}
		collected.ClientEvents = append(collected.ClientEvents, sanitizeClientEvent(event))
	}
	collected.collectClientCoverage(req.ClientCoverage, len(req.ClientEvents))
	for _, task := range tasks {
		collected.Tasks = append(collected.Tasks, sanitizeTask(task))
	}
	s.collectCanvasBindings(userID, tasks, collected)
	collected.setCoverage("canvasBindings", len(collected.CanvasBindings), 0, nil)
	canvasCoverage := collected.Collectors["canvasBindings"]
	canvasCoverage.Scope = "current_state"
	for _, binding := range collected.CanvasBindings {
		if binding.CanvasStatus == "unavailable" || binding.CanvasStatus == "invalid" {
			canvasCoverage.Status = "partial"
			canvasCoverage.Reason = "canvas_snapshot_unavailable"
		}
	}
	collected.Collectors["canvasBindings"] = canvasCoverage
	for _, taskLog := range taskLogs {
		collected.TaskLogs = append(collected.TaskLogs, sanitizeTaskLog(taskLog))
	}
	for _, apiCall := range apiCalls {
		collected.APICalls = append(collected.APICalls, sanitizeAPICall(apiCall))
	}
	// Best-effort: a missing or unreadable provider snapshot must not fail the
	// export the user is trying to send.
	if s.config != nil {
		body, readErr := s.config.ReadLocalModelConfig()
		collected.setCoverage("modelConfig", 0, 0, readErr)
		if readErr == nil {
			collected.ModelConfig = buildModelConfigSummary(body)
			if collected.ModelConfig == nil {
				collected.setCoverage("modelConfig", 0, 0, errors.New("invalid config"))
			} else {
				collected.setCoverage("modelConfig", 1, 0, nil)
			}
		}
	} else {
		collected.unavailable("modelConfig", "not_configured")
	}
	collected.UpdateLog = collectUpdateLog(s.updateLogDir, window)
	if collected.UpdateLog != nil && collected.UpdateLog.Truncated {
		collected.Truncated = true
	}
	collected.collectUpdateCoverage()
	s.collectAssistantEvidence(userID, collected)
	s.collectTraceEvidence(userID, collected)
	s.collectResourceEvidence(userID, tasks, collected)
	collected.setCoverage("environment", 1, 0, nil)
	if collected.collectionErr != nil {
		return nil, collected.collectionErr
	}
	collected.Findings = analyze(collected)
	return collected, nil
}

func (s *Service) normalizeWindow(fromRaw string, toRaw string) (timeWindow, error) {
	now := s.now().UTC()
	from, to := now.Add(-30*time.Minute), now
	var err error
	if strings.TrimSpace(fromRaw) != "" {
		from, err = time.Parse(time.RFC3339Nano, strings.TrimSpace(fromRaw))
		if err != nil {
			return timeWindow{}, kernel.BadAuthRequest("诊断开始时间格式无效")
		}
	}
	if strings.TrimSpace(toRaw) != "" {
		to, err = time.Parse(time.RFC3339Nano, strings.TrimSpace(toRaw))
		if err != nil {
			return timeWindow{}, kernel.BadAuthRequest("诊断结束时间格式无效")
		}
	}
	from, to = from.UTC(), to.UTC()
	if to.After(now) {
		to = now
	}
	if !to.After(from) {
		return timeWindow{}, kernel.BadAuthRequest("诊断时间范围无效")
	}
	if to.Sub(from) > maxWindow {
		return timeWindow{}, kernel.BadAuthRequest("诊断时间范围不能超过 24 小时")
	}
	return timeWindow{From: from, To: to}, nil
}
