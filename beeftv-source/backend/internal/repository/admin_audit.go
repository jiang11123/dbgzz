package repository

import "infinite-canvas/backend/internal/model"

// AppendAdminAudit keeps an append-only record of local configuration changes.
// It is intentionally independent from accounts, sessions, and SaaS operators.
func (r *Repository) AppendAdminAudit(event *model.AdminAuditEvent) error {
	return r.db.Create(event).Error
}

func (r *Repository) APICallLog(id string) (*model.ApiCallLog, error) {
	var log model.ApiCallLog
	if err := r.db.First(&log, "id = ?", id).Error; err != nil {
		return nil, err
	}
	return &log, nil
}
