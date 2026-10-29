package generation

import (
	"context"
	"errors"
	"time"
)

const seedanceUploadRecoveryBudget = 30 * time.Second

// Recovery owns only this signed upload ticket and these bytes. It never
// creates a replacement ticket or dispatches a model request.
func completeBeefAPISeedanceSingle(ctx context.Context, config Config, session BeefAPISeedanceUploadSession, data []byte) (BeefAPISeedanceUploadComplete, error) {
	var cancel context.CancelFunc
	defer func() {
		if cancel != nil {
			cancel()
		}
	}()
	for attempt := 1; ; attempt++ {
		attemptCtx := referenceUploadAttempt(referenceUploadStage(ctx, "put"), attempt)
		reporter, _ := ctx.Value(referenceProgressContext{}).(*referenceReporter)
		if attempt > 1 && reporter != nil {
			reporter.resumeAt(0)
		}
		putErr := PutBeefAPISeedanceBytes(attemptCtx, session, data)
		if putErr == nil {
			if reporter != nil {
				reporter.report("processing", int64(len(data)))
			}
			return confirmSeedanceUpload(attemptCtx, config, session.Ticket)
		}
		// A single PUT cannot refresh an expired signature. Unlike multipart
		// resume, repeating a storage 403 with this URL cannot repair it.
		if !retrySeedanceUpload(ctx, putErr, false) {
			return BeefAPISeedanceUploadComplete{}, MapBeefAPISeedanceUploadError(putErr, false)
		}
		if cancel == nil {
			ctx, cancel = context.WithTimeout(ctx, seedanceUploadRecoveryBudget)
		}
		var upload *ReferenceUploadError
		if errors.As(putErr, &upload) && upload.Dispatched {
			// The object may already be complete. A successful idempotent
			// confirmation also covers a lost PUT or completion response.
			completed, err := confirmSeedanceUpload(referenceUploadAttempt(ctx, attempt), config, session.Ticket)
			if err == nil {
				return completed, nil
			}
			var incomplete *ReferenceUploadError
			if !errors.As(err, &incomplete) || incomplete.Code != "video_reference_upload_incomplete" || incomplete.HTTPStatus != 400 {
				return BeefAPISeedanceUploadComplete{}, err
			}
		}
		if attempt == 3 {
			return BeefAPISeedanceUploadComplete{}, MapBeefAPISeedanceUploadError(putErr, false)
		}
		if err := seedanceUploadRetryPause(ctx, attempt-1); err != nil {
			return BeefAPISeedanceUploadComplete{}, referenceUploadError(attemptCtx, err)
		}
	}
}
