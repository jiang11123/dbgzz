package repository

import (
	"infinite-canvas/backend/internal/model"
)

func (r *Repository) Workspace(id string) (*model.Workspace, error) {
	var value model.Workspace
	if err := r.db.First(&value, "id = ?", id).Error; err != nil {
		return nil, err
	}
	return &value, nil
}

func (r *Repository) DefaultWorkspace() (*model.Workspace, error) {
	var value model.Workspace
	if err := r.db.Order("created_at ASC").First(&value).Error; err != nil {
		return nil, err
	}
	return &value, nil
}
