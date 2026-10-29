package app

import "infinite-canvas/backend/internal/asset"

// ResourceService exposes the same durable owner used by task delivery and
// uploads; composition must not create a second resource boundary.
func (s *Service) ResourceService() *asset.Service { return s.resourceDomain() }
