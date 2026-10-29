package generation

import (
	"context"
	"errors"
	"testing"

	"infinite-canvas/backend/internal/protocol"
)

func TestMultipartPreparationCannotBeAnUncertainPaidSubmission(t *testing.T) {
	_, _, err := ExecuteProtocolBinaryRequest(context.Background(), Config{}, protocol.RequestSpec{Method: "POST", Path: "/videos", ContentType: "multipart/form-data", Files: []protocol.RequestFilePart{{Name: "input_reference", Reference: protocol.MediaReference{DataURL: "data:image/png;base64,invalid"}}}})
	var preparation RequestPreparationError
	if !errors.As(err, &preparation) {
		t.Fatalf("expected pre-dispatch preparation error: %v", err)
	}
	classified := ClassifyError(UncertainVideoSubmission(context.Background(), err))
	if classified.Uncertain || classified.Category == CategorySubmissionUncertain {
		t.Fatalf("unsent POST classified as paid uncertainty: %#v", classified)
	}
}
