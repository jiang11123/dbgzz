package generation

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"infinite-canvas/backend/internal/protocol"
)

func TestVideoCredentialRemovalPreservesSignedRawQuery(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	payload := unifiedVideoPayload(t)
	const signedQuery = "resource=a%2fb&policy=%7E+space&signature=a+b%2F%7e"
	for _, tc := range []struct {
		name, query          string
		redirect, sameOrigin bool
	}{
		{"direct-unchanged", signedQuery, false, false},
		{"direct-remove-secret", "resource=a%2fb&credential=provider%2Fkey&policy=%7E+space&signature=a+b%2F%7e", false, false},
		{"redirect-unchanged", signedQuery, true, false},
		{"redirect-remove-secret", "resource=a%2fb&credential=Key+provider%2fkey&policy=%7E+space&signature=a+b%2F%7e", true, false},
		{"same-origin-existing-auth", "resource=a%2fb&credential=Key+provider%2fkey&policy=%7E+space&signature=a+b%2F%7e", false, true},
		{"same-origin-insert-auth", signedQuery, false, true},
		{"same-origin-replace-auth", signedQuery + "&credential=old", false, true},
		{"same-origin-deduplicate-auth", "resource=a%2fb&credential=Key+provider%2fkey&policy=%7E+space&signature=a+b%2F%7e&credential=old", false, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var reads atomic.Int32
			media := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				reads.Add(1)
				// This storage fixture accepts only the original signed spelling.
				// Equivalent decoded query values do not authorize the request.
				if r.URL.RawQuery != signedQuery || r.Header.Get("Authorization") != "" {
					t.Errorf("signed raw query changed or auth leaked: %q", r.URL.RawQuery)
					w.WriteHeader(http.StatusForbidden)
					return
				}
				_, _ = w.Write(payload)
			}))
			defer media.Close()
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Query().Get("credential") != "Key provider/key" {
					t.Error("provider query authentication missing")
				}
				if tc.sameOrigin {
					reads.Add(1)
					want := tc.query
					if tc.name == "same-origin-insert-auth" || tc.name == "same-origin-replace-auth" {
						want = signedQuery + "&credential=Key+provider%2Fkey"
					} else if tc.name == "same-origin-deduplicate-auth" {
						want = strings.TrimSuffix(want, "&credential=old")
					}
					if r.URL.RawQuery != want {
						t.Errorf("provider auth rewrote signed raw query: %q", r.URL.RawQuery)
						w.WriteHeader(http.StatusForbidden)
						return
					}
					_, _ = w.Write(payload)
					return
				}
				http.Redirect(w, r, media.URL+"/video?"+tc.query, http.StatusFound)
			}))
			defer provider.Close()
			ctx := withVideoProtocolAuth(context.Background(), protocol.ManifestAuth{Type: "query", Field: "apiKey", Query: "credential", Prefix: "Key "})
			rawURL := media.URL + "/video?" + tc.query
			if tc.redirect {
				rawURL = provider.URL + "/redirect"
			} else if tc.sameOrigin {
				rawURL = provider.URL + "/video?" + tc.query
			}
			data, _, err := DownloadVideoResult(ctx, Config{BaseURL: provider.URL, APIKey: "provider/key"}, rawURL, "original")
			if err != nil || !bytes.Equal(data, payload) || reads.Load() != 1 {
				t.Fatalf("reads=%d bytes=%d err=%v", reads.Load(), len(data), err)
			}
		})
	}
}

func reviewVideoOutputAdapter(t *testing.T) protocol.Adapter {
	t.Helper()
	manifest := []byte(`{"apiVersion":"beeftv.plugin/v2","id":"video-output-identity-fixture","name":"Fixture","version":"1.0.0","contributes":{"providers":[{"id":"video-output-identity-fixture","label":"Fixture","capabilities":["video"],"scopes":["canvas"],"auth":{"type":"bearer","field":"apiKey"},"create":{"method":"POST","path":"/v1/tasks"},"poll":{"method":"GET","path":"/v1/tasks/{{taskId}}"},"result":{"method":"GET","path":"/v1/tasks/{{taskId}}/result"},"response":{"taskId":{"$ref":"response.id"},"status":{"$ref":"response.status"},"videos":{"$ref":"response.videos"}}}]}}`)
	adapter, err := protocol.LoadInstalledPlugin(manifest, nil)
	if err != nil {
		t.Fatal(err)
	}
	return adapter
}

func TestVideoRenewalPreservesOriginalTaskAndOutputIdentity(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	payload := unifiedVideoPayload(t)
	for _, name := range []string{"wrong-task", "second-output-missing", "second-output-empty", "stable-id-missing", "stable-id-duplicate", "stable-id-reordered"} {
		t.Run(name, func(t *testing.T) {
			var queries, singleResults, correctReads, wrongReads atomic.Int32
			media := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("Authorization") != "" {
					t.Error("provider auth leaked to storage")
				}
				switch r.URL.Path {
				case "/expired":
					w.WriteHeader(http.StatusForbidden)
				case "/correct":
					correctReads.Add(1)
					_, _ = w.Write(payload)
				case "/wrong":
					wrongReads.Add(1)
					t.Error("renewal downloaded a different task/output")
					_, _ = w.Write(payload)
				default:
					_, _ = w.Write(payload)
				}
			}))
			defer media.Close()
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodGet || r.Header.Get("Authorization") != "Bearer provider-key" || r.URL.Query().Get("delivery") != "" {
					t.Error("renewal changed original query auth/method or used BeefAPI backup")
					w.WriteHeader(http.StatusBadRequest)
					return
				}
				if r.URL.Path == "/v1/tasks/original/result" {
					singleResults.Add(1)
					t.Error("renewal substituted a single result for a missing output")
					_, _ = w.Write(payload)
					return
				}
				if r.URL.Path != "/v1/tasks/original" {
					t.Errorf("unexpected original task path: %s", r.URL.Path)
					w.WriteHeader(http.StatusBadRequest)
					return
				}
				queries.Add(1)
				id := "original"
				videos := []map[string]interface{}{{"url": media.URL + "/wrong"}}
				switch name {
				case "wrong-task":
					id = "different"
				case "second-output-empty":
					videos = nil
				case "stable-id-missing":
					videos[0]["id"] = "asset-a"
				case "stable-id-duplicate":
					videos = []map[string]interface{}{{"id": "asset-b", "url": media.URL + "/correct"}, {"id": "asset-b", "url": media.URL + "/wrong"}}
				case "stable-id-reordered":
					videos = []map[string]interface{}{{"id": "asset-b", "url": media.URL + "/correct"}, {"id": "asset-a", "url": media.URL + "/wrong"}}
				}
				_ = json.NewEncoder(w).Encode(map[string]interface{}{"id": id, "status": "completed", "videos": videos})
			}))
			defer provider.Close()
			references := []protocol.MediaReference{{URL: media.URL + "/expired"}}
			if strings.HasPrefix(name, "second-output") || name == "stable-id-reordered" {
				references = []protocol.MediaReference{{URL: media.URL + "/initial"}, {URL: media.URL + "/expired"}}
			}
			if name == "stable-id-missing" || name == "stable-id-duplicate" {
				references[0].ID = "asset-b"
			}
			if name == "stable-id-reordered" {
				references[0].ID, references[1].ID = "asset-a", "asset-b"
			}
			policy := DefaultVideoPollPolicy()
			policy.Sleep = func(context.Context, time.Duration) error { t.Error("identity mismatch retried"); return nil }
			result, err := FinishProtocolAdapterResult(context.Background(), Input{Mode: "video", Config: Config{BaseURL: provider.URL, APIKey: "provider-key"}}, reviewVideoOutputAdapter(t), protocol.GenerationRequest{}, "original", &protocol.Result{Videos: references}, policy)
			if name == "stable-id-reordered" {
				if err != nil {
					t.Fatal(err)
				}
				unifiedVideoResult(t, result, payload)
				if correctReads.Load() != 1 {
					t.Fatalf("matching output reads=%d", correctReads.Load())
				}
			} else if err == nil || result != nil || correctReads.Load() != 0 {
				t.Fatalf("unsafe renewal accepted: result=%v err=%v", result, err)
			}
			if queries.Load() != 1 || singleResults.Load() != 0 || wrongReads.Load() != 0 {
				t.Fatalf("queries=%d single=%d wrong=%d", queries.Load(), singleResults.Load(), wrongReads.Load())
			}
		})
	}
}

func TestSameOriginVideoLinkRejectionRenewsOriginalTask(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	payload := unifiedVideoPayload(t)
	for _, status := range []int{http.StatusUnauthorized, http.StatusForbidden} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			var expired, queries, fresh atomic.Int32
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodGet || r.Header.Get("Authorization") != "Bearer provider-key" || r.URL.Query().Get("delivery") != "" {
					t.Error("same-origin renewal changed auth or entered generation/BeefAPI backup")
					w.WriteHeader(http.StatusBadRequest)
					return
				}
				switch r.URL.Path {
				case "/expired":
					expired.Add(1)
					w.WriteHeader(status)
				case "/v1/videos/original":
					queries.Add(1)
					_ = json.NewEncoder(w).Encode(map[string]interface{}{"id": "original", "status": "completed", "video_url": "/fresh?signature=fresh"})
				case "/fresh":
					fresh.Add(1)
					_, _ = w.Write(payload)
				default:
					t.Errorf("unexpected route: %s", r.URL.Path)
					w.WriteHeader(http.StatusBadRequest)
				}
			}))
			defer provider.Close()
			result, err := FinishProtocolAdapterResult(context.Background(), Input{Mode: "video", Config: Config{BaseURL: provider.URL + "/v1", APIKey: "provider-key"}}, unifiedVideoAdapter(t, "openai-videos"), protocol.GenerationRequest{}, "original", &protocol.Result{Videos: []protocol.MediaReference{{URL: "/expired?signature=expired"}}}, DefaultVideoPollPolicy())
			if err != nil {
				t.Fatal(err)
			}
			unifiedVideoResult(t, result, payload)
			if expired.Load() != 1 || queries.Load() != 1 || fresh.Load() != 1 {
				t.Fatalf("expired=%d queries=%d fresh=%d", expired.Load(), queries.Load(), fresh.Load())
			}
		})
	}
}

func TestBeefAPIVideoPrimaryAuthenticationRejectionStops(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	for _, status := range []int{http.StatusUnauthorized, http.StatusForbidden} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			var requests atomic.Int32
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				requests.Add(1)
				if r.URL.Query().Get("delivery") != "" {
					t.Error("gateway auth rejection entered backup")
				}
				w.WriteHeader(status)
			}))
			defer provider.Close()
			ctx := WithEndpoints(context.Background(), Endpoints{BeefAPIVideoBaseURL: provider.URL})
			_, _, err := DownloadVideoResult(ctx, Config{BaseURL: provider.URL, APIKey: "provider-key"}, provider.URL+"/v1/videos/original/content", "original")
			if err == nil || requests.Load() != 1 {
				t.Fatalf("requests=%d err=%v", requests.Load(), err)
			}
		})
	}
}
