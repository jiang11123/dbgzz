package project

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"

	"gorm.io/gorm"
)

func (s *Service) FilterProjectAssets(userID string, projectID string, filter ProjectAssetFilter) ([]AssetSummary, error) {
	assets, err := s.ProjectAssets(userID, projectID)
	if err != nil {
		return nil, err
	}
	result := make([]AssetSummary, 0, len(assets))
	for _, asset := range assets {
		if filter.Category != "" && string(asset.Category) != filter.Category {
			continue
		}
		if filter.MediaType != "" && asset.MediaType != filter.MediaType {
			continue
		}
		if filter.Status != "" && string(asset.Status) != filter.Status {
			continue
		}
		if filter.Usage != "" && !containsString(asset.Usages, filter.Usage) {
			continue
		}
		result = append(result, asset)
	}
	return result, nil
}

func (s *Service) ProjectAssets(userID string, projectID string) ([]AssetSummary, error) {
	if _, err := s.Owned(userID, projectID); err != nil {
		return nil, err
	}
	assets, err := s.repo.ProjectAssets(userID, projectID)
	if err != nil {
		return nil, err
	}
	result := make([]AssetSummary, 0, len(assets))
	for _, asset := range assets {
		summary, summaryErr := s.assetSummary(userID, projectID, &asset)
		if summaryErr != nil {
			return nil, summaryErr
		}
		result = append(result, summary)
	}
	return result, nil
}

func (s *Service) LinkProjectAsset(userID string, projectID string, req LinkProjectAssetRequest) (AssetSummary, error) {
	if _, err := s.Active(userID, projectID); err != nil {
		return AssetSummary{}, err
	}
	assetID := strings.TrimSpace(req.AssetID)
	source := strings.TrimSpace(req.Source)
	if source != AssetSourceCanvas {
		source = AssetSourceUploaded
	}
	asset, err := s.repo.AssetForUser(userID, assetID)
	if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
		return AssetSummary{}, err
	}
	if asset == nil {
		asset, err = s.assetFromUploadedResource(userID, assetID, req.Title, source)
		if err != nil {
			return AssetSummary{}, err
		}
	}
	category := model.AssetCategory(strings.TrimSpace(req.Category))
	if category == "" {
		category = asset.Category
	}
	if !validAssetCategory(category) {
		return AssetSummary{}, kernel.BadAuthRequest("不支持的资产业务分类")
	}
	folderID, err := s.resolveAssetFolderID(projectID, req.FolderID)
	if err != nil {
		return AssetSummary{}, err
	}
	linked, err := s.repo.ProjectAssetLinked(projectID, asset.ID)
	if err != nil {
		return AssetSummary{}, err
	}
	if linked {
		return s.assetSummary(userID, projectID, asset)
	}
	now := time.Now()
	asset.Category = category
	if asset.Status == "" {
		asset.Status = model.AssetVersionStatusConfirmed
	}
	versions, err := s.repo.AssetVersions(asset.ID)
	if err != nil {
		return AssetSummary{}, err
	}
	var initialVersion *model.AssetVersion
	if len(versions) == 0 {
		version := model.AssetVersion{ID: kernel.NewID(), AssetID: asset.ID, Version: 1, Status: asset.Status, DefinitionJSON: "{}", CreatedAt: now, UpdatedAt: now}
		initialVersion = &version
		asset.PrimaryVersionID = version.ID
		versions = append(versions, version)
	}
	asset.UpdatedAt = now
	position, err := s.repo.NextProjectAssetPosition(projectID, folderID)
	if err != nil {
		return AssetSummary{}, err
	}
	link := model.ProjectAssetLink{ID: kernel.NewID(), ProjectID: projectID, AssetID: asset.ID, FolderID: folderID, Position: position, CreatedAt: now}
	created, err := s.repo.LinkProjectAsset(asset, initialVersion, &link)
	if err != nil {
		return AssetSummary{}, mapProjectWriteError(err)
	}
	if !created {
		current, currentErr := s.repo.AssetForUser(userID, asset.ID)
		if currentErr != nil {
			return AssetSummary{}, currentErr
		}
		return s.assetSummary(userID, projectID, current)
	}
	return s.assetSummary(userID, projectID, asset)
}

func (s *Service) assetFromUploadedResource(userID string, resourceID string, title string, source string) (*model.Asset, error) {
	resource, err := s.repo.ResourceForUser(userID, resourceID)
	if err != nil {
		return nil, err
	}
	if resource.Kind == "" {
		return nil, kernel.BadAuthRequest("资源缺少媒体类型，无法导入")
	}
	payload, err := json.Marshal(map[string]any{
		"data": map[string]any{
			"storageKey": "resource:" + resource.ID,
			"mimeType":   resource.MimeType,
			"kind":       resource.Kind,
			"size":       resource.Size,
			"width":      resource.Width,
			"height":     resource.Height,
			"durationMs": resource.DurationMs,
			"status":     resource.Status,
			"mediaType":  resource.Kind,
			"source":     source,
		},
	})
	if err != nil {
		return nil, err
	}
	title = strings.TrimSpace(title)
	if title == "" {
		title = mediaTitleFallback(resource)
	}
	return &model.Asset{
		ID:          resource.ID,
		UserID:      userID,
		Kind:        resource.Kind,
		Category:    model.NormalizeAssetCategory("", resource.Kind),
		Status:      model.AssetVersionStatusConfirmed,
		Title:       title,
		PayloadJSON: string(payload),
		CreatedAt:   resource.CreatedAt,
		UpdatedAt:   resource.UpdatedAt,
	}, nil
}

func mediaTitleFallback(resource *model.Resource) string {
	base := "未命名" + resource.Kind
	if resource.Width > 0 && resource.Height > 0 {
		base += fmt.Sprintf(" %dx%d", resource.Width, resource.Height)
	}
	return base
}

func (s *Service) UnlinkProjectAsset(userID string, projectID string, assetID string) error {
	if _, err := s.Active(userID, projectID); err != nil {
		return err
	}
	asset, err := s.repo.AssetForUser(userID, assetID)
	if err != nil {
		return err
	}
	if asset.Category == model.AssetCategoryCharacter {
		canvases, canvasErr := s.repo.ProjectCanvasDocuments(userID, projectID)
		if canvasErr != nil {
			return canvasErr
		}
		for _, canvas := range canvases {
			referenced, parseErr := canvasReferencesCharacterAsset(canvas.PayloadJSON, assetID)
			if parseErr != nil {
				return kernel.BadAuthRequest("画布数据格式错误，无法确认角色引用")
			}
			if referenced {
				return kernel.BadAuthRequest("角色仍被项目画布引用，请先删除对应角色卡节点")
			}
		}
	}
	return mapProjectWriteError(s.repo.UnlinkProjectAssetAndBump(userID, projectID, assetID))
}

func canvasReferencesCharacterAsset(payloadJSON string, assetID string) (bool, error) {
	var payload struct {
		Nodes []struct {
			Metadata struct {
				WorkflowKind     string `json:"workflowKind"`
				CharacterAssetID string `json:"characterAssetId"`
			} `json:"metadata"`
		} `json:"nodes"`
	}
	if err := json.Unmarshal([]byte(payloadJSON), &payload); err != nil {
		return false, err
	}
	for _, node := range payload.Nodes {
		if node.Metadata.WorkflowKind == "character" && node.Metadata.CharacterAssetID == assetID {
			return true, nil
		}
	}
	return false, nil
}

func (s *Service) UpdateProjectAsset(userID string, projectID string, assetID string, req UpdateProjectAssetRequest) (AssetSummary, error) {
	project, err := s.Active(userID, projectID)
	if err != nil {
		return AssetSummary{}, err
	}
	asset, err := s.repo.AssetForUser(userID, strings.TrimSpace(assetID))
	if err != nil {
		return AssetSummary{}, err
	}
	linked, err := s.repo.ProjectAssetLinked(projectID, asset.ID)
	if err != nil {
		return AssetSummary{}, err
	}
	if !linked {
		return AssetSummary{}, kernel.BadAuthRequest("素材尚未加入当前项目")
	}
	if req.Category != nil && req.FolderID != nil {
		return AssetSummary{}, kernel.BadAuthRequest("一次只能修改素材分类或所在文件夹")
	}
	if req.Category != nil {
		category := model.AssetCategory(strings.TrimSpace(*req.Category))
		if !validAssetCategory(category) {
			return AssetSummary{}, kernel.BadAuthRequest("不支持的资产业务分类")
		}
		asset.Category = category
		asset.UpdatedAt = time.Now()
		if err := s.repo.UpdateProjectAssetCategoryAndBump(userID, projectID, project.Revision, asset); err != nil {
			return AssetSummary{}, mapProjectWriteError(err)
		}
	} else if req.FolderID != nil {
		folderID, folderErr := s.resolveAssetFolderID(projectID, req.FolderID)
		if folderErr != nil {
			return AssetSummary{}, folderErr
		}
		position, positionErr := s.repo.NextProjectAssetPosition(projectID, folderID)
		if positionErr != nil {
			return AssetSummary{}, positionErr
		}
		if err := s.repo.MoveProjectAssetActive(userID, projectID, asset.ID, folderID, position); err != nil {
			return AssetSummary{}, mapProjectWriteError(err)
		}
	} else {
		return AssetSummary{}, kernel.BadAuthRequest("没有可更新的素材字段")
	}
	return s.assetSummary(userID, projectID, asset)
}

func (s *Service) CreateProjectAssetVersion(userID string, projectID string, assetID string, req CreateAssetVersionRequest) (model.AssetVersion, error) {
	if _, err := s.Active(userID, projectID); err != nil {
		return model.AssetVersion{}, err
	}
	asset, err := s.repo.AssetForUser(userID, assetID)
	if err != nil {
		return model.AssetVersion{}, err
	}
	definition := strings.TrimSpace(req.DefinitionJSON)
	if definition == "" {
		definition = "{}"
	}
	if !json.Valid([]byte(definition)) {
		return model.AssetVersion{}, kernel.BadAuthRequest("资产版本设定必须是有效 JSON")
	}
	now := time.Now()
	version := model.AssetVersion{ID: kernel.NewID(), AssetID: assetID, Status: model.AssetVersionStatusDraft, DefinitionJSON: definition, Prompt: strings.TrimSpace(req.Prompt), Note: strings.TrimSpace(req.Note), CreatedAt: now, UpdatedAt: now}
	asset.UpdatedAt = now
	if err := s.repo.CreateProjectAssetVersionAndBump(userID, projectID, asset, &version); err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return model.AssetVersion{}, kernel.BadAuthRequest("素材尚未加入当前项目")
		}
		return model.AssetVersion{}, mapProjectWriteError(err)
	}
	return version, nil
}

func (s *Service) ConfirmProjectAssetCandidate(userID string, projectID string, candidateID string, req ConfirmProjectAssetCandidateRequest) (AssetSummary, error) {
	if _, err := s.Active(userID, projectID); err != nil {
		return AssetSummary{}, err
	}
	candidate, err := s.repo.ProjectAssetCandidate(projectID, candidateID)
	if err != nil {
		return AssetSummary{}, err
	}
	if candidate.Status != "pending_confirmation" {
		return AssetSummary{}, kernel.BadAuthRequest("资产候选已处理")
	}
	now := time.Now()
	assetID := strings.TrimSpace(req.AssetID)
	if assetID != "" && candidate.Category == model.AssetCategoryCharacter {
		asset, assetErr := s.repo.ProjectCharacterAsset(userID, projectID, assetID)
		if assetErr != nil {
			return AssetSummary{}, assetErr
		}
		current, versionErr := s.repo.AssetVersion(asset.PrimaryVersionID)
		if versionErr != nil {
			return AssetSummary{}, versionErr
		}
		definition, mergeErr := mergeCharacterCandidateDefinition(current.DefinitionJSON, candidate.DetailsJSON, asset.Title, candidate.Name)
		if mergeErr != nil {
			return AssetSummary{}, mergeErr
		}
		expectedPrimary := asset.PrimaryVersionID
		nextAsset, nextVersion, representations, voice, prepareErr := s.prepareNextCharacterVersion(asset, asset.Title, definition, nil, nil, false)
		if prepareErr != nil {
			return AssetSummary{}, prepareErr
		}
		candidate.Status = "confirmed"
		candidate.ResolvedAssetID = asset.ID
		candidate.UpdatedAt = now
		if saveErr := s.repo.ConfirmProjectCharacterCandidateActive(userID, candidate, expectedPrimary, &nextAsset, &nextVersion, representations, voice); saveErr != nil {
			return AssetSummary{}, mapProjectWriteError(saveErr)
		}
		return s.assetSummary(userID, projectID, &nextAsset)
	}
	createAsset := assetID == ""
	var asset model.Asset
	var version model.AssetVersion
	if createAsset {
		assetID = kernel.NewID()
		versionID := kernel.NewID()
		kind := "text"
		var payload []byte
		var marshalErr error
		if candidate.Category == model.AssetCategoryCharacter {
			kind = "entity"
			var characterPayload string
			characterPayload, marshalErr = characterAssetPayload(assetID, versionID, candidate.Name, json.RawMessage(candidate.DetailsJSON), now, now)
			payload = []byte(characterPayload)
		} else {
			payload, marshalErr = json.Marshal(map[string]any{
				"id": assetID, "kind": kind, "category": candidate.Category, "status": model.AssetVersionStatusConfirmed,
				"primaryVersionId": versionID, "title": candidate.Name, "tags": []string{}, "data": map[string]string{"content": ""},
				"createdAt": now.Format(time.RFC3339Nano), "updatedAt": now.Format(time.RFC3339Nano),
			})
		}
		if marshalErr != nil {
			return AssetSummary{}, marshalErr
		}
		asset = model.Asset{ID: assetID, UserID: userID, Kind: kind, Category: candidate.Category, Status: model.AssetVersionStatusConfirmed, PrimaryVersionID: versionID, Title: candidate.Name, PayloadJSON: string(payload), CreatedAt: now, UpdatedAt: now}
		version = model.AssetVersion{ID: versionID, AssetID: assetID, Version: 1, Status: model.AssetVersionStatusConfirmed, DefinitionJSON: candidate.DetailsJSON, CreatedAt: now, UpdatedAt: now}
	} else {
		existing, assetErr := s.repo.AssetForUser(userID, assetID)
		if assetErr != nil {
			return AssetSummary{}, assetErr
		}
		asset = *existing
	}
	candidate.Status = "confirmed"
	candidate.ResolvedAssetID = assetID
	candidate.UpdatedAt = now
	folderID, folderErr := s.resolveAssetFolderID(projectID, nil)
	if folderErr != nil {
		return AssetSummary{}, folderErr
	}
	position, positionErr := s.repo.NextProjectAssetPosition(projectID, folderID)
	if positionErr != nil {
		return AssetSummary{}, positionErr
	}
	link := model.ProjectAssetLink{ID: kernel.NewID(), ProjectID: projectID, AssetID: assetID, FolderID: folderID, Position: position, CreatedAt: now}
	if err := s.repo.ConfirmProjectAssetCandidateActive(userID, candidate, &asset, &version, &link, createAsset); err != nil {
		return AssetSummary{}, mapProjectWriteError(err)
	}
	return s.assetSummary(userID, projectID, &asset)
}

func mergeCharacterCandidateDefinition(currentJSON string, candidateJSON string, currentName string, candidateName string) (string, error) {
	current := map[string]any{}
	candidate := map[string]any{}
	if err := json.Unmarshal([]byte(currentJSON), &current); err != nil {
		return "", err
	}
	if err := json.Unmarshal([]byte(candidateJSON), &candidate); err != nil {
		return "", kernel.BadAuthRequest("角色候选设定格式无效")
	}
	for key, value := range candidate {
		if key == "aliases" || !emptyCharacterDefinitionValue(current[key]) {
			continue
		}
		current[key] = value
	}
	aliases := make([]string, 0)
	seen := map[string]bool{}
	appendAlias := func(value string) {
		value = strings.TrimSpace(value)
		key := strings.ToLower(value)
		if value == "" || seen[key] || strings.EqualFold(value, strings.TrimSpace(currentName)) {
			return
		}
		seen[key] = true
		aliases = append(aliases, value)
	}
	for _, value := range []any{current["aliases"], candidate["aliases"]} {
		if list, ok := value.([]any); ok {
			for _, item := range list {
				if text, valid := item.(string); valid {
					appendAlias(text)
				}
			}
		}
	}
	appendAlias(candidateName)
	current["aliases"] = aliases
	encoded, err := json.Marshal(current)
	return string(encoded), err
}

func emptyCharacterDefinitionValue(value any) bool {
	switch typed := value.(type) {
	case nil:
		return true
	case string:
		return strings.TrimSpace(typed) == ""
	case []any:
		return len(typed) == 0
	default:
		return false
	}
}

func containsString(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

func validAssetCategory(category model.AssetCategory) bool {
	switch category {
	case model.AssetCategoryCharacter, model.AssetCategoryEnvironment, model.AssetCategoryProp, model.AssetCategoryMaterial, model.AssetCategoryOther:
		return true
	default:
		return false
	}
}

func (s *Service) assetSummary(userID string, projectID string, asset *model.Asset) (AssetSummary, error) {
	versions, err := s.repo.AssetVersions(asset.ID)
	if err != nil {
		return AssetSummary{}, err
	}
	usages, err := s.repo.ProjectAssetUsageRoles(projectID, asset.ID)
	if err != nil {
		return AssetSummary{}, err
	}
	link, err := s.repo.ProjectAssetLink(projectID, asset.ID)
	if err != nil {
		return AssetSummary{}, err
	}
	storageKey, previewText, source, durationMs := projectAssetPreview(asset.PayloadJSON)
	summary := AssetSummary{ID: asset.ID, Title: asset.Title, MediaType: asset.Kind, Category: asset.Category, Status: asset.Status, PrimaryVersionID: asset.PrimaryVersionID, VersionCount: len(versions), Usages: usages, FolderID: link.FolderID, Position: link.Position, StorageKey: storageKey, PreviewText: previewText, DurationMs: durationMs, UpdatedAt: asset.UpdatedAt, Source: source}
	if asset.Category == model.AssetCategoryCharacter && asset.PrimaryVersionID != "" {
		card, cardErr := s.characterCard(userID, asset)
		if cardErr != nil {
			return AssetSummary{}, cardErr
		}
		summary.Character = &card
	}
	return summary, nil
}

func projectAssetPreview(payloadJSON string) (string, string, string, int64) {
	var payload struct {
		Data struct {
			StorageKey string `json:"storageKey"`
			Content    string `json:"content"`
			Source     string `json:"source"`
			DurationMs int64  `json:"durationMs"`
		} `json:"data"`
	}
	if json.Unmarshal([]byte(payloadJSON), &payload) != nil {
		return "", "", "", 0
	}
	previewRunes := []rune(strings.TrimSpace(payload.Data.Content))
	if len(previewRunes) > 240 {
		previewRunes = append(previewRunes[:240], '…')
	}
	return strings.TrimSpace(payload.Data.StorageKey), string(previewRunes), strings.TrimSpace(payload.Data.Source), payload.Data.DurationMs
}
