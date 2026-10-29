package app

import (
	"encoding/json"
	"strings"
	"time"

	"infinite-canvas/backend/internal/model"
)

func (s *Service) appendAdminAudit(actor *model.User, action string, targetType string, targetID string, summary string, metadata any) error {
	event, err := newAdminAuditEvent(actor, action, targetType, targetID, summary, metadata)
	if err != nil {
		return err
	}
	return s.repo.AppendAdminAudit(event)
}

func newAdminAuditEvent(actor *model.User, action string, targetType string, targetID string, summary string, metadata any) (*model.AdminAuditEvent, error) {
	if actor == nil {
		return nil, Unauthorized("请先登录")
	}
	encoded := ""
	if metadata != nil {
		data, err := json.Marshal(metadata)
		if err != nil {
			return nil, err
		}
		encoded = string(data)
	}
	return &model.AdminAuditEvent{
		ID: newID(), ActorUserID: actor.ID, Action: strings.TrimSpace(action), TargetType: strings.TrimSpace(targetType),
		TargetID: strings.TrimSpace(targetID), Summary: truncateRunes(strings.TrimSpace(summary), 500), MetadataJSON: encoded, CreatedAt: time.Now(),
	}, nil
}
