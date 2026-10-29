package workflow

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
)

func runningHubWorkflowFailureMessage(response map[string]any) string {
	message := runningHubFailureMessage(response)
	normalized := strings.ToLower(message)
	if strings.Contains(message, "企业版余额不足") || (strings.Contains(normalized, "enterprise") && strings.Contains(normalized, "balance")) {
		return message + "；工作流提交固定使用积分 API Key，请确认提交 Key 不是企业级素材上传 Key"
	}
	return message
}
func runningHubUploadAuthFailure(err error) string {
	var httpErr StatusError
	if !errors.As(err, &httpErr) || httpErr.StatusCode != http.StatusUnauthorized {
		return ""
	}
	if !strings.Contains(strings.ToLower(httpErr.Body), "apikey verification failed") {
		return ""
	}
	return "RunningHub 参考素材上传接口认证失败（HTTP 401）：ApiKey verification failed。请确认“素材上传 API Key（企业级）”有效，并且它与 Base URL 属于同一个 RunningHub 站点"
}

// RunningHub 工作流的管理、提交和轮询固定使用积分 API Key；企业级 Key 仅由上传接口单独读取。
func runningHubAPIKey(config Config) string {
	return strings.TrimSpace(config.APIKey)
}
func runningHubOutputMimeType(rawURL string, declared string) string {
	declared = strings.TrimSpace(strings.Split(declared, ";")[0])
	if declared != "" && declared != "application/octet-stream" {
		return declared
	}
	pathValue := rawURL
	if parsed, err := url.Parse(rawURL); err == nil && parsed.Path != "" {
		pathValue = parsed.Path
	}
	pathValue = strings.ToLower(strings.Split(pathValue, "?")[0])
	for suffix, mimeType := range map[string]string{
		".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif",
		".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".m4v": "video/mp4",
		".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg", ".m4a": "audio/mp4", ".flac": "audio/flac",
	} {
		if strings.HasSuffix(pathValue, suffix) {
			return mimeType
		}
	}
	return declared
}

func workflowOutputValue(mimeType string, data []byte) interface{} {
	mimeType = strings.TrimSpace(strings.Split(mimeType, ";")[0])
	if mimeType == "" {
		mimeType = "application/octet-stream"
	}
	if len(data) == 0 {
		return nil
	}
	return map[string]interface{}{"dataUrl": dataURL(mimeType, data), "mimeType": mimeType, "bytes": len(data)}
}

func runningHubRootURL(value string) string {
	base := strings.TrimRight(strings.TrimSpace(value), "/")
	if base == "" {
		base = "https://www.runninghub.cn"
	}
	// 设置页可能保存根地址、/openapi/v2 或带尾部斜杠的任一形式；任务
	// OpenAPI 使用根地址下的 /task/openapi/*，统一剥掉 API 前缀。
	lower := strings.ToLower(base)
	for _, suffix := range []string{"/openapi/v2", "/openapi"} {
		if strings.HasSuffix(lower, suffix) {
			base = base[:len(base)-len(suffix)]
			break
		}
	}
	return strings.TrimRight(base, "/")
}

func resolveRunningHubOutputURL(root string, rawURL string) string {
	rawURL = rewriteRunningHubOutputHost(strings.TrimSpace(rawURL))
	if rawURL == "" || strings.HasPrefix(rawURL, "data:") || isPublicMediaURL(rawURL) {
		return rawURL
	}
	if strings.HasPrefix(rawURL, "//") {
		return "https:" + rawURL
	}
	if strings.HasPrefix(rawURL, "/") {
		return strings.TrimRight(root, "/") + rawURL
	}
	// API 可能返回 output/foo、assets/foo 这类无前导斜杠的相对路径。
	for _, prefix := range []string{"output/", "assets/", "input/"} {
		if strings.HasPrefix(strings.ToLower(rawURL), prefix) {
			return strings.TrimRight(root, "/") + "/" + rawURL
		}
	}
	if runningHubRelativeOutputPath(rawURL) {
		return strings.TrimRight(root, "/") + "/" + strings.TrimLeft(rawURL, "/")
	}
	return rawURL
}

// RunningHub 某些区域会返回旧 COS 域名，参考项目已将其迁移到可访问域名；
// 这里只做固定 host 映射，不接受响应内容提供任意代理目标。
func rewriteRunningHubOutputHost(rawURL string) string {
	parsed, err := url.Parse(rawURL)
	if err != nil || parsed.Host == "" {
		return rawURL
	}
	if strings.EqualFold(parsed.Host, "rh-images-1252422369.cos.ap-beijing.myqcloud.com") {
		parsed.Host = "rh-images.xiaoyaoyou.com"
		return parsed.String()
	}
	return rawURL
}

func runningHubTaskID(payload map[string]any) string {
	for _, keys := range [][]string{{"data", "taskId"}, {"data", "task_id"}, {"data", "taskID"}, {"data", "id"}, {"taskId"}, {"task_id"}, {"taskID"}, {"id"}} {
		if len(keys) == 2 {
			if value := nestedString(payload, keys[0], keys[1]); value != "" {
				return value
			}
		} else if value := stringValue(payload[keys[0]]); value != "" {
			return value
		}
	}
	return ""
}

type runningHubOutput struct {
	URL   string
	ID    string
	Field string
	Owner string
}

func runningHubOutputURLs(value interface{}) []string {
	outputs := runningHubOutputs(value)
	urls := make([]string, len(outputs))
	for i, output := range outputs {
		urls[i] = output.URL
	}
	return urls
}

func runningHubOutputs(value interface{}) []runningHubOutput {
	result := make([]runningHubOutput, 0)
	seen := map[string]bool{}
	var visit func(interface{}, string, string, string, string)
	visit = func(current interface{}, path, field, id, owner string) {
		switch item := current.(type) {
		case string:
			item = strings.TrimSpace(item)
			if runningHubIsOutputURL(item) {
				if !seen[item] {
					seen[item] = true
					result = append(result, runningHubOutput{URL: item, ID: id, Field: field, Owner: owner})
				}
			}
		case []interface{}:
			for index, child := range item {
				visit(child, path+"/"+strconv.Itoa(index), field, id, owner)
			}
		case map[string]interface{}:
			if outputID := runningHubOutputID(item); outputID != "" {
				id, field, owner = outputID, "", path
			}
			keys := make([]string, 0, len(item))
			for key := range item {
				keys = append(keys, key)
			}
			sort.Strings(keys)
			for _, key := range keys {
				lowerKey := strings.ToLower(strings.TrimSpace(key))
				if runningHubOutputField(lowerKey) {
					visit(item[key], path+"/"+key, field+"/"+lowerKey, id, owner)
				}
			}
		}
	}
	visit(value, "", "", "", "")
	return result
}

func runningHubOutputField(key string) bool {
	switch key {
	case "fileurl", "file_url", "url", "downloadurl", "download_url", "src", "output", "outputs", "results", "files", "data", "images", "videos", "audio", "audios", "result":
		return true
	}
	return false
}

func runningHubOutputID(item map[string]interface{}) string {
	for _, key := range []string{"outputId", "outputID", "output_id", "fileId", "fileID", "file_id", "id"} {
		// A status envelope's generic id belongs to the task, not its outputs.
		if key == "id" && !runningHubHasOutputURL(item) {
			continue
		}
		if value := stringValue(item[key]); value != "" {
			return value
		}
	}
	return ""
}

func runningHubHasOutputURL(item map[string]interface{}) bool {
	for key := range item {
		switch strings.ToLower(strings.TrimSpace(key)) {
		case "fileurl", "file_url", "url", "downloadurl", "download_url", "src":
			if value, ok := item[key].(string); ok && runningHubIsOutputURL(strings.TrimSpace(value)) {
				return true
			}
		}
	}
	return false
}

func runningHubIsOutputURL(value string) bool {
	return strings.HasPrefix(value, "http://") || strings.HasPrefix(value, "https://") || strings.HasPrefix(value, "data:") || (strings.HasPrefix(value, "/") && !strings.HasPrefix(value, "//")) || runningHubRelativeOutputPath(value)
}

func validateRunningHubQueryTaskID(response map[string]any, taskID string) error {
	objects := []map[string]any{response}
	if data, ok := response["data"].(map[string]any); ok {
		objects = append(objects, data)
	}
	for _, object := range objects {
		for _, key := range []string{"taskId", "task_id", "taskID", "id"} {
			if key == "id" && runningHubHasOutputURL(object) {
				if _, status := runningHubDirectCode(object); !status {
					continue
				}
			}
			if id := stringValue(object[key]); id != "" && id != taskID {
				return errors.New("RunningHub 查询返回了其他任务的状态")
			}
		}
	}
	return nil
}

func matchRunningHubOutput(original runningHubOutput, fresh []runningHubOutput) (runningHubOutput, error) {
	matched := make([]runningHubOutput, 0, 1)
	owners := map[string]bool{}
	for _, output := range fresh {
		if original.ID != "" {
			if output.ID == original.ID {
				owners[output.Owner] = true
			}
			if output.ID == original.ID && output.Field == original.Field {
				matched = append(matched, output)
			}
		} else if output.URL == original.URL && output.Field == original.Field {
			matched = append(matched, output)
		}
	}
	if original.ID == "" && len(matched) == 0 {
		// Legacy signed URLs retain the asset path. Never substitute the new
		// array index if that path is missing or shared by different outputs.
		locator := runningHubOutputLocator(original.URL)
		for _, output := range fresh {
			if locator != "" && runningHubOutputLocator(output.URL) == locator {
				matched = append(matched, output)
			}
		}
		if len(matched) == 1 && matched[0].Field != original.Field {
			matched = nil
		}
	}
	if len(matched) != 1 || len(owners) > 1 {
		return runningHubOutput{}, errors.New("原工作流任务没有返回唯一对应的产物")
	}
	return matched[0], nil
}

func runningHubOutputLocator(rawURL string) string {
	parsed, err := url.Parse(rawURL)
	if err != nil || parsed.Host == "" || parsed.Path == "" || !isPublicMediaURL(rawURL) {
		return ""
	}
	query, err := url.ParseQuery(parsed.RawQuery)
	if err != nil {
		return ""
	}
	// Only comparison ignores signing metadata; the actual request keeps the
	// original query spelling. Resource selectors such as asset/id must stay.
	for key := range query {
		name := strings.ToLower(key)
		switch name {
		case "signature", "sign", "sig", "expires", "expiry", "exp", "policy", "key-pair-id", "awsaccesskeyid", "q-sign-algorithm", "q-ak", "q-sign-time", "q-key-time", "q-header-list", "q-url-param-list", "q-signature":
			query.Del(key)
		default:
			if strings.HasPrefix(name, "x-amz-") || strings.HasPrefix(name, "x-goog-") || strings.HasPrefix(name, "x-tos-") {
				query.Del(key)
			}
		}
	}
	locator := strings.ToLower(parsed.Scheme) + "://" + strings.ToLower(parsed.Host) + parsed.EscapedPath()
	if encoded := query.Encode(); encoded != "" {
		locator += "?" + encoded
	}
	return locator
}

func runningHubRelativeOutputPath(value string) bool {
	value = strings.ToLower(strings.TrimSpace(value))
	if value == "" || strings.Contains(value, "://") || strings.HasPrefix(value, "//") {
		return false
	}
	for _, segment := range strings.Split(strings.Split(value, "?")[0], "/") {
		if segment == ".." {
			return false
		}
	}
	for _, prefix := range []string{"output/", "assets/", "input/"} {
		if strings.HasPrefix(value, prefix) {
			return true
		}
	}
	for _, suffix := range []string{".png", ".jpg", ".jpeg", ".webp", ".gif", ".mp4", ".webm", ".mov", ".m4v", ".mp3", ".wav", ".ogg", ".m4a", ".flac"} {
		if strings.HasSuffix(strings.Split(value, "?")[0], suffix) {
			return true
		}
	}
	return false
}

func runningHubFailureMessage(payload map[string]any) string {
	for _, key := range []string{"msg", "message", "error", "failReason", "failedReason", "errorMessage"} {
		if value := stringValue(payload[key]); value != "" {
			return runningHubActionableFailureMessage(value)
		}
	}
	if nested, ok := payload["data"].(map[string]interface{}); ok {
		return runningHubFailureMessage(nested)
	}
	return "上游未提供失败原因"
}

func isWorkflowSeedField(value string) bool {
	normalized := strings.ToLower(strings.NewReplacer("_", "", "-", "", " ", "").Replace(strings.TrimSpace(value)))
	return normalized == "seed" || strings.HasSuffix(normalized, "seed") || strings.Contains(normalized, "noiseseed")
}

func runningHubActionableFailureMessage(message string) string {
	normalized := strings.ToLower(message)
	if strings.Contains(normalized, "node_info_mismatch") || strings.Contains(normalized, "node_not_found_in_workflow") {
		return "RunningHub AI 应用的公开参数已变化，请到“设置 → RunningHub 工作流”重新选择该 App 并点击“拉取参数”后再试（上游详情：" + message + "）"
	}
	return message
}

// runningHubPayloadCode 兼容 code/statusCode 以及部分网关返回的字符串状态。
// 统一映射到 RunningHub 公开状态码：0 成功、804 运行中、813 排队中、805/806 失败。
func runningHubPayloadCode(payload map[string]any) (int, bool) {
	if payload == nil {
		return 0, false
	}
	topCode, topValid := runningHubDirectCode(payload)
	if nested, ok := payload["data"].(map[string]interface{}); ok {
		if nestedCode, nestedValid := runningHubPayloadCode(nested); nestedValid {
			// 有些网关把 HTTP 成功包装成顶层 code=0，同时把真实任务状态放在
			// data.code/status；真实任务状态优先，避免把排队任务误判成完成。
			if !topValid || topCode == 0 || nestedCode != 0 {
				return nestedCode, true
			}
		}
	}
	return topCode, topValid
}

func runningHubDirectCode(payload map[string]any) (int, bool) {
	primaryCode := 0
	primaryValid := false
	for _, key := range []string{"code", "statusCode", "status_code"} {
		if value, ok := payload[key]; ok {
			if code, valid := runningHubCode(value); valid {
				if (key == "statusCode" || key == "status_code") && code >= 200 && code < 300 {
					code = 0
				}
				primaryCode, primaryValid = code, true
				break
			}
		}
	}
	for _, key := range []string{"status", "state", "taskStatus", "task_status"} {
		if code, valid := runningHubStatusCode(payload[key]); valid {
			if !primaryValid || primaryCode == 0 || code != 0 {
				return code, true
			}
			break
		}
	}
	if primaryValid {
		return primaryCode, true
	}
	// errorCode=0 通常只是“无错误”标记，不能覆盖 data.status=running。
	for _, key := range []string{"errorCode", "error_code"} {
		if value, ok := payload[key]; ok {
			if code, valid := runningHubCode(value); valid && code != 0 {
				return code, true
			}
		}
	}
	return 0, false
}

func runningHubStatusCode(value interface{}) (int, bool) {
	text := strings.ToLower(strings.TrimSpace(fmt.Sprint(value)))
	if text == "" || text == "<nil>" {
		return 0, false
	}
	if numeric, ok := runningHubCode(text); ok {
		switch numeric {
		case 0, 804, 813, 805, 806:
			return numeric, true
		}
	}
	text = strings.NewReplacer("_", "", "-", "", " ", "").Replace(text)
	switch text {
	case "success", "succeeded", "complete", "completed", "done", "finished", "finish", "3":
		return 0, true
	case "queued", "queue", "pending", "waiting", "created", "submitted":
		return 813, true
	case "running", "processing", "executing", "inprogress", "started", "working", "1", "2":
		return 804, true
	case "failed", "failure", "error", "rejected", "cancelled", "canceled", "expired", "aborted", "4", "5":
		return 805, true
	default:
		return 0, false
	}
}

func nestedString(payload map[string]any, first string, second string) string {
	nested, _ := payload[first].(map[string]interface{})
	return stringValue(nested[second])
}

func runningHubFileName(payload map[string]any) string {
	for _, key := range []string{"fileName", "file_name", "filename", "name"} {
		if value := stringValue(payload[key]); value != "" {
			return value
		}
	}
	for _, container := range []string{"data", "result", "file", "files"} {
		if nested, ok := payload[container].(map[string]interface{}); ok {
			for _, key := range []string{"fileName", "file_name", "filename", "name"} {
				if value := stringValue(nested[key]); value != "" {
					return value
				}
			}
		}
	}
	return ""
}

func runningHubCode(value interface{}) (int, bool) {
	switch item := value.(type) {
	case int:
		if item < 0 {
			return 0, false
		}
		return item, true
	case int64:
		if item < 0 {
			return 0, false
		}
		return int(item), true
	case float64:
		code := int(item)
		if item < 0 || float64(code) != item {
			return 0, false
		}
		return code, true
	case json.Number, string:
		code := mapNumber(item)
		return code, code >= 0
	default:
		return 0, false
	}
}

func mapNumber(value interface{}) int {
	switch item := value.(type) {
	case int:
		return item
	case int64:
		return int(item)
	case float64:
		return int(item)
	case json.Number:
		parsed, _ := strconv.Atoi(string(item))
		return parsed
	case string:
		parsed, _ := strconv.Atoi(strings.TrimSpace(item))
		return parsed
	default:
		return -1
	}
}
