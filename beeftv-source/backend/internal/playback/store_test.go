package playback

import (
	"sync"

	"infinite-canvas/backend/internal/model"
)

type memStore struct {
	mu        sync.Mutex
	resources map[string]*model.Resource
}

func (s *memStore) init() {
	if s.resources == nil {
		s.resources = map[string]*model.Resource{}
	}
}

func (s *memStore) put(resource model.Resource) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.init()
	copy := resource
	s.resources[resource.ID] = &copy
}

func (s *memStore) ResourceForUser(userID, id string) (*model.Resource, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.init()
	resource := s.resources[id]
	if resource == nil || resource.UserID != userID {
		return nil, nil
	}
	copy := *resource
	return &copy, nil
}

func (s *memStore) ClaimPlaybackTranscode(id string) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.init()
	resource := s.resources[id]
	if resource == nil || resource.Status != model.ResourceStatusReady {
		return false, nil
	}
	if resource.PlaybackStatus != "" && resource.PlaybackStatus != model.PlaybackStatusNone {
		return false, nil
	}
	resource.PlaybackStatus = model.PlaybackStatusProcessing
	resource.PlaybackError = ""
	return true, nil
}

func (s *memStore) ReleasePlaybackTranscodeClaim(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.init()
	resource := s.resources[id]
	if resource == nil || resource.PlaybackStatus != model.PlaybackStatusProcessing || resource.Status != model.ResourceStatusReady {
		return nil
	}
	resource.PlaybackStatus = ""
	resource.PlaybackError = ""
	return nil
}

func (s *memStore) FinishPlaybackTranscode(id, status, objectKey, errText string) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.init()
	resource := s.resources[id]
	if resource == nil || resource.PlaybackStatus != model.PlaybackStatusProcessing || resource.Status != model.ResourceStatusReady {
		return false, nil
	}
	resource.PlaybackStatus = status
	resource.PlaybackObjectKey = objectKey
	resource.PlaybackError = errText
	return true, nil
}

func (s *memStore) MarkPlaybackNone(id string) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.init()
	resource := s.resources[id]
	if resource == nil || resource.Status != model.ResourceStatusReady {
		return false, nil
	}
	if resource.PlaybackStatus != "" && resource.PlaybackStatus != model.PlaybackStatusNone {
		return false, nil
	}
	resource.PlaybackStatus = model.PlaybackStatusNone
	resource.PlaybackError = ""
	return true, nil
}

func (s *memStore) ResetStuckPlaybackTranscodes() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.init()
	for _, resource := range s.resources {
		if resource.PlaybackStatus == model.PlaybackStatusProcessing {
			resource.PlaybackStatus = ""
			resource.PlaybackError = ""
		}
	}
	return nil
}

func (s *memStore) get(id string) *model.Resource {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.init()
	resource := s.resources[id]
	if resource == nil {
		return nil
	}
	copy := *resource
	return &copy
}

func (s *memStore) setStatus(id string, status model.ResourceStatus) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.init()
	if resource := s.resources[id]; resource != nil {
		resource.Status = status
	}
}
