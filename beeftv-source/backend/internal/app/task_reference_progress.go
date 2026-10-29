package app

import (
	"infinite-canvas/backend/internal/generation"
	"sync"
)

type appReferenceProgressPort struct {
	service *Service
	taskID  string
	mu      sync.Mutex
	closed  bool
	value   *generation.ReferenceProgress
}

func (s *Service) newReferenceProgressPort(taskID string) *appReferenceProgressPort {
	p := &appReferenceProgressPort{service: s, taskID: taskID}
	s.referenceProgress.Store(taskID, p)
	return p
}

func (p *appReferenceProgressPort) ReportReference(value generation.ReferenceProgress) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if !p.closed {
		p.value = &value
	}
}

func (p *appReferenceProgressPort) ClearReference() {
	p.mu.Lock()
	p.closed = true
	p.value = nil
	p.mu.Unlock()
	p.service.referenceProgress.CompareAndDelete(p.taskID, p)
}

func (s *Service) referenceProgressForTask(taskID string) *generation.ReferenceProgress {
	value, ok := s.referenceProgress.Load(taskID)
	if !ok {
		return nil
	}
	p := value.(*appReferenceProgressPort)
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.value == nil {
		return nil
	}
	progress := *p.value
	return &progress
}
