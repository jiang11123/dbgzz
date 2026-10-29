package asset

import (
	"bytes"
	"encoding/json"
	"math"
	"strings"
	"time"
	"unicode/utf8"

	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
)

var userAssetKinds = map[string]struct{}{
	"text":   {},
	"image":  {},
	"video":  {},
	"audio":  {},
	"model":  {},
	"entity": {},
}

func AssetFromJSON(userID string, raw json.RawMessage) (model.Asset, error) {
	if err := ValidateSyncedPayload(raw, "素材"); err != nil {
		return model.Asset{}, err
	}
	var payload struct {
		ID               string `json:"id"`
		FolderID         string `json:"folderId"`
		Kind             string `json:"kind"`
		Category         string `json:"category"`
		Status           string `json:"status"`
		PrimaryVersionID string `json:"primaryVersionId"`
		Title            string `json:"title"`
		CreatedAt        string `json:"createdAt"`
		UpdatedAt        string `json:"updatedAt"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return model.Asset{}, kernel.BadAuthRequest("素材数据格式错误")
	}
	now := time.Now()
	createdAt := parseClientTime(payload.CreatedAt, now)
	updatedAt := parseClientTime(payload.UpdatedAt, createdAt)
	id := strings.TrimSpace(payload.ID)
	if id == "" {
		id = kernel.NewID()
	}
	if utf8.RuneCountInString(id) > model.AssetIDMaxLength {
		return model.Asset{}, kernel.BadAuthRequest("素材 ID 不能超过 80 个字符")
	}
	primaryVersionID := strings.TrimSpace(payload.PrimaryVersionID)
	if utf8.RuneCountInString(primaryVersionID) > 36 {
		return model.Asset{}, kernel.BadAuthRequest("素材主版本 ID 不能超过 36 个字符")
	}
	if err := ValidateDocument(raw); err != nil {
		return model.Asset{}, err
	}
	// Keep the document identity identical to the database key without decoding
	// extension fields into a lossy, closed payload type.
	var document map[string]json.RawMessage
	if err := json.Unmarshal(raw, &document); err != nil {
		return model.Asset{}, kernel.BadAuthRequest("素材数据格式错误")
	}
	document["id"], _ = json.Marshal(id)
	normalized, err := json.Marshal(document)
	if err != nil {
		return model.Asset{}, kernel.BadAuthRequest("素材数据格式错误")
	}
	category := model.NormalizeAssetCategory(model.AssetCategory(payload.Category), payload.Kind)
	status := model.AssetVersionStatus(strings.TrimSpace(payload.Status))
	if status == "" {
		status = model.AssetVersionStatusConfirmed
	}
	return model.Asset{
		ID:               id,
		UserID:           userID,
		FolderID:         strings.TrimSpace(payload.FolderID),
		Kind:             strings.TrimSpace(payload.Kind),
		Category:         category,
		Status:           status,
		PrimaryVersionID: primaryVersionID,
		Title:            strings.TrimSpace(payload.Title),
		PayloadJSON:      string(normalized),
		CreatedAt:        createdAt,
		UpdatedAt:        updatedAt,
	}, nil
}

func ValidateDocument(raw json.RawMessage) error {
	var object map[string]json.RawMessage
	if err := json.Unmarshal(raw, &object); err != nil {
		return kernel.BadAuthRequest("素材数据格式错误")
	}
	kind, err := requiredJSONStringField(object, "kind")
	if err != nil {
		return err
	}
	kind = strings.TrimSpace(kind)
	if _, ok := userAssetKinds[kind]; !ok {
		return kernel.BadAuthRequest("不支持的素材类型")
	}
	if _, err := requiredJSONStringField(object, "title"); err != nil {
		return err
	}
	if _, err := requiredJSONStringField(object, "coverUrl"); err != nil {
		return err
	}
	if err := validateUserAssetTags(object); err != nil {
		return err
	}
	data, err := requiredJSONObjectField(object, "data")
	if err != nil {
		return err
	}
	return validateUserAssetData(kind, data)
}

func validateUserAssetTags(object map[string]json.RawMessage) error {
	raw, ok := object["tags"]
	if !ok {
		return kernel.BadAuthRequest("素材缺少 tags 字段")
	}
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '[' {
		return kernel.BadAuthRequest("素材 tags 必须是字符串数组")
	}
	var tags []string
	if err := json.Unmarshal(raw, &tags); err != nil {
		return kernel.BadAuthRequest("素材 tags 必须是字符串数组")
	}
	return nil
}

func validateUserAssetData(kind string, data map[string]json.RawMessage) error {
	switch kind {
	case "text":
		_, err := requiredJSONStringField(data, "content")
		return err
	case "image":
		if err := requireMediaLocator(data, "dataUrl", "图片"); err != nil {
			return err
		}
		if _, err := requiredJSONNumberField(data, "width"); err != nil {
			return err
		}
		if _, err := requiredJSONNumberField(data, "height"); err != nil {
			return err
		}
		if _, err := requiredJSONNumberField(data, "bytes"); err != nil {
			return err
		}
		return requireNonEmptyJSONString(data, "mimeType")
	case "video":
		if err := requireMediaLocator(data, "url", "视频"); err != nil {
			return err
		}
		if _, err := requiredJSONNumberField(data, "width"); err != nil {
			return err
		}
		if _, err := requiredJSONNumberField(data, "height"); err != nil {
			return err
		}
		if _, err := requiredJSONNumberField(data, "bytes"); err != nil {
			return err
		}
		return requireNonEmptyJSONString(data, "mimeType")
	case "audio":
		if err := requireMediaLocator(data, "url", "音频"); err != nil {
			return err
		}
		if _, err := requiredJSONNumberField(data, "bytes"); err != nil {
			return err
		}
		return requireNonEmptyJSONString(data, "mimeType")
	case "model":
		if err := requireMediaLocator(data, "url", "模型"); err != nil {
			return err
		}
		if _, err := requiredJSONNumberField(data, "bytes"); err != nil {
			return err
		}
		if err := requireNonEmptyJSONString(data, "mimeType"); err != nil {
			return err
		}
		return requireNonEmptyJSONString(data, "fileName")
	case "entity":
		return requireJSONObjectFieldPresent(data, "definition")
	default:
		return kernel.BadAuthRequest("不支持的素材类型")
	}
}

func requireMediaLocator(data map[string]json.RawMessage, primaryKey string, label string) error {
	primary, err := optionalJSONStringField(data, primaryKey)
	if err != nil {
		return err
	}
	storageKey, err := optionalJSONStringField(data, "storageKey")
	if err != nil {
		return err
	}
	if strings.TrimSpace(primary) == "" && strings.TrimSpace(storageKey) == "" {
		return kernel.BadAuthRequest(label + "素材缺少 " + primaryKey + " 或 storageKey")
	}
	return nil
}

func requiredJSONStringField(object map[string]json.RawMessage, key string) (string, error) {
	raw, ok := object[key]
	if !ok {
		return "", kernel.BadAuthRequest("素材缺少 " + key + " 字段")
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return "", kernel.BadAuthRequest("素材字段 " + key + " 必须是字符串")
	}
	return value, nil
}

func optionalJSONStringField(object map[string]json.RawMessage, key string) (string, error) {
	raw, ok := object[key]
	if !ok || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return "", nil
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return "", kernel.BadAuthRequest("素材字段 " + key + " 必须是字符串")
	}
	return value, nil
}

func requireNonEmptyJSONString(object map[string]json.RawMessage, key string) error {
	value, err := requiredJSONStringField(object, key)
	if err != nil {
		return err
	}
	if strings.TrimSpace(value) == "" {
		return kernel.BadAuthRequest("素材字段 " + key + " 不能为空")
	}
	return nil
}

func requiredJSONNumberField(object map[string]json.RawMessage, key string) (float64, error) {
	raw, ok := object[key]
	if !ok {
		return 0, kernel.BadAuthRequest("素材缺少 " + key + " 字段")
	}
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return 0, kernel.BadAuthRequest("素材字段 " + key + " 必须是数字")
	}
	var value float64
	if err := json.Unmarshal(raw, &value); err != nil {
		return 0, kernel.BadAuthRequest("素材字段 " + key + " 必须是数字")
	}
	if math.IsNaN(value) || math.IsInf(value, 0) || value < 0 {
		return 0, kernel.BadAuthRequest("素材字段 " + key + " 必须是非负数字")
	}
	return value, nil
}

func requiredJSONObjectField(object map[string]json.RawMessage, key string) (map[string]json.RawMessage, error) {
	raw, ok := object[key]
	if !ok {
		return nil, kernel.BadAuthRequest("素材缺少 " + key + " 字段")
	}
	var nested map[string]json.RawMessage
	if err := json.Unmarshal(raw, &nested); err != nil || nested == nil {
		return nil, kernel.BadAuthRequest("素材字段 " + key + " 必须是对象")
	}
	return nested, nil
}

func requireJSONObjectFieldPresent(object map[string]json.RawMessage, key string) error {
	_, err := requiredJSONObjectField(object, key)
	return err
}

func ValidateSyncedPayload(raw json.RawMessage, label string) error {
	if len(raw) > 4<<20 {
		return kernel.BadAuthRequest(label + "数据超过 4MB，请先把媒体文件保存到资源存储")
	}
	var payload interface{}
	if err := json.Unmarshal(raw, &payload); err == nil && ContainsInlineMediaDataURL(payload) {
		return kernel.BadAuthRequest(label + "数据包含内嵌媒体，请先上传到资源存储")
	}
	return nil
}

func ContainsInlineMediaDataURL(value interface{}) bool {
	switch item := value.(type) {
	case string:
		text := strings.ToLower(strings.TrimSpace(item))
		return strings.HasPrefix(text, "data:image/") || strings.HasPrefix(text, "data:video/") || strings.HasPrefix(text, "data:audio/")
	case []interface{}:
		for _, child := range item {
			if ContainsInlineMediaDataURL(child) {
				return true
			}
		}
	case map[string]interface{}:
		for _, child := range item {
			if ContainsInlineMediaDataURL(child) {
				return true
			}
		}
	}
	return false
}

func parseClientTime(value string, fallback time.Time) time.Time {
	value = strings.TrimSpace(value)
	if value == "" {
		return fallback
	}
	if parsed, err := time.Parse(time.RFC3339Nano, value); err == nil {
		return parsed
	}
	return fallback
}
