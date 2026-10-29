package generation

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"strconv"
	"sync/atomic"
	"testing"
	"time"

	"infinite-canvas/backend/internal/outbound"
	"infinite-canvas/backend/internal/protocol"
)

func TestBeefAPIVideoDeliveryKeepsTaskAcrossPendingAndExpiredBackup(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	for _, tc := range []struct {
		model    string
		interval time.Duration
	}{
		{"seedance-2.0-mini", 5 * time.Second},
		{"sora-2", 5 * time.Second},
	} {
		model := tc.model
		for _, resumed := range []bool{false, true} {
			t.Run(model+"/resumed="+strconv.FormatBool(resumed), func(t *testing.T) {
				creates, polls, direct, backup, signed := 0, 0, 0, 0, 0
				media := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					if r.Header.Get("Authorization") != "" || r.Header.Get("X-Gateway-Secret") != "" || r.Header.Get("X-Beeftv-Owner") != "" || r.Header.Get(beefAPIVideoDeliveryHeader) != "" {
						t.Error("media request leaked gateway headers")
					}
					if r.URL.Path == "/tos.mp4" {
						direct++
						w.WriteHeader(http.StatusForbidden)
						return
					}
					signed++
					if r.URL.Query().Get("signature") == "expired" {
						w.WriteHeader(http.StatusForbidden)
						return
					}
					w.Header().Set("Content-Type", "video/mp4")
					_, _ = w.Write([]byte("original video bytes"))
				}))
				defer media.Close()
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					if r.Header.Get("Authorization") != "Bearer test-key" {
						t.Error("gateway request missing credential")
					}
					switch {
					case r.Method == http.MethodPost && r.URL.Path == "/v1/videos":
						if r.Header.Get(beefAPIVideoDeliveryHeader) != "" {
							t.Error("opt-in header sent on generation create")
						}
						creates++
						_ = json.NewEncoder(w).Encode(map[string]any{"id": "original", "status": "queued"})
					case r.Method == http.MethodGet && r.URL.Path == "/v1/videos/original":
						if r.Header.Get(beefAPIVideoDeliveryHeader) != "direct" {
							t.Error("video status did not opt in to direct delivery")
						}
						polls++
						_ = json.NewEncoder(w).Encode(map[string]any{"id": "original", "status": "completed", "video_url": media.URL + "/tos.mp4", "metadata": map[string]any{"url": media.URL + "/tos.mp4"}})
					case r.Method == http.MethodGet && r.URL.Path == "/v1/videos/original/content" && r.URL.Query().Get("delivery") == "backup":
						if r.Header.Get(beefAPIVideoDeliveryHeader) != "" {
							t.Error("backup request sent direct delivery opt-in")
						}
						backup++
						if backup <= 4 {
							w.Header().Set("Retry-After", "7")
							w.WriteHeader(http.StatusServiceUnavailable)
							_, _ = w.Write([]byte(`{"error":{"code":"video_delivery_pending"}}`))
							return
						}
						signature := "fresh"
						if backup == 5 {
							signature = "expired"
						}
						http.Redirect(w, r, media.URL+"/cos.mp4?signature="+signature, http.StatusFound)
					default:
						t.Errorf("unexpected operation: %s %s", r.Method, r.URL.Path)
						w.WriteHeader(http.StatusNotFound)
					}
				}))
				defer server.Close()
				ctx := WithEndpoints(context.Background(), Endpoints{BeefAPIVideoBaseURL: server.URL})
				manifest, err := os.ReadFile("../../../plugin-packages/openai-videos/manifest.json")
				if err != nil {
					t.Fatal(err)
				}
				adapters, err := protocol.LoadInstalledProviders(manifest, nil)
				if err != nil {
					t.Fatal(err)
				}
				registry, err := protocol.NewRegistry(adapters...)
				if err != nil {
					t.Fatal(err)
				}
				ctx = WithProtocolRegistry(ctx, registry)
				if resumed {
					ctx = WithCallMeta(ctx, CallMeta{ProviderRequestID: "original"})
				}
				var waits []time.Duration
				policy := DefaultVideoPollPolicy()
				policy.Sleep = func(_ context.Context, delay time.Duration) error {
					waits = append(waits, delay)
					return nil
				}
				result, err := RunVideoTaskWithPolicy(ctx, Input{Mode: "video", Prompt: "test", Config: Config{
					BaseURL: server.URL, APIKey: "test-key", InterfaceType: "newapi", Model: model,
					VideoSeconds: "4", VQuality: "480P", Size: "16:9",
					Headers: []outbound.OutboundHeader{{Name: "X-Gateway-Secret", Value: "private-value"}, {Name: "X-Beeftv-Owner", Value: "private-owner"}},
				}}, policy)
				if err != nil {
					t.Fatal(err)
				}
				video, _ := result["video"].(map[string]any)
				_, data, err := DecodeProviderDataURL(stringField(video, "dataUrl"))
				wantCreates := 1
				if resumed {
					wantCreates = 0
				}
				if err != nil || string(data) != "original video bytes" || creates != wantCreates || polls != 1 || direct != 1 || backup != 6 || signed != 2 {
					t.Fatalf("bytes=%q creates=%d polls=%d direct=%d backup=%d signed=%d err=%v", data, creates, polls, direct, backup, signed, err)
				}
				wantWaits := []time.Duration{tc.interval, 7 * time.Second, 7 * time.Second, 7 * time.Second, 7 * time.Second, tc.interval}
				if !reflect.DeepEqual(waits, wantWaits) {
					t.Fatalf("waits = %v, want %v", waits, wantWaits)
				}
			})
		}
	}
}

func TestBeefAPIVideoBackupRejectsGatewayCredentialsWithoutRetry(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	for _, status := range []int{http.StatusUnauthorized, http.StatusForbidden} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			backup := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Query().Get("delivery") == "backup" {
					backup++
					w.WriteHeader(status)
					return
				}
				w.WriteHeader(http.StatusServiceUnavailable)
			}))
			defer server.Close()
			ctx := WithEndpoints(context.Background(), Endpoints{BeefAPIVideoBaseURL: server.URL})
			_, _, err := RunVideoDownload(ctx, "original", fastPolicy(3, func(context.Context, time.Duration) error {
				t.Error("gateway authentication rejection was retried")
				return nil
			}), videoResultDownloader(Config{BaseURL: server.URL}, server.URL+"/original", "original"))
			var httpErr HTTPError
			if !errors.As(err, &httpErr) || httpErr.StatusCode != status || backup != 1 {
				t.Fatalf("backup calls=%d err=%v", backup, err)
			}
		})
	}
}

func TestVideoDeliveryIdleTimeoutAndCancellation(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	for _, phase := range []string{"headers", "body"} {
		t.Run(phase, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if phase == "body" {
					w.Header().Set("Content-Length", "100")
					_, _ = w.Write([]byte("partial"))
					w.(http.Flusher).Flush()
				}
				<-r.Context().Done()
			}))
			defer server.Close()
			started := time.Now()
			_, _, err := getVideoBinaryWithIdleTimeout(context.Background(), Config{}, server.URL, 100*time.Millisecond)
			if !errors.Is(err, context.DeadlineExceeded) || time.Since(started) > time.Second {
				t.Fatalf("idle timeout err=%v elapsed=%v", err, time.Since(started))
			}
		})
	}
	t.Run("steady transfer exceeds idle duration", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Length", "12")
			for i := 0; i < 12; i++ {
				_, _ = w.Write([]byte("v"))
				w.(http.Flusher).Flush()
				time.Sleep(100 * time.Millisecond)
			}
		}))
		defer server.Close()
		started := time.Now()
		data, _, err := getVideoBinaryWithIdleTimeout(context.Background(), Config{}, server.URL, 300*time.Millisecond)
		if err != nil || len(data) != 12 || time.Since(started) < 300*time.Millisecond {
			t.Fatalf("steady download len=%d err=%v elapsed=%v", len(data), err, time.Since(started))
		}
	})
	t.Run("cancel stops without backup", func(t *testing.T) {
		var backup atomic.Int32
		started := make(chan struct{})
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Query().Get("delivery") == "backup" {
				backup.Add(1)
				return
			}
			close(started)
			<-r.Context().Done()
		}))
		defer server.Close()
		ctx := WithEndpoints(context.Background(), Endpoints{BeefAPIVideoBaseURL: server.URL})
		ctx, cancel := context.WithCancel(ctx)
		go func() { <-started; cancel() }()
		_, _, err := RunVideoDownload(ctx, "original", DefaultVideoPollPolicy(), videoResultDownloader(Config{BaseURL: server.URL}, server.URL+"/original", "original"))
		if !errors.Is(err, context.Canceled) || backup.Load() != 0 {
			t.Fatalf("cancel err=%v backup=%d", err, backup.Load())
		}
	})
}

func TestNonBeefAPIVideoRetainsPollingAndNoBackup(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests++
		w.WriteHeader(http.StatusForbidden)
	}))
	defer server.Close()
	config := Config{BaseURL: server.URL}
	policy := videoPollPolicyForConfig(context.Background(), config, DefaultVideoPollPolicy())
	if policy.InitialDelay != 30*time.Second || policy.Interval != 30*time.Second {
		t.Fatalf("changed custom provider policy: %+v", policy)
	}
	_, _, err := videoResultDownloader(config, server.URL+"/video.mp4", "original")(context.Background())
	if err == nil || requests != 1 {
		t.Fatalf("custom provider requests=%d err=%v", requests, err)
	}
	custom := VideoPollPolicy{InitialDelay: time.Second, Interval: 2 * time.Second}
	customConfig := config
	customConfig.Model = "seedance-2.0-mini"
	if got := videoPollPolicyForConfig(WithEndpoints(context.Background(), Endpoints{BeefAPIVideoBaseURL: server.URL}), customConfig, custom); got.InitialDelay != custom.InitialDelay || got.Interval != custom.Interval {
		t.Fatalf("overrode explicit policy: %+v", got)
	}
}

func TestBeefAPIVideoPollPolicyDoesNotDependOnModelName(t *testing.T) {
	for _, tc := range []struct {
		name     string
		config   Config
		interval time.Duration
	}{
		{"cached Seedance", Config{BaseURL: "https://enterprise.beefapi.com/v1", Model: "seedance-2.0-mini"}, 5 * time.Second},
		{"case-normalized Seedance", Config{BaseURL: "https://enterprise.beefapi.com/v1", Model: "DOUBAO-SEEDANCE-2.5"}, 5 * time.Second},
		{"managed Gemini", Config{BaseURL: "https://enterprise.beefapi.com/v1", Model: "veo-3.1", APIFormat: "gemini", InterfaceType: "gemini-veo", ChannelModelKey: "seedance-2.0-mini"}, 5 * time.Second},
		{"managed Vertex", Config{BaseURL: "https://enterprise.beefapi.com/v1", Model: "veo-3.1-fast", APIFormat: "gemini", InterfaceType: "gemini-veo", ProviderModelKey: "seedance-2.0-mini"}, 5 * time.Second},
		{"other BeefAPI video", Config{BaseURL: "https://enterprise.beefapi.com/v1", Model: "sora-2"}, 5 * time.Second},
		{"unknown model", Config{BaseURL: "https://enterprise.beefapi.com/v1", Model: "arbitrary-future-video"}, 5 * time.Second},
		{"empty model", Config{BaseURL: "https://enterprise.beefapi.com/v1"}, 5 * time.Second},
		{"custom Seedance provider", Config{BaseURL: "https://provider.example/v1", Model: "seedance-2.0-mini"}, 30 * time.Second},
	} {
		t.Run(tc.name, func(t *testing.T) {
			policy := videoPollPolicyForConfig(context.Background(), tc.config, DefaultVideoPollPolicy())
			if policy.InitialDelay != tc.interval || policy.Interval != tc.interval {
				t.Fatalf("selected model %q poll=%v/%v, want %v", tc.config.Model, policy.InitialDelay, policy.Interval, tc.interval)
			}
		})
	}
}

func TestVideoBackupRedirectRetainsSSRFGuard(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("delivery") == "backup" {
			http.Redirect(w, r, "http://169.254.169.254/private", http.StatusFound)
			return
		}
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer server.Close()
	ctx := WithEndpoints(context.Background(), Endpoints{BeefAPIVideoBaseURL: server.URL})
	_, _, err := videoResultDownloader(Config{BaseURL: server.URL}, server.URL+"/original", "original")(ctx)
	if err == nil {
		t.Fatal("backup redirect bypassed SSRF guard")
	}
	if retry, _ := RetryableVideoPollError(ctx, err); retry {
		t.Fatal("unsafe redirect classified as a transient transfer failure")
	}
}

func TestBeefAPIVideoStallSwitchesToBackup(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	primary, backup := 0, 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("delivery") == "backup" {
			backup++
			w.Header().Set("Content-Type", "video/mp4")
			_, _ = w.Write([]byte("complete original video"))
			return
		}
		primary++
		w.Header().Set("Content-Length", "100")
		_, _ = w.Write([]byte("partial"))
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	}))
	defer server.Close()
	ctx := WithEndpoints(context.Background(), Endpoints{BeefAPIVideoBaseURL: server.URL})
	started := time.Now()
	data, _, err := RunVideoDownload(ctx, "original", DefaultVideoPollPolicy(), videoResultDownloader(Config{BaseURL: server.URL}, server.URL+"/original", "original"))
	if err != nil || string(data) != "complete original video" || primary != 1 || backup != 1 || time.Since(started) > videoDeliveryIdleTimeout+3*time.Second {
		t.Fatalf("stall fallback primary=%d backup=%d bytes=%q err=%v elapsed=%v", primary, backup, data, err, time.Since(started))
	}
}

func TestBeefAPIVideoOptInOnlyAtVideoStatusEndpoint(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		want := ""
		if r.Method == http.MethodGet && r.URL.Path == "/v1/videos/original" {
			want = "direct"
		}
		if got := r.Header.Get(beefAPIVideoDeliveryHeader); got != want {
			t.Errorf("%s %s opt-in = %q want %q", r.Method, r.URL.Path, got, want)
		}
		_, _ = w.Write([]byte(`{"status":"completed"}`))
	}))
	defer server.Close()
	ctx := WithEndpoints(context.Background(), Endpoints{BeefAPIVideoBaseURL: server.URL})
	config := Config{BaseURL: server.URL}
	var state map[string]any
	if err := GetJSON(ctx, config, "/videos/original", &state); err != nil {
		t.Fatal(err)
	}
	for _, request := range []protocol.RequestSpec{
		{Method: http.MethodGet, Path: "/v1/videos/original"},
		{Method: http.MethodGet, Path: "/v1/videos/original/content"},
		{Method: http.MethodGet, Path: "/v1/videos"},
		{Method: http.MethodGet, Path: "/v1/images/original"},
		{Method: http.MethodPost, Path: "/v1/videos"},
	} {
		if _, _, err := ExecuteProtocolBinaryRequest(ctx, config, request); err != nil {
			t.Fatal(err)
		}
	}
	for _, rawURL := range []string{server.URL + "/v1/videos/original", "https://media.example/v1/videos/original"} {
		req, err := http.NewRequest(http.MethodGet, rawURL, nil)
		if err != nil {
			t.Fatal(err)
		}
		applyBeefAPIVideoDeliveryHeader(context.Background(), config, req)
		if req.Header.Get(beefAPIVideoDeliveryHeader) != "" {
			t.Fatal("opted in a custom provider")
		}
	}
}

type queuedVideoDownloadLimits struct{ stubLimits }

func (queuedVideoDownloadLimits) AcquireChannelSlot(ctx context.Context, _, _ string, _ time.Duration) (func(), int, error) {
	if err := SleepContext(ctx, 250*time.Millisecond); err != nil {
		return nil, 0, err
	}
	return func() {}, 1, nil
}

func TestVideoIdleTimerStartsAfterChannelAdmission(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("complete video"))
	}))
	defer server.Close()
	ctx := WithRuntime(context.Background(), Runtime{Limits: queuedVideoDownloadLimits{}, Call: CallMeta{RequestKind: "download"}})
	data, _, err := getVideoBinaryWithIdleTimeout(ctx, Config{}, server.URL, 100*time.Millisecond)
	if err != nil || string(data) != "complete video" {
		t.Fatalf("local queue triggered media timeout: bytes=%q err=%v", data, err)
	}
}

func TestSeedanceOctetStreamMP4IsVideoForDirectAndBackup(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	payload, err := os.ReadFile("../app/testdata/reference-fragmented-30fps.mp4")
	if err != nil {
		t.Fatal(err)
	}
	for _, withURL := range []bool{false, true} {
		for _, useBackup := range []bool{false, true} {
			t.Run("url="+strconv.FormatBool(withURL)+"/backup="+strconv.FormatBool(useBackup), func(t *testing.T) {
				creates, downloads, backups := 0, 0, 0
				var server *httptest.Server
				server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					if r.Method != http.MethodGet {
						creates++
						t.Error("result retrieval submitted generation")
						w.WriteHeader(http.StatusBadRequest)
						return
					}
					if r.URL.Path == "/v1/videos/original" {
						state := map[string]any{"status": "completed"}
						if withURL {
							state["video_url"] = server.URL + "/video.mp4"
						}
						_ = json.NewEncoder(w).Encode(state)
						return
					}
					downloads++
					if r.URL.Query().Get("delivery") == "backup" {
						backups++
					} else if useBackup {
						w.WriteHeader(http.StatusServiceUnavailable)
						return
					}
					w.Header().Set("Content-Type", "application/octet-stream")
					_, _ = w.Write(payload)
				}))
				defer server.Close()
				ctx := WithEndpoints(context.Background(), Endpoints{BeefAPIVideoBaseURL: server.URL})
				ctx = WithCallMeta(ctx, CallMeta{ProviderRequestID: "original"})
				policy := DefaultVideoPollPolicy()
				policy.Sleep = func(context.Context, time.Duration) error { return nil }
				result, err := RunSeedanceVideosTask(ctx, Input{Mode: "video", Config: Config{BaseURL: server.URL, Model: "seedance-2.0-mini"}}, policy)
				if err != nil {
					t.Fatal(err)
				}
				video := result["video"].(map[string]any)
				mimeType, data, err := DecodeProviderDataURL(stringField(video, "dataUrl"))
				wantBackups := 0
				if useBackup {
					wantBackups = 1
				}
				if err != nil || mimeType != "video/mp4" || video["mimeType"] != "video/mp4" || !bytes.Equal(data, payload) || creates != 0 || backups != wantBackups || downloads != 1+wantBackups {
					t.Fatalf("mime=%s/%v bytes=%d creates=%d downloads=%d backups=%d err=%v", mimeType, video["mimeType"], len(data), creates, downloads, backups, err)
				}
			})
		}
	}
}
