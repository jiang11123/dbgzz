package app

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/generation"
	"infinite-canvas/backend/internal/model"
)

func TestSeedanceUploadRecoveryBeforeSingleGeneration(t *testing.T) {
	for _, tc := range []struct {
		name    string
		status  int
		recover bool
	}{{"storage_signature_rejected", 403, true}, {"storage_unavailable", 503, true}, {"connection_reset", 0, true}, {"invalid_upload", 400, false}} {
		t.Run(tc.name, func(t *testing.T) {
			h := newBeefAPISeedanceUploadHarness(t)
			h.putHook = func(w http.ResponseWriter, r *http.Request) {
				if h.puts == 1 {
					w.WriteHeader(200)
					return
				}
				if tc.status == 0 {
					conn, _, err := w.(http.Hijacker).Hijack()
					if err != nil {
						t.Error(err)
						return
					}
					_ = conn.Close()
					return
				}
				w.Header().Set("X-Amz-Request-Id", "storage-request-123456")
				w.WriteHeader(tc.status)
				_, _ = w.Write([]byte(`<Error><Code>SignatureDoesNotMatch</Code><RequestId>storage-request-123456</RequestId><Message>PRIVATE https://storage.test/?X-Amz-Signature=PRIVATE</Message><CanonicalRequest>PRIVATE</CanonicalRequest></Error>`))
			}
			input := h.testInput(providerMedia{DataURL: dataURL("image/png", []byte("first-image"))}, providerMedia{}, providerMedia{})
			input.ReferenceImages = append(input.ReferenceImages, providerMedia{DataURL: dataURL("image/png", []byte("second-image"))})
			ctx, recorder := withTaskRequestEvidence(h.ctx())
			err := prepareBeefAPISeedanceReferences(ctx, input.Config, &input, nil)
			d := recorder.snapshot(false)
			confirmed := tc.status == 0 || tc.status == 503
			wantRequests, wantCompletes := 5, 1
			if confirmed {
				wantRequests, wantCompletes = 6, 2
			}
			if len(d.Requests) != wantRequests {
				t.Fatalf("missing create/PUT/complete receipts: %+v", d.Requests)
			}
			put := d.Requests[4]
			if put.Operation != "reference_put" || put.HTTPStatus != tc.status || !strings.Contains(put.Summary, "参考图 2") || put.RequestBytes != int64(len("second-image")) {
				t.Fatalf("lost failing asset or transport: %+v", put)
			}
			encoded, _ := json.Marshal(d)
			if strings.Contains(string(encoded), "PRIVATE") || strings.Contains(string(encoded), "X-Amz-Signature") || strings.Contains(string(encoded), "first-image") {
				t.Fatalf("unsafe receipt: %s", encoded)
			}
			if !tc.recover {
				var upload *generation.ReferenceUploadError
				if !errors.As(err, &upload) || h.generates != 0 {
					t.Fatalf("invalid upload continued: %v", err)
				}
				task := model.Task{FailureDiagnostics: d}
				captureTaskFailureDiagnostics(&task, err, "unknown")
				d = task.FailureDiagnostics
				if d.Source != "reference_upload" || d.ProviderCode != "SignatureDoesNotMatch" || d.RequestID != "storage-request-123456" || d.HTTPStatus != 400 || !strings.Contains(d.Stage, "参考图 2") {
					t.Fatalf("terminal evidence lost: %+v", d)
				}
				return
			}
			if err != nil || h.generates != 0 || h.completes != wantCompletes || h.puts != 2 {
				t.Fatalf("recovery failed or generated early: %v", err)
			}
			if input.ReferenceImages[0].DataURL != "" || input.ReferenceImages[0].URL == "" {
				t.Fatal("mixed references lost during recovery")
			}
			if confirmed {
				if input.ReferenceImages[1].DataURL != "" || input.ReferenceImages[1].URL == "" {
					t.Fatal("confirmed upload was retransmitted inline")
				}
			} else if !strings.HasPrefix(input.ReferenceImages[1].DataURL, "data:image/png;base64,") {
				t.Fatal("inline recovery lost reference")
			}
			body, err := beefAPIVideoRequestBody(input)
			if err != nil {
				t.Fatal(err)
			}
			var result map[string]any
			if err = postJSONWithSubmissionKey(ctx, input.Config, "/videos", body, &result); err != nil || h.generates != 1 {
				t.Fatalf("generation was not submitted exactly once: %v count=%d", err, h.generates)
			}
		})
	}
}

func TestSeedanceUploadRecoveryRetainsLargeVideoFailure(t *testing.T) {
	h := newBeefAPISeedanceUploadHarness(t)
	h.putHook = func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusServiceUnavailable) }
	h.completeStatus = http.StatusBadRequest
	input := h.testInput(providerMedia{}, providerMedia{StorageKey: "resource:large-video", MimeType: "video/mp4", Bytes: 50 << 20}, providerMedia{})
	ctx, recorder := withTaskRequestEvidence(h.ctx())
	err := prepareBeefAPISeedanceReferences(ctx, input.Config, &input, func(string, providerMedia) ([]byte, string, bool, error) {
		return paddedSyntheticVideo(t, 50<<20), "video/mp4", false, nil
	})
	var upload *generation.ReferenceUploadError
	if !errors.As(err, &upload) || upload.HTTPStatus != 503 || h.generates != 0 || h.completes != 3 || h.puts != 3 || len(recorder.snapshot(false).Requests) != 7 {
		t.Fatalf("oversize fallback lost upload failure or submitted: %v", err)
	}
	failure := generation.ClassifyError(err)
	if failure.Uncertain || failure.Retryable || failure.BlocksManualRetry() || !failure.BlocksAutomaticRetry() {
		t.Fatalf("preparation error has unsafe retry policy: %+v", failure)
	}
}

func TestHTTPReferenceUploadFailureDoesNotUseSeedanceInlineRecovery(t *testing.T) {
	for _, status := range []int{http.StatusForbidden, http.StatusServiceUnavailable} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			h := newBeefAPISeedanceUploadHarness(t)
			h.putHook = func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(status) }
			h.completeStatus = http.StatusBadRequest
			input := h.testInput(providerMedia{DataURL: dataURL("image/png", []byte("image"))}, providerMedia{}, providerMedia{})
			input.Config.Model, input.Config.InterfaceType = "wan3.0-video", "newapi-channel-2"
			err := prepareBeefAPISeedanceReferences(h.ctx(), input.Config, &input, nil)
			var preparation generation.RequestPreparationError
			var upload *generation.ReferenceUploadError
			if !errors.As(err, &preparation) || !errors.As(err, &upload) || upload.HTTPStatus != status {
				t.Fatalf("HTTP-only model used inline recovery: %v", err)
			}
			wantPuts, wantCompletes := 1, 0
			if status == http.StatusServiceUnavailable {
				wantPuts, wantCompletes = 3, 3
			}
			if h.generates != 0 || h.completes != wantCompletes || h.puts != wantPuts || input.ReferenceImages[0].DataURL == "" {
				t.Fatalf("failed preparation dispatched or rewrote input: generate=%d complete=%d puts=%d", h.generates, h.completes, h.puts)
			}
		})
	}
}

func TestSeedanceUploadRecoveryValidatesRemainingInlineReferences(t *testing.T) {
	h := newBeefAPISeedanceUploadHarness(t)
	h.putHook = func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusServiceUnavailable) }
	h.completeStatus = http.StatusBadRequest
	input := h.testInput(providerMedia{DataURL: dataURL("image/png", []byte("first-image"))}, providerMedia{}, providerMedia{})
	input.ReferenceImages = append(input.ReferenceImages, providerMedia{DataURL: dataURL("text/html", []byte("not-an-image"))})
	err := prepareBeefAPISeedanceReferences(h.ctx(), input.Config, &input, nil)
	if err == nil || h.generates != 0 || h.completes != 3 || h.puts != 3 {
		t.Fatalf("recovery skipped validation of a later reference: %v", err)
	}
}

func TestSeedanceUploadGateway4xxKeepsUploadDiagnostics(t *testing.T) {
	for _, stage := range []string{"create", "complete"} {
		err := &generation.ReferenceUploadError{
			Meta:       generation.ReferenceUploadMeta{Kind: "image", Index: 2, Stage: stage},
			HTTPStatus: 400, Code: "video_reference_upload_incomplete", RequestID: "gateway-request-123456", Detail: "请先上传文件",
			Cause: generation.HTTPError{StatusCode: 400},
		}
		task := model.Task{}
		captureTaskFailureDiagnostics(&task, err, "unknown")
		d := task.FailureDiagnostics
		if d.Source != "reference_upload" || d.HTTPStatus != 400 || d.ProviderCode != err.Code || d.RequestID != err.RequestID || d.Stage != err.Meta.Label() {
			t.Fatalf("gateway rejection lost upload diagnostics: %+v", d)
		}
	}
}

func TestSeedanceUploadTruncatedStorageErrorRemainsFailure(t *testing.T) {
	h := newBeefAPISeedanceUploadHarness(t)
	h.putHook = func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Length", "10000")
		w.Header().Set("X-Amz-Request-Id", "storage-request-123456")
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte("<Error><Code>"))
	}
	input := h.testInput(providerMedia{DataURL: dataURL("image/png", []byte("image"))}, providerMedia{}, providerMedia{})
	err := prepareBeefAPISeedanceReferences(h.ctx(), input.Config, &input, nil)
	var upload *generation.ReferenceUploadError
	if !errors.As(err, &upload) || upload.HTTPStatus != 400 || upload.RequestID != "storage-request-123456" || h.completes != 0 || h.generates != 0 {
		t.Fatalf("truncated storage rejection was accepted: %v", err)
	}
}
