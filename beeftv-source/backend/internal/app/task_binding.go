package app

import (
	"encoding/json"
	"errors"
	"strconv"
	"strings"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/operations"
	localtask "infinite-canvas/backend/internal/task"
)

const canvasBindRecoveryBatch = 64

func (s *Service) workspaceOperations() *operations.Registry {
	if s == nil || s.repo == nil {
		return nil
	}
	s.workspaceOpsMu.Lock()
	defer s.workspaceOpsMu.Unlock()
	if s.workspaceOps != nil {
		return s.workspaceOps
	}
	db := s.Database()
	if db == nil {
		return nil
	}
	registry := operations.NewRegistry(s, operations.NewStore(db))
	operations.RegisterDefaultOps(registry)
	s.workspaceOps = registry
	return registry
}

func (s *Service) recoverCanvasTaskBindings(task model.Task) error {
	if s == nil || strings.TrimSpace(task.ID) == "" || strings.TrimSpace(task.UserID) == "" {
		return nil
	}
	if task.Status != model.TaskStatusSucceeded {
		return nil
	}
	if err := s.prepareSeedreamOutputNodes(task); err != nil {
		return err
	}
	registry := s.workspaceOperations()
	intents := s.CanvasBindingIntents(task)
	var last error
	if registry != nil {
		for _, target := range canvasBindTargets(task, intents) {
			if err := s.executeCanvasTaskBind(registry, task, target.nodeID, target.outputIndex); err != nil {
				if skippableCanvasBindError(err) {
					continue
				}
				last = err
			}
		}
		for _, target := range messageBindTargets(task, intents) {
			if err := s.executeMessageTaskAttach(registry, task, target.conversationID, target.messageID, target.outputIndex); err != nil {
				if skippableCanvasBindError(err) {
					continue
				}
				last = err
			}
		}
	}
	if err := s.RegisterTaskOutputFromTask(task); err != nil {
		last = err
	}
	if projectID := strings.TrimSpace(task.ProjectID); projectID != "" {
		s.reconcileCharacterTurnaroundTasks(task.UserID, projectID)
	}
	return last
}

func (s *Service) recoverPendingCanvasBindings(limit int) error {
	if s == nil || s.repo == nil {
		return nil
	}
	if s.workspaceOperations() == nil {
		return nil
	}
	if limit <= 0 {
		limit = canvasBindRecoveryBatch
	}
	s.bindCursorMu.Lock()
	afterID := s.bindAfterID
	s.bindCursorMu.Unlock()
	tasks, err := s.repo.SucceededTasksForDelivery(afterID, limit)
	if err != nil {
		if bindInfrastructureUnavailable(err) {
			return nil
		}
		return err
	}
	if len(tasks) == 0 && afterID != "" {
		tasks, err = s.repo.SucceededTasksForDelivery("", limit)
		if err != nil {
			if bindInfrastructureUnavailable(err) {
				return nil
			}
			return err
		}
	}
	s.bindCursorMu.Lock()
	if len(tasks) == 0 || len(tasks) < limit {
		s.bindAfterID = ""
	} else {
		s.bindAfterID = tasks[len(tasks)-1].ID
	}
	s.bindCursorMu.Unlock()
	var last error
	for _, task := range tasks {
		if err := s.recoverCanvasTaskBindings(task); err != nil {
			last = err
		}
	}
	return last
}

func (s *Service) executeMessageTaskAttach(registry *operations.Registry, task model.Task, conversationID, messageID string, outputIndex int) error {
	conversationID = strings.TrimSpace(conversationID)
	messageID = strings.TrimSpace(messageID)
	if registry == nil || conversationID == "" || messageID == "" {
		return nil
	}
	params, err := json.Marshal(map[string]any{
		"conversationId": conversationID,
		"taskId":         task.ID,
		"messageId":      messageID,
		"outputIndex":    outputIndex,
	})
	if err != nil {
		return err
	}
	_, err = registry.Execute(operations.Request{
		Op:     "conversation.message.attach",
		OpID:   localtask.AttachMessageEffectKey(task.ID, messageID, outputIndex),
		UserID: task.UserID,
		Caller: operations.ManualCaller(false),
		Params: params,
	})
	if skippableCanvasBindError(err) {
		return nil
	}
	return err
}

func (s *Service) executeCanvasTaskBind(registry *operations.Registry, task model.Task, nodeID string, outputIndex int) error {
	canvasID := strings.TrimSpace(task.ProjectID)
	nodeID = strings.TrimSpace(nodeID)
	if registry == nil || canvasID == "" || nodeID == "" {
		return nil
	}
	params, err := json.Marshal(map[string]any{
		"canvasId":    canvasID,
		"taskId":      task.ID,
		"nodeId":      nodeID,
		"outputIndex": outputIndex,
	})
	if err != nil {
		return err
	}
	_, err = registry.Execute(operations.Request{
		Op:     "canvas.task.bind",
		OpID:   localtask.AttachNodeEffectKey(task.ID, nodeID, outputIndex),
		UserID: task.UserID,
		Caller: operations.ManualCaller(false),
		Params: params,
	})
	if skippableCanvasBindError(err) {
		return nil
	}
	return err
}

type canvasBindTarget struct {
	nodeID      string
	outputIndex int
}

type messageBindTarget struct {
	conversationID string
	messageID      string
	outputIndex    int
}

func canvasBindTargets(task model.Task, intents []localtask.CanvasBindingIntent) []canvasBindTarget {
	seen := map[string]bool{}
	targets := make([]canvasBindTarget, 0, len(intents)+1)
	add := func(nodeID string, outputIndex int) {
		nodeID = strings.TrimSpace(nodeID)
		if nodeID == "" {
			return
		}
		key := nodeID + ":" + strconv.Itoa(outputIndex)
		if seen[key] {
			return
		}
		seen[key] = true
		targets = append(targets, canvasBindTarget{nodeID: nodeID, outputIndex: outputIndex})
	}
	for _, intent := range intents {
		if intent.TargetBinding == nil {
			continue
		}
		add(intent.TargetBinding.NodeID, intent.OutputIndex)
	}
	switch strings.TrimSpace(task.Type) {
	case "canvas_text", "text_replay":
		add(localtask.TargetBindingFromInput(task.InputJSON).NodeID, 0)
	}
	return targets
}

func messageBindTargets(task model.Task, intents []localtask.CanvasBindingIntent) []messageBindTarget {
	seen := map[string]bool{}
	targets := make([]messageBindTarget, 0, len(intents)+1)
	add := func(conversationID, messageID string, outputIndex int) {
		conversationID = strings.TrimSpace(conversationID)
		messageID = strings.TrimSpace(messageID)
		if conversationID == "" || messageID == "" {
			return
		}
		key := conversationID + ":" + messageID + ":" + strconv.Itoa(outputIndex)
		if seen[key] {
			return
		}
		seen[key] = true
		targets = append(targets, messageBindTarget{conversationID: conversationID, messageID: messageID, outputIndex: outputIndex})
	}
	for _, intent := range intents {
		if intent.TargetBinding == nil {
			continue
		}
		add(intent.TargetBinding.ConversationID, intent.TargetBinding.MessageID, intent.OutputIndex)
	}
	target := localtask.TargetBindingFromInput(task.InputJSON)
	add(target.ConversationID, target.MessageID, 0)
	return targets
}

func skippableCanvasBindError(err error) bool {
	if err == nil {
		return true
	}
	if bindInfrastructureUnavailable(err) {
		return true
	}
	var opErr *operations.Error
	if !errors.As(err, &opErr) {
		return false
	}
	switch opErr.Reason {
	case "node_deleted", "node_task_mismatch", "node_mismatch", "canvas_mismatch",
		"conversation_deleted", "message_deleted", "message_mismatch", "conversation_mismatch",
		"message_task_mismatch",
		"task_not_found", "task_not_succeeded", "task_foreign",
		"output_not_ready", "resource_not_ready", "resource_missing", "resource_foreign",
		"resource_mismatch", "asset_foreign", "delivery_unreadable", "unsupported_result_shape",
		"effect_identity_mismatch":
		return true
	default:
		return false
	}
}

func bindInfrastructureUnavailable(err error) bool {
	if err == nil {
		return false
	}
	message := strings.ToLower(err.Error())
	return strings.Contains(message, "no such table") ||
		strings.Contains(message, "op_store_unavailable") ||
		strings.Contains(message, "op_domain_unavailable")
}
