package assistantturns

import "infinite-canvas/backend/internal/model"

// PendingContinuations is a bounded workspace scan. The durable receipt remains
// the queue; the cursor only prevents an incomplete old batch starving others.
func (s *Service) PendingContinuations(afterID string, limit int) ([]ContinuationView, error) {
	if limit <= 0 || limit > 64 {
		limit = 16
	}
	var rows []model.AssistantContinuation
	err := s.store.DB().Where("id > ? AND state IN ?", afterID, []string{"waiting", "claimed", "running"}).Order("id ASC").Limit(limit).Find(&rows).Error
	if err != nil {
		return nil, err
	}
	views := make([]ContinuationView, 0, len(rows))
	for _, row := range rows {
		views = append(views, continuationView(row))
	}
	return views, nil
}
