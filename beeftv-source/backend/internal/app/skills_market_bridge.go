package app

import (
	"context"
	"infinite-canvas/backend/internal/skillhub"
	"infinite-canvas/backend/internal/skills"
	"time"
)

func (s *Service) SkillsDomain() *skills.Service { return s.skillDomain() }

func (s *operationSession) SearchSkillMarket(query string, page, pageSize int) (*skillhub.SearchResult, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return s.service.skillDomain().MarketSearch(ctx, query, page, pageSize)
}
func (s *operationSession) GetSkillMarketRelease(id, release string) (*skillhub.Release, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return s.service.skillDomain().MarketRelease(ctx, id, release)
}
func (s *operationSession) ReadSkillMarketFile(id, release, name string, offset, limit int) (*skillhub.FileChunk, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return s.service.skillDomain().MarketFile(ctx, id, release, name, offset, limit)
}
func (s *operationSession) DraftSkill(user string, input skills.SkillMutationRequest) (*skills.SkillItem, error) {
	return skills.New(s.repo, s.service.dataDir, nil).CreateSkill(user, input)
}
func (s *operationSession) PrepareSkillPublication(user, id, canvas string, metadata skillhub.Metadata, target skills.PublicationTarget) (*skills.PublishPlan, error) {
	if _, e := s.UserCanvasProject(user, canvas); e != nil {
		return nil, e
	}
	return skills.New(s.repo, s.service.dataDir, nil).PublishPrepareInCanvas(user, id, canvas, metadata, target)
}
func (s *operationSession) SkillPublicationStatus(user, id string) (*skills.PublishPlan, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return s.service.skillDomain().PublicationStatus(ctx, user, id)
}
