package app

import localproject "infinite-canvas/backend/internal/project"

func (s *Service) ProjectService() *localproject.Service {
	return s.projectDomain()
}

func (s *Service) projectDomain() *localproject.Service {
	if s.projects != nil {
		return s.projects
	}
	return localproject.New(s.repo, localproject.Dependencies{})
}
