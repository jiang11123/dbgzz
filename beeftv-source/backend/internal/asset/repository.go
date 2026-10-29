package asset

import "infinite-canvas/backend/internal/repository"

type gormRepository struct {
	*repository.Repository
}

// NewRepository adapts the GORM resource store to the domain port.
func NewRepository(repo *repository.Repository) Repository {
	if repo == nil {
		return nil
	}
	return gormRepository{Repository: repo}
}
