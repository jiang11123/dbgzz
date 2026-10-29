package generation

import (
	"context"
	"encoding/base64"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type passImagePort struct{}

func (passImagePort) Intercept(*http.Request) (bool, []byte, string, error) {
	return false, nil, "", nil
}

type nopReceipts struct{}

func (nopReceipts) Observe(TransportObservation)              {}
func (nopReceipts) NotifyPoll(context.Context, string, error) {}
func (nopReceipts) SyncProgress(string, []byte)               {}

type recordingReceipts struct {
	mu    sync.Mutex
	calls []TransportObservation
}

func (r *recordingReceipts) Observe(observation TransportObservation) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.calls = append(r.calls, observation)
}

func (r *recordingReceipts) NotifyPoll(context.Context, string, error) {}
func (r *recordingReceipts) SyncProgress(string, []byte)               {}

func (r *recordingReceipts) snapshot() []TransportObservation {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]TransportObservation, len(r.calls))
	copy(out, r.calls)
	return out
}

type stubLimits struct{ limit int }

func (s stubLimits) GeneratedFileBytes(context.Context) (int64, error)  { return 64 << 20, nil }
func (s stubLimits) ResourceUploadBytes(context.Context) (int64, error) { return 64 << 20, nil }
func (s stubLimits) CircuitOpen(context.Context, string) (bool, error)  { return false, nil }
func (s stubLimits) AcquireChannelSlot(context.Context, string, string, time.Duration) (func(), int, error) {
	return func() {}, s.limit, nil
}
func (s stubLimits) RecordChannelResult(context.Context, string, bool) error { return nil }

type probeFunc func(config Config, index int, media *Media, data []byte) error

func (f probeFunc) ProbeSeedance2Video(config Config, index int, media *Media, data []byte) error {
	return f(config, index, media, data)
}

func taskRuntime(extras ...func(*Runtime)) Runtime {
	runtime := Runtime{
		Images:   passImagePort{},
		Receipts: nopReceipts{},
		Limits:   stubLimits{limit: 1},
		Call:     CallMeta{UserID: "user-1", TaskID: "task-1"},
	}
	for _, extra := range extras {
		extra(&runtime)
	}
	return runtime
}

func TestExecuteRejectsMissingOwnerBeforeHTTP(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	var hits atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		hits.Add(1)
	}))
	t.Cleanup(server.Close)
	input := Input{Mode: "image", Prompt: "draw", Config: Config{BaseURL: server.URL, APIKey: "key", Model: "img"}}
	_, err := Execute(context.Background(), input)
	if err == nil || !strings.Contains(err.Error(), "无法执行生成任务") {
		t.Fatalf("Execute() error = %v, want missing runtime", err)
	}
	if hits.Load() != 0 {
		t.Fatalf("HTTP dispatched without runtime: %d", hits.Load())
	}
	ctx := WithRuntime(context.Background(), Runtime{Images: passImagePort{}, Receipts: nopReceipts{}, Call: CallMeta{UserID: "user-1"}})
	_, err = Execute(ctx, input)
	if err == nil || !strings.Contains(err.Error(), "生成任务缺少用户或任务身份") {
		t.Fatalf("Execute() error = %v, want missing identity", err)
	}
	if hits.Load() != 0 {
		t.Fatalf("HTTP dispatched without task identity: %d", hits.Load())
	}
}

func TestExecuteRejectsImageTaskWithoutSubmissionPort(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	var hits atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		hits.Add(1)
	}))
	t.Cleanup(server.Close)
	ctx := WithRuntime(context.Background(), Runtime{
		Receipts: nopReceipts{},
		Call:     CallMeta{UserID: "user-1", TaskID: "task-1"},
	})
	_, err := Execute(ctx, Input{Mode: "image", Prompt: "draw", Config: Config{BaseURL: server.URL, APIKey: "key", Model: "img"}})
	if err == nil || !strings.Contains(err.Error(), "无法执行生成任务") {
		t.Fatalf("Execute() error = %v, want missing image port", err)
	}
	if hits.Load() != 0 {
		t.Fatalf("image paid path dispatched without Images port: %d", hits.Load())
	}
}

func TestExecuteCannotBypassLimitsWithIdentityAndReceipts(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	var hits atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { hits.Add(1) }))
	t.Cleanup(server.Close)
	runtime := taskRuntime(func(runtime *Runtime) { runtime.Limits = nil })
	_, err := Execute(WithRuntime(context.Background(), runtime), Input{
		Mode: "text", Prompt: "hello", Config: Config{BaseURL: server.URL, APIKey: "key", Model: "text"},
	})
	if err == nil || hits.Load() != 0 {
		t.Fatalf("missing limits: err=%v, outbound requests=%d", err, hits.Load())
	}
}

func TestMissingProbeRejectsReferencedVideo(t *testing.T) {
	ctx := WithRuntime(context.Background(), taskRuntime())
	err := applySeedance2VideoProbe(ctx, Config{InterfaceType: "newapi", Model: "seedance-2.5"}, 0, &Media{MimeType: "video/mp4"}, []byte("video-bytes"))
	if err == nil || !strings.Contains(err.Error(), "参考视频无法校验") {
		t.Fatalf("applySeedance2VideoProbe() error = %v, want fail-closed", err)
	}

	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	var hits atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		http.NotFound(w, r)
	}))
	t.Cleanup(server.Close)
	ctx = WithRuntime(context.Background(), taskRuntime(func(runtime *Runtime) {
		runtime.Endpoints.BeefAPIVideoBaseURL = server.URL
	}))
	payload := []byte("video-bytes")
	input := Input{
		Mode:   "video",
		Prompt: "walk",
		Config: Config{BaseURL: server.URL, APIKey: "key", Model: "seedance-2.5", InterfaceType: "newapi"},
		ReferenceVideos: []Media{{
			ID:       "vid-1",
			DataURL:  "data:video/mp4;base64," + base64.StdEncoding.EncodeToString(payload),
			MimeType: "video/mp4",
			Bytes:    int64(len(payload)),
		}},
	}
	err = PrepareBeefAPIVideoReferences(ctx, input.Config, &input, nil)
	if err == nil || !strings.Contains(err.Error(), "参考视频无法校验") {
		t.Fatalf("PrepareBeefAPIVideoReferences() error = %v, want missing probe", err)
	}
	if hits.Load() != 0 {
		t.Fatalf("preupload HTTP dispatched without probe: %d", hits.Load())
	}
}

func TestParallelRuntimesCannotShareProbes(t *testing.T) {
	var seenA, seenB atomic.Int32
	probeA := probeFunc(func(Config, int, *Media, []byte) error {
		seenA.Add(1)
		return nil
	})
	probeB := probeFunc(func(Config, int, *Media, []byte) error {
		seenB.Add(1)
		return nil
	})
	ctxA := WithRuntime(context.Background(), taskRuntime(func(runtime *Runtime) { runtime.Probe = probeA }))
	ctxB := WithRuntime(context.Background(), taskRuntime(func(runtime *Runtime) { runtime.Probe = probeB }))
	var wg sync.WaitGroup
	var failed atomic.Int32
	for i := 0; i < 32; i++ {
		wg.Add(2)
		go func() {
			defer wg.Done()
			if err := applySeedance2VideoProbe(ctxA, Config{}, 0, &Media{}, []byte("a")); err != nil {
				failed.Add(1)
			}
		}()
		go func() {
			defer wg.Done()
			if err := applySeedance2VideoProbe(ctxB, Config{}, 0, &Media{}, []byte("b")); err != nil {
				failed.Add(1)
			}
		}()
	}
	wg.Wait()
	if failed.Load() != 0 {
		t.Fatalf("probe error count = %d", failed.Load())
	}
	if seenA.Load() != 32 || seenB.Load() != 32 {
		t.Fatalf("probe isolation lost: a=%d b=%d", seenA.Load(), seenB.Load())
	}
}

func TestWithCallMetaReplacesRouteAndEnrichKeepsIt(t *testing.T) {
	ctx := WithRuntime(context.Background(), Runtime{Call: CallMeta{
		UserID: "user-1", TaskID: "task-1", TraceID: "trace-old", Model: "model-old",
		Capability: "video", ChannelID: "channel-old", VideoSeconds: 5, ProviderRequestID: "orig",
	}})
	ctx = WithCallMeta(ctx, CallMeta{
		UserID: "user-1", TaskID: "task-1", TraceID: "trace-new", Model: "model-new",
		Capability: "video", ChannelID: "channel-new", VideoSeconds: 10, ProviderRequestID: "orig",
	})
	meta, _ := CallMetaFromContext(ctx)
	if meta.Model != "model-new" || meta.TraceID != "trace-new" || meta.ChannelID != "channel-new" || meta.VideoSeconds != 10 || meta.ProviderRequestID != "orig" {
		t.Fatalf("full replace Call = %#v", meta)
	}
	ctx = EnrichCallMeta(ctx, CallMeta{RequestKind: "poll", UserID: "user-1", TaskID: "task-1"})
	meta, _ = CallMetaFromContext(ctx)
	if meta.RequestKind != "poll" || meta.Model != "model-new" || meta.TraceID != "trace-new" || meta.ChannelID != "channel-new" || meta.VideoSeconds != 10 {
		t.Fatalf("enrich Call = %#v", meta)
	}
}

func TestWireRequestsRecordCurrentRequestKindAndConcurrency(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"id":"ok"}`)
	}))
	t.Cleanup(server.Close)
	receipts := &recordingReceipts{}
	ctx := WithRuntime(context.Background(), Runtime{
		Images:   passImagePort{},
		Receipts: receipts,
		Limits:   stubLimits{limit: 4},
		Call: CallMeta{
			UserID: "user-1", TaskID: "task-1", Capability: "video", ChannelID: "channel-1",
			Model: "seedance-2.5", RequestKind: "create",
		},
	})
	var created map[string]any
	if err := PostJSON(ctx, Config{BaseURL: server.URL, APIKey: "key"}, "/videos", map[string]any{"model": "seedance-2.5"}, &created); err != nil {
		t.Fatal(err)
	}
	if err := PostJSON(WithRequestKind(ctx, "poll"), Config{BaseURL: server.URL, APIKey: "key"}, "/videos/task-1", map[string]any{"id": "task-1"}, &created); err != nil {
		t.Fatal(err)
	}
	if err := GetJSON(WithRequestKind(ctx, "download"), Config{BaseURL: server.URL, APIKey: "key"}, "/videos/task-1/content", &created); err != nil {
		t.Fatal(err)
	}
	calls := receipts.snapshot()
	if len(calls) != 3 {
		t.Fatalf("recorded calls = %d, want 3", len(calls))
	}
	want := []string{"create", "poll", "download"}
	for i, observation := range calls {
		meta, ok := CallMetaFromContext(observation.Request.Context())
		if !ok {
			t.Fatalf("call %d missing runtime", i)
		}
		if meta.RequestKind != want[i] {
			t.Fatalf("call %d RequestKind = %q, want %q", i, meta.RequestKind, want[i])
		}
		if meta.ConcurrencyLimit != 4 {
			t.Fatalf("call %d ConcurrencyLimit = %d, want 4", i, meta.ConcurrencyLimit)
		}
		if meta.Model != "seedance-2.5" || meta.ChannelID != "channel-1" || meta.TaskID != "task-1" {
			t.Fatalf("call %d lost route metadata: %#v", i, meta)
		}
	}
}

func TestParallelEndpointOverridesStayIsolated(t *testing.T) {
	ctxA := WithEndpoints(context.Background(), Endpoints{BeefAPIVideoBaseURL: "http://127.0.0.1:1"})
	ctxB := WithEndpoints(context.Background(), Endpoints{BeefAPIVideoBaseURL: "http://127.0.0.1:2"})
	configA := Config{BaseURL: "http://127.0.0.1:1", Model: "seedance-2.5"}
	configB := Config{BaseURL: "http://127.0.0.1:2", Model: "seedance-2.5"}
	var wg sync.WaitGroup
	var leaked atomic.Int32
	for i := 0; i < 32; i++ {
		wg.Add(2)
		go func() {
			defer wg.Done()
			if !IsBeefAPIVideoConfig(ctxA, configA) || IsBeefAPIVideoConfig(ctxA, configB) {
				leaked.Add(1)
			}
		}()
		go func() {
			defer wg.Done()
			if !IsBeefAPIVideoConfig(ctxB, configB) || IsBeefAPIVideoConfig(ctxB, configA) {
				leaked.Add(1)
			}
		}()
	}
	wg.Wait()
	if leaked.Load() != 0 {
		t.Fatalf("endpoint override leaked across parallel contexts: %d", leaked.Load())
	}
}
