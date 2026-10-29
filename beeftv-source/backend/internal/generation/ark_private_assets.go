package generation

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"infinite-canvas/backend/internal/model"

	"github.com/volcengine/volc-sdk-golang/base"
)

type ArkPrivateAssetSettingValue struct {
	Enabled         bool   `json:"enabled"`
	Region          string `json:"region"`
	ProjectName     string `json:"projectName"`
	AccessKeyID     string `json:"accessKeyId"`
	AccessKeySecret string `json:"accessKeySecret"`
	DefaultGroupID  string `json:"defaultGroupId"`
}

const (
	arkPrivateAssetAPIVersion = "2024-01-01"
	arkPrivateAssetGroupType  = "AIGC"
	arkPrivateAssetStatusNew  = "creating"
	arkPrivateAssetStatusWait = "processing"
	arkPrivateAssetStatusLive = "active"
	arkPrivateAssetStatusFail = "failed"
	arkPrivateAssetPollLimit  = 3 * time.Minute
)

// 可信素材 asset:// 仅方舟视频协议支持；Agent Plan Seedream 等图片渠道不能上传或改写。

// The desktop profile owns the source media locally. Never copy a local
// resource into Ark's hosted trusted-asset service as a side effect of
// generation; the normal provider path will handle compatible inline media.

func IsArkPrivateAssetVideoConfig(config Config) bool {
	iface := strings.TrimSpace(config.InterfaceType)
	// Agent Plan 图片与视频共用 /api/plan/v3；图片协议不得进入可信素材同步。
	if iface == string(model.ChannelInterfaceVolcengineArkImage) || iface == "volcengine-ark-agent-plan-image" {
		return false
	}
	return iface == string(model.ChannelInterfaceVolcengineArkVideo) || iface == "volcengine-ark-agent-plan-video" || IsArkPlanVideoConfig(config)
}

func ArkPrivateAssetAutomaticSyncEnabled(setting ArkPrivateAssetSettingValue) (bool, error) {
	// 可信素材同步是可选增强能力。管理员未启用时保持原始参考 URL，
	// 继续执行常规火山方舟视频请求。
	if !setting.Enabled {
		return false, nil
	}
	if setting.AccessKeyID == "" || setting.AccessKeySecret == "" {
		return false, errors.New("方舟可信素材库尚未配置，请由管理员在方舟素材库设置中填写启用的 IAM AK/SK")
	}
	return true, nil
}

func ArkPrivateAssetResourceID(reference Media) string {
	if !strings.HasPrefix(reference.StorageKey, "resource:") {
		return ""
	}
	return strings.TrimSpace(strings.TrimPrefix(reference.StorageKey, "resource:"))
}

type ArkPrivateAssetSyncResult struct {
	ResourceID string `json:"resourceId"`
	Status     string `json:"status"`
}

// SyncResourceToArkPrivateAsset 是用户显式触发的参考图预同步入口。
// 它与任务 worker 共用团队资源归属、就绪状态和审核规则，客户端不能借此向方舟提交任意 URL。

// 素材已创建成功，只是旧版 GetAsset 参数错误导致轮询失败；恢复轮询，
// 不重新上传素材，也不会创建重复的方舟资产。

// 早期字段解析未识别方舟返回的 Id。仅重试尚未创建素材或素材组的记录，
// 审核拒绝等真实业务失败仍保持终态，避免重复上传。

// 重试时复用已建成的素材组，避免管理员调整配置清空 DefaultGroupID 后重复建组。

// shouldRetryArkPrivateAssetBinding 判断失败的素材绑定能否安全重试。
// 素材组尚未建成（两个 ID 均为空）时任何失败都可重试：网络中断、区域配错、
// 套餐未开通都发生在建组之前，且绝无重复上传风险。素材组已建、素材未建时仅重试
// 创建素材阶段的失败，最坏情况是组内多出一份素材。审核拒绝发生在拿到素材 ID 之后，
// ArkAssetID 非空，天然不会进入重试路径。
func ShouldRetryArkPrivateAssetBinding(binding *model.ArkPrivateAssetBinding) bool {
	if binding == nil || strings.ToLower(strings.TrimSpace(binding.Status)) != arkPrivateAssetStatusFail || binding.ArkAssetID != "" {
		return false
	}
	if binding.AssetGroupID == "" {
		return true
	}
	return strings.Contains(binding.Error, "上传方舟可信素材失败") || strings.Contains(binding.Error, "方舟素材库没有返回素材 ID")
}

func ShouldResumeArkPrivateAssetPolling(binding *model.ArkPrivateAssetBinding) bool {
	if binding == nil || strings.ToLower(strings.TrimSpace(binding.Status)) != arkPrivateAssetStatusFail || binding.AssetGroupID == "" || binding.ArkAssetID == "" {
		return false
	}
	return strings.Contains(binding.Error, "MissingParameter.Id")
}

func CallArkPrivateAssetAPI(ctx context.Context, setting ArkPrivateAssetSettingValue, action string, payload map[string]interface{}) (map[string]interface{}, error) {
	// 素材库控制面调用不是模型生成；不能继承视频任务的请求审计或账单上下文，
	// 否则创建素材组、上传素材和审核查询会被误记为真实的视频生成调用。
	ctx = WithoutCallAccounting(ctx)
	data, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	baseURL, err := ArkPrivateAssetControlPlaneURL(ctx, setting.Region)
	if err != nil {
		return nil, err
	}
	endpoint, err := url.Parse(baseURL)
	if err != nil {
		return nil, err
	}
	query := endpoint.Query()
	query.Set("Action", action)
	query.Set("Version", arkPrivateAssetAPIVersion)
	endpoint.RawQuery = query.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint.String(), bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	credentials := base.Credentials{
		AccessKeyID:     setting.AccessKeyID,
		SecretAccessKey: setting.AccessKeySecret,
		Region:          setting.Region,
		Service:         "ark",
	}
	var response map[string]interface{}
	if err := DoJSON(credentials.Sign(req), &response); err != nil {
		// doJSON 对非 2xx 响应只按状态码生成通用提示（401/403 会被说成“模型服务鉴权失败”），
		// 方舟把真实原因（如 SubscriptionRequired）放在响应体的 ResponseMetadata.Error 里，必须还原。
		var httpErr HTTPError
		if errors.As(err, &httpErr) && strings.TrimSpace(httpErr.Body) != "" {
			var body map[string]interface{}
			if json.Unmarshal([]byte(httpErr.Body), &body) == nil {
				if detail := ArkPrivateAssetUpstreamDetail(body); detail != "" {
					return nil, fmt.Errorf("方舟素材库请求失败（HTTP %d）：%s", httpErr.StatusCode, detail)
				}
			}
		}
		return nil, err
	}
	if detail := ArkPrivateAssetUpstreamDetail(response); detail != "" {
		return nil, errors.New(detail)
	}
	return response, nil
}

// arkPrivateAssetUpstreamDetail 提取方舟控制面响应里 ResponseMetadata.Error 的 Code/Message，
// 用于把上游真实失败原因透传给用户；没有上游错误时返回空串。
func ArkPrivateAssetUpstreamDetail(response map[string]interface{}) string {
	metadata, _ := response["ResponseMetadata"].(map[string]interface{})
	if metadata == nil {
		return ""
	}
	upstream, _ := metadata["Error"].(map[string]interface{})
	if upstream == nil {
		return ""
	}
	code := stringField(upstream, "Code")
	message := stringField(upstream, "Message")
	detail := strings.TrimSpace(strings.Trim(strings.Join([]string{code, message}, " "), " "))
	if detail == "" {
		return "方舟素材库请求失败"
	}
	return detail
}

func ArkPrivateAssetControlPlaneURL(ctx context.Context, region string) (string, error) {
	if runtime, ok := RuntimeFromContext(ctx); ok {
		if override := strings.TrimSpace(runtime.Endpoints.ArkPrivateAssetAPIBaseURL); override != "" {
			return override, nil
		}
	}
	region = strings.ToLower(strings.TrimSpace(region))
	if region == "" {
		return "", errors.New("方舟素材库未配置 Region")
	}
	for _, char := range region {
		if !(char >= 'a' && char <= 'z') && !(char >= '0' && char <= '9') && char != '-' {
			return "", errors.New("方舟素材库 Region 格式无效")
		}
	}
	return "https://ark." + region + ".volcengineapi.com", nil
}

func ArkPrivateAssetResponseField(response map[string]interface{}, keys ...string) string {
	for _, source := range ArkPrivateAssetResponseMaps(response) {
		for _, key := range keys {
			if value := strings.TrimSpace(fmt.Sprint(source[key])); value != "" && value != "<nil>" {
				return value
			}
		}
	}
	return ""
}

func ArkPrivateAssetResponseMaps(response map[string]interface{}) []map[string]interface{} {
	result := []map[string]interface{}{response}
	for _, key := range []string{"Result", "Asset", "Group", "Data"} {
		if value, ok := response[key].(map[string]interface{}); ok {
			result = append(result, value)
			for _, nestedKey := range []string{"Asset", "Group", "Data"} {
				if nested, ok := value[nestedKey].(map[string]interface{}); ok {
					result = append(result, nested)
				}
			}
		}
	}
	return result
}
