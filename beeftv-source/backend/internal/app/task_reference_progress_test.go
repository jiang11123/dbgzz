package app

import (
	"infinite-canvas/backend/internal/generation"
	"sync"
	"testing"
)

func TestReferenceProgressIsBoundToBeefTVTaskAndCleared(t *testing.T) {
	s := &Service{}
	port := s.newReferenceProgressPort("beeftv-task")
	port.ReportReference(generation.ReferenceProgress{Label: "参考视频 1", Phase: "transferring", LoadedBytes: 512, TotalBytes: 2048})
	if s.referenceProgressForTask("supplier-task") != nil {
		t.Fatal("progress leaked to another task")
	}
	got := s.referenceProgressForTask("beeftv-task")
	if got == nil || got.LoadedBytes != 512 {
		t.Fatal("progress missing")
	}
	port.ClearReference()
	port.ReportReference(generation.ReferenceProgress{LoadedBytes: 1024})
	if s.referenceProgressForTask("beeftv-task") != nil {
		t.Fatal("completed upload retained stale progress")
	}
}

func TestOldReferenceWorkerCannotOverwriteOrClearNewWorker(t *testing.T) {
	s := &Service{}
	old := s.newReferenceProgressPort("task")
	current := s.newReferenceProgressPort("task")
	current.ReportReference(generation.ReferenceProgress{LoadedBytes: 512})
	old.ReportReference(generation.ReferenceProgress{LoadedBytes: 4096})
	old.ClearReference()
	got := s.referenceProgressForTask("task")
	if got == nil || got.LoadedBytes != 512 {
		t.Fatal("old worker changed the current worker progress")
	}
}

func TestReferenceProgressConcurrentCallbacksAndClear(t *testing.T) {
	s := &Service{}
	p := s.newReferenceProgressPort("task")
	var pending sync.WaitGroup
	for worker := 0; worker < 4; worker++ {
		pending.Go(func() {
			for loaded := int64(0); loaded < 100; loaded++ {
				p.ReportReference(generation.ReferenceProgress{LoadedBytes: loaded})
				_ = s.referenceProgressForTask("task")
			}
		})
	}
	p.ClearReference()
	pending.Wait()
	if s.referenceProgressForTask("task") != nil {
		t.Fatal("late callback resurrected a cleared upload")
	}
}
