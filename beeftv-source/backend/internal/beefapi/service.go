package beefapi

import (
	"context"
	"errors"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/workspace"

	"github.com/pkg/browser"
)

var (
	errRevoked      = errors.New("BeefTV 连接已失效，请重新连接")
	errNotConnected = errors.New("尚未连接 BeefTV")
	errStore        = errors.New("保存连接失败，请重试")
)

type Options struct {
	DataDir       string
	Origin        string
	HTTPClient    *http.Client
	OpenURL       func(string) error
	Now           func() time.Time
	Sleep         func(time.Duration)
	Provider      *workspace.ProviderConfig
	ClientVersion string
	Hostname      string
	FetchCatalog  func(apiKey, baseURL string) ([]CatalogModel, error)
	Persist       func(persistedState) error
}

type Service struct {
	dataDir       string
	origin        string
	httpClient    *http.Client
	openURL       func(string) error
	now           func() time.Time
	sleep         func(time.Duration)
	provider      *workspace.ProviderConfig
	clientVersion string
	hostname      string
	fetchCatalog  func(apiKey, baseURL string) ([]CatalogModel, error)
	persistFn     func(persistedState) error

	mu         sync.Mutex
	state      persistedState
	pollCancel context.CancelFunc
	closed     bool
	lifecycle  context.Context
	shutdown   context.CancelFunc
	workers    sync.WaitGroup
}

func New(opts Options) (*Service, error) {
	origin, err := CanonicalOrigin(opts.Origin)
	if err != nil {
		return nil, err
	}
	dataDir := strings.TrimSpace(opts.DataDir)
	if dataDir == "" {
		return nil, errors.New("本地工作区数据目录不能为空")
	}
	httpClient := opts.HTTPClient
	openURL := opts.OpenURL
	if openURL == nil {
		openURL = browser.OpenURL
	}
	now := opts.Now
	if now == nil {
		now = time.Now
	}
	sleep := opts.Sleep
	hostname := strings.TrimSpace(opts.Hostname)
	if hostname == "" {
		hostname, _ = os.Hostname()
	}
	if hostname == "" {
		hostname = "BeefTV"
	}
	clientVersion := strings.TrimSpace(opts.ClientVersion)
	if clientVersion == "" {
		clientVersion = "dev"
	}
	state, err := loadState(dataDir)
	if err == nil {
		state.AuthorizationOrigin, err = savedOrigin(state, origin)
	}
	if err != nil {
		state = persistedState{SchemaVersion: connectionSchema, Status: StateStoreError, LastError: "读取已保存的连接失败", Balance: BalanceUnknown}
	}
	lifecycle, shutdown := context.WithCancel(context.Background())
	svc := &Service{
		dataDir: dataDir, origin: origin, httpClient: httpClient, openURL: openURL,
		now: now, sleep: sleep, provider: opts.Provider, clientVersion: clientVersion,
		hostname: hostname, fetchCatalog: opts.FetchCatalog, persistFn: opts.Persist, state: state,
		lifecycle: lifecycle, shutdown: shutdown,
	}
	if svc.httpClient == nil {
		svc.httpClient = defaultHTTPClient(func() {
			svc.mu.Lock()
			defer svc.mu.Unlock()
			if !svc.closed && svc.state.Status == StateConnecting {
				svc.state.LastError = "正在尝试其他连接方式"
			}
		})
	}
	return svc, nil
}

func (s *Service) persistState(state persistedState) error {
	if s.persistFn != nil {
		return s.persistFn(state)
	}
	return saveState(s.dataDir, state)
}

func (s *Service) Close() {
	s.mu.Lock()
	s.closed = true
	s.shutdown()
	if s.pollCancel != nil {
		s.pollCancel()
		s.pollCancel = nil
	}
	s.mu.Unlock()
	// Admission and Add are protected by mu; no new worker can race this Wait.
	// Never hold mu here: finishing workers need it to save their state.
	s.workers.Wait()
}

func (s *Service) beginWork() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return errors.New("企业连接服务已关闭")
	}
	s.workers.Add(1)
	return nil
}

func (s *Service) pause(ctx context.Context, duration time.Duration) bool {
	if ctx.Err() != nil {
		return false
	}
	if s.sleep != nil {
		s.sleep(duration)
		return ctx.Err() == nil
	}
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}

func (s *Service) Origin() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.state.AuthorizationOrigin != "" {
		return s.state.AuthorizationOrigin
	}
	return s.origin
}

// Existing encrypted credentials and pending grants remain bound to their issuer.
// Only the two production origins or this explicitly configured test origin may be restored.
func savedOrigin(state persistedState, fallback string) (string, error) {
	candidate := state.AuthorizationOrigin
	if candidate == "" {
		candidate = state.ProviderBaseURL
	}
	if candidate == "" && state.Device != nil {
		for _, origin := range []string{ProductionOrigin, LegacyOrigin, fallback} {
			if _, err := ValidateVerificationURL(origin, state.Device.VerificationURI); err == nil {
				candidate = origin
				break
			}
		}
		if candidate == "" {
			return "", errStore
		}
	}
	if candidate == "" && state.hasCredential() {
		candidate = LegacyOrigin
	}
	if candidate == "" {
		candidate = fallback
	}
	if candidate != ProductionOrigin && candidate != LegacyOrigin && candidate != fallback {
		return "", errStore
	}
	if state.ProviderBaseURL != "" && state.ProviderBaseURL != candidate {
		return "", errStore
	}
	return candidate, nil
}

func (s *Service) Status() Summary {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.summaryLocked()
}

func (s *Service) HasManagedCredential() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.state.hasCredential()
}

func (s *Service) Resolve() (Credential, error) {
	s.mu.Lock()
	state := s.state
	s.mu.Unlock()
	if !state.hasCredential() {
		return Credential{}, errNotConnected
	}
	if state.Status == StateRevoked {
		return Credential{}, errRevoked
	}
	apiKey, err := decryptSecret(s.dataDir, state.EncryptedAPIKey)
	if err != nil {
		return Credential{}, &kernel.AppError{Status: 500, Code: 500, Reason: "local_credential_failed", Message: "本地算力凭据读取失败。" + credentialFailureDetail(err) + "。请检查工作区数据目录并重新连接算力账号；不要删除工作区密钥", Cause: err}
	}
	if strings.TrimSpace(apiKey) == "" {
		return Credential{}, errNotConnected
	}
	accountID := ""
	if state.Account != nil {
		accountID = state.Account.ID.String()
	}
	baseURL := state.ProviderBaseURL
	if baseURL == "" {
		baseURL = state.AuthorizationOrigin
	}
	return Credential{APIKey: apiKey, BaseURL: baseURL, AccountID: accountID, TokenID: state.TokenID, KeyName: state.KeyName}, nil
}

// Only allowlisted causes leave the credential boundary; never copy a key or path.
func credentialFailureDetail(err error) string {
	switch {
	case errors.Is(err, os.ErrNotExist):
		return "工作区密钥文件不存在"
	case errors.Is(err, os.ErrPermission):
		return "没有读取工作区密钥文件的权限"
	}
	switch err.Error() {
	case "工作区密钥长度无效", "本地密钥密文格式无效", "本地密钥密文长度无效", "本地密钥解密失败，请检查工作区密钥":
		return err.Error()
	default:
		return "读取工作区密钥文件失败"
	}
}

func (s *Service) MarkRevoked() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.state.hasCredential() {
		return
	}
	s.state.Status = StateRevoked
	s.state.LastError = "连接已失效，请重新连接"
	_ = s.persistState(s.state)
}

func (s *Service) MarkZeroBalance() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.state.Balance = BalanceZero
	_ = s.persistState(s.state)
}

func (s *Service) needsFinalizeLocked() bool {
	if !s.state.hasCredential() {
		return false
	}
	if s.state.Status == StateExpired || s.state.Status == StateRejected || s.state.Status == StateRevoked {
		return false
	}
	return !s.state.Acked || !s.state.CatalogOK || s.state.Status == StateCatalogFailed || s.state.Status == StateStoreError
}

func (s *Service) Start(ctx context.Context) (Summary, error) {
	if err := s.beginWork(); err != nil {
		return Summary{}, err
	}
	defer s.workers.Done()
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return Summary{}, errors.New("企业连接服务已关闭")
	}
	if s.state.Status == StateConnecting {
		summary := s.summaryLocked()
		s.mu.Unlock()
		return summary, nil
	}
	if s.needsFinalizeLocked() {
		s.mu.Unlock()
		if err := s.finalizeSavedCredential(ctx, ""); err == nil {
			return s.Status(), nil
		}
		summary := s.Status()
		if summary.HasCredential && summary.State != StateExpired && summary.State != StateRejected && summary.State != StateRevoked {
			return summary, nil
		}
		s.mu.Lock()
	} else if s.state.Status == StateConnected && s.state.hasCredential() && s.state.Acked && s.state.CatalogOK {
		summary := s.summaryLocked()
		s.mu.Unlock()
		return summary, nil
	} else if s.state.Status == StatePending && s.state.Device != nil && s.now().Before(parseTime(s.state.Device.ExpiresAt)) {
		summary := s.summaryLocked()
		s.mu.Unlock()
		return summary, nil
	}
	if s.state.hasCredential() {
		summary := s.summaryLocked()
		s.mu.Unlock()
		return summary, nil
	}
	if s.pollCancel != nil {
		s.pollCancel()
		s.pollCancel = nil
	}
	s.state.AuthorizationOrigin = s.origin
	s.state.ProviderBaseURL = ""
	s.state.Status = StateConnecting
	s.state.LastError = "正在连接 BeefTV"
	s.mu.Unlock()

	device, err := s.requestDeviceCode()
	if s.lifecycle.Err() != nil {
		return s.Status(), s.lifecycle.Err()
	}
	if err != nil {
		s.setError(StateConnectionError, err.Error())
		return s.Status(), err
	}
	expiresAt := s.now().Add(time.Duration(device.ExpiresIn) * time.Second).UTC().Format(time.RFC3339Nano)
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return s.Status(), context.Canceled
	}
	s.state.Status = StatePending
	s.state.LastError = ""
	s.state.Device = &persistedDevice{
		DeviceCode: device.DeviceCode, UserCode: device.UserCode,
		VerificationURI: device.VerificationURI, VerificationURIComplete: device.VerificationURIComplete,
		IntervalSeconds: device.Interval, ExpiresAt: expiresAt,
	}
	if err := s.persistState(s.state); err != nil {
		s.state.Status = StateStoreError
		s.state.LastError = "保存连接失败，请重试"
		s.mu.Unlock()
		return s.Status(), errStore
	}
	pollCtx, cancel := context.WithCancel(s.lifecycle)
	s.pollCancel = cancel
	s.workers.Add(1)
	summary := s.summaryLocked()
	s.mu.Unlock()

	openTarget := device.VerificationURIComplete
	if openTarget == "" {
		openTarget = device.VerificationURI
	}
	if err := s.openTrusted(openTarget); err != nil {
		s.setError(StatePending, "无法打开系统浏览器，请复制确认页地址")
	}
	go func() {
		defer s.workers.Done()
		s.pollLoop(pollCtx, device.DeviceCode, time.Duration(device.Interval)*time.Second, parseTime(expiresAt))
	}()
	return summary, nil
}

func (s *Service) Cancel(ctx context.Context) (Summary, error) {
	if err := s.beginWork(); err != nil {
		return Summary{}, err
	}
	defer s.workers.Done()
	s.mu.Lock()
	deviceCode := ""
	if s.state.Device != nil {
		deviceCode = s.state.Device.DeviceCode
	}
	if s.pollCancel != nil {
		s.pollCancel()
		s.pollCancel = nil
	}
	s.mu.Unlock()
	_ = s.cancelRemote(deviceCode)
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.state.hasCredential() && s.state.Acked && s.state.Status == StateConnected {
		return s.summaryLocked(), nil
	}
	s.state.Status = StateCancelled
	s.state.Device = nil
	s.state.LastError = ""
	if !s.state.Acked {
		s.state.EncryptedAPIKey = ""
		s.state.CatalogOK = false
	}
	if err := s.persistState(s.state); err != nil {
		s.state.Status = StateStoreError
		s.state.LastError = "保存连接失败，请重试"
		return s.summaryLocked(), errStore
	}
	return s.summaryLocked(), nil
}

func (s *Service) Disconnect(ctx context.Context) (Summary, error) {
	if err := s.beginWork(); err != nil {
		return Summary{}, err
	}
	defer s.workers.Done()
	s.mu.Lock()
	if s.pollCancel != nil {
		s.pollCancel()
		s.pollCancel = nil
	}
	encrypted := s.state.EncryptedAPIKey
	s.mu.Unlock()
	if encrypted != "" {
		if apiKey, err := decryptSecret(s.dataDir, encrypted); err == nil && apiKey != "" {
			_ = s.revokeRemote(apiKey)
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	// Catalog removal and credential invalidation must be atomic to refreshes.
	if err := clearBeefAPIModels(s.provider); err != nil {
		s.state.Status = StateStoreError
		s.state.LastError = "保存连接失败，请重试"
		return s.summaryLocked(), errStore
	}
	s.state = persistedState{SchemaVersion: connectionSchema, Status: StateDisconnected, Balance: BalanceUnknown}
	if err := s.persistState(s.state); err != nil {
		s.state.Status = StateStoreError
		s.state.LastError = "保存连接失败，请重试"
		return s.summaryLocked(), errStore
	}
	return s.summaryLocked(), nil
}

func (s *Service) OpenWallet() error {
	return s.openTrusted(WalletURL(s.origin))
}

func (s *Service) Recover(ctx context.Context) error {
	if err := s.beginWork(); err != nil {
		return err
	}
	defer s.workers.Done()
	s.mu.Lock()
	needsFinalize := s.needsFinalizeLocked()
	state := s.state
	s.mu.Unlock()
	if needsFinalize {
		return s.finalizeSavedCredential(ctx, "")
	}
	if state.Status == StatePending && state.Device != nil {
		expires := parseTime(state.Device.ExpiresAt)
		if s.now().After(expires) {
			s.setError(StateExpired, "授权已过期，请重新连接")
			return nil
		}
		s.mu.Lock()
		if s.closed || s.pollCancel != nil {
			s.mu.Unlock()
			return nil
		}
		pollCtx, cancel := context.WithCancel(s.lifecycle)
		s.pollCancel = cancel
		s.workers.Add(1)
		deviceCode := state.Device.DeviceCode
		interval := time.Duration(state.Device.IntervalSeconds) * time.Second
		s.mu.Unlock()
		go func() { defer s.workers.Done(); s.pollLoop(pollCtx, deviceCode, interval, expires) }()
	}
	if state.Status == StateConnected && state.hasCredential() {
		s.mu.Lock()
		if !s.closed {
			s.workers.Add(1)
			go func() { defer s.workers.Done(); s.verifyRemote() }()
		}
		s.mu.Unlock()
	}
	return nil
}

func (s *Service) RedactConfig(config map[string]any) map[string]any {
	managed := s.HasManagedCredential()
	result := RedactConfig(config, managed)
	if managed {
		channels, _ := result["channels"].([]any)
		for _, raw := range channels {
			if channel, ok := raw.(map[string]any); ok && channel["id"] == ChannelID {
				channel["baseUrl"] = s.Origin()
			}
		}
	}
	return result
}

func (s *Service) PreserveWrite(incoming, existing map[string]any) {
	PreserveManagedChannel(incoming, existing, s.HasManagedCredential())
}

func (s *Service) pollLoop(ctx context.Context, deviceCode string, interval time.Duration, expiresAt time.Time) {
	if interval < time.Second {
		interval = 5 * time.Second
	}
	for {
		select {
		case <-ctx.Done():
			return
		default:
		}
		if !expiresAt.IsZero() && s.now().After(expiresAt) {
			s.setError(StateExpired, "授权已过期，请重新连接")
			return
		}
		token, code, err := s.pollToken(deviceCode)
		if ctx.Err() != nil {
			return
		}
		if err != nil {
			s.updatePollMessage(deviceCode, "连接中断，正在重试")
			if !s.pause(ctx, interval) {
				return
			}
			continue
		}
		switch code {
		case "", "success":
			if strings.TrimSpace(token.APIKey) == "" {
				if !s.pause(ctx, interval) {
					return
				}
				continue
			}
			if err := s.acceptToken(ctx, deviceCode, token); err != nil {
				return
			}
			return
		case "authorization_pending":
			s.updatePollMessage(deviceCode, "")
			if !s.pause(ctx, interval) {
				return
			}
		case "slow_down":
			interval += 5 * time.Second
			if !s.pause(ctx, interval) {
				return
			}
		case "expired_token", "expired":
			s.setError(StateExpired, "授权已过期，请重新连接")
			return
		case "access_denied", "denied", "rejected":
			s.setError(StateRejected, "授权被拒绝")
			return
		default:
			s.updatePollMessage(deviceCode, "授权状态读取失败，正在重试")
			if !s.pause(ctx, interval) {
				return
			}
		}
	}
}

func (s *Service) updatePollMessage(deviceCode, message string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.closed && s.state.Status == StatePending && s.state.Device != nil && s.state.Device.DeviceCode == deviceCode {
		s.state.LastError = message
	}
}

const ackRetryLimit = 5

func (s *Service) acceptToken(ctx context.Context, deviceCode string, token tokenSuccess) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	origin := s.Origin()
	accountID, tokenID, err := validateTokenSuccess(origin, token)
	if err != nil {
		s.setError(StateRejected, err.Error())
		return err
	}
	encrypted, err := encryptSecret(s.dataDir, token.APIKey)
	if err != nil {
		s.setError(StateStoreError, "保存连接失败，请重试")
		return errStore
	}
	s.mu.Lock()
	previousAccount := ""
	if s.state.Account != nil {
		previousAccount = s.state.Account.ID.String()
	}
	previousEncrypted := s.state.EncryptedAPIKey
	account := token.Account
	account.ID = wireID(accountID)
	if s.state.Device == nil {
		s.state.Device = &persistedDevice{}
	}
	s.state.Device.DeviceCode = deviceCode
	s.state.EncryptedAPIKey = encrypted
	s.state.ProviderBaseURL = ProviderBaseURL(origin)
	s.state.Market = "enterprise"
	s.state.Group = "enterprise"
	s.state.Account = &account
	s.state.KeyName = token.KeyName
	s.state.TokenID = tokenID
	s.state.Acked = false
	s.state.CatalogOK = false
	s.state.AssistantDefaultPending = true
	s.state.Status = StatePending
	s.state.Balance = BalanceUnknown
	s.state.LastError = ""
	if err := s.persistState(s.state); err != nil {
		s.state.Status = StateStoreError
		s.state.LastError = "保存连接失败，请重试"
		s.mu.Unlock()
		return errStore
	}
	s.mu.Unlock()
	if previousEncrypted != "" && previousAccount != "" && previousAccount != accountID {
		if oldKey, decryptErr := decryptSecret(s.dataDir, previousEncrypted); decryptErr == nil && oldKey != "" && oldKey != token.APIKey {
			_ = s.revokeRemote(oldKey)
		}
	}
	return s.finalizeSavedCredential(ctx, previousAccount)
}

func (s *Service) finalizeSavedCredential(ctx context.Context, previousAccountID string) error {
	if s.lifecycle.Err() != nil {
		return s.lifecycle.Err()
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	s.mu.Lock()
	state := s.state
	deviceCode := ""
	if state.Device != nil {
		deviceCode = state.Device.DeviceCode
	}
	previousAccount := strings.TrimSpace(previousAccountID)
	s.mu.Unlock()
	if !state.hasCredential() {
		return errNotConnected
	}
	if !state.Acked {
		if strings.TrimSpace(deviceCode) == "" {
			s.markDoomedCredential(StateExpired, "授权已过期，请重新连接")
			return errAckExpired
		}
		s.mu.Lock()
		s.state.Status = StatePending
		s.state.LastError = "正在完成连接确认"
		s.mu.Unlock()
		if err := s.acknowledgeWithRetry(deviceCode); err != nil {
			if s.lifecycle.Err() != nil {
				return s.lifecycle.Err()
			}
			s.noteAckFailure(err)
			return err
		}
		s.mu.Lock()
		previousDevice := s.state.Device
		s.state.Acked = true
		s.state.LastError = ""
		s.state.Device = nil
		if err := s.persistState(s.state); err != nil {
			s.state.Acked = false
			s.state.Device = previousDevice
			s.state.Status = StateStoreError
			s.state.LastError = "保存连接失败，请重试"
			s.mu.Unlock()
			return errStore
		}
		s.mu.Unlock()
	}
	apiKey, err := decryptSecret(s.dataDir, state.EncryptedAPIKey)
	if err != nil {
		s.setError(StateStoreError, "保存连接失败，请重试")
		return errStore
	}
	models, err := s.fetchModels(apiKey)
	if s.lifecycle.Err() != nil {
		return s.lifecycle.Err()
	}
	if err != nil {
		if errors.Is(err, errRevoked) {
			s.MarkRevoked()
			return errRevoked
		}
		s.mu.Lock()
		s.state.Status = StateCatalogFailed
		s.state.CatalogOK = false
		s.state.LastError = "模型列表读取失败，请重试"
		if persistErr := s.persistState(s.state); persistErr != nil {
			s.state.Status = StateStoreError
			s.state.LastError = "保存连接失败，请重试"
			s.mu.Unlock()
			return errStore
		}
		s.mu.Unlock()
		return err
	}
	nextAccount := previousAccount
	s.mu.Lock()
	if s.state.Account != nil {
		nextAccount = s.state.Account.ID.String()
	}
	s.mu.Unlock()
	authorizationID := ""
	if state.AssistantDefaultPending {
		authorizationID = state.TokenID
	}
	if err := applyCatalog(s.provider, models, previousAccount, nextAccount, authorizationID); err != nil {
		s.mu.Lock()
		s.state.Status = StateCatalogFailed
		s.state.CatalogOK = false
		s.state.LastError = "模型列表读取失败，请重试"
		if persistErr := s.persistState(s.state); persistErr != nil {
			s.state.Status = StateStoreError
			s.state.LastError = "保存连接失败，请重试"
			s.mu.Unlock()
			return errStore
		}
		s.mu.Unlock()
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.state.CatalogOK = true
	s.state.AssistantDefaultPending = false
	s.state.Status = StateConnected
	s.state.LastError = ""
	s.state.Device = nil
	if s.state.ConnectedAt == "" {
		s.state.ConnectedAt = s.now().UTC().Format(time.RFC3339Nano)
	}
	if err := s.persistState(s.state); err != nil {
		s.state.CatalogOK = false
		s.state.Status = StateStoreError
		s.state.LastError = "保存连接失败，请重试"
		return errStore
	}
	return nil
}

func (s *Service) acknowledgeWithRetry(deviceCode string) error {
	var last error
	for attempt := 0; attempt < ackRetryLimit; attempt++ {
		if s.lifecycle.Err() != nil {
			return s.lifecycle.Err()
		}
		if attempt > 0 {
			if !s.pause(s.lifecycle, time.Second) {
				return s.lifecycle.Err()
			}
		}
		last = s.acknowledge(deviceCode)
		if last == nil {
			return nil
		}
		if isPermanentAck(last) {
			return last
		}
	}
	if last == nil {
		last = errAckTransient
	}
	return last
}

func (s *Service) noteAckFailure(err error) {
	switch {
	case errors.Is(err, errAckExpired):
		s.markDoomedCredential(StateExpired, "授权已过期，请重新连接")
	case errors.Is(err, errAckRejected):
		s.markDoomedCredential(StateRejected, "授权被拒绝")
	default:
		s.mu.Lock()
		defer s.mu.Unlock()
		s.state.Status = StateConnectionError
		s.state.Acked = false
		s.state.CatalogOK = false
		s.state.LastError = "连接确认失败，请重试"
		if persistErr := s.persistState(s.state); persistErr != nil {
			s.state.Status = StateStoreError
			s.state.LastError = "保存连接失败，请重试"
		}
	}
}

func (s *Service) markDoomedCredential(status, message string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.state.Status = status
	s.state.LastError = message
	s.state.EncryptedAPIKey = ""
	s.state.Acked = false
	s.state.CatalogOK = false
	s.state.Device = nil
	s.state.TokenID = ""
	s.state.Account = nil
	if persistErr := s.persistState(s.state); persistErr != nil {
		s.state.Status = StateStoreError
		s.state.LastError = "保存连接失败，请重试"
	}
}

func (s *Service) verifyRemote() {
	cred, err := s.Resolve()
	if err != nil {
		return
	}
	_, status, err := s.remoteConnection(cred.APIKey)
	if s.lifecycle.Err() != nil {
		return
	}
	if err != nil {
		return
	}
	if status == http.StatusUnauthorized || status == http.StatusForbidden {
		s.MarkRevoked()
	}
}

func (s *Service) openTrusted(raw string) error {
	target := strings.TrimSpace(raw)
	if target == "" {
		target = WalletURL(s.origin)
	}
	parsed, err := ValidateWalletURL(s.origin, target)
	if err != nil {
		if parsed, err = ValidateVerificationURL(s.Origin(), target); err != nil {
			return err
		}
	}
	return s.openURL(parsed.String())
}

func (s *Service) setError(status, message string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return
	}
	s.state.Status = status
	s.state.LastError = message
	if status != StatePending {
		if s.pollCancel != nil {
			s.pollCancel()
			s.pollCancel = nil
		}
	}
	_ = s.persistState(s.state)
}

func (s *Service) summaryLocked() Summary {
	summary := Summary{
		State:         s.state.Status,
		Market:        s.state.Market,
		KeyName:       s.state.KeyName,
		TokenID:       s.state.TokenID,
		Balance:       s.state.Balance,
		ErrorReason:   s.state.LastError,
		ConnectedAt:   s.state.ConnectedAt,
		HasCredential: s.state.hasCredential(),
		CatalogFailed: s.state.Status == StateCatalogFailed || (s.state.hasCredential() && !s.state.CatalogOK && s.state.Status != StatePending),
	}
	if s.state.hasCredential() {
		summary.CredentialRef = CredentialRef
		summary.WalletURL = WalletURL(s.origin)
		if s.state.Account != nil {
			account := *s.state.Account
			summary.Account = &account
		}
	}
	if s.state.Device != nil && s.state.Status == StatePending {
		summary.UserCode = s.state.Device.UserCode
		summary.VerificationURI = s.state.Device.VerificationURIComplete
		if summary.VerificationURI == "" {
			summary.VerificationURI = s.state.Device.VerificationURI
		}
		summary.ExpiresAt = s.state.Device.ExpiresAt
	}
	if summary.State == "" {
		summary.State = StateDisconnected
	}
	return summary
}
