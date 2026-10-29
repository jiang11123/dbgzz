package generation

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestReferenceUploadGateway4xxKeepsRequestIDAndCategory(t *testing.T) {
	for _, stage := range []string{"create", "complete"} {
		for _, status := range []int{400, 401, 402, 403} {
			t.Run(stage+http.StatusText(status), func(t *testing.T) {
				cause := HTTPError{StatusCode: status}
				err := &ReferenceUploadError{Meta: ReferenceUploadMeta{Kind: "image", Index: 1, Stage: stage}, HTTPStatus: status, RequestID: "gateway-request-123456", Cause: cause}
				failure := ClassifyError(err)
				if failure.Category != ClassifyError(cause).Category || failure.HTTPStatus != status || failure.RequestID != err.RequestID || failure.Uncertain || !failure.BlocksAutomaticRetry() {
					t.Fatalf("lost gateway classification or upload request ID: %+v", failure)
				}
			})
		}
	}
}

func TestSeedanceInlineFallbackCombinedLimit(t *testing.T) {
	data := make([]byte, 25<<20)
	inline := DataURL("image/png", data)
	for _, stored := range []bool{false, true} {
		t.Run(map[bool]string{false: "inline_and_inline", true: "inline_and_stored"}[stored], func(t *testing.T) {
			second := Media{DataURL: inline}
			if stored {
				second = Media{StorageKey: "resource:second", Bytes: int64(len(data)), MimeType: "image/png"}
			}
			input := Input{ReferenceImages: []Media{{DataURL: inline}, second}}
			read := func(kind string, media Media) ([]byte, string, bool, error) {
				if media.StorageKey != "" {
					return data, "image/png", false, nil
				}
				return ReadBeefAPISeedanceInlineMedia(kind, media)
			}
			if err := FallbackBeefAPISeedanceInline(context.Background(), &input, read); !errors.Is(err, ErrVideoJSONRequestTooLarge) {
				t.Fatalf("combined inline body exceeded 64 MiB without rejection: %v", err)
			}
		})
	}
}

func TestReferenceUploadTLSDeadlineIsRecordedBeforeGeneration(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	address, closeServer := stalledTLS(t)
	defer closeServer()
	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
	defer cancel()
	receipts := &recordingReceipts{}
	ctx = WithRuntime(ctx, Runtime{Receipts: receipts})
	ctx = withReferenceUpload(ctx, ReferenceUploadMeta{Kind: "image", Index: 2})
	err := PutBeefAPISeedanceBytes(ctx, BeefAPISeedanceUploadSession{UploadURL: address + "/?X-Amz-Signature=PRIVATE"}, []byte("owned-fixture"))
	var upload *ReferenceUploadError
	if !errors.As(err, &upload) || !errors.Is(err, context.DeadlineExceeded) || upload.Meta.Index != 2 || strings.Contains(err.Error(), "PRIVATE") {
		t.Fatalf("upload cause lost or unsafe: %v", err)
	}
	seen := receipts.snapshot()
	if len(seen) != 1 || seen[0].Dispatched || seen[0].TransportPhase != "tls" || seen[0].TransportRoute != "direct" || len(seen[0].Body) != 0 {
		t.Fatalf("missing safe PUT receipt: %+v", seen)
	}
	if call, _ := CallMetaFromContext(seen[0].Request.Context()); call.RequestKind != "reference_put" {
		t.Fatalf("storage upload counted as model creation: %+v", call)
	}
	failure := ClassifyError(err)
	if failure.Uncertain || failure.BlocksManualRetry() || !failure.BlocksAutomaticRetry() || failure.ProviderCode != "reference_preupload_failed" {
		t.Fatalf("upload timeout confused with paid generation: %+v", failure)
	}
}
