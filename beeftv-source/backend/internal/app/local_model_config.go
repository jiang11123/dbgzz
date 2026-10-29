package app

import "infinite-canvas/backend/internal/workspace"

// ReadLocalModelConfig reads the desktop-only provider snapshot. It is kept
// outside the browser so frontend asset updates cannot clear API credentials
// or model capability metadata.
func (s *Service) ReadLocalModelConfig() ([]byte, error) {
	store, err := workspace.NewProviderConfig(s.dataDir)
	if err != nil {
		return nil, err
	}
	return store.ReadLocalModelConfig()
}

// SaveLocalModelConfig atomically stores the frontend config snapshot with
// owner-only permissions. The file is deliberately local and never included
// in API responses other than the same local workspace process.
func (s *Service) SaveLocalModelConfig(body []byte) error {
	store, err := workspace.NewProviderConfig(s.dataDir)
	if err != nil {
		return err
	}
	return store.SaveLocalModelConfig(body)
}
