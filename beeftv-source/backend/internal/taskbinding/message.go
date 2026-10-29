package taskbinding

import (
	"errors"
	"strings"

	"infinite-canvas/backend/internal/assets"
	"infinite-canvas/backend/internal/model"
	localtask "infinite-canvas/backend/internal/task"
)

// AttachMessage binds a durable backend task output onto an existing
// conversation message in one domain step. Conversation CAS retries stay
// inside this call so the operation identity does not change.
func AttachMessage(ports MessagePorts, userID string, req MessageRequest) (MessageReceipt, error) {
	if ports == nil {
		return MessageReceipt{}, invalid("bind_ports_unavailable", "绑定端口不可用")
	}
	userID = strings.TrimSpace(userID)
	req.ConversationID = strings.TrimSpace(req.ConversationID)
	req.MessageID = strings.TrimSpace(req.MessageID)
	req.TaskID = strings.TrimSpace(req.TaskID)
	req.EffectKey = strings.TrimSpace(req.EffectKey)
	if userID == "" {
		return MessageReceipt{}, invalid("missing_scope", "缺少用户/工作区作用域")
	}
	if req.ConversationID == "" || req.TaskID == "" || req.MessageID == "" {
		return MessageReceipt{}, invalid("invalid_params", "conversationId、taskId、messageId 必填")
	}
	if req.OutputIndex < 0 {
		return MessageReceipt{}, invalid("invalid_params", "outputIndex 无效")
	}
	task, err := ports.Task(userID, req.TaskID)
	if err != nil {
		return MessageReceipt{}, mapPortError(err)
	}
	if task == nil || strings.TrimSpace(task.ID) == "" {
		return MessageReceipt{}, notFound("task_not_found", "任务不存在")
	}
	if strings.TrimSpace(task.UserID) != userID {
		return MessageReceipt{}, forbidden("task_foreign", "任务不属于当前用户")
	}
	if task.Status != model.TaskStatusSucceeded {
		return MessageReceipt{}, precondition("task_not_succeeded", "只有成功的任务才能绑定到消息")
	}
	target := localtask.TargetBindingFromInput(task.InputJSON)
	if conversationID := strings.TrimSpace(target.ConversationID); conversationID != "" && conversationID != req.ConversationID {
		return MessageReceipt{}, conflict("conversation_mismatch", "只能绑定到任务原先指定的对话")
	}
	if messageID := strings.TrimSpace(target.MessageID); messageID != "" && messageID != req.MessageID {
		return MessageReceipt{}, conflict("message_mismatch", "只能绑定到任务原先指定的消息")
	}
	wantKey := localtask.AttachMessageEffectKey(req.TaskID, req.MessageID, req.OutputIndex)
	if req.EffectKey == "" {
		req.EffectKey = wantKey
	}
	if req.EffectKey != wantKey {
		return MessageReceipt{}, invalid("effect_identity_mismatch", "操作身份必须是 attach-message:任务:消息:输出序号")
	}

	patch, err := messagePatch(ports, userID, *task, req)
	if err != nil {
		return MessageReceipt{}, err
	}
	var attached ConversationView
	for attempt := 0; attempt < maxBindRevisionAttempts; attempt++ {
		attached, err = ports.AttachMessageResult(userID, MessageAttachInput{
			ConversationID: req.ConversationID,
			MessageID:      req.MessageID,
			TaskID:         req.TaskID,
			EffectKey:      req.EffectKey,
			ResultURLs:     patch.ResultURLs,
			Status:         "done",
			Content:        patch.Content,
		})
		if err == nil {
			return messageReceiptFor(req, patch, attached), nil
		}
		if !isMessageRevisionConflict(err) {
			return MessageReceipt{}, mapPortError(err)
		}
	}
	return MessageReceipt{}, mapPortError(err)
}

type messagePatchFields struct {
	MediaType  string
	AssetID    string
	ResourceID string
	StorageKey string
	Content    string
	ResultURLs []string
}

func messagePatch(ports MessagePorts, userID string, task model.Task, req MessageRequest) (messagePatchFields, error) {
	if isMessageTextTask(task) {
		if req.OutputIndex != 0 {
			return messagePatchFields{}, invalid("invalid_params", "文本任务只能绑定 outputIndex 0")
		}
		text, _, ok, unreadable := durableText(task.ResultJSON)
		if unreadable {
			return messagePatchFields{}, precondition("delivery_unreadable", "任务结果无法读取，不能绑定到消息")
		}
		if !ok {
			return messagePatchFields{}, precondition("output_not_ready", "文本任务还没有可绑定的结果")
		}
		return messagePatchFields{MediaType: "text", Content: text}, nil
	}
	outputs, err := ports.GenerationOutputs(task.ID)
	if err != nil {
		return messagePatchFields{}, mapPortError(err)
	}
	var output localtask.CanonicalOutput
	found := false
	for _, item := range outputs {
		if item.OutputIndex == req.OutputIndex {
			output = item
			found = true
			break
		}
	}
	if !found {
		return messagePatchFields{}, precondition("output_not_ready", "任务产物尚未交付，不能绑定到消息")
	}
	if strings.TrimSpace(output.MaterializationErrorCode) != "" && strings.TrimSpace(output.MaterializedAssetID) == "" {
		return messagePatchFields{}, precondition(output.MaterializationErrorCode, "任务产物不可用，不能绑定到消息")
	}
	if strings.TrimSpace(output.MaterializedAssetID) == "" || strings.TrimSpace(output.ResourceID) == "" {
		return messagePatchFields{}, precondition("output_not_ready", "任务产物尚未就绪，不能绑定到消息")
	}
	resource, err := ports.OwnedReadyResource(userID, output.ResourceID)
	if err != nil {
		return messagePatchFields{}, mapPortError(err)
	}
	if resource == nil || strings.TrimSpace(resource.ID) == "" || resource.Status != model.ResourceStatusReady {
		return messagePatchFields{}, precondition("resource_not_ready", "任务资源未就绪，不能绑定到消息")
	}
	if strings.TrimSpace(resource.UserID) != userID {
		return messagePatchFields{}, forbidden("resource_foreign", "任务资源不属于当前用户")
	}
	if strings.TrimSpace(resource.ID) != strings.TrimSpace(output.ResourceID) {
		return messagePatchFields{}, precondition("resource_mismatch", "任务资源与产物记录不一致，不能绑定到消息")
	}
	asset, err := ports.OwnedAsset(userID, output.MaterializedAssetID)
	if err != nil {
		return messagePatchFields{}, mapPortError(err)
	}
	if asset == nil || strings.TrimSpace(asset.ID) == "" {
		return messagePatchFields{}, precondition("output_not_ready", "任务素材尚未就绪，不能绑定到消息")
	}
	if strings.TrimSpace(asset.UserID) != userID {
		return messagePatchFields{}, forbidden("asset_foreign", "任务素材不属于当前用户")
	}
	if assetResourceID(asset) != strings.TrimSpace(output.ResourceID) {
		return messagePatchFields{}, precondition("resource_mismatch", "任务素材未指向本次产物资源，不能绑定到消息")
	}
	mediaType := strings.TrimSpace(output.MediaType)
	if mediaType == "" {
		mediaType = strings.TrimSpace(resource.Kind)
	}
	content := mediaResultLabel(mediaType)
	url := assets.FileURL(resource.ID)
	return messagePatchFields{
		MediaType:  mediaType,
		AssetID:    output.MaterializedAssetID,
		ResourceID: resource.ID,
		StorageKey: "resource:" + resource.ID,
		Content:    content,
		ResultURLs: []string{url},
	}, nil
}

func isMessageTextTask(task model.Task) bool {
	switch strings.TrimSpace(task.Type) {
	case "text", "canvas_text", "text_replay":
		return true
	default:
		return false
	}
}

func mediaResultLabel(mediaType string) string {
	switch strings.TrimSpace(mediaType) {
	case "video":
		return "视频已生成"
	case "audio":
		return "音频已生成"
	default:
		return "图片已生成"
	}
}

func messageReceiptFor(req MessageRequest, patch messagePatchFields, attached ConversationView) MessageReceipt {
	return MessageReceipt{
		Applied:        true,
		ConversationID: req.ConversationID,
		MessageID:      req.MessageID,
		TaskID:         req.TaskID,
		OutputIndex:    req.OutputIndex,
		EffectKey:      req.EffectKey,
		MediaType:      patch.MediaType,
		AssetID:        patch.AssetID,
		ResourceID:     patch.ResourceID,
		StorageKey:     patch.StorageKey,
		Content:        patch.Content,
		ResultURLs:     append([]string(nil), patch.ResultURLs...),
		Revision:       attached.Revision,
	}
}

func isMessageRevisionConflict(err error) bool {
	var bindErr *Error
	return errors.As(err, &bindErr) && bindErr.Reason == "stale_revision"
}
