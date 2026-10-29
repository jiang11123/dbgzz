package repository

import "infinite-canvas/backend/internal/model"

func (r *Repository) PlaybackCopiesForUser(userID string) ([]model.Resource, error) {
	var rows []model.Resource
	err := r.db.Where("user_id = ? AND provider = ? AND status = ? AND playback_status IN ?", userID, "local", model.ResourceStatusReady, []string{model.PlaybackStatusReady, model.PlaybackStatusFailed}).Find(&rows).Error
	return rows, err
}

func (r *Repository) ResetPlaybackCopy(userID, id, objectKey string) error {
	return r.db.Model(&model.Resource{}).Where("user_id = ? AND id = ? AND status = ? AND playback_object_key = ? AND playback_status IN ?", userID, id, model.ResourceStatusReady, objectKey, []string{model.PlaybackStatusReady, model.PlaybackStatusFailed}).Updates(map[string]any{"playback_status": model.PlaybackStatusNone, "playback_object_key": "", "playback_error": ""}).Error
}
