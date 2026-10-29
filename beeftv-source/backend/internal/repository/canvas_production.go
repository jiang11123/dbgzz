package repository

import "infinite-canvas/backend/internal/model"

func (r *Repository) ProductionLinksForTask(taskID string) ([]model.ProductionTaskLink, error) {
	var links []model.ProductionTaskLink
	err := r.db.Where("task_id = ?", taskID).Find(&links).Error
	return links, err
}

func (r *Repository) ShotArtifactsForTask(taskID string) ([]model.ShotArtifact, error) {
	var artifacts []model.ShotArtifact
	err := r.db.Where("task_id = ?", taskID).Find(&artifacts).Error
	return artifacts, err
}
