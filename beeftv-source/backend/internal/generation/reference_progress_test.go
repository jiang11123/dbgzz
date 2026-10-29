package generation

import (
	"bytes"
	"context"
	"io"
	"testing"
)

type referenceProgressRecorder struct{ values []ReferenceProgress }

func (p *referenceProgressRecorder) ReportReference(value ReferenceProgress) {
	p.values = append(p.values, value)
}
func (p *referenceProgressRecorder) ClearReference() { p.values = nil }

func TestReferenceUploadReportsActualBytesAndConfirmation(t *testing.T) {
	port := &referenceProgressRecorder{}
	ctx := WithRuntime(context.Background(), Runtime{ReferenceProgress: port})
	data := bytes.Repeat([]byte("fixture"), 100000)
	ctx, _ = beginReferenceProgress(ctx, "参考视频 1", int64(len(data)))
	got, err := io.ReadAll(referenceUploadReader(ctx, bytes.NewReader(data)))
	if err != nil || !bytes.Equal(got, data) {
		t.Fatalf("upload body changed: %v", err)
	}
	if len(port.values) < 2 {
		t.Fatal("missing preparation/body progress")
	}
	last := port.values[len(port.values)-1]
	if last.Phase != "processing" || last.LoadedBytes != int64(len(data)) || last.TotalBytes != int64(len(data)) {
		t.Fatalf("final observation = %+v", last)
	}
	if last.Label != "参考视频 1" {
		t.Fatal("reference identity lost")
	}
}

func TestReferenceProgressStopsOnCancellation(t *testing.T) {
	port := &referenceProgressRecorder{}
	ctx, cancel := context.WithCancel(WithRuntime(context.Background(), Runtime{ReferenceProgress: port}))
	_, reporter := beginReferenceProgress(ctx, "参考图片 1", 100)
	cancel()
	reporter.report("transferring", 50)
	if len(port.values) != 1 {
		t.Fatal("cancelled operation published late progress")
	}
}

func TestResumedReferenceBytesDoNotBecomeTrafficRate(t *testing.T) {
	port := &referenceProgressRecorder{}
	ctx := WithRuntime(context.Background(), Runtime{ReferenceProgress: port})
	_, reporter := beginReferenceProgress(ctx, "参考视频 1", 100<<20)
	reporter.resumeAt(80 << 20)
	last := port.values[len(port.values)-1]
	if last.LoadedBytes != 80<<20 || last.BytesPerSecond != 0 {
		t.Fatalf("acknowledged chunks were counted as traffic: %+v", last)
	}
}
