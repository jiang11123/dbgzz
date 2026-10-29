package generation

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"io"
	"math/rand/v2"
	"net"
	"strings"
	"time"
)

type BeefAPISeedanceMultipartPlan struct {
	PartBytes int64                       `json:"part_bytes"`
	Parts     []BeefAPISeedanceUploadPart `json:"parts"`
}

type BeefAPISeedanceUploadPart struct {
	Number          int               `json:"number"`
	Bytes           int64             `json:"bytes"`
	Received        bool              `json:"received"`
	UploadURL       string            `json:"upload_url"`
	RequiredHeaders map[string]string `json:"required_headers"`
}

func validateSeedanceMultipart(ctx context.Context, plan *BeefAPISeedanceMultipartPlan, size int64) error {
	if plan == nil || plan.PartBytes < 5<<20 || plan.PartBytes > 16<<20 || len(plan.Parts) == 0 || len(plan.Parts) > 40 {
		return errBeefAPISeedanceUploadIncomplete
	}
	var total int64
	for i, part := range plan.Parts {
		if part.Number != i+1 || part.Bytes <= 0 || part.Bytes > plan.PartBytes || (i < len(plan.Parts)-1 && part.Bytes != plan.PartBytes) {
			return errBeefAPISeedanceUploadIncomplete
		}
		total += part.Bytes
		if !part.Received {
			if err := ValidateBeefAPISeedanceSecureURL(ctx, part.UploadURL); err != nil {
				return referenceUploadAddressError(ctx, err)
			}
		}
	}
	if total > beefAPISeedanceVideoMaxBytes || (size > 0 && total != size) {
		return errBeefAPISeedanceUploadIncomplete
	}
	return nil
}

// Retries stay entirely in reference preparation. A model request is never
// replayed here. Storage receipts also recover a PUT whose acknowledgement
// was lost; only the missing part is retransmitted after a partial body.
func completeBeefAPISeedanceMultipart(ctx context.Context, config Config, session BeefAPISeedanceUploadSession, data []byte) (result BeefAPISeedanceUploadComplete, resultErr error) {
	if err := validateSeedanceMultipart(ctx, session.Multipart, int64(len(data))); err != nil {
		return result, err
	}
	defer func() {
		if resultErr != nil {
			cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
			defer cancel()
			var ignored map[string]any
			_ = PostJSON(referenceUploadStage(cleanup, "abort"), config, beefAPISeedanceUploadCreatePath+"/abort", map[string]string{"ticket": session.Ticket}, &ignored)
		}
	}()
	for attempt := 0; attempt < 4; attempt++ {
		var offset int64
		var putErr error
		reporter, _ := ctx.Value(referenceProgressContext{}).(*referenceReporter)
		if reporter != nil {
			// Discard bytes sent without a receipt on an earlier attempt.
			reporter.resumeAt(0)
		}
		for _, part := range session.Multipart.Parts {
			end := offset + part.Bytes
			if part.Received {
				if reporter != nil {
					reporter.resumeAt(end)
				}
			} else {
				putErr = PutBeefAPISeedanceBytes(ctx, BeefAPISeedanceUploadSession{UploadURL: part.UploadURL, RequiredHeaders: part.RequiredHeaders}, data[offset:end])
				if putErr != nil {
					break
				}
			}
			offset = end
		}
		if putErr == nil {
			if reporter != nil {
				reporter.report("processing", int64(len(data)))
			}
			return confirmSeedanceUpload(ctx, config, session.Ticket)
		}
		resultErr = MapBeefAPISeedanceUploadError(putErr, false)
		if !retrySeedanceUpload(ctx, putErr, true) || attempt == 3 {
			return result, resultErr
		}
		if err := seedanceUploadRetryPause(ctx, attempt); err != nil {
			return result, err
		}
		var resumed BeefAPISeedanceUploadSession
		for retry := 0; retry < 3; retry++ {
			err := PostJSON(referenceUploadStage(ctx, "resume"), config, beefAPISeedanceUploadCreatePath+"/resume", map[string]string{"ticket": session.Ticket}, &resumed)
			if err == nil {
				break
			}
			if !retrySeedanceUpload(ctx, err, false) || retry == 2 {
				return result, referenceUploadError(referenceUploadStage(ctx, "resume"), err)
			}
			if err := seedanceUploadRetryPause(ctx, retry); err != nil {
				return result, err
			}
		}
		if resumed.Ticket != session.Ticket {
			return result, errBeefAPISeedanceUploadIncomplete
		}
		if err := validateSeedanceMultipart(ctx, resumed.Multipart, int64(len(data))); err != nil {
			return result, err
		}
		// Offsets cannot change when refreshing signatures/receipts.
		if resumed.Multipart.PartBytes != session.Multipart.PartBytes {
			return result, errBeefAPISeedanceUploadIncomplete
		}
		session = resumed
	}
	return result, resultErr
}

func confirmSeedanceUpload(ctx context.Context, config Config, ticket string) (BeefAPISeedanceUploadComplete, error) {
	ctx = referenceUploadStage(ctx, "complete")
	var cancel context.CancelFunc
	defer func() {
		if cancel != nil {
			cancel()
		}
	}()
	for attempt := 0; ; attempt++ {
		var uploaded BeefAPISeedanceUploadComplete
		attemptCtx := referenceUploadAttempt(ctx, attempt+1)
		err := PostJSON(attemptCtx, config, beefAPISeedanceUploadCompletePath, map[string]string{"ticket": ticket}, &uploaded)
		if err != nil {
			if !retrySeedanceUpload(ctx, err, false) || attempt == 3 {
				return uploaded, referenceUploadError(attemptCtx, err)
			}
			if cancel == nil {
				ctx, cancel = context.WithTimeout(ctx, seedanceUploadRecoveryBudget)
			}
			if err := seedanceUploadRetryPause(ctx, attempt); err != nil {
				return uploaded, referenceUploadError(attemptCtx, err)
			}
			continue
		}
		if strings.TrimSpace(uploaded.URL) == "" {
			return uploaded, errBeefAPISeedanceUploadIncomplete
		}
		if err := ValidateBeefAPISeedanceSecureURL(ctx, uploaded.URL); err != nil {
			return BeefAPISeedanceUploadComplete{}, errBeefAPISeedanceUploadUnavailable
		}
		return uploaded, nil
	}
}

func retrySeedanceUpload(ctx context.Context, err error, storage bool) bool {
	if ctx.Err() != nil || errors.Is(err, context.Canceled) || errors.Is(err, errBeefAPISeedanceUploadRedirect) {
		return false
	}
	var certificate *tls.CertificateVerificationError
	var authority x509.UnknownAuthorityError
	var hostname x509.HostnameError
	var invalid x509.CertificateInvalidError
	if errors.As(err, &certificate) || errors.As(err, &authority) || errors.As(err, &hostname) || errors.As(err, &invalid) {
		return false
	}
	var upload *ReferenceUploadError
	if errors.As(err, &upload) {
		if upload.Code == "upload_address_invalid" {
			return false
		}
		return upload.Code == "upload_transport_error" || upload.HTTPStatus == 408 || upload.HTTPStatus == 429 || upload.HTTPStatus >= 500 || (storage && upload.HTTPStatus == 403)
	}
	var httpErr HTTPError
	if errors.As(err, &httpErr) {
		return httpErr.StatusCode == 408 || httpErr.StatusCode == 429 || httpErr.StatusCode >= 500
	}
	var netErr net.Error
	return errors.As(err, &netErr) || errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF)
}

func seedanceUploadRetryPause(ctx context.Context, attempt int) error {
	// Spread recovery traffic without delaying the first healthy request.
	delay := 250 * time.Millisecond * time.Duration(1<<min(attempt, 2))
	timer := time.NewTimer(delay/2 + time.Duration(rand.Int64N(int64(delay/2))))
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
