package app

import (
	"errors"
	"infinite-canvas/backend/internal/kernel"
	stdlog "log"
	"time"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/modelcatalog"

	"gorm.io/gorm"
)

type AdminListQuery struct {
	Keyword string
	Status  string
	Type    string
	Page    int
	Limit   int
}

type AdminChannelReference struct {
	ID      string   `json:"id"`
	Name    string   `json:"name"`
	Enabled bool     `json:"enabled"`
	Models  []string `json:"models"`
}

func (s *Service) RequireAdmin(user *model.User) error {
	if user == nil {
		return Unauthorized("请先登录")
	}
	if user.Role != model.UserRoleAdmin {
		return Forbidden("需要管理员权限")
	}
	return nil
}

func (s *Service) PublicSystemChannels() ([]PublicModelChannel, error) {
	channels, err := s.repo.SystemChannels(false)
	if err != nil {
		return nil, err
	}
	result := make([]PublicModelChannel, 0, len(channels))
	for _, channel := range channels {
		items, itemErr := s.repo.ChannelModels(channel.ID, false)
		if itemErr != nil {
			return nil, itemErr
		}
		result = append(result, publicChannel(channel, false, items))
	}
	return result, nil
}

func (s *Service) SystemChannel(id string) (*model.ModelChannel, error) {
	channel, err := s.repo.SystemChannel(id)
	if err != nil {
		return nil, err
	}
	if err := s.decryptSystemChannelSecrets(channel); err != nil {
		return nil, err
	}
	return channel, nil
}

func (s *Service) adminSystemChannel(id string) (*model.ModelChannel, error) {
	channel, err := s.repo.AdminSystemChannel(id)
	if err != nil {
		return nil, err
	}
	if err := s.decryptSystemChannelSecrets(channel); err != nil {
		return nil, err
	}
	return channel, nil
}

func (s *Service) AdminSystemChannelPage(actor *model.User, query AdminListQuery) (*AdminChannelPage, error) {
	if err := s.RequireAdmin(actor); err != nil {
		return nil, err
	}
	page, limit := normalizeAdminPage(query.Page, query.Limit)
	channels, total, err := s.repo.AdminSystemChannels(query.Keyword, query.Status, limit, (page-1)*limit)
	if err != nil {
		return nil, err
	}
	result := make([]PublicModelChannel, 0, len(channels))
	for _, channel := range channels {
		items, itemErr := s.repo.ChannelModels(channel.ID, true)
		if itemErr != nil {
			return nil, itemErr
		}
		result = append(result, publicChannel(channel, true, items))
	}
	return &AdminChannelPage{Channels: result, Total: total, Page: page, Limit: limit}, nil
}

func (s *Service) CreateSystemChannel(actor *model.User, req ChannelRequest) (*PublicModelChannel, error) {
	if err := s.RequireAdmin(actor); err != nil {
		return nil, err
	}
	channelID, err := s.repo.NextPrefixedID("CHANNEL")
	if err != nil {
		return nil, err
	}
	channel, err := s.channelFromRequest(req, model.ModelChannel{ID: channelID, UserID: actor.ID, Scope: model.ChannelScopeSystem, Enabled: true})
	if err != nil {
		return nil, err
	}
	if err := s.encryptSystemChannelSecrets(&channel); err != nil {
		return nil, err
	}
	if err := s.repo.Create(&channel); err != nil {
		return nil, err
	}
	if err := s.syncInitialChannelModels(&channel, req.Models); err != nil {
		return nil, err
	}
	s.invalidateRouteCatalog()
	items, err := s.repo.ChannelModels(channel.ID, true)
	if err != nil {
		return nil, err
	}
	public := publicChannel(channel, true, items)
	return &public, nil
}

func (s *Service) DuplicateSystemChannel(actor *model.User, id string) (*PublicModelChannel, error) {
	if err := s.RequireAdmin(actor); err != nil {
		return nil, err
	}
	source, err := s.adminSystemChannel(id)
	if err != nil {
		return nil, err
	}
	sourceModels, err := s.repo.ChannelModels(source.ID, true)
	if err != nil {
		return nil, err
	}
	channelID, err := s.repo.NextPrefixedID("CHANNEL")
	if err != nil {
		return nil, err
	}
	channel, channelModels, variants, err := modelcatalog.DuplicateSystemChannelModels(*source, sourceModels, actor.ID, channelID, s.repo.NextPrefixedID)
	if err != nil {
		return nil, err
	}
	if err := s.encryptSystemChannelSecrets(&channel); err != nil {
		return nil, err
	}
	if err := s.repo.CreateDuplicatedSystemChannel(&channel, channelModels, variants); err != nil {
		return nil, err
	}
	s.invalidateRouteCatalog()
	items, err := s.repo.ChannelModels(channel.ID, true)
	if err != nil {
		return nil, err
	}
	public := publicChannel(channel, true, items)
	return &public, nil
}

func (s *Service) UpdateSystemChannel(actor *model.User, id string, req ChannelRequest) (*PublicModelChannel, error) {
	if err := s.RequireAdmin(actor); err != nil {
		return nil, err
	}
	if req.PresentationOnly() {
		return s.updateChannelPresentation(id, req)
	}
	updateModels := req.Models != nil
	channel, err := s.repo.AdminSystemChannel(id)
	if err != nil {
		return nil, err
	}
	if err := s.decryptSystemChannelSecrets(channel); err != nil {
		return nil, err
	}
	req = mergeChannelRequest(req, *channel)
	next, err := s.channelFromRequest(req, *channel)
	if err != nil {
		return nil, err
	}
	next.ID = channel.ID
	next.UserID = channel.UserID
	next.Scope = model.ChannelScopeSystem
	next.CreatedAt = channel.CreatedAt
	if req.APIKey == "" {
		next.APIKey = channel.APIKey
	}
	if req.SecretKey == "" {
		next.SecretKey = channel.SecretKey
	}
	if err := s.encryptSystemChannelSecrets(&next); err != nil {
		return nil, err
	}
	if err := s.repo.Save(&next); err != nil {
		return nil, err
	}
	if updateModels {
		if err := s.syncInitialChannelModels(&next, req.Models); err != nil {
			return nil, err
		}
	}
	s.invalidateRouteCatalog()
	items, err := s.repo.ChannelModels(next.ID, true)
	if err != nil {
		return nil, err
	}
	public := publicChannel(next, true, items)
	return &public, nil
}

func (s *Service) encryptSystemChannelSecrets(channel *model.ModelChannel) error {
	apiKey, err := s.encryptSettingSecret(channel.APIKey)
	if err != nil {
		return err
	}
	secretKey, err := s.encryptSettingSecret(channel.SecretKey)
	if err != nil {
		return err
	}
	channel.APIKey = apiKey
	channel.SecretKey = secretKey
	return nil
}

func (s *Service) decryptSystemChannelSecrets(channel *model.ModelChannel) error {
	apiKey, err := s.decryptSettingSecret(channel.APIKey)
	if err != nil {
		return err
	}
	secretKey, err := s.decryptSettingSecret(channel.SecretKey)
	if err != nil {
		return err
	}
	channel.APIKey = apiKey
	channel.SecretKey = secretKey
	return nil
}

func (s *Service) DeleteSystemChannel(actor *model.User, id string) error {
	if err := s.RequireAdmin(actor); err != nil {
		return err
	}
	channel, err := s.repo.AdminSystemChannel(id)
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return BadAuthRequest("系统渠道不存在或已删除")
		}
		return err
	}
	// 保留主体供历史账单和调用日志关联，但从所有业务查询中隐藏并清除密钥。
	err = s.repo.DeleteSystemChannel(channel.ID)
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return BadAuthRequest("系统渠道不存在或已删除")
	}
	if err == nil {
		s.invalidateRouteCatalog()
	}
	return err
}

func (s *Service) LogAPICall(log model.ApiCallLog) error {
	if log.ID == "" {
		log.ID = newID()
	}
	if log.CreatedAt.IsZero() {
		log.CreatedAt = time.Now()
	}
	if log.StartedAt.IsZero() {
		log.StartedAt = log.CreatedAt.Add(-time.Duration(log.DurationMs) * time.Millisecond)
	}
	if log.TaskID != "" {
		stage := log.RequestKind
		var nextPollAt *time.Time
		if stage == "create" && log.Status == model.ApiCallStatusSucceeded && log.ProviderRequestID != "" {
			stage = "accepted"
			delay := 2 * time.Second
			if log.Capability == "video" {
				delay = defaultVideoPollInterval
			}
			next := time.Now().Add(delay)
			nextPollAt = &next
		} else if stage == "poll" {
			delay := 5 * time.Second
			if log.Capability == "video" {
				delay = defaultVideoPollInterval
			}
			next := time.Now().Add(delay)
			nextPollAt = &next
		}
		if err := s.repo.UpdateTaskProviderState(log.TaskID, log.ProviderRequestID, stage, nextPollAt); err != nil {
			// 请求日志本身仍需保留；任务状态可由后续任务收尾或恢复流程
			// 重建，不能让一次状态写失败掩盖真实的上游调用。
			stdlog.Printf("provider task state update failed: task_id=%s provider_request_id=%s error=%v", log.TaskID, log.ProviderRequestID, err)
		}
	}
	if merged, err := s.mergeVideoAPICallLog(log); err != nil {
		return err
	} else if merged {
		return nil
	}
	policy, err := s.RuntimePolicy()
	if err != nil {
		return err
	}
	s.storageMu.Lock()
	defer s.storageMu.Unlock()
	usage, err := s.repo.UserStorageUsage(log.UserID)
	if err != nil {
		return err
	}
	incomingBytes := int64(len(log.Path) + len(log.Model) + len(log.ProviderRequestID) + len(log.ErrorCode) + len(log.Error) + len(log.UpstreamURL) + len(log.RequestContentType) + len(log.RequestBody) + len(log.ResponseBody))
	if err := validateAPICallLogQuotaWithPolicy(usage, incomingBytes, policy.Resource); err != nil {
		return err
	}
	return s.repo.Create(&log)
}

func (s *Service) mergeVideoAPICallLog(log model.ApiCallLog) (bool, error) {
	if log.Capability != "video" || (log.RequestKind != "poll" && log.RequestKind != "download") {
		return false, nil
	}
	if log.TaskID == "" && log.ProviderRequestID == "" {
		return false, nil
	}
	root, err := s.repo.VideoAPICallRoot(log)
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if log.RequestKind == "poll" {
		root.PollCount++
		if log.ResponseBody != "" {
			root.ResponseBody = log.ResponseBody
		}
	}
	if log.ProviderRequestID != "" {
		root.ProviderRequestID = log.ProviderRequestID
	}
	if log.ProviderStatus != "" {
		root.ProviderStatus = log.ProviderStatus
	}
	startedAt := root.StartedAt
	if startedAt.IsZero() {
		startedAt = root.CreatedAt.Add(-time.Duration(root.DurationMs) * time.Millisecond)
		root.StartedAt = startedAt
	}
	root.DurationMs = max(root.DurationMs, log.CreatedAt.Sub(startedAt).Milliseconds())
	root.StatusCode = log.StatusCode
	root.ConcurrencyLimit = log.ConcurrencyLimit
	if log.Status == model.ApiCallStatusFailed {
		root.Status = log.Status
		root.ErrorCode = log.ErrorCode
		root.Error = log.Error
	} else {
		root.Status = model.ApiCallStatusSucceeded
		root.ErrorCode = ""
		root.Error = ""
	}
	if log.UsageAvailable {
		root.UsageAvailable = true
		root.InputTokens = log.InputTokens
		root.OutputTokens = log.OutputTokens
		root.CachedTokens = log.CachedTokens
	}
	return true, s.repo.Save(root)
}

func (s *Service) APICallLogs(actor *model.User, limit int) ([]model.ApiCallLog, error) {
	if actor == nil {
		return nil, Unauthorized("请先登录")
	}
	return s.repo.ApiCallLogs(actor.ID, actor.Role == model.UserRoleAdmin, limit)
}

func uniqueNonEmpty(values []string) []string {
	return kernel.UniqueNonEmpty(values)
}
