package supporttrace

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"
)

func newRecorder(t *testing.T, dir string) *Recorder {
	t.Helper()
	r, err := New(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = r.Close(context.Background()) })
	return r
}

func snapshot(t *testing.T, r *Recorder, owner string) Snapshot {
	t.Helper()
	s, err := r.Snapshot(owner, time.Time{}, time.Time{})
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func TestW3CTracePersistenceAndOwnerIsolation(t *testing.T) {
	dir := t.TempDir()
	global := otel.GetTracerProvider()
	r := newRecorder(t, dir)
	if otel.GetTracerProvider() != global {
		t.Fatal("local recorder replaced global provider")
	}
	ctx := Extract(context.Background(), http.Header{
		"Traceparent": {"00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"},
		"Baggage":     {"secret=not-imported"},
	})
	ctx, end := r.Start(ctx, "task.execute", Fields{UserID: "owner-a", TaskID: "task-1", CanvasID: "canvas-1"})
	r.Event(ctx, "resource.saved", Fields{OperationID: "op-1"})
	child, childEnd := r.Start(ctx, "video.download", Fields{})
	childEnd("download_timeout")
	childEnd("duplicate")
	end("")
	result := snapshot(t, r, "owner-a")
	if len(result.Events) != 5 || result.Coverage.Status != "complete" {
		t.Fatalf("unexpected snapshot: %+v", result)
	}
	first := result.Events[0]
	if first.TraceID != "0af7651916cd43dd8448eb211c80319c" || first.ParentSpanID != "b7ad6b7169203331" {
		t.Fatalf("remote parent lost: %+v", first)
	}
	if result.Events[2].ParentSpanID != first.SpanID || TraceID(child) != first.TraceID || SpanID(child) == first.SpanID {
		t.Fatal("child did not inherit W3C trace")
	}
	if result.Events[3].Reason != "download_timeout" || result.Events[3].Status != "error" || result.Events[3].TaskID != "task-1" {
		t.Fatalf("end did not retain diagnostic fields: %+v", result.Events[3])
	}
	if err := r.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	reopened := newRecorder(t, dir)
	reopened.Event(context.Background(), "assistant.continued", Fields{UserID: "owner-b", SessionID: "durable:session-2"})
	a := snapshot(t, reopened, "owner-a")
	b := snapshot(t, reopened, "owner-b")
	if len(a.Events) != 5 || len(b.Events) != 1 || a.Events[0].LaunchID == b.Events[0].LaunchID {
		t.Fatalf("reopen/isolation failed: a=%+v b=%+v", a, b)
	}
	for _, path := range []string{reopened.journal.path, reopened.journal.statePath} {
		info, err := os.Stat(path)
		if err != nil || (runtime.GOOS != "windows" && info.Mode().Perm() != 0600) {
			t.Fatalf("private file mode: %v %v", info, err)
		}
	}
}

func TestSnapshotTimeWindowIncludesBothBounds(t *testing.T) {
	r := newRecorder(t, t.TempDir())
	base := time.Now().UTC().Truncate(time.Second).Add(-time.Minute)
	// Wall clocks need not increase between consecutive SDK span ends. Fixed
	// timestamps test the export boundaries independently of OS clock precision.
	for i := 0; i < 5; i++ {
		r.record(Event{Fields: Fields{UserID: "owner-window"}, ID: fmt.Sprintf("event-%d", i), Timestamp: base.Add(time.Duration(i) * time.Second), Name: "resource.saved", Phase: "event", LaunchID: r.launchID}, false)
	}
	window, err := r.Snapshot("owner-window", base.Add(time.Second), base.Add(3*time.Second))
	if err != nil || len(window.Events) != 3 {
		t.Fatalf("window filter: %+v %v", window, err)
	}
	for i, event := range window.Events {
		if event.ID != fmt.Sprintf("event-%d", i+1) {
			t.Fatalf("unexpected window event: %+v", event)
		}
	}
}

func TestSnapshotWithoutUpperBoundIncludesPersistedClockAheadEvents(t *testing.T) {
	r := newRecorder(t, t.TempDir())
	now := time.Now().UTC()
	r.journal.now = func() time.Time { return now }
	for i, at := range []time.Time{now, now.Add(time.Millisecond)} {
		r.record(Event{Fields: Fields{UserID: "owner-clock"}, ID: fmt.Sprintf("clock-%d", i), Timestamp: at, Name: "task.execute", Phase: "end", LaunchID: r.launchID}, false)
	}
	r.record(Event{Fields: Fields{UserID: "other-owner"}, ID: "other-clock", Timestamp: now.Add(time.Hour), Name: "task.execute", Phase: "end", LaunchID: r.launchID}, false)
	// Another owner's future record must not widen this owner's loss window.
	r.journal.recordDrop("owner-clock", now.Add(time.Hour), 1)
	all := snapshot(t, r, "owner-clock")
	if len(all.Events) != 2 || all.Coverage.Status != "complete" || all.Coverage.Dropped != 0 {
		t.Fatalf("persisted events omitted or another owner's window imported: %+v", all)
	}
	bounded, err := r.Snapshot("owner-clock", time.Time{}, now)
	if err != nil || len(bounded.Events) != 1 || bounded.Events[0].ID != "clock-0" {
		t.Fatalf("explicit upper bound changed: %+v %v", bounded, err)
	}
}

func TestStartSurvivesKilledProcess(t *testing.T) {
	if dir := os.Getenv("BEEFTV_SUPPORTTRACE_TEST_CHILD"); dir != "" {
		r, err := New(dir)
		if err != nil {
			panic(err)
		}
		_, _ = r.Start(context.Background(), "assistant.turn", Fields{UserID: "owner-kill", SessionID: "session-1", TurnID: "turn-1"})
		fmt.Println("checkpoint-ready")
		for {
			time.Sleep(time.Hour)
		}
	}
	dir := t.TempDir()
	cmd := exec.Command(os.Args[0], "-test.run=^TestStartSurvivesKilledProcess$")
	cmd.Env = append(os.Environ(), "BEEFTV_SUPPORTTRACE_TEST_CHILD="+dir)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cmd.Process.Kill(); _ = cmd.Wait() })
	ready := make(chan bool, 1)
	go func() {
		scanner := bufio.NewScanner(stdout)
		ready <- scanner.Scan() && scanner.Text() == "checkpoint-ready"
	}()
	select {
	case ok := <-ready:
		if !ok {
			t.Fatal("child did not checkpoint")
		}
	case <-time.After(15 * time.Second):
		t.Fatal("child checkpoint timed out")
	}
	if err := cmd.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	_ = cmd.Wait()
	r := newRecorder(t, dir)
	result := snapshot(t, r, "owner-kill")
	if len(result.Events) != 1 || result.Events[0].Phase != "start" || result.Events[0].LaunchID == r.launchID || result.Events[0].TurnID != "turn-1" {
		t.Fatalf("unended work was lost after kill: %+v", result)
	}
}

func TestDetachedTraceHintDoesNotInventParent(t *testing.T) {
	r := newRecorder(t, t.TempDir())
	const desired = "0af7651916cd43dd8448eb211c80319c"
	ctx, end := r.Start(WithTraceID(nil, desired), "task.detached", Fields{UserID: "owner-a"})
	end("")
	if TraceID(ctx) != desired {
		t.Fatal("detached task lost stored trace ID")
	}
	parent := Extract(nil, http.Header{"Traceparent": {"00-11111111111111111111111111111111-2222222222222222-01"}})
	child, childEnd := r.Start(WithTraceID(parent, desired), "task.parented", Fields{UserID: "owner-a"})
	childEnd("")
	if TraceID(child) != "11111111111111111111111111111111" {
		t.Fatal("hint replaced real parent context")
	}
	invalid, invalidEnd := r.Start(WithTraceID(nil, "invalid trace id"), "task.invalid_hint", Fields{UserID: "owner-a"})
	invalidEnd("")
	if TraceID(invalid) == "" || TraceID(invalid) == desired {
		t.Fatal("invalid trace hint accepted")
	}
	result := snapshot(t, r, "owner-a")
	if result.Events[0].ParentSpanID != "" || result.Events[2].ParentSpanID != "2222222222222222" {
		t.Fatalf("parent span fabricated: %+v", result.Events)
	}
}

func TestRejectSensitiveValuesAndCrossOwnerInheritance(t *testing.T) {
	r := newRecorder(t, t.TempDir())
	ctx, end := r.Start(context.Background(), "video.retrieve", Fields{UserID: "owner-a", TaskID: "task-1", RequestID: "https://private.example/api?token=credential"})
	r.Event(ctx, "resource.saved", Fields{NodeID: "sk-privatecredential", Reason: "Bearer_PrivateCredential"})
	r.Event(ctx, "https://private.example", Fields{})
	r.Event(ctx, "assistant.turn", Fields{UserID: "owner-b"})
	trace.SpanFromContext(ctx).SetAttributes(attribute.String("arbitrary.body", "raw prompt and password"))
	trace.SpanFromContext(ctx).RecordError(fmt.Errorf("sensitive API response body"))
	end("password_contains_private_text")
	result := snapshot(t, r, "owner-a")
	data, err := os.ReadFile(r.journal.path)
	if err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{"private.example", "credential", "raw prompt", "password", "sensitive API", "owner-b"} {
		if strings.Contains(strings.ToLower(string(data)), strings.ToLower(forbidden)) {
			t.Fatalf("sensitive data persisted: %s", forbidden)
		}
	}
	if len(result.Events) != 3 || result.Coverage.Dropped != 5 || result.Coverage.Status != "partial" {
		t.Fatalf("rejections not accounted for: %+v", result)
	}
	other := snapshot(t, r, "owner-b")
	if len(other.Events) != 0 || other.Coverage.Dropped != 0 || other.Coverage.Status != "complete" {
		t.Fatalf("owner leaked: %+v", other)
	}
}

func TestRetentionSizeAndCountersSurviveReopen(t *testing.T) {
	dir := t.TempDir()
	r := newRecorder(t, dir)
	r.journal.maxBytes = 4096
	for i := 0; i < 80; i++ {
		r.Event(context.Background(), "task.completed", Fields{UserID: "owner-a", TaskID: fmt.Sprintf("task-%d", i)})
	}
	before := snapshot(t, r, "owner-a")
	info, err := os.Stat(r.journal.path)
	if err != nil || info.Size() > r.journal.maxBytes || before.Coverage.Dropped == 0 || len(before.Events) == 0 {
		t.Fatalf("size rotation failed: %+v %v %v", before, info, err)
	}
	if err := r.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	reopened := newRecorder(t, dir)
	after := snapshot(t, reopened, "owner-a")
	if after.Coverage.Dropped != before.Coverage.Dropped || len(after.Events) != len(before.Events) {
		t.Fatalf("loss counters forgotten: before=%+v after=%+v", before, after)
	}
	reopened.journal.now = func() time.Time { return time.Now().Add(49 * time.Hour) }
	expired := snapshot(t, reopened, "owner-a")
	if len(expired.Events) != 0 || expired.Coverage.Dropped != 0 || reopened.journal.owner("owner-a").Dropped != 80 {
		t.Fatalf("retention failed: %+v", expired)
	}
	info, err = os.Stat(reopened.journal.path)
	if err != nil || info.Size() != 0 {
		t.Fatalf("expired bytes retained: %v %v", info, err)
	}
}

func TestCorruptTailIsMarkedAndNewRecordsCanBeWritten(t *testing.T) {
	for _, tail := range []string{`{"userId":"other-private-owner","unfinished":`, strings.Repeat("x", maxLineBytes+100), `{"missing":"fields"}` + "\n"} {
		t.Run(fmt.Sprint(len(tail)), func(t *testing.T) {
			dir := t.TempDir()
			r := newRecorder(t, dir)
			r.Event(context.Background(), "resource.saved", Fields{UserID: "owner-a"})
			if err := r.Close(context.Background()); err != nil {
				t.Fatal(err)
			}
			file, err := os.OpenFile(r.journal.path, os.O_APPEND|os.O_WRONLY, 0600)
			if err != nil {
				t.Fatal(err)
			}
			_, err = file.WriteString(tail)
			if err != nil {
				t.Fatal(err)
			}
			_ = file.Close()
			reopened := newRecorder(t, dir)
			reopened.Event(context.Background(), "assistant.continued", Fields{UserID: "owner-a"})
			result := snapshot(t, reopened, "owner-a")
			if len(result.Events) != 2 || result.Coverage.Status != "partial" {
				t.Fatalf("corruption recovery: %+v", result)
			}
			data, _ := json.Marshal(result)
			if strings.Contains(string(data), "other-private-owner") {
				t.Fatal("corrupt owner leaked")
			}
			_ = reopened.Close(context.Background())
			third := newRecorder(t, dir)
			if snapshot(t, third, "owner-a").Coverage.Status != "partial" {
				t.Fatal("reopen forgot corrupt evidence")
			}
		})
	}
}

func TestDiskFailureIsNonFatalAndVisible(t *testing.T) {
	dir := t.TempDir()
	r := newRecorder(t, dir)
	if err := os.Mkdir(r.journal.path, 0700); err != nil {
		t.Fatal(err)
	}
	ctx, end := r.Start(context.Background(), "task.execute", Fields{UserID: "owner-a"})
	r.Event(ctx, "task.started", Fields{})
	end("")
	result, err := r.Snapshot("owner-a", time.Time{}, time.Time{})
	if err == nil || result.Coverage.WriteErrors != 3 || result.Coverage.Status != "partial" || strings.Contains(err.Error(), dir) {
		t.Fatalf("disk failure missing or exposes path: %+v %v", result, err)
	}
	if err := os.Remove(r.journal.path); err != nil {
		t.Fatal(err)
	}
	r.Event(context.Background(), "storage.recovered", Fields{UserID: "owner-a"})
	if err := r.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	reopened := newRecorder(t, dir)
	result = snapshot(t, reopened, "owner-a")
	if len(result.Events) != 1 || result.Coverage.WriteErrors != 3 {
		t.Fatalf("reopen forgot failure: %+v", result)
	}
}

func TestNilClosedAndInvalidOwner(t *testing.T) {
	var absent *Recorder
	ctx, end := absent.Start(nil, "task.execute", Fields{})
	end("failure")
	absent.Event(ctx, "task.done", Fields{})
	if s, err := absent.Snapshot("", time.Time{}, time.Time{}); err != nil || s.Coverage.Status != "unavailable" {
		t.Fatalf("nil snapshot: %+v %v", s, err)
	}
	if err := absent.Close(nil); err != nil {
		t.Fatal(err)
	}
	r := newRecorder(t, t.TempDir())
	_, end = r.Start(ctx, "task.execute", Fields{UserID: "owner-a"})
	_ = r.Close(nil)
	end("")
	r.Event(ctx, "task.done", Fields{UserID: "owner-a"})
	_, noop := r.Start(ctx, "task.execute", Fields{UserID: "owner-a"})
	noop("")
	if len(snapshot(t, r, "owner-a").Events) != 1 {
		t.Fatal("closed recorder accepted events")
	}
	if _, err := r.Snapshot("../other-owner", time.Time{}, time.Time{}); err == nil {
		t.Fatal("invalid owner accepted")
	}
	if TraceID(nil) != "" || SpanID(nil) != "" {
		t.Fatal("nil context has trace")
	}
	if _, err := New(""); err == nil {
		t.Fatal("empty data directory accepted")
	}
}

func TestConcurrentRecordingAndClose(t *testing.T) {
	r := newRecorder(t, t.TempDir())
	var wg sync.WaitGroup
	for worker := 0; worker < 12; worker++ {
		wg.Add(1)
		go func(worker int) {
			defer wg.Done()
			for i := 0; i < 10; i++ {
				ctx, end := r.Start(context.Background(), "task.execute", Fields{UserID: "owner-a", TaskID: fmt.Sprintf("task-%d-%d", worker, i)})
				r.Event(ctx, "resource.saved", Fields{})
				end("")
			}
		}(worker)
	}
	wg.Wait()
	if got := len(snapshot(t, r, "owner-a").Events); got != 360 {
		t.Fatalf("concurrent records lost: %d", got)
	}
	for worker := 0; worker < 12; worker++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			ctx, end := r.Start(context.Background(), "task.execute", Fields{UserID: "owner-a"})
			r.Event(ctx, "resource.saved", Fields{})
			end("")
			_ = r.Close(context.Background())
		}()
	}
	wg.Wait()
}

func TestCoverageOwnerCardinalityIsBounded(t *testing.T) {
	r := newRecorder(t, t.TempDir())
	for i := 0; i < maxOwners+4; i++ {
		r.Event(context.Background(), "invalid name", Fields{UserID: fmt.Sprintf("owner-%d", i)})
	}
	if len(r.journal.state.Owners) != maxOwners || !r.journal.state.Incomplete {
		t.Fatal("owner counter storage is unbounded or silently drops coverage")
	}
	info, err := os.Stat(filepath.Join(filepath.Dir(r.journal.path), "coverage.json"))
	if err != nil || info.Size() > maxCoverageBytes {
		t.Fatalf("coverage bound: %v %v", info, err)
	}
}

func TestRejectedOwnerChangeClearsInheritedScope(t *testing.T) {
	r := newRecorder(t, t.TempDir())
	ctx, end := r.Start(nil, "task.execute", Fields{UserID: "owner-a", TaskID: "task-private-a"})
	other, otherEnd := r.Start(ctx, "task.execute", Fields{UserID: "owner-b"})
	otherEnd("")
	r.Event(other, "task.started", Fields{UserID: "owner-b"})
	end("")
	result := snapshot(t, r, "owner-b")
	if len(result.Events) != 1 || result.Events[0].TaskID != "" || result.Events[0].TraceID != "" || TraceID(other) != "" {
		t.Fatalf("inherited owner scope leaked: %+v", result)
	}
}

func TestJournalSymlinkNeverWritesOrExportsTarget(t *testing.T) {
	dir := t.TempDir()
	r := newRecorder(t, dir)
	outside := filepath.Join(t.TempDir(), "outside-private.json")
	const contents = "private-token-in-unrelated-file"
	if err := os.WriteFile(outside, []byte(contents), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, r.journal.path); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	r.Event(nil, "task.started", Fields{UserID: "owner-a"})
	result, err := r.Snapshot("owner-a", time.Time{}, time.Time{})
	if err == nil || result.Coverage.Status != "partial" || len(result.Events) != 0 {
		t.Fatalf("symlink treated as trace file: %+v %v", result, err)
	}
	data, err := os.ReadFile(outside)
	if err != nil || string(data) != contents {
		t.Fatalf("unrelated target changed: %s %v", data, err)
	}
}

func TestInterruptedCompactionTemporaryFileIsBoundedAndMarked(t *testing.T) {
	dir := t.TempDir()
	r := newRecorder(t, dir)
	r.Event(nil, "task.started", Fields{UserID: "owner-a"})
	_ = r.Close(nil)
	if err := os.WriteFile(r.journal.path+".tmp", []byte("partial rewrite"), 0600); err != nil {
		t.Fatal(err)
	}
	reopened := newRecorder(t, dir)
	result := snapshot(t, reopened, "owner-a")
	if len(result.Events) != 1 || result.Coverage.Status != "partial" {
		t.Fatalf("interrupted replacement not reported: %+v", result)
	}
	if _, err := os.Stat(reopened.journal.path + ".tmp"); !os.IsNotExist(err) {
		t.Fatalf("temporary replacement retained: %v", err)
	}
}

func TestLossOutsideRequestedWindowDoesNotMarkHealthyWindowPartial(t *testing.T) {
	dir := t.TempDir()
	r := newRecorder(t, dir)
	now := time.Now()
	r.journal.now = func() time.Time { return now.Add(-2 * time.Hour) }
	r.Event(nil, "invalid name", Fields{UserID: "owner-a"})
	r.journal.now = time.Now
	r.Event(nil, "task.completed", Fields{UserID: "owner-a"})
	_ = r.Close(nil)
	reopened := newRecorder(t, dir)
	recent, err := reopened.Snapshot("owner-a", now.Add(-30*time.Minute), now.Add(time.Minute))
	if err != nil || len(recent.Events) != 1 || recent.Coverage.Dropped != 0 || recent.Coverage.Status != "complete" {
		t.Fatalf("old unrelated loss tainted healthy recent window: %+v %v", recent, err)
	}
	older, err := reopened.Snapshot("owner-a", now.Add(-3*time.Hour), now.Add(-time.Hour))
	if err != nil || len(older.Events) != 0 || older.Coverage.Dropped != 1 || older.Coverage.Status != "partial" {
		t.Fatalf("loss time bounds were forgotten: %+v %v", older, err)
	}
}

func TestCanvasNanoIDsMayBeginWithUnderscoreOrDash(t *testing.T) {
	r := newRecorder(t, t.TempDir())
	r.Event(nil, "canvas.bind", Fields{UserID: "owner-a", CanvasID: "_canvas-1", NodeID: "-node-1"})
	result := snapshot(t, r, "owner-a")
	if len(result.Events) != 1 || result.Events[0].CanvasID != "_canvas-1" || result.Events[0].NodeID != "-node-1" || result.Coverage.Status != "complete" {
		t.Fatalf("valid NanoID rejected: %+v", result)
	}
}
