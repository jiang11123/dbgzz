package workflow

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"infinite-canvas/backend/internal/model"
)

type scriptedExecutor struct {
	mu      sync.Mutex
	calls   []Request
	handler func(req Request) ([]byte, string, error)
}

func (s *scriptedExecutor) Execute(ctx context.Context, req Request) ([]byte, string, error) {
	if err := ctx.Err(); err != nil {
		return nil, "", err
	}
	s.mu.Lock()
	s.calls = append(s.calls, req)
	s.mu.Unlock()
	return s.handler(req)
}

func (s *scriptedExecutor) paths() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	paths := make([]string, 0, len(s.calls))
	for _, call := range s.calls {
		paths = append(paths, call.URL)
	}
	return paths
}

type stubMedia struct{}

func (stubMedia) LocalBytes(media Media) ([]byte, string, error) {
	if strings.HasPrefix(media.DataURL, "data:") {
		mimeType, data, err := decodeDataURL(media.DataURL)
		return data, mimeType, err
	}
	return nil, "", errors.New("后端任务队列需要 data URL 形式的本地参考素材")
}

type immediatePoller struct{}

func (immediatePoller) Poll(ctx context.Context, _ string, _ PollPolicy, query func(context.Context) (PollOutcome, error)) (map[string]interface{}, error) {
	for {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		out, err := query(ctx)
		if err != nil {
			return nil, err
		}
		if out.Done {
			return out.Result, nil
		}
	}
}

func (immediatePoller) Download(ctx context.Context, _ string, _ PollPolicy, source BinarySource, _ func(context.Context) (BinarySource, error)) ([]byte, string, error) {
	return source.Read(ctx)
}

type cancelSleep struct{ DefaultTimePolicy }

func (cancelSleep) Sleep(context.Context, time.Duration) error { return context.Canceled }

type denyPlugin struct{ err error }

func (d denyPlugin) EnsureEnabled(context.Context, string) error { return d.err }

type allowPlugin struct{}

func (allowPlugin) EnsureEnabled(context.Context, string) error { return nil }

type memoryReceipt struct {
	mu           sync.Mutex
	accepted     []string
	failAccepted error
	failReady    error
}

func (m *memoryReceipt) Ready(context.Context) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.failReady
}

func (m *memoryReceipt) RecordAccepted(_ context.Context, requestID, _ string, _ *time.Time) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.failAccepted != nil {
		return m.failAccepted
	}
	m.accepted = append(m.accepted, requestID)
	return nil
}

func (m *memoryReceipt) UpdateStage(context.Context, string, string, *time.Time) error { return nil }

func (m *memoryReceipt) acceptedIDs() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]string, len(m.accepted))
	copy(out, m.accepted)
	return out
}

func imageCreateInput() Input {
	return Input{
		Mode: "image",
		Config: Config{
			InterfaceType: string(model.ChannelInterfaceRunningHubImage),
			BaseURL:       "https://www.runninghub.cn",
			APIKey:        "k",
			WorkflowID:    "wf-1",
			WorkflowJSON:  map[string]interface{}{"1": map[string]interface{}{"class_type": "Note", "inputs": map[string]interface{}{}}},
		},
	}
}

func productionClient(exec RequestExecutor, extras ...any) *Client {
	client := &Client{
		Requests: exec,
		Media:    stubMedia{},
		Receipt:  &memoryReceipt{},
		Plugins:  allowPlugin{},
		Poller:   immediatePoller{},
	}
	for _, extra := range extras {
		switch value := extra.(type) {
		case Receipt:
			client.Receipt = value
		case PluginAvailability:
			client.Plugins = value
		case TimePolicy:
			client.Time = value
		case VideoPoller:
			client.Poller = value
		case MediaLoader:
			client.Media = value
		}
	}
	return client
}

func pngJSON() []byte {
	return []byte(`{"code":0,"data":[{"fileUrl":"https://rh-images.xiaoyaoyou.com/out.png"}]}`)
}

func TestRunResumesOriginalAcceptedTaskWithoutCreate(t *testing.T) {
	exec := &scriptedExecutor{handler: func(req Request) ([]byte, string, error) {
		if strings.Contains(req.URL, "/task/openapi/create") || strings.Contains(req.URL, "/ai-app/run") {
			t.Fatal("resume must not create a new upstream task")
		}
		if strings.Contains(req.URL, "/task/openapi/outputs") {
			body, _ := json.Marshal(map[string]any{"apiKey": "k", "taskId": "orig-9"})
			if string(req.Body) != string(body) {
				t.Fatalf("poll body = %s", req.Body)
			}
			return pngJSON(), "application/json", nil
		}
		if strings.HasSuffix(req.URL, "/out.png") {
			return []byte("PNGDATA"), "image/png", nil
		}
		t.Fatalf("unexpected URL %s", req.URL)
		return nil, "", nil
	}}
	client := productionClient(exec)
	client.Receipt = nil
	result, err := client.RunRunningHub(context.Background(), Input{
		Mode:             "image",
		ResumedRequestID: "orig-9",
		Config: Config{
			InterfaceType: string(model.ChannelInterfaceRunningHubImage),
			BaseURL:       "https://www.runninghub.cn",
			APIKey:        "k",
			WorkflowID:    "wf-1",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if result["mode"] != "image" {
		t.Fatalf("result = %#v", result)
	}
	if len(exec.paths()) == 0 {
		t.Fatal("expected poll/download calls")
	}
}

func TestCreateOmitsCodeButReturnsTaskIDThenPollsOriginal(t *testing.T) {
	creates := 0
	exec := &scriptedExecutor{handler: func(req Request) ([]byte, string, error) {
		switch {
		case strings.Contains(req.URL, "/task/openapi/create"):
			creates++
			return []byte(`{"data":{"taskId":"accepted-1"}}`), "application/json", nil
		case strings.Contains(req.URL, "/task/openapi/outputs"):
			var payload map[string]any
			_ = json.Unmarshal(req.Body, &payload)
			if payload["taskId"] != "accepted-1" {
				t.Fatalf("poll taskId = %#v", payload["taskId"])
			}
			return pngJSON(), "application/json", nil
		case strings.HasSuffix(req.URL, "/out.png"):
			return []byte("PNGDATA"), "image/png", nil
		default:
			t.Fatalf("unexpected URL %s", req.URL)
			return nil, "", nil
		}
	}}
	client := productionClient(exec)
	result, err := client.RunRunningHub(context.Background(), imageCreateInput())
	if err != nil {
		t.Fatal(err)
	}
	if creates != 1 {
		t.Fatalf("creates = %d, want 1", creates)
	}
	if result["mode"] != "image" {
		t.Fatalf("result = %#v", result)
	}
}

func TestCreateProtocolErrorIsReturned(t *testing.T) {
	exec := &scriptedExecutor{handler: func(req Request) ([]byte, string, error) {
		if strings.Contains(req.URL, "/task/openapi/create") {
			return []byte(`{"code":805,"msg":"NODE_INFO_MISMATCH"}`), "application/json", nil
		}
		t.Fatalf("unexpected URL %s", req.URL)
		return nil, "", nil
	}}
	client := productionClient(exec)
	_, err := client.RunRunningHub(context.Background(), imageCreateInput())
	if err == nil || !strings.Contains(err.Error(), "重新选择该 App") {
		t.Fatalf("error = %v, want actionable protocol message", err)
	}
	var uncertain CreateUncertain
	if errors.As(err, &uncertain) {
		t.Fatalf("protocol 805 wrapped as CreateUncertain: %v", err)
	}
}

func TestReadyFailureDoesNotCreate(t *testing.T) {
	exec := &scriptedExecutor{handler: func(Request) ([]byte, string, error) {
		t.Fatal("Ready failure must not call upstream")
		return nil, "", nil
	}}
	client := productionClient(exec, &memoryReceipt{failReady: errors.New("receipt not ready")})
	_, err := client.Run(context.Background(), imageCreateInput())
	if err == nil || !strings.Contains(err.Error(), "receipt not ready") {
		t.Fatalf("error = %v, want Ready failure", err)
	}
}

func TestCreateTransportIsCreateUncertain(t *testing.T) {
	transport := errors.New("connection reset")
	exec := &scriptedExecutor{handler: func(req Request) ([]byte, string, error) {
		if strings.Contains(req.URL, "/task/openapi/create") {
			return nil, "", transport
		}
		t.Fatalf("unexpected URL %s", req.URL)
		return nil, "", nil
	}}
	_, err := productionClient(exec).Run(context.Background(), imageCreateInput())
	var uncertain CreateUncertain
	if !errors.As(err, &uncertain) || !errors.Is(err, transport) {
		t.Fatalf("error = %v, want CreateUncertain wrapping transport", err)
	}
}

func TestCreateMalformedJSONIsCreateUncertain(t *testing.T) {
	exec := &scriptedExecutor{handler: func(req Request) ([]byte, string, error) {
		if strings.Contains(req.URL, "/task/openapi/create") {
			return []byte(`{"code":0,`), "application/json", nil
		}
		t.Fatalf("unexpected URL %s", req.URL)
		return nil, "", nil
	}}
	_, err := productionClient(exec).Run(context.Background(), imageCreateInput())
	var uncertain CreateUncertain
	if !errors.As(err, &uncertain) {
		t.Fatalf("error = %v, want CreateUncertain", err)
	}
}

func TestCreateMissingTaskIDIsCreateUncertain(t *testing.T) {
	exec := &scriptedExecutor{handler: func(req Request) ([]byte, string, error) {
		if strings.Contains(req.URL, "/task/openapi/create") {
			return []byte(`{"code":0,"data":{}}`), "application/json", nil
		}
		t.Fatalf("unexpected URL %s", req.URL)
		return nil, "", nil
	}}
	_, err := productionClient(exec).Run(context.Background(), imageCreateInput())
	var uncertain CreateUncertain
	if !errors.As(err, &uncertain) || !strings.Contains(err.Error(), "未返回 taskId") {
		t.Fatalf("error = %v, want missing taskId CreateUncertain", err)
	}
}

func TestCreateEmptySuccessEnvelopeIsCreateUncertain(t *testing.T) {
	for _, body := range []string{`{}`, `{"data":{}}`} {
		exec := &scriptedExecutor{handler: func(req Request) ([]byte, string, error) {
			if strings.Contains(req.URL, "/task/openapi/create") {
				return []byte(body), "application/json", nil
			}
			t.Fatalf("unexpected URL %s", req.URL)
			return nil, "", nil
		}}
		_, err := productionClient(exec).Run(context.Background(), imageCreateInput())
		var uncertain CreateUncertain
		if !errors.As(err, &uncertain) {
			t.Fatalf("body %s error = %v, want CreateUncertain", body, err)
		}
	}
}

func TestPollCancelDoesNotCreateNewTask(t *testing.T) {
	polls := 0
	exec := &scriptedExecutor{handler: func(req Request) ([]byte, string, error) {
		if strings.Contains(req.URL, "/create") {
			t.Fatal("cancel path must not create")
		}
		if strings.Contains(req.URL, "/outputs") {
			polls++
			return []byte(`{"code":804,"msg":"running"}`), "application/json", nil
		}
		t.Fatalf("unexpected URL %s", req.URL)
		return nil, "", nil
	}}
	client := &Client{Requests: exec, Time: cancelSleep{}, Poller: immediatePoller{}}
	_, err := client.Poll(context.Background(), Config{APIKey: "k"}, "https://www.runninghub.cn", "orig-7", "image")
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("error = %v, want context.Canceled", err)
	}
	if polls != 1 {
		t.Fatalf("polls = %d, want 1", polls)
	}
}

func TestPluginAuthorizationBlocksRun(t *testing.T) {
	denied := errors.New("RunningHub 工作流插件未启用")
	client := &Client{
		Requests: &scriptedExecutor{handler: func(Request) ([]byte, string, error) {
			t.Fatal("disabled plugin must not call upstream")
			return nil, "", nil
		}},
		Plugins: denyPlugin{err: denied},
	}
	_, err := client.Run(context.Background(), Input{
		Mode: "image",
		Config: Config{
			InterfaceType: string(model.ChannelInterfaceRunningHubImage),
			APIKey:        "k",
			WorkflowID:    "wf-1",
		},
	})
	if !errors.Is(err, denied) {
		t.Fatalf("error = %v, want plugin denial", err)
	}
}

func TestAppModeUsesAiAppEndpoint(t *testing.T) {
	var createURL string
	exec := &scriptedExecutor{handler: func(req Request) ([]byte, string, error) {
		if strings.Contains(req.URL, "/task/openapi/ai-app/run") || strings.HasSuffix(req.URL, "/task/openapi/create") {
			createURL = req.URL
			return []byte(`{"code":0,"data":{"taskId":"app-1"}}`), "application/json", nil
		}
		if strings.Contains(req.URL, "/outputs") {
			return pngJSON(), "application/json", nil
		}
		if strings.HasSuffix(req.URL, "/out.png") {
			return []byte("PNGDATA"), "image/png", nil
		}
		t.Fatalf("unexpected URL %s", req.URL)
		return nil, "", nil
	}}
	client := productionClient(exec)
	_, err := client.RunRunningHub(context.Background(), Input{
		Mode: "image",
		Config: Config{
			InterfaceType: string(model.ChannelInterfaceRunningHubImage),
			BaseURL:       "https://www.runninghub.cn",
			APIKey:        "k",
			WebappID:      "app-88",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(createURL, "/task/openapi/ai-app/run") {
		t.Fatalf("app endpoint = %s", createURL)
	}
}

func TestLocalWorkspaceRejectsMediaUpload(t *testing.T) {
	client := &Client{Requests: &scriptedExecutor{handler: func(Request) ([]byte, string, error) {
		t.Fatal("local workspace must not upload")
		return nil, "", nil
	}}}
	_, err := client.RunRunningHub(context.Background(), Input{
		Mode:           "video",
		LocalWorkspace: true,
		ReferenceImages: []Media{{
			ID:      "ref-1",
			DataURL: "data:image/png;base64,AAAA",
		}},
		Config: Config{
			InterfaceType: string(model.ChannelInterfaceRunningHubVideo),
			BaseURL:       "https://www.runninghub.cn",
			APIKey:        "k",
			WorkflowID:    "wf-1",
		},
	})
	if err == nil || !strings.Contains(err.Error(), "本地工作区") {
		t.Fatalf("error = %v", err)
	}
}

func TestUploadAuthFailureUsesStatusBody(t *testing.T) {
	exec := &scriptedExecutor{handler: func(req Request) ([]byte, string, error) {
		if req.Kind == "upload" && req.Method == http.MethodPost {
			return nil, "", StatusError{StatusCode: http.StatusUnauthorized, Body: `ApiKey verification failed`, Err: errors.New("401")}
		}
		t.Fatalf("unexpected URL %s", req.URL)
		return nil, "", nil
	}}
	client := &Client{Requests: exec, Media: stubMedia{}}
	_, err := client.UploadMedia(context.Background(), "https://www.runninghub.cn", Config{RunningHubUploadKey: "upload-key"}, Media{
		ID:      "ref-1",
		DataURL: "data:image/png;base64,AAAA",
	}, false)
	if err == nil || !strings.Contains(err.Error(), "素材上传 API Key（企业级）") {
		t.Fatalf("error = %v", err)
	}
}

func TestValidateConfigRequiresWorkflowIdentity(t *testing.T) {
	err := ValidateConfig("image", Config{
		InterfaceType: string(model.ChannelInterfaceRunningHubImage),
		BaseURL:       "https://www.runninghub.cn",
		APIKey:        "k",
	})
	if err == nil || !strings.Contains(err.Error(), "workflowId") {
		t.Fatalf("error = %v", err)
	}
}

func TestNilReceiptFailsBeforePaidCreate(t *testing.T) {
	exec := &scriptedExecutor{handler: func(Request) ([]byte, string, error) {
		t.Fatal("nil receipt must not call upstream")
		return nil, "", nil
	}}
	client := productionClient(exec)
	client.Receipt = nil
	_, err := client.Run(context.Background(), imageCreateInput())
	if err == nil || !strings.Contains(err.Error(), "受理回执") {
		t.Fatalf("error = %v, want missing receipt", err)
	}
}

func TestNilPluginsFailsBeforePaidCreate(t *testing.T) {
	exec := &scriptedExecutor{handler: func(Request) ([]byte, string, error) {
		t.Fatal("nil plugins must not call upstream")
		return nil, "", nil
	}}
	client := productionClient(exec)
	client.Plugins = nil
	_, err := client.Run(context.Background(), imageCreateInput())
	if err == nil || !strings.Contains(err.Error(), "插件授权") {
		t.Fatalf("error = %v, want missing plugin port", err)
	}
}

func TestRunRunningHubEnforcesPluginGate(t *testing.T) {
	denied := errors.New("RunningHub 工作流插件未启用")
	client := productionClient(&scriptedExecutor{handler: func(Request) ([]byte, string, error) {
		t.Fatal("disabled plugin must not call upstream")
		return nil, "", nil
	}}, denyPlugin{err: denied})
	_, err := client.RunRunningHub(context.Background(), imageCreateInput())
	if !errors.Is(err, denied) {
		t.Fatalf("error = %v, want plugin denial", err)
	}
}

func TestResumeRequiresPluginButNotReceipt(t *testing.T) {
	denied := errors.New("RunningHub 工作流插件未启用")
	exec := &scriptedExecutor{handler: func(Request) ([]byte, string, error) {
		t.Fatal("denied resume must not poll")
		return nil, "", nil
	}}
	client := productionClient(exec, denyPlugin{err: denied})
	client.Receipt = nil
	_, err := client.Run(context.Background(), Input{
		Mode:             "image",
		ResumedRequestID: "orig-9",
		Config: Config{
			InterfaceType: string(model.ChannelInterfaceRunningHubImage),
			BaseURL:       "https://www.runninghub.cn",
			APIKey:        "k",
			WorkflowID:    "wf-1",
		},
	})
	if !errors.Is(err, denied) {
		t.Fatalf("error = %v, want plugin denial", err)
	}
}

func TestAcceptedReceiptFailurePreservesOriginalAndResumeDoesNotCreate(t *testing.T) {
	creates := 0
	exec := &scriptedExecutor{handler: func(req Request) ([]byte, string, error) {
		switch {
		case strings.Contains(req.URL, "/task/openapi/create"):
			creates++
			return []byte(`{"code":0,"data":{"taskId":"accepted-77"}}`), "application/json", nil
		case strings.Contains(req.URL, "/task/openapi/outputs"):
			var payload map[string]any
			_ = json.Unmarshal(req.Body, &payload)
			if payload["taskId"] != "accepted-77" {
				t.Fatalf("poll taskId = %#v", payload["taskId"])
			}
			return pngJSON(), "application/json", nil
		case strings.HasSuffix(req.URL, "/out.png"):
			return []byte("PNGDATA"), "image/png", nil
		default:
			t.Fatalf("unexpected URL %s", req.URL)
			return nil, "", nil
		}
	}}
	persistErr := errors.New("receipt write failed")
	client := productionClient(exec, &memoryReceipt{failAccepted: persistErr})
	_, err := client.Run(context.Background(), imageCreateInput())
	var recorded AcceptedNotRecorded
	if !errors.As(err, &recorded) {
		t.Fatalf("error = %v, want AcceptedNotRecorded", err)
	}
	if recorded.RequestID != "accepted-77" {
		t.Fatalf("request id = %q", recorded.RequestID)
	}
	if !errors.Is(err, persistErr) {
		t.Fatalf("unwrap = %v, want persist error", err)
	}
	if creates != 1 {
		t.Fatalf("creates after failed receipt = %d", creates)
	}
	resume := productionClient(exec)
	resume.Receipt = nil
	input := imageCreateInput()
	input.ResumedRequestID = recorded.RequestID
	result, err := resume.Run(context.Background(), input)
	if err != nil {
		t.Fatal(err)
	}
	if result["mode"] != "image" {
		t.Fatalf("result = %#v", result)
	}
	if creates != 1 {
		t.Fatalf("resume created a new upstream task: creates = %d", creates)
	}
}

func TestConcurrentRunDoesNotMutateSharedClient(t *testing.T) {
	exec := &scriptedExecutor{handler: func(req Request) ([]byte, string, error) {
		switch {
		case strings.Contains(req.URL, "/task/openapi/create"):
			return []byte(`{"code":0,"data":{"taskId":"race-1"}}`), "application/json", nil
		case strings.Contains(req.URL, "/task/openapi/outputs"):
			return pngJSON(), "application/json", nil
		case strings.HasSuffix(req.URL, "/out.png"):
			return []byte("PNGDATA"), "image/png", nil
		default:
			return nil, "", errors.New("unexpected URL " + req.URL)
		}
	}}
	client := productionClient(exec)
	var wg sync.WaitGroup
	errCh := make(chan error, 16)
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := client.Run(context.Background(), imageCreateInput())
			errCh <- err
		}()
	}
	wg.Wait()
	close(errCh)
	for err := range errCh {
		if err != nil {
			t.Fatal(err)
		}
	}
	if client.Time != nil || client.Progress != nil {
		t.Fatal("shared client received lazy defaults")
	}
}
