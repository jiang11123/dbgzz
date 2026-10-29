package app

import (
	"context"
	"errors"
	"net/http"
	"runtime"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"infinite-canvas/backend/internal/buildinfo"
	"infinite-canvas/backend/internal/generation"
	"infinite-canvas/backend/internal/model"
)

type taskRequestEvidenceKey struct{}

// One execution owns this recorder; parallel provider calls share only its lock.
type taskRequestEvidenceRecorder struct {
	mu          sync.Mutex
	diagnostics model.TaskFailureDiagnostics
}

func withTaskRequestEvidence(ctx context.Context, previous ...*model.TaskFailureDiagnostics) (context.Context, *taskRequestEvidenceRecorder) {
	r := &taskRequestEvidenceRecorder{diagnostics: model.TaskFailureDiagnostics{Source: "unknown", Version: buildinfo.Current().Version, Platform: runtime.GOOS + "/" + runtime.GOARCH}}
	if len(previous) > 0 && previous[0] != nil {
		prior := generation.SanitizeTaskDiagnostics(previous[0])
		r.diagnostics.Requests, r.diagnostics.OmittedRequests, r.diagnostics.Input = prior.Requests, prior.OmittedRequests, prior.Input
	}
	return bindRequestReceipts(context.WithValue(ctx, taskRequestEvidenceKey{}, r)), r
}

func taskRequestRecorder(ctx context.Context) *taskRequestEvidenceRecorder {
	r, _ := ctx.Value(taskRequestEvidenceKey{}).(*taskRequestEvidenceRecorder)
	return r
}

func (r *taskRequestEvidenceRecorder) snapshot(completed bool) *model.TaskFailureDiagnostics {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.diagnostics.ExecutionResult = "failed"
	if completed {
		r.diagnostics.ExecutionResult = "completed"
	}
	return generation.SanitizeTaskDiagnostics(&r.diagnostics)
}

func recordTaskDiagnosticInput(ctx context.Context, input canvasGenerationInput) {
	r := taskRequestRecorder(ctx)
	if r == nil {
		return
	}
	d := &model.TaskDiagnosticInput{Protocol: input.Config.InterfaceType, Model: input.Config.Model, Size: input.Config.Size, Quality: input.Config.Quality, Count: input.Config.Count,
		PromptChars: utf8.RuneCountInString(input.Prompt), ImageCount: len(input.ReferenceImages), VideoCount: len(input.ReferenceVideos), AudioCount: len(input.ReferenceAudios)}
	for i, media := range input.ReferenceImages {
		if i == 16 {
			break
		}
		d.Images = append(d.Images, model.TaskDiagnosticMedia{Bytes: media.Bytes, Width: media.Width, Height: media.Height})
	}
	if input.ImageCapability != nil {
		d.ImageLimitsRecorded = true
		d.MaxImages, d.MaxImageBytes = input.ImageCapability.References.MaxImages, input.ImageCapability.References.MaxImageBytes
	}
	r.mu.Lock()
	r.diagnostics.Input = d
	r.mu.Unlock()
}

func recordTaskRequestEvidence(req *http.Request, evidence model.TaskRequestEvidence, body []byte, err error) {
	r := taskRequestRecorder(req.Context())
	if r == nil {
		return
	}
	evidence.Method = req.Method
	evidence.Operation = "other"
	switch {
	case strings.HasSuffix(req.URL.Path, "/images/edits"):
		evidence.Operation = "image_edit"
	case strings.HasSuffix(req.URL.Path, "/images/generations"):
		evidence.Operation = "image_generate"
	case req.Method == http.MethodGet:
		evidence.Operation = "query_or_download"
	case req.Method == http.MethodPost:
		evidence.Operation = "submit"
	}
	evidence.RequestBytes = req.ContentLength
	reference, isReference := generation.ReferenceUploadFromContext(req.Context())
	if isReference {
		evidence.Operation = "reference_" + reference.Stage
		evidence.Attempt = reference.Attempt
		evidence.Summary = reference.Label()
	}
	responseLimited := evidence.Outcome == "response_limit"
	evidence.Outcome = "response_received"
	if err != nil {
		evidence.Outcome = "transport_error"
		if evidence.HTTPStatus >= 400 {
			evidence.Outcome = "http_error"
		}
		if errors.Is(err, context.Canceled) {
			evidence.Outcome = "cancelled"
		}
		if errors.Is(err, context.DeadlineExceeded) {
			evidence.Outcome = "timeout"
		}
		if !evidence.Dispatched && !errors.Is(err, context.Canceled) {
			evidence.Outcome = "not_dispatched"
		}
		failure := classifyTaskFailure(err)
		evidence.Summary = firstNonEmpty(failure.ProviderMessage, err.Error())
		evidence.ProviderCode = failure.ProviderCode
		evidence.RequestID = firstNonEmpty(failure.RequestID, evidence.RequestID)
	} else if _, _, failed := providerResponseBusinessFailure(body); failed {
		evidence.Outcome = "business_error"
		failure := generation.ClassifyText(string(body))
		evidence.ProviderCode, evidence.Summary = failure.ProviderCode, firstNonEmpty(failure.ProviderMessage, failure.UserMessage())
		evidence.RequestID = firstNonEmpty(failure.RequestID, evidence.RequestID)
	}
	if started, parseErr := time.Parse(time.RFC3339Nano, evidence.StartedAt); parseErr == nil {
		evidence.DurationMS = time.Since(started).Milliseconds()
	}
	if responseLimited {
		evidence.Outcome = "response_limit"
	}
	if isReference && err != nil {
		var upload *generation.ReferenceUploadError
		if errors.As(err, &upload) {
			evidence.ProviderCode, evidence.RequestID = upload.Code, upload.RequestID
			evidence.Summary = upload.Error()
		} else {
			evidence.Summary = reference.Label() + "：" + generation.DiagnosticSummary(err.Error())
		}
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	// Keep the original submit and the latest seven calls, including the terminal response.
	if len(r.diagnostics.Requests) == 8 {
		r.diagnostics.Requests = append(r.diagnostics.Requests[:1], r.diagnostics.Requests[2:]...)
		r.diagnostics.OmittedRequests++
	}
	r.diagnostics.Requests = append(r.diagnostics.Requests, evidence)
}
