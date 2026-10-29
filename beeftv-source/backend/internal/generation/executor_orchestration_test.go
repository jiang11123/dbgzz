package generation

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"infinite-canvas/backend/internal/model"
)

type stubWorkflowPort struct{ calls atomic.Int32 }

func (s *stubWorkflowPort) Execute(ctx context.Context, input Input) (map[string]interface{}, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	s.calls.Add(1)
	return map[string]interface{}{"mode": input.Mode, "workflow": true}, nil
}

type countingPrompt struct{ compiles atomic.Int32 }

func (p *countingPrompt) Compile(string, string, map[string]string) (string, error) {
	p.compiles.Add(1)
	return "compiled-prompt", nil
}

func (p *countingPrompt) ValidateResult(string, map[string]any) error { return nil }

func chatCompletionJSON() string {
	return `{"choices":[{"message":{"content":"ok"}}]}`
}

func TestExecuteTextImageAudioAndWorkflow(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	var hits atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		switch {
		case strings.Contains(r.URL.Path, "/chat/completions"):
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, chatCompletionJSON())
		case strings.Contains(r.URL.Path, "/images/generations"):
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, `{"data":[{"b64_json":"YQ=="}]}`)
		case strings.Contains(r.URL.Path, "/audio/speech"):
			w.Header().Set("Content-Type", "audio/mpeg")
			_, _ = w.Write([]byte("ID3\x04fake-mp3-body"))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)
	cfg := Config{BaseURL: server.URL, APIKey: "key", Model: "test-model"}

	text, err := Execute(WithRuntime(context.Background(), taskRuntime()), Input{
		Mode: "text", Prompt: "hello", Config: Config{BaseURL: server.URL, APIKey: "key", Model: "test-model", InterfaceType: "chat-completion"},
	})
	if err != nil || text["text"] != "ok" {
		t.Fatalf("text Execute: %#v %v", text, err)
	}

	image, err := Execute(WithRuntime(context.Background(), taskRuntime()), Input{
		Mode: "image", Prompt: "draw", Config: cfg,
	})
	if err != nil {
		t.Fatalf("image Execute: %v", err)
	}
	images, _ := image["images"].([]map[string]string)
	if len(images) != 1 {
		t.Fatalf("image Execute payload = %#v", image)
	}

	workflowPort := &stubWorkflowPort{}
	workflow, err := Execute(WithRuntime(context.Background(), taskRuntime(func(runtime *Runtime) {
		runtime.Workflow = workflowPort
	})), Input{
		Mode: "image", Prompt: "draw",
		Config: Config{
			BaseURL: "https://www.runninghub.cn", APIKey: "key", Model: "wf",
			InterfaceType: string(model.ChannelInterfaceRunningHubImage), WorkflowID: "wf-1",
		},
	})
	if err != nil || workflow["workflow"] != true || workflowPort.calls.Load() != 1 {
		t.Fatalf("workflow Execute: %#v err=%v calls=%d", workflow, err, workflowPort.calls.Load())
	}

	agent, err := Execute(WithRuntime(context.Background(), taskRuntime()), Input{
		Mode: "text", Prompt: "tool", Config: Config{BaseURL: server.URL, APIKey: "key", Model: "test-model", InterfaceType: "chat-completion"},
		AgentRequests: &AgentToolRequests{ChatCompletion: map[string]interface{}{
			"messages": []interface{}{map[string]interface{}{"role": "user", "content": "hi"}},
		}},
	})
	if err != nil || agent["text"] != "ok" {
		t.Fatalf("agent Execute: %#v %v", agent, err)
	}
}

func TestExecuteVideoSkipsPromptTemplateAndHonorsCancel(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	var hits atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		hits.Add(1)
	}))
	t.Cleanup(server.Close)
	prompt := &countingPrompt{}
	ctx, cancel := context.WithCancel(WithRuntime(context.Background(), taskRuntime(func(runtime *Runtime) {
		runtime.Prompt = prompt
	})))
	cancel()
	_, err := Execute(ctx, Input{
		Mode: "video", Prompt: "walk",
		Config: Config{BaseURL: server.URL, APIKey: "key", Model: "video-model"},
		Metadata: map[string]interface{}{
			"promptTemplateOperation": "storyboard",
			"promptTemplateVariables": map[string]interface{}{"scene": "1"},
		},
	})
	if prompt.compiles.Load() != 0 {
		t.Fatalf("video compiled prompt template %d times", prompt.compiles.Load())
	}
	if err == nil || hits.Load() != 0 || !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled video Execute error = %v hits=%d", err, hits.Load())
	}
}

type countingResolvePort struct{ calls atomic.Int32 }

func (p *countingResolvePort) Resolve(config Config) (Config, error) {
	p.calls.Add(1)
	if p.calls.Load() > 1 && config.ChannelModelKey == "seedance-2-5-480p" && config.Model == "doubao-seedance-2-5" {
		return Config{}, errors.New("系统渠道模型标识不一致")
	}
	out := config
	out.ChannelModelKey = "seedance-2-5-480p"
	out.Model = "doubao-seedance-2-5"
	if out.InterfaceType == "" {
		out.InterfaceType = "chat-completion"
	}
	return out, nil
}
func (p *countingResolvePort) ApplyCapabilities(context.Context, *Input) error { return nil }
func (p *countingResolvePort) RequireWorkflow(string) error                    { return nil }
func (p *countingResolvePort) SyncArkPrivateAssets(context.Context, string, *Input) error {
	return nil
}

func TestExecuteResolvesNoVariantSKUOnce(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	var posts atomic.Int32
	var postedModel string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		posts.Add(1)
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		postedModel, _ = body["model"].(string)
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, chatCompletionJSON())
	}))
	t.Cleanup(server.Close)
	port := &countingResolvePort{}
	ctx := WithProtocolRegistry(WithRuntime(context.Background(), taskRuntime(func(runtime *Runtime) {
		runtime.Config = port
		runtime.Call.TaskType = "canvas_text"
	})), LoadOfficialFallbackRegistry())
	result, err := Execute(ctx, Input{
		Mode: "text", Prompt: "hello",
		Config: Config{ChannelID: "channel-1", ChannelModelKey: "seedance-2-5-480p", Model: "seedance-2-5-480p", BaseURL: server.URL, APIKey: "key", InterfaceType: "chat-completion"},
	})
	if err != nil || result["text"] != "ok" {
		t.Fatalf("Execute: %#v %v", result, err)
	}
	if port.calls.Load() != 1 {
		t.Fatalf("Config.Resolve calls = %d, want 1", port.calls.Load())
	}
	if posts.Load() != 1 || postedModel != "doubao-seedance-2-5" {
		t.Fatalf("upstream posts=%d model=%q", posts.Load(), postedModel)
	}
}

func TestExecuteCanvasTextStreamsVisibleTextWithoutReasoning(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	var posts atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		posts.Add(1)
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"内部分析\",\"content\":\"可见回答\"}}]}\n\ndata: [DONE]\n\n")
	}))
	t.Cleanup(server.Close)
	var streamed strings.Builder
	ctx := WithProtocolRegistry(WithRuntime(context.Background(), taskRuntime(func(runtime *Runtime) {
		runtime.Call.TaskType = "canvas_text"
	})), LoadOfficialFallbackRegistry())
	result, err := Execute(ctx, Input{
		Mode: "text", Prompt: "hello",
		OnTextDelta: func(delta string) { streamed.WriteString(delta) },
		Config:      Config{BaseURL: server.URL, APIKey: "key", Model: "text-model", InterfaceType: "chat-completion"},
	})
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if result["text"] != "可见回答" {
		t.Fatalf("result = %#v", result)
	}
	if streamed.String() != "可见回答" {
		t.Fatalf("streamed = %q", streamed.String())
	}
	if strings.Contains(streamed.String(), "内部分析") {
		t.Fatalf("reasoning entered text stream: %q", streamed.String())
	}
	if posts.Load() != 1 {
		t.Fatalf("upstream POSTs = %d, want 1", posts.Load())
	}
}

func TestExecuteAudioHonorsCancel(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	var hits atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		hits.Add(1)
	}))
	t.Cleanup(server.Close)
	ctx, cancel := context.WithCancel(WithRuntime(context.Background(), taskRuntime()))
	cancel()
	_, err := Execute(ctx, Input{
		Mode: "audio", Prompt: "speak",
		Config: Config{BaseURL: server.URL, APIKey: "key", Model: "tts"},
	})
	if err == nil || hits.Load() != 0 || !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled audio Execute error = %v hits=%d", err, hits.Load())
	}
}
