package generation

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
)

func TestSeedanceMultipartRecoversLostAckPartialBodyAndCompletion(t *testing.T) {
	for _, proxy := range []bool{false, true} {
		t.Run(fmt.Sprintf("proxy=%t", proxy), func(t *testing.T) {
			t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
			data := bytes.Repeat([]byte("owned-fixture"), (17<<20)/13+1)
			digest := sha256.Sum256(data)
			hexDigest := hex.EncodeToString(digest[:])
			var mu sync.Mutex
			puts := map[int]int{}
			stored := map[int][]byte{}
			creates, resumes, completes, aborts, generates, proxyCalls := 0, 0, 0, 0, 0, 0
			storage := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				mu.Lock()
				defer mu.Unlock()
				if proxy {
					proxyCalls++
				}
				if r.Header.Get("Authorization") != "" || r.Header.Get("Cookie") != "" || r.Header.Get("X-Api-Key") != "" {
					t.Error("gateway credentials reached storage")
				}
				n, _ := strconv.Atoi(strings.TrimPrefix(r.URL.Path, "/part/"))
				puts[n]++
				if n == 2 && puts[n] == 1 {
					_, _ = io.CopyN(io.Discard, r.Body, 128<<10)
					conn, _, _ := w.(http.Hijacker).Hijack()
					_ = conn.Close()
					return
				}
				body, err := io.ReadAll(r.Body)
				if err != nil {
					t.Error(err)
					return
				}
				stored[n] = body
				if n == 1 && puts[n] == 1 {
					conn, _, _ := w.(http.Hijacker).Hijack()
					_ = conn.Close()
					return
				}
				w.WriteHeader(http.StatusOK)
			})
			storageServer := httptest.NewServer(storage)
			defer storageServer.Close()
			storageURL := storageServer.URL
			if proxy {
				t.Setenv("HTTP_PROXY", storageServer.URL)
				t.Setenv("http_proxy", storageServer.URL)
				t.Setenv("NO_PROXY", "127.0.0.1,localhost")
				t.Setenv("no_proxy", "127.0.0.1,localhost")
				storageURL = "http://example.com"
			}
			gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				mu.Lock()
				defer mu.Unlock()
				w.Header().Set("Content-Type", "application/json")
				switch r.URL.Path {
				case "/v1/video-references/uploads", "/v1/video-references/uploads/resume":
					if strings.HasSuffix(r.URL.Path, "/resume") {
						resumes++
					} else {
						creates++
						var req BeefAPISeedanceUploadRequest
						_ = json.NewDecoder(r.Body).Decode(&req)
						if !req.Resumable || req.SHA256 != hexDigest {
							t.Error("missing multipart negotiation or digest")
						}
					}
					plan := &BeefAPISeedanceMultipartPlan{PartBytes: 8 << 20}
					for n, start := 1, 0; start < len(data); n, start = n+1, start+8<<20 {
						size := min(8<<20, len(data)-start)
						plan.Parts = append(plan.Parts, BeefAPISeedanceUploadPart{Number: n, Bytes: int64(size), Received: len(stored[n]) == size, UploadURL: fmt.Sprintf("%s/part/%d", storageURL, n), RequiredHeaders: map[string]string{"Authorization": "must-drop", "Cookie": "must-drop", "X-Api-Key": "must-drop"}})
					}
					_ = json.NewEncoder(w).Encode(BeefAPISeedanceUploadSession{Ticket: "same-owned-upload", Multipart: plan})
				case "/v1/video-references/uploads/complete":
					completes++
					if !bytes.Equal(append(append(append([]byte{}, stored[1]...), stored[2]...), stored[3]...), data) {
						t.Error("completed bytes differ")
					}
					if completes == 1 {
						conn, _, _ := w.(http.Hijacker).Hijack()
						_ = conn.Close()
						return
					}
					_ = json.NewEncoder(w).Encode(BeefAPISeedanceUploadComplete{URL: "https://example.com/completed.png", Kind: "image", Mime: "image/png", Bytes: int64(len(data)), SHA256: hexDigest})
				case "/v1/video-references/uploads/abort":
					aborts++
					_, _ = io.WriteString(w, "{}")
				default:
					generates++
					w.WriteHeader(http.StatusBadRequest)
				}
			}))
			defer gateway.Close()
			ctx := WithRuntime(context.Background(), Runtime{Endpoints: Endpoints{BeefAPIVideoBaseURL: gateway.URL}})
			input := Input{Config: Config{BaseURL: gateway.URL + "/v1", APIKey: "gateway-key", Model: "seedance-2.0-mini", InterfaceType: "newapi"}, ReferenceImages: []Media{{DataURL: "fixture", MimeType: "image/png"}}}
			err := PrepareBeefAPIVideoReferences(ctx, input.Config, &input, func(string, Media) ([]byte, string, bool, error) { return data, "image/png", false, nil })
			if err != nil {
				t.Fatal(err)
			}
			mu.Lock()
			defer mu.Unlock()
			if creates != 1 || resumes != 2 || completes != 2 || aborts != 0 || generates != 0 || puts[1] != 1 || puts[2] != 2 || puts[3] != 1 {
				t.Fatalf("counts create=%d resume=%d complete=%d abort=%d generate=%d puts=%v", creates, resumes, completes, aborts, generates, puts)
			}
			if proxy && proxyCalls != 4 {
				t.Fatalf("expected all storage PUTs through proxy, got %d", proxyCalls)
			}
			if input.ReferenceImages[0].URL != "https://example.com/completed.png" || input.ReferenceImages[0].DataURL != "" {
				t.Fatal("reference not committed")
			}
		})
	}
}

func TestSeedanceMultipartRejectsCorruptPlanBeforeNetwork(t *testing.T) {
	ctx := context.Background()
	for _, plan := range []*BeefAPISeedanceMultipartPlan{
		{PartBytes: 8 << 20},
		{PartBytes: 8 << 20, Parts: []BeefAPISeedanceUploadPart{{Number: 2, Bytes: 10, Received: true}}},
		{PartBytes: 8 << 20, Parts: []BeefAPISeedanceUploadPart{{Number: 1, Bytes: 10, Received: true}}},
	} {
		if _, err := completeBeefAPISeedanceMultipart(ctx, Config{}, BeefAPISeedanceUploadSession{Multipart: plan}, make([]byte, 11)); err == nil {
			t.Fatal("invalid receipt accepted")
		}
	}
}

func TestSeedanceMultipartProgressResumesAtAcknowledgedBytes(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	data := make([]byte, (5<<20)+100)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPut {
			_, _ = io.Copy(io.Discard, r.Body)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"url":"https://example.com/completed.png"}`)
	}))
	defer server.Close()
	port := &referenceProgressRecorder{}
	ctx := WithRuntime(context.Background(), Runtime{ReferenceProgress: port, Endpoints: Endpoints{BeefAPIVideoBaseURL: server.URL}})
	ctx, reporter := beginReferenceProgress(ctx, "参考图片 1", int64(len(data)))
	// The previous attempt sent half of the last part without a receipt.
	reporter.report("transferring", (5<<20)+50)
	session := BeefAPISeedanceUploadSession{Ticket: "owned-ticket", Multipart: &BeefAPISeedanceMultipartPlan{
		PartBytes: 5 << 20,
		Parts: []BeefAPISeedanceUploadPart{
			{Number: 1, Bytes: 5 << 20, Received: true},
			{Number: 2, Bytes: 100, UploadURL: server.URL + "/part/2"},
		},
	}}
	_, err := CompleteBeefAPISeedanceUpload(ctx, Config{BaseURL: server.URL + "/v1", APIKey: "fixture-key"}, session, data)
	if err != nil {
		t.Fatal(err)
	}
	acknowledged := false
	for _, value := range port.values {
		if value.LoadedBytes == 5<<20 && value.BytesPerSecond == 0 {
			acknowledged = true
		}
	}
	last := port.values[len(port.values)-1]
	if !acknowledged || last.Phase != "processing" || last.LoadedBytes != int64(len(data)) {
		t.Fatalf("resume must skip acknowledged bytes and replace partial traffic: acknowledged=%t last=%+v", acknowledged, last)
	}
}

func TestSeedanceMultipartStopsOnGatewayRejectionAndCleansOnCancel(t *testing.T) {
	for _, status := range []int{0, 400, 401, 403} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
			var completes, aborts, other int
			var mu sync.Mutex
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				mu.Lock()
				defer mu.Unlock()
				w.Header().Set("Content-Type", "application/json")
				switch r.URL.Path {
				case "/v1/video-references/uploads/complete":
					completes++
					w.WriteHeader(status)
					_, _ = io.WriteString(w, `{"error":{"message":"rejected"}}`)
				case "/v1/video-references/uploads/abort":
					aborts++
					_, _ = io.WriteString(w, `{}`)
				default:
					other++
					w.WriteHeader(500)
				}
			}))
			defer server.Close()
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			if status == 0 {
				cancel()
			}
			session := BeefAPISeedanceUploadSession{Ticket: "owned-ticket", Multipart: &BeefAPISeedanceMultipartPlan{PartBytes: 8 << 20, Parts: []BeefAPISeedanceUploadPart{{Number: 1, Bytes: 10, Received: true}}}}
			_, err := CompleteBeefAPISeedanceUpload(ctx, Config{BaseURL: server.URL + "/v1", APIKey: "fixture-key"}, session, make([]byte, 10))
			mu.Lock()
			defer mu.Unlock()
			if err == nil || aborts != 1 || other != 0 {
				t.Fatalf("err=%v abort=%d other=%d", err, aborts, other)
			}
			if status == 0 {
				if completes != 0 || !errors.Is(err, context.Canceled) {
					t.Fatalf("cancel error=%v complete=%d", err, completes)
				}
			} else if completes != 1 {
				t.Fatalf("gateway rejection retried %d times", completes)
			}
		})
	}
}

func TestSeedanceMultipartReceivedPartsWaitForConfirmation(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	var reporter *referenceReporter
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/video-references/uploads/complete" {
			t.Errorf("unexpected upload request: %s", r.URL.Path)
		}
		reporter.mu.Lock()
		value := reporter.value
		reporter.mu.Unlock()
		if value.Phase != "processing" || value.LoadedBytes != 100 {
			t.Errorf("all received parts must wait for confirmation, got %+v", value)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"url":"https://example.com/completed.png"}`)
	}))
	defer server.Close()
	port := &referenceProgressRecorder{}
	ctx := WithRuntime(context.Background(), Runtime{ReferenceProgress: port, Endpoints: Endpoints{BeefAPIVideoBaseURL: server.URL}})
	ctx, reporter = beginReferenceProgress(ctx, "参考图片 1", 100)
	session := BeefAPISeedanceUploadSession{Ticket: "owned-ticket", Multipart: &BeefAPISeedanceMultipartPlan{
		PartBytes: 5 << 20, Parts: []BeefAPISeedanceUploadPart{{Number: 1, Bytes: 100, Received: true}},
	}}
	if _, err := CompleteBeefAPISeedanceUpload(ctx, Config{BaseURL: server.URL + "/v1"}, session, make([]byte, 100)); err != nil {
		t.Fatal(err)
	}
}
