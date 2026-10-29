package app

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"infinite-canvas/backend/internal/model"

	"gorm.io/gorm"
)

const (
	arkPrivateAssetAPIVersion = "2024-01-01"
	arkPrivateAssetGroupType  = "AIGC"
	arkPrivateAssetStatusNew  = "creating"
	arkPrivateAssetStatusWait = "processing"
	arkPrivateAssetStatusLive = "active"
	arkPrivateAssetStatusFail = "failed"
	arkPrivateAssetPollLimit  = 3 * time.Minute
)

func (s *Service) prepareArkPrivateAssetReferences(ctx context.Context, userID string, input *canvasGenerationInput) error {
	// 可信素材 asset:// 仅方舟视频协议支持；Agent Plan Seedream 等图片渠道不能上传或改写。
	if input == nil || input.Mode != "video" || !isArkPrivateAssetVideoConfig(input.Config) || !parseBool(input.Config.ArkPrivateAssetUpload, true) {
		return nil
	}
	// The desktop profile owns the source media locally. Never copy a local
	// resource into Ark's hosted trusted-asset service as a side effect of
	// generation; the normal provider path will handle compatible inline media.
	if s.IsLocalMode() {
		return nil
	}
	hasOwnedReference := false
	for _, reference := range input.ReferenceImages {
		if arkPrivateAssetResourceID(reference) != "" {
			hasOwnedReference = true
			break
		}
	}
	if !hasOwnedReference {
		return nil
	}
	settingRecord, setting, err := s.readArkPrivateAssetSetting()
	if err != nil {
		return err
	}
	automaticSyncEnabled, err := arkPrivateAssetAutomaticSyncEnabled(setting)
	if err != nil {
		return err
	}
	if !automaticSyncEnabled {
		return nil
	}
	if taskID := taskExecutionID(ctx); taskID != "" {
		_ = s.repo.UpdateTaskProgress(taskID, "同步方舟可信素材", 36)
	}
	for index := range input.ReferenceImages {
		reference := &input.ReferenceImages[index]
		if strings.HasPrefix(strings.TrimSpace(reference.URL), "asset://") {
			continue
		}
		resourceID := arkPrivateAssetResourceID(*reference)
		if resourceID == "" {
			continue
		}
		resource, err := s.Resource(userID, resourceID)
		if err != nil {
			return fmt.Errorf("读取方舟参考素材失败：%w", err)
		}
		if resource.Status != model.ResourceStatusReady {
			return errors.New("方舟参考素材尚未上传完成")
		}
		if !strings.HasPrefix(strings.ToLower(strings.TrimSpace(resource.MimeType)), "image/") {
			return errors.New("方舟可信素材库当前只支持上传图片参考素材")
		}
		assetID, err := s.ensureArkPrivateAsset(ctx, userID, resource, settingRecord, &setting)
		if err != nil {
			return err
		}
		reference.URL = "asset://" + assetID
		reference.DataURL = ""
	}
	if taskID := taskExecutionID(ctx); taskID != "" {
		_ = s.repo.UpdateTaskProgress(taskID, "调用生成模型", 40)
	}
	return nil
}

// Agent Plan 图片与视频共用 /api/plan/v3；图片协议不得进入可信素材同步。

// 可信素材同步是可选增强能力。管理员未启用时保持原始参考 URL，
// 继续执行常规火山方舟视频请求。

// SyncResourceToArkPrivateAsset 是用户显式触发的参考图预同步入口。
// 它与任务 worker 共用团队资源归属、就绪状态和审核规则，客户端不能借此向方舟提交任意 URL。
func (s *Service) SyncResourceToArkPrivateAsset(ctx context.Context, actor *model.User, resourceID string) (*ArkPrivateAssetSyncResult, error) {
	if s.IsLocalMode() {
		return nil, BadAuthRequest("本地工作区不支持将素材同步到云端可信素材库")
	}
	resourceID = strings.TrimSpace(resourceID)
	if resourceID == "" {
		return nil, BadAuthRequest("请选择要同步的图片素材")
	}
	resource, err := s.Resource(actor.ID, resourceID)
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, NotFound("图片素材不存在或无权访问")
	}
	if err != nil {
		return nil, err
	}
	if resource.Status != model.ResourceStatusReady {
		return nil, BadAuthRequest("图片素材尚未上传完成")
	}
	if !strings.HasPrefix(strings.ToLower(strings.TrimSpace(resource.MimeType)), "image/") {
		return nil, BadAuthRequest("方舟可信素材库当前只支持上传图片素材")
	}
	settingRecord, setting, err := s.readArkPrivateAssetSetting()
	if err != nil {
		return nil, err
	}
	if !setting.Enabled || setting.AccessKeyID == "" || setting.AccessKeySecret == "" {
		return nil, BadAuthRequest("方舟可信素材库尚未配置，请由管理员在方舟素材库设置中填写启用的 IAM AK/SK")
	}
	if _, err := s.ensureArkPrivateAsset(ctx, actor.ID, resource, settingRecord, &setting); err != nil {
		return nil, err
	}
	return &ArkPrivateAssetSyncResult{ResourceID: resource.ID, Status: arkPrivateAssetStatusLive}, nil
}

func (s *Service) ensureArkPrivateAsset(ctx context.Context, userID string, resource *model.Resource, settingRecord *model.SystemSetting, setting *arkPrivateAssetSettingValue) (string, error) {
	binding, err := s.repo.ArkPrivateAssetBinding(resource.ID, setting.ProjectName)
	if err == nil {
		if shouldResumeArkPrivateAssetPolling(binding) {
			// 素材已创建成功，只是旧版 GetAsset 参数错误导致轮询失败；恢复轮询，
			// 不重新上传素材，也不会创建重复的方舟资产。
			binding.Status = arkPrivateAssetStatusWait
			binding.Error = ""
			if err := s.repo.SaveArkPrivateAssetBinding(binding); err != nil {
				return "", err
			}
			return s.waitForArkPrivateAsset(ctx, binding, setting)
		}
		if !shouldRetryArkPrivateAssetBinding(binding) {
			return s.waitForArkPrivateAsset(ctx, binding, setting)
		}
		// 早期字段解析未识别方舟返回的 Id。仅重试尚未创建素材或素材组的记录，
		// 审核拒绝等真实业务失败仍保持终态，避免重复上传。
		binding.Status = arkPrivateAssetStatusNew
		binding.Error = ""
		if err := s.repo.SaveArkPrivateAssetBinding(binding); err != nil {
			return "", err
		}
	}
	if err != nil {
		if !errors.Is(err, gorm.ErrRecordNotFound) {
			return "", err
		}
		binding = &model.ArkPrivateAssetBinding{
			ID:          newID(),
			UserID:      userID,
			ResourceID:  resource.ID,
			ProjectName: setting.ProjectName,
			Status:      arkPrivateAssetStatusNew,
		}
		created, err := s.repo.CreateArkPrivateAssetBinding(binding)
		if err != nil {
			return "", err
		}
		if !created {
			binding, err = s.repo.ArkPrivateAssetBinding(resource.ID, setting.ProjectName)
			if err != nil {
				return "", err
			}
			return s.waitForArkPrivateAsset(ctx, binding, setting)
		}
	}

	// 重试时复用已建成的素材组，避免管理员调整配置清空 DefaultGroupID 后重复建组。
	groupID := strings.TrimSpace(binding.AssetGroupID)
	if groupID == "" {
		groupID, err = s.ensureArkPrivateAssetGroup(ctx, settingRecord, setting)
		if err != nil {
			return "", s.failArkPrivateAssetBinding(binding, err)
		}
	}
	binding.AssetGroupID = groupID
	resourceURL, err := s.directResourceURL(resource, time.Now().Add(time.Hour))
	if err != nil {
		return "", s.failArkPrivateAssetBinding(binding, fmt.Errorf("生成方舟素材临时地址失败：%w", err))
	}
	response, err := callArkPrivateAssetAPI(ctx, *setting, "CreateAsset", map[string]interface{}{
		"GroupId":     groupID,
		"URL":         resourceURL,
		"AssetType":   "Image",
		"Name":        "ark-private-asset-" + resource.ID,
		"ProjectName": setting.ProjectName,
	})
	if err != nil {
		return "", s.failArkPrivateAssetBinding(binding, fmt.Errorf("上传方舟可信素材失败：%w", err))
	}
	assetID := arkPrivateAssetResponseField(response, "AssetId", "AssetID", "asset_id", "Id", "ID", "id")
	if assetID == "" {
		return "", s.failArkPrivateAssetBinding(binding, errors.New("方舟素材库没有返回素材 ID"))
	}
	binding.ArkAssetID = assetID
	binding.Status = arkPrivateAssetStatusWait
	binding.Error = ""
	if err := s.repo.SaveArkPrivateAssetBinding(binding); err != nil {
		return "", err
	}
	return s.waitForArkPrivateAsset(ctx, binding, setting)
}

func (s *Service) ensureArkPrivateAssetGroup(ctx context.Context, settingRecord *model.SystemSetting, setting *arkPrivateAssetSettingValue) (string, error) {
	if strings.TrimSpace(setting.DefaultGroupID) != "" {
		return setting.DefaultGroupID, nil
	}
	response, err := callArkPrivateAssetAPI(ctx, *setting, "CreateAssetGroup", map[string]interface{}{
		"Name":        "ark-private-assets",
		"Description": "自动导入的方舟可信素材",
		"GroupType":   arkPrivateAssetGroupType,
		"ProjectName": setting.ProjectName,
	})
	if err != nil {
		return "", fmt.Errorf("创建方舟素材组失败：%w", err)
	}
	groupID := arkPrivateAssetResponseField(response, "GroupId", "GroupID", "group_id", "Id", "ID", "id")
	if groupID == "" {
		return "", errors.New("方舟素材库没有返回素材组 ID")
	}
	setting.DefaultGroupID = groupID
	if settingRecord == nil {
		settingRecord = &model.SystemSetting{Key: arkPrivateAssetSettingKey}
	}
	if err := s.saveArkPrivateAssetSetting(settingRecord, *setting); err != nil {
		return "", err
	}
	return groupID, nil
}

// shouldRetryArkPrivateAssetBinding 判断失败的素材绑定能否安全重试。
// 素材组尚未建成（两个 ID 均为空）时任何失败都可重试：网络中断、区域配错、
// 套餐未开通都发生在建组之前，且绝无重复上传风险。素材组已建、素材未建时仅重试
// 创建素材阶段的失败，最坏情况是组内多出一份素材。审核拒绝发生在拿到素材 ID 之后，
// ArkAssetID 非空，天然不会进入重试路径。

func (s *Service) waitForArkPrivateAsset(ctx context.Context, binding *model.ArkPrivateAssetBinding, setting *arkPrivateAssetSettingValue) (string, error) {
	deadline := time.Now().Add(arkPrivateAssetPollLimit)
	for time.Now().Before(deadline) {
		switch strings.ToLower(strings.TrimSpace(binding.Status)) {
		case arkPrivateAssetStatusLive:
			if strings.TrimSpace(binding.ArkAssetID) == "" {
				return "", errors.New("方舟可信素材记录缺少素材 ID")
			}
			return binding.ArkAssetID, nil
		case arkPrivateAssetStatusFail:
			return "", fmt.Errorf("方舟可信素材审核失败：%s", defaultString(binding.Error, "请更换拥有使用权的虚拟人物素材后重试"))
		}
		if binding.ArkAssetID != "" {
			response, err := callArkPrivateAssetAPI(ctx, *setting, "GetAsset", map[string]interface{}{
				"Id":          binding.ArkAssetID,
				"ProjectName": setting.ProjectName,
			})
			if err != nil {
				return "", fmt.Errorf("查询方舟可信素材审核状态失败：%w", err)
			}
			status := strings.ToLower(arkPrivateAssetResponseField(response, "Status", "status"))
			switch status {
			case "active":
				binding.Status = arkPrivateAssetStatusLive
				binding.Error = ""
				if err := s.repo.SaveArkPrivateAssetBinding(binding); err != nil {
					return "", err
				}
				return binding.ArkAssetID, nil
			case "failed":
				message := arkPrivateAssetResponseField(response, "ErrorMessage", "Message", "message")
				binding.Status = arkPrivateAssetStatusFail
				binding.Error = defaultString(message, "方舟未通过素材审核")
				if err := s.repo.SaveArkPrivateAssetBinding(binding); err != nil {
					return "", err
				}
				return "", fmt.Errorf("方舟可信素材审核失败：%s", binding.Error)
			case "":
				return "", errors.New("方舟可信素材状态缺失")
			}
		}
		if err := sleepContext(ctx, 2*time.Second); err != nil {
			return "", err
		}
		latest, err := s.repo.ArkPrivateAssetBinding(binding.ResourceID, binding.ProjectName)
		if err != nil {
			return "", err
		}
		binding = latest
	}
	return "", errors.New("方舟可信素材审核超时，请稍后重新提交视频任务")
}

func (s *Service) failArkPrivateAssetBinding(binding *model.ArkPrivateAssetBinding, reason error) error {
	binding.Status = arkPrivateAssetStatusFail
	binding.Error = reason.Error()
	if err := s.repo.SaveArkPrivateAssetBinding(binding); err != nil {
		return err
	}
	return reason
}

// 素材库控制面调用不是模型生成；不能继承视频任务的请求审计或账单上下文，
// 否则创建素材组、上传素材和审核查询会被误记为真实的视频生成调用。

// doJSON 对非 2xx 响应只按状态码生成通用提示（401/403 会被说成“模型服务鉴权失败”），
// 方舟把真实原因（如 SubscriptionRequired）放在响应体的 ResponseMetadata.Error 里，必须还原。

// arkPrivateAssetUpstreamDetail 提取方舟控制面响应里 ResponseMetadata.Error 的 Code/Message，
// 用于把上游真实失败原因透传给用户；没有上游错误时返回空串。
