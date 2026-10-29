package operations

import (
	"encoding/json"
	"errors"
	"strings"

	"infinite-canvas/backend/internal/model"
	localtask "infinite-canvas/backend/internal/task"
	"infinite-canvas/backend/internal/taskbinding"
)

func opConversationMessageAttach(ctx *Context, params json.RawMessage) (any, error) {
	var args struct {
		ConversationID string `json:"conversationId"`
		TaskID         string `json:"taskId"`
		MessageID      string `json:"messageId"`
		OutputIndex    int    `json:"outputIndex"`
	}
	if err := decodeParams(params, &args); err != nil {
		return nil, err
	}
	receipt, err := taskbinding.AttachMessage(&messageBindPorts{ctx: ctx}, ctx.UserID, taskbinding.MessageRequest{
		ConversationID: args.ConversationID,
		TaskID:         args.TaskID,
		MessageID:      args.MessageID,
		OutputIndex:    args.OutputIndex,
	})
	if err != nil {
		return nil, mapDomainError(err)
	}
	projected, err := projectConversationMessageAttachOutcome(ctx, args.ConversationID, args.MessageID, messageReceiptMap(receipt))
	if err != nil {
		return nil, err
	}
	return sanitizeForClient(projected), nil
}

func projectConversationMessageAttachReplay(ctx *Context, params json.RawMessage, stored any) (any, error) {
	var args struct {
		ConversationID string `json:"conversationId"`
		MessageID      string `json:"messageId"`
		TaskID         string `json:"taskId"`
	}
	if json.Unmarshal(params, &args) != nil {
		return stored, nil
	}
	historical := cloneReceiptMap(stored)
	projected, err := projectConversationMessageAttachOutcome(ctx, args.ConversationID, args.MessageID, historical)
	if err != nil {
		return nil, err
	}
	return sanitizeForClient(projected), nil
}

func projectConversationMessageAttachOutcome(ctx *Context, conversationID, messageID string, stored map[string]any) (map[string]any, error) {
	historical := historicalBindReceipt(stored)
	projected := map[string]any{
		"applied":        stored["applied"],
		"conversationId": stored["conversationId"],
		"messageId":      stored["messageId"],
		"taskId":         stored["taskId"],
		"outputIndex":    stored["outputIndex"],
		"effectKey":      stored["effectKey"],
		"mediaType":      stored["mediaType"],
		"alreadyBound":   stored["alreadyBound"],
		"historical":     historical,
		"bindingStatus":  "deleted",
	}
	if ctx == nil || ctx.Domain == nil {
		return projected, nil
	}
	view, err := ctx.Domain.UserConversation(ctx.UserID, strings.TrimSpace(conversationID))
	if err != nil {
		if isNotFoundError(err) {
			return projected, nil
		}
		return nil, mapDomainError(err)
	}
	if view.Deleted {
		projected["revision"] = view.Revision
		return projected, nil
	}
	doc, err := decodeConversationDocument(view.Document)
	if err != nil {
		return nil, AsError(err)
	}
	projected["revision"] = view.Revision
	projected["conversation"] = doc
	message := findConversationMessage(doc, strings.TrimSpace(messageID))
	if message == nil {
		return projected, nil
	}
	projected["message"] = message
	historicalTaskID, _ := stored["taskId"].(string)
	if currentTaskIDs := messageTaskIDs(message); strings.TrimSpace(historicalTaskID) != "" && !containsString(currentTaskIDs, strings.TrimSpace(historicalTaskID)) {
		projected["bindingStatus"] = "replaced"
		return projected, nil
	}
	projected["bindingStatus"] = "bound"
	copyCurrentMessageFields(projected, message)
	return projected, nil
}

func decodeConversationDocument(raw []byte) (map[string]any, error) {
	if len(strings.TrimSpace(string(raw))) == 0 {
		return nil, errors.New("conversation document missing")
	}
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, err
	}
	if doc == nil {
		return nil, errors.New("conversation document missing")
	}
	return doc, nil
}

func findConversationMessage(doc map[string]any, messageID string) map[string]any {
	if doc == nil || messageID == "" {
		return nil
	}
	messages, _ := doc["messages"].([]any)
	for _, raw := range messages {
		message, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		if strings.TrimSpace(fmtStringValue(message["id"])) == messageID {
			return message
		}
	}
	return nil
}

func messageTaskIDs(message map[string]any) []string {
	if message == nil {
		return nil
	}
	return stringListValue(message["taskIds"])
}

func copyCurrentMessageFields(projected map[string]any, message map[string]any) {
	if projected == nil || message == nil {
		return
	}
	if content, _ := message["content"].(string); strings.TrimSpace(content) != "" {
		projected["content"] = content
	}
	if urls := stringListValue(message["resultUrls"]); len(urls) > 0 {
		projected["resultUrls"] = urls
	}
	if keys := stringListValue(message["generationEffectKeys"]); len(keys) > 0 {
		projected["generationEffectKeys"] = keys
	}
}

func stringListValue(value any) []string {
	switch typed := value.(type) {
	case []string:
		return append([]string(nil), typed...)
	case []any:
		out := make([]string, 0, len(typed))
		for _, item := range typed {
			text := strings.TrimSpace(fmtStringValue(item))
			if text != "" {
				out = append(out, text)
			}
		}
		return out
	default:
		return nil
	}
}

func fmtStringValue(value any) string {
	text, _ := value.(string)
	return text
}

func containsString(items []string, want string) bool {
	for _, item := range items {
		if item == want {
			return true
		}
	}
	return false
}

func messageReceiptMap(receipt taskbinding.MessageReceipt) map[string]any {
	encoded, err := json.Marshal(receipt)
	if err != nil {
		return map[string]any{"applied": receipt.Applied, "conversationId": receipt.ConversationID, "messageId": receipt.MessageID, "taskId": receipt.TaskID, "revision": receipt.Revision}
	}
	var out map[string]any
	if json.Unmarshal(encoded, &out) != nil {
		return map[string]any{"applied": receipt.Applied, "revision": receipt.Revision}
	}
	return out
}

func messageEffectKey(params json.RawMessage) string {
	var args struct {
		TaskID      string `json:"taskId"`
		MessageID   string `json:"messageId"`
		OutputIndex int    `json:"outputIndex"`
	}
	if json.Unmarshal(params, &args) != nil {
		return ""
	}
	taskID := strings.TrimSpace(args.TaskID)
	messageID := strings.TrimSpace(args.MessageID)
	if taskID == "" || messageID == "" {
		return ""
	}
	return localtask.AttachMessageEffectKey(taskID, messageID, args.OutputIndex)
}

type messageBindPorts struct {
	ctx *Context
}

func (p *messageBindPorts) Task(userID, taskID string) (*model.Task, error) {
	return p.ctx.Domain.WorkspaceTask(userID, taskID)
}

func (p *messageBindPorts) GenerationOutputs(taskID string) ([]localtask.CanonicalOutput, error) {
	return p.ctx.Domain.GenerationOutputs(taskID)
}

func (p *messageBindPorts) OwnedReadyResource(userID, resourceID string) (*model.Resource, error) {
	return p.ctx.Domain.OwnedReadyResource(userID, resourceID)
}

func (p *messageBindPorts) OwnedAsset(userID, assetID string) (*model.Asset, error) {
	return p.ctx.Domain.OwnedAsset(userID, assetID)
}

func (p *messageBindPorts) Conversation(userID, conversationID string) (taskbinding.ConversationView, error) {
	return p.ctx.Domain.UserConversation(userID, conversationID)
}

func (p *messageBindPorts) AttachMessageResult(userID string, input taskbinding.MessageAttachInput) (taskbinding.ConversationView, error) {
	return p.ctx.Domain.AttachConversationMessage(userID, input)
}
