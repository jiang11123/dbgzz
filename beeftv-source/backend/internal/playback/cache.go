package playback

import (
	"errors"
	"fmt"
	"infinite-canvas/backend/internal/model"
	"os"
)

// CacheStore only lists completed copies belonging to the authenticated user.
// In-flight work is left alone; original resource objects are never removed.
type CacheStore interface {
	PlaybackCopiesForUser(userID string) ([]model.Resource, error)
	ResetPlaybackCopy(userID, id, objectKey string) error
}

func (s *Service) ClearCache(userID string) (int, error) {
	store, ok := s.store.(CacheStore)
	if !ok {
		return 0, fmt.Errorf("视频预览缓存暂时无法清理")
	}
	s.cacheMu.Lock()
	defer s.cacheMu.Unlock()
	rows, err := store.PlaybackCopiesForUser(userID)
	if err != nil {
		return 0, err
	}
	cleared := 0
	for _, row := range rows {
		path := ""
		if row.PlaybackObjectKey != "" {
			key, err := copyObjectKey(row.ID)
			if err != nil || key != row.PlaybackObjectKey {
				return cleared, fmt.Errorf("视频预览缓存记录无效，无法清理")
			}
			path, err = s.copyPath(row.PlaybackObjectKey)
			if err != nil {
				return cleared, err
			}
			if err := ensureSafeExistingPath(s.playbackRoot(), path); err != nil && !errors.Is(err, os.ErrNotExist) {
				return cleared, err
			}
		}
		if err := store.ResetPlaybackCopy(userID, row.ID, row.PlaybackObjectKey); err != nil {
			return cleared, err
		}
		if path != "" {
			if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
				return cleared, err
			}
		}
		cleared++
	}
	return cleared, nil
}

// Prepare owns retry and missing-copy recovery under the same lock as cache clearing.
// Resource ownership has already been checked by the caller's resource domain.
func (s *Service) Prepare(resource *model.Resource) error {
	if s == nil || resource == nil || resource.Kind != "video" {
		return nil
	}
	s.cacheMu.Lock()
	defer s.cacheMu.Unlock()
	missing := false
	if resource.PlaybackStatus == model.PlaybackStatusReady {
		if resource.PlaybackObjectKey == "" {
			missing = true
		} else {
			path, err := s.copyPath(resource.PlaybackObjectKey)
			if err != nil {
				return err
			}
			if err := ensureSafeExistingPath(s.playbackRoot(), path); err != nil {
				if !errors.Is(err, os.ErrNotExist) {
					return err
				}
				missing = true
			}
		}
	}
	if resource.PlaybackStatus == model.PlaybackStatusFailed || missing {
		store, ok := s.store.(CacheStore)
		if !ok {
			return fmt.Errorf("视频预览暂时无法重新准备")
		}
		if err := store.ResetPlaybackCopy(resource.UserID, resource.ID, resource.PlaybackObjectKey); err != nil {
			return err
		}
		resource.PlaybackStatus = model.PlaybackStatusNone
		resource.PlaybackObjectKey = ""
	}
	s.maybeStart(resource)
	return nil
}
