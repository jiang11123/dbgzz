package app

import (
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/outbound"
)

// deliveryProgressRegistry is a process-local, in-memory view of in-flight
// artifact downloads. It is never persisted: a restart simply loses progress,
// and the task projection reports nothing until delivery runs again.
type deliveryProgressRegistry struct {
	mu      sync.Mutex
	entries map[string]model.TaskDeliveryOutputProgress
}

func (s *Service) deliveryProgressRegistry() *deliveryProgressRegistry {
	s.deliveryProgressOnce.Do(func() {
		s.deliveryProgress = &deliveryProgressRegistry{}
	})
	return s.deliveryProgress
}

func (r *deliveryProgressRegistry) record(identity string, progress model.TaskDeliveryOutputProgress) {
	if r == nil {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.entries == nil {
		r.entries = map[string]model.TaskDeliveryOutputProgress{}
	}
	progress.UpdatedAt = time.Now().UnixMilli()
	r.entries[identity] = progress
}

func (r *deliveryProgressRegistry) clear(identity string) {
	if r == nil {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.entries, identity)
}

// forTask projects the live downloads of one task. The registry key is the
// delivery identity "taskID:outputIndex" already used by PersistRemoteArtifact.
func (r *deliveryProgressRegistry) forTask(taskID string) *model.TaskDeliveryProgress {
	if r == nil {
		return nil
	}
	prefix := strings.TrimSpace(taskID) + ":"
	r.mu.Lock()
	defer r.mu.Unlock()
	outputs := make([]model.TaskDeliveryOutputProgress, 0, len(r.entries))
	for identity, progress := range r.entries {
		if strings.HasPrefix(identity, prefix) {
			outputs = append(outputs, progress)
		}
	}
	if len(outputs) == 0 {
		return nil
	}
	sort.Slice(outputs, func(i, j int) bool { return outputs[i].OutputIndex < outputs[j].OutputIndex })
	return &model.TaskDeliveryProgress{Outputs: outputs}
}

func deliveryOutputIndex(identity string) int {
	if index := strings.LastIndex(identity, ":"); index >= 0 {
		if parsed, err := strconv.Atoi(identity[index+1:]); err == nil {
			return parsed
		}
	}
	return 0
}

func deliveryProgressFromOutbound(identity string, progress outbound.ResumableProgress) model.TaskDeliveryOutputProgress {
	return model.TaskDeliveryOutputProgress{
		OutputIndex:     deliveryOutputIndex(identity),
		DownloadedBytes: progress.DownloadedBytes,
		TotalBytes:      progress.TotalBytes,
		BytesPerSecond:  progress.BytesPerSecond,
		State:           progress.State,
	}
}
