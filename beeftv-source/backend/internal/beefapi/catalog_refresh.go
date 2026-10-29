package beefapi

import (
	"context"
	"errors"
)

// RefreshCatalog fetches and persists prices through the saved connection. A
// client config write must never supply the managed catalog's trusted prices.
func (s *Service) RefreshCatalog(ctx context.Context) ([]CatalogModel, error) {
	if err := s.beginWork(); err != nil {
		return nil, err
	}
	defer s.workers.Done()
	s.mu.Lock()
	state := s.state
	closed := s.closed
	s.mu.Unlock()
	if closed || !state.hasCredential() || !state.Acked {
		return nil, errNotConnected
	}
	if s.provider == nil {
		return nil, errStore
	}
	if state.Status == StateRevoked || state.Status == StateExpired || state.Status == StateRejected {
		return nil, errRevoked
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	apiKey, err := decryptSecret(s.dataDir, state.EncryptedAPIKey)
	if err != nil {
		return nil, errStore
	}
	models, err := s.fetchModels(apiKey)
	if err != nil {
		if errors.Is(err, errRevoked) {
			return nil, errRevoked
		}
		return nil, errors.New("读取模型列表失败，请重试")
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	// A disconnect or account change during the fetch invalidates its result.
	if s.closed || s.state.EncryptedAPIKey != state.EncryptedAPIKey || s.state.TokenID != state.TokenID ||
		s.state.ProviderBaseURL != state.ProviderBaseURL || s.state.Status != state.Status {
		return nil, errors.New("企业连接已改变，请重新读取模型")
	}
	accountID := ""
	if state.Account != nil {
		accountID = state.Account.ID.String()
	}
	currentAccountID := ""
	if s.state.Account != nil {
		currentAccountID = s.state.Account.ID.String()
	}
	if currentAccountID != accountID {
		return nil, errors.New("企业连接已改变，请重新读取模型")
	}
	if err := applyCatalog(s.provider, models, accountID, accountID, ""); err != nil {
		return nil, errStore
	}
	return models, nil
}
