package conversation

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"unicode/utf8"
)

// MaxDocumentBytes matches the existing structured workspace document bound.
// Message count and individual text fields do not introduce smaller limits.
const MaxDocumentBytes = 4 << 20

const (
	maxDocumentBytes = MaxDocumentBytes
	maxIDLength      = 80
	maxTitleLength   = 120
)

var idPattern = regexp.MustCompile(`^[A-Za-z0-9._:~-]{1,80}$`)

var credentialKeys = map[string]struct{}{
	"apikey": {}, "api_key": {}, "api-key": {}, "x-api-key": {}, "x_api_key": {},
	"authorization": {}, "cookie": {}, "set-cookie": {}, "set_cookie": {},
	"password": {}, "secret": {}, "clientsecret": {}, "client_secret": {},
	"accesstoken": {}, "access_token": {}, "refreshtoken": {}, "refresh_token": {},
	"credential": {}, "credentials": {}, "privatekey": {}, "private_key": {},
}

type normalizedDocument struct {
	id  string
	raw json.RawMessage
}

func NormalizeDocument(expectedID string, raw json.RawMessage) (normalizedDocument, error) {
	if len(bytesTrimSpace(raw)) == 0 {
		return normalizedDocument{}, errInvalid("缺少对话内容")
	}
	if len(raw) > maxDocumentBytes*2 {
		return normalizedDocument{}, errInvalid("对话内容过大")
	}
	var payload any
	if err := json.Unmarshal(raw, &payload); err != nil {
		return normalizedDocument{}, errInvalid("对话内容不是有效 JSON")
	}
	object, ok := payload.(map[string]any)
	if !ok {
		return normalizedDocument{}, errInvalid("对话内容必须是对象")
	}
	cleaned, err := sanitizeValue(object)
	if err != nil {
		return normalizedDocument{}, err
	}
	doc, ok := cleaned.(map[string]any)
	if !ok {
		return normalizedDocument{}, errInvalid("对话内容必须是对象")
	}
	id, err := requiredID(doc["id"], "对话")
	if err != nil {
		return normalizedDocument{}, err
	}
	expectedID = strings.TrimSpace(expectedID)
	if expectedID != "" && expectedID != id {
		return normalizedDocument{}, errInvalid("对话标识与路径不一致")
	}
	doc["id"] = id
	title, err := optionalTitle(doc["title"])
	if err != nil {
		return normalizedDocument{}, err
	}
	doc["title"] = title
	if canvasID, exists := doc["canvasId"]; exists && canvasID != nil {
		if text, ok := canvasID.(string); !ok || strings.TrimSpace(text) != "" {
			normalizedCanvas, canvasErr := requiredID(canvasID, "画布")
			if canvasErr != nil {
				return normalizedDocument{}, canvasErr
			}
			doc["canvasId"] = normalizedCanvas
		}
	}
	messages, err := normalizeMessages(doc["messages"])
	if err != nil {
		return normalizedDocument{}, err
	}
	doc["messages"] = messages
	encoded, err := json.Marshal(doc)
	if err != nil {
		return normalizedDocument{}, errInvalid("对话内容无法保存")
	}
	if len(encoded) > maxDocumentBytes {
		return normalizedDocument{}, errInvalid("对话内容过大")
	}
	return normalizedDocument{id: id, raw: encoded}, nil
}

func DocumentHash(raw json.RawMessage) string {
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}

func normalizeMessages(value any) ([]any, error) {
	if value == nil {
		return []any{}, nil
	}
	list, ok := value.([]any)
	if !ok {
		return nil, errInvalid("消息列表无效")
	}
	out := make([]any, 0, len(list))
	seen := make(map[string]struct{}, len(list))
	for _, item := range list {
		message, ok := item.(map[string]any)
		if !ok {
			return nil, errInvalid("消息必须是对象")
		}
		id, err := requiredID(message["id"], "消息")
		if err != nil {
			return nil, err
		}
		if _, exists := seen[id]; exists {
			return nil, errInvalid("消息标识重复")
		}
		seen[id] = struct{}{}
		message["id"] = id
		role, err := requiredRole(message["role"])
		if err != nil {
			return nil, err
		}
		message["role"] = role
		if mode, exists := message["mode"]; exists && mode != nil {
			if text, ok := mode.(string); !ok || strings.TrimSpace(text) != "" {
				normalizedMode, modeErr := requiredMode(mode)
				if modeErr != nil {
					return nil, modeErr
				}
				message["mode"] = normalizedMode
			}
		}
		if taskIDs, exists := message["taskIds"]; exists && taskIDs != nil {
			normalizedTasks, taskErr := normalizeIDList(taskIDs, "任务")
			if taskErr != nil {
				return nil, taskErr
			}
			message["taskIds"] = normalizedTasks
		}
		out = append(out, message)
	}
	return out, nil
}

func requiredID(value any, label string) (string, error) {
	text, ok := value.(string)
	if !ok {
		return "", errInvalid(label + "标识无效")
	}
	text = strings.TrimSpace(text)
	if text == "" {
		return "", errInvalid("缺少" + label + "标识")
	}
	if utf8.RuneCountInString(text) > maxIDLength || !idPattern.MatchString(text) {
		return "", errInvalid(label + "标识无效")
	}
	return text, nil
}

func requiredRole(value any) (string, error) {
	role, ok := value.(string)
	if !ok {
		return "", errInvalid("消息角色无效")
	}
	role = strings.TrimSpace(role)
	if role != "user" && role != "assistant" {
		return "", errInvalid("消息角色无效")
	}
	return role, nil
}

func requiredMode(value any) (string, error) {
	mode, ok := value.(string)
	if !ok {
		return "", errInvalid("对话模式无效")
	}
	mode = strings.TrimSpace(mode)
	if mode != "text" && mode != "image" && mode != "video" {
		return "", errInvalid("对话模式无效")
	}
	return mode, nil
}

func optionalTitle(value any) (string, error) {
	if value == nil {
		return "新创作", nil
	}
	title, ok := value.(string)
	if !ok {
		return "", errInvalid("对话标题无效")
	}
	title = strings.TrimSpace(title)
	if title == "" {
		return "新创作", nil
	}
	runes := []rune(title)
	if len(runes) > maxTitleLength {
		title = string(runes[:maxTitleLength])
	}
	return title, nil
}

func normalizeIDList(value any, label string) ([]any, error) {
	list, ok := value.([]any)
	if !ok {
		return nil, errInvalid(label + "列表无效")
	}
	out := make([]any, 0, len(list))
	seen := make(map[string]struct{}, len(list))
	for _, item := range list {
		id, err := requiredID(item, label)
		if err != nil {
			return nil, err
		}
		if _, exists := seen[id]; exists {
			continue
		}
		seen[id] = struct{}{}
		out = append(out, id)
	}
	return out, nil
}

func sanitizeValue(value any) (any, error) {
	return sanitizeValueAt(value, "")
}

func sanitizeValueAt(value any, key string) (any, error) {
	switch typed := value.(type) {
	case map[string]any:
		out := make(map[string]any, len(typed))
		for childKey, item := range typed {
			if isCredentialKey(childKey) {
				return nil, errInvalid("对话内容不能包含凭据")
			}
			cleaned, err := sanitizeValueAt(item, childKey)
			if err != nil {
				return nil, err
			}
			if cleaned == skipField {
				continue
			}
			out[childKey] = cleaned
		}
		return out, nil
	case []any:
		if isAttachmentListKey(key) {
			return sanitizeAttachmentList(typed)
		}
		if isMediaURLListKey(key) {
			return sanitizeMediaURLList(typed)
		}
		out := make([]any, 0, len(typed))
		for _, item := range typed {
			cleaned, err := sanitizeValueAt(item, "")
			if err != nil {
				return nil, err
			}
			if cleaned == skipField {
				continue
			}
			out = append(out, cleaned)
		}
		return out, nil
	case string:
		if isMediaURLKey(key) && isTempMediaBlob(typed) {
			return skipField, nil
		}
		return typed, nil
	default:
		return typed, nil
	}
}

func sanitizeAttachmentList(list []any) ([]any, error) {
	out := make([]any, 0, len(list))
	for _, item := range list {
		object, ok := item.(map[string]any)
		if !ok {
			return nil, errInvalid("附件必须是对象")
		}
		cleaned, err := sanitizeAttachment(object)
		if err != nil {
			return nil, err
		}
		out = append(out, cleaned)
	}
	return out, nil
}

func sanitizeAttachment(object map[string]any) (map[string]any, error) {
	storageKey := firstStringField(object, "storageKey", "storage_key")
	out := make(map[string]any, len(object))
	for key, item := range object {
		if isCredentialKey(key) {
			return nil, errInvalid("对话内容不能包含凭据")
		}
		if text, ok := item.(string); ok && isMediaURLKey(key) && isTempMediaBlob(text) {
			if storageKey == "" {
				return nil, errInvalid("附件没有可恢复的存储引用")
			}
			continue
		}
		cleaned, err := sanitizeValueAt(item, key)
		if err != nil {
			return nil, err
		}
		if cleaned == skipField {
			continue
		}
		out[key] = cleaned
	}
	return out, nil
}

func sanitizeMediaURLList(list []any) ([]any, error) {
	out := make([]any, 0, len(list))
	for _, item := range list {
		text, ok := item.(string)
		if ok && isTempMediaBlob(text) {
			continue
		}
		cleaned, err := sanitizeValueAt(item, "url")
		if err != nil {
			return nil, err
		}
		if cleaned == skipField {
			continue
		}
		out = append(out, cleaned)
	}
	return out, nil
}

func firstStringField(object map[string]any, keys ...string) string {
	for _, key := range keys {
		text, ok := object[key].(string)
		if ok && strings.TrimSpace(text) != "" {
			return strings.TrimSpace(text)
		}
	}
	return ""
}

func normalizeFieldKey(key string) string {
	normalized := strings.ToLower(strings.TrimSpace(key))
	return strings.ReplaceAll(normalized, "_", "")
}

func isMediaURLKey(key string) bool {
	switch normalizeFieldKey(key) {
	case "dataurl", "url", "previewurl", "poster", "src", "thumbnail", "thumbnailurl", "imageurl":
		return true
	default:
		return false
	}
}

func isMediaURLListKey(key string) bool {
	return normalizeFieldKey(key) == "resulturls"
}

func isAttachmentListKey(key string) bool {
	return normalizeFieldKey(key) == "attachments"
}

var skipField = struct{ skip bool }{skip: true}

func isCredentialKey(key string) bool {
	normalized := strings.ToLower(strings.TrimSpace(key))
	normalized = strings.ReplaceAll(normalized, "-", "_")
	_, found := credentialKeys[normalized]
	return found
}

func isTempMediaBlob(value string) bool {
	trimmed := strings.TrimSpace(strings.ToLower(value))
	return strings.HasPrefix(trimmed, "data:") || strings.HasPrefix(trimmed, "blob:")
}

func bytesTrimSpace(raw json.RawMessage) json.RawMessage {
	return json.RawMessage(strings.TrimSpace(string(raw)))
}

func stringList(value any) []string {
	switch typed := value.(type) {
	case []any:
		out := make([]string, 0, len(typed))
		for _, item := range typed {
			text := strings.TrimSpace(fmt.Sprint(item))
			if text != "" && text != "<nil>" {
				out = append(out, text)
			}
		}
		return out
	case []string:
		out := make([]string, 0, len(typed))
		for _, item := range typed {
			text := strings.TrimSpace(item)
			if text != "" {
				out = append(out, text)
			}
		}
		return out
	default:
		return nil
	}
}

func containsString(values []string, want string) bool {
	for _, item := range values {
		if item == want {
			return true
		}
	}
	return false
}

func decodeObject(raw json.RawMessage) (map[string]any, error) {
	var object map[string]any
	if err := json.Unmarshal(raw, &object); err != nil {
		return nil, errInvalid("对话内容不是有效 JSON")
	}
	return object, nil
}
