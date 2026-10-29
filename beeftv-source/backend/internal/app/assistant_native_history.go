package app

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"infinite-canvas/backend/internal/agentops"
	"infinite-canvas/backend/internal/operations"
	"io"
)

func (s *Service) BindAssistantDurableSession(userID, turnID, sessionID string, historical bool) error {
	return s.assistantTurnsOrInit().BindDurableSession(userID, turnID, sessionID, historical)
}
func (s *Service) RevalidateAssistantNativeSource(ctx context.Context, userID, currentTurnID, originTurnID, sessionID string, source operations.MediaSource) (any, error) {
	pin, _ := json.Marshal(source)
	if !s.assistantTurnsOrInit().HasNativeSource(userID, originTurnID, sessionID, string(pin)) {
		return nil, operations.PermissionDenied("native_history_untrusted", "历史素材没有读取授权")
	}
	if _, err := s.assistantTurnsOrInit().NativeHistoryScope(userID, currentTurnID, originTurnID, sessionID); err != nil {
		return nil, err
	}
	if _, err := s.UserCanvasProject(userID, source.CanvasID); err != nil {
		return nil, err
	}
	if source.AssetID != "" {
		if _, err := s.UserAsset(userID, source.AssetID); err != nil {
			return nil, err
		}
	}
	resource, err := s.BindDomain(nil).OwnedReadyResource(userID, source.ResourceID)
	if err != nil {
		return nil, err
	}
	if resource.Size > 256<<20 {
		return nil, operations.PreconditionFailed("media_too_large", "历史素材过大", nil)
	}
	body, err := s.BindDomain(nil).(*operationSession).OpenMediaResource(ctx, userID, source.ResourceID)
	if err != nil {
		return nil, err
	}
	defer body.Close()
	hash := sha256.New()
	size, err := io.Copy(hash, io.LimitReader(body, (256<<20)+1))
	if err != nil {
		return nil, err
	}
	if size > 256<<20 || hex.EncodeToString(hash.Sum(nil)) != source.Version {
		return nil, operations.Conflict("stale_media_version", "历史素材内容已变化，请重新添加", nil)
	}
	return operations.MediaResult{Source: source}, nil
}
func (s *Service) validateAssistantNativeSource(ctx context.Context, userID, currentTurnID, originTurnID, sessionID string, source operations.MediaSource) (any, error) {
	trusted, err := s.assistantTurnsOrInit().NativeHistoryScope(userID, currentTurnID, originTurnID, sessionID)
	if err != nil {
		return nil, err
	}
	scope := &agentops.AssistantScope{PermissionMode: trusted.PermissionMode, CanvasID: trusted.CanvasID, AssetIDs: map[string]bool{}, CanvasIDs: map[string]bool{}, ProjectReference: func(kind, id string) error {
		return s.ValidateAgentProjectReference(userID, trusted.CanvasID, kind, id)
	}}
	for _, id := range trusted.AssetIDs {
		scope.AssetIDs[id] = true
	}
	for _, id := range trusted.CanvasIDs {
		scope.CanvasIDs[id] = true
	}
	raw, _ := json.Marshal(map[string]any{"canvasId": source.CanvasID, "nodeId": source.NodeID, "assetId": source.AssetID, "resourceId": source.ResourceID, "expectedVersion": source.Version})
	result, err := s.workspaceOperations().Execute(operations.Request{Context: ctx, UserID: userID, Caller: operations.AssistantCaller(scope, true), Op: "media.overview", Params: raw})
	if err != nil {
		return nil, err
	}
	return result.Result, nil
}

func (s *Service) RegisterAssistantNativeSource(ctx context.Context, userID, currentTurnID, originTurnID, sessionID string, source operations.MediaSource) error {
	pin, _ := json.Marshal(source)
	if s.assistantTurnsOrInit().HasNativeSource(userID, originTurnID, sessionID, string(pin)) {
		_, err := s.RevalidateAssistantNativeSource(ctx, userID, currentTurnID, originTurnID, sessionID, source)
		return err
	}
	if _, err := s.validateAssistantNativeSource(ctx, userID, currentTurnID, originTurnID, sessionID, source); err != nil {
		return err
	}
	return s.assistantTurnsOrInit().RegisterNativeSource(userID, originTurnID, sessionID, string(pin))
}
