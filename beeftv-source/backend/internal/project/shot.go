package project

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/operations"

	"gorm.io/gorm"
)

const AssetCandidateSourceChapterCharacter = "chapter_character_extract"

func (s *Service) CreateProjectShot(userID string, projectID string, req CreateProjectShotRequest) (model.Shot, error) {
	if _, err := s.Active(userID, projectID); err != nil {
		return model.Shot{}, err
	}
	unitID := strings.TrimSpace(req.UnitID)
	if unitID != "" {
		if _, err := s.repo.ProjectUnit(projectID, unitID); err != nil {
			return model.Shot{}, err
		}
	}
	title := strings.TrimSpace(req.Title)
	if title == "" {
		return model.Shot{}, kernel.BadAuthRequest("镜头标题不能为空")
	}
	if req.Position < 0 || req.DurationMs < 0 {
		return model.Shot{}, kernel.BadAuthRequest("镜头顺序和时长不能为负数")
	}
	now := time.Now()
	shotID := strings.TrimSpace(req.ID)
	create := shotID == ""
	status := strings.TrimSpace(req.Status)
	expectedRevisionID := ""
	if create {
		shotID = kernel.NewID()
		if status == "" {
			status = "draft"
		}
	} else {
		existing, err := s.repo.ShotForProject(projectID, shotID)
		if err != nil {
			return model.Shot{}, err
		}
		if unitID == "" {
			unitID = existing.UnitID
		}
		if status == "" {
			status = existing.Status
		}
		now = existing.CreatedAt
		expectedRevisionID = existing.CurrentRevisionID
	}
	if !validShotStatus(status) {
		return model.Shot{}, kernel.BadAuthRequest("不支持的镜头状态")
	}
	updatedAt := time.Now()
	description := strings.TrimSpace(req.Description)
	revision, err := newShotRevision(userID, shotID, req.Revision, description, req.DurationMs, updatedAt)
	if err != nil {
		return model.Shot{}, err
	}
	shot := model.Shot{ID: shotID, ProjectID: projectID, UnitID: unitID, CurrentRevisionID: revision.ID, Title: title, Description: revision.PlotDescription, Position: req.Position, DurationMs: revision.DurationMs, Status: status, CreatedAt: now, UpdatedAt: updatedAt}
	if err := s.repo.SaveShotWithRevisionActive(userID, &shot, &revision, create, expectedRevisionID); err != nil {
		return model.Shot{}, mapProjectWriteError(err)
	}
	return shot, nil
}

func (s *Service) ReplaceProjectUnitShots(userID string, projectID string, unitID string, req ReplaceProjectUnitShotsRequest) ([]model.Shot, error) {
	if _, err := s.Active(userID, projectID); err != nil {
		return nil, err
	}
	unitID = strings.TrimSpace(unitID)
	if _, err := s.repo.ProjectUnit(projectID, unitID); err != nil {
		return nil, err
	}
	if len(req.Shots) == 0 || len(req.Shots) > 200 {
		return nil, kernel.BadAuthRequest("章节分镜数量必须在 1 到 200 之间")
	}
	currentShots, err := s.repo.ProjectUnitShots(projectID, unitID)
	if err != nil {
		return nil, err
	}
	expectedIDs := req.ExpectedShotIDs
	if expectedIDs == nil {
		expectedIDs = make([]string, 0, len(currentShots))
		for _, shot := range currentShots {
			expectedIDs = append(expectedIDs, shot.ID)
		}
	}
	expectedPointers := make(map[string]string, len(currentShots))
	for _, shot := range currentShots {
		expectedPointers[shot.ID] = shot.CurrentRevisionID
	}
	if req.ExpectedRevision <= 0 {
		return nil, kernel.BadAuthRequest("请刷新后再保存分镜")
	}
	now := time.Now()
	shots := make([]model.Shot, 0, len(req.Shots))
	revisions := make([]model.ShotRevision, 0, len(req.Shots))
	references := make([]model.ShotAssetReference, 0)
	for position, input := range req.Shots {
		title := strings.TrimSpace(input.Title)
		description := strings.TrimSpace(input.Description)
		if title == "" || description == "" || input.DurationMs < 0 {
			return nil, kernel.BadAuthRequest("分镜标题、描述或时长无效")
		}
		shotID := kernel.NewID()
		revision, err := newShotRevision(userID, shotID, input.Revision, description, input.DurationMs, now)
		if err != nil {
			return nil, err
		}
		revision.Version = 1
		shots = append(shots, model.Shot{ID: shotID, ProjectID: projectID, UnitID: unitID, CurrentRevisionID: revision.ID, Title: title, Description: revision.PlotDescription, Position: position, DurationMs: revision.DurationMs, Status: "draft", CreatedAt: now, UpdatedAt: now})
		revisions = append(revisions, revision)
		seenVersions := make(map[string]bool, len(input.AssetVersionIDs))
		for _, rawVersionID := range input.AssetVersionIDs {
			versionID := strings.TrimSpace(rawVersionID)
			if versionID == "" || seenVersions[versionID] {
				continue
			}
			if len(seenVersions) >= 6 {
				return nil, kernel.BadAuthRequest("单个分镜最多引用 6 个资产版本")
			}
			if _, err := s.repo.AssetVersionForProject(projectID, versionID); err != nil {
				return nil, err
			}
			seenVersions[versionID] = true
			references = append(references, model.ShotAssetReference{ID: kernel.NewID(), ShotID: shotID, AssetVersionID: versionID, Role: "reference", Status: "linked", CreatedAt: now})
		}
	}
	source, err := s.resolveChapterApplySource(userID, projectID, unitID, req.SourceTaskID, chapterApplyStoryboard, storyboardApplyPayloadFromRequest(unitID, req.Shots))
	if err != nil {
		return nil, err
	}
	if source.TaskID == "" {
		if err := s.repo.ReplaceProjectUnitShotsActive(userID, projectID, unitID, shots, revisions, references, expectedIDs, expectedPointers, req.ExpectedRevision); err != nil {
			return nil, mapChapterApplyWriteError(err)
		}
		return shots, nil
	}
	receiptJSON, err := marshalChapterApplyReceipt(chapterApplyReceipt{
		TaskID: source.TaskID, ProjectID: projectID, UnitID: unitID, Kind: chapterApplyKindStoryboard, Shots: shots,
	})
	if err != nil {
		return nil, err
	}
	outcome, err := operations.NewStore(s.repo.DB()).Run(context.Background(), source.runRequest(userID), func(tx *gorm.DB) ([]byte, error) {
		if runErr := s.repo.ReplaceProjectUnitShotsTx(tx, userID, projectID, unitID, shots, revisions, references, expectedIDs, expectedPointers, req.ExpectedRevision); runErr != nil {
			return nil, runErr
		}
		return receiptJSON, nil
	})
	if err != nil {
		return nil, mapChapterApplyWriteError(err)
	}
	if outcome.Replayed {
		stored, replayErr := unmarshalChapterApplyReceipt(outcome.Result)
		if replayErr != nil {
			return nil, replayErr
		}
		return stored.Shots, nil
	}
	return shots, nil
}

func (s *Service) CreateShotRevision(userID string, projectID string, shotID string, input ShotRevisionInput) (model.Shot, model.ShotRevision, error) {
	if _, err := s.Active(userID, projectID); err != nil {
		return model.Shot{}, model.ShotRevision{}, err
	}
	shot, err := s.repo.ShotForProject(projectID, strings.TrimSpace(shotID))
	if err != nil {
		return model.Shot{}, model.ShotRevision{}, err
	}
	now := time.Now()
	revision, err := newShotRevision(userID, shot.ID, input, shot.Description, shot.DurationMs, now)
	if err != nil {
		return model.Shot{}, model.ShotRevision{}, err
	}
	expectedRevisionID := shot.CurrentRevisionID
	shot.Description = revision.PlotDescription
	shot.DurationMs = revision.DurationMs
	shot.Status = "draft"
	shot.UpdatedAt = now
	if err := s.repo.SaveShotWithRevisionActive(userID, shot, &revision, false, expectedRevisionID); err != nil {
		return model.Shot{}, model.ShotRevision{}, mapProjectWriteError(err)
	}
	return *shot, revision, nil
}

func (s *Service) DeleteProjectShot(userID string, projectID string, shotID string) error {
	if _, err := s.Active(userID, projectID); err != nil {
		return err
	}
	shotID = strings.TrimSpace(shotID)
	if shotID == "" {
		return kernel.BadAuthRequest("镜头不能为空")
	}
	if _, err := s.repo.ShotForProject(projectID, shotID); err != nil {
		return err
	}
	return mapProjectWriteError(s.repo.DeleteProjectShotActive(userID, projectID, shotID, time.Now()))
}

func newShotRevision(userID string, shotID string, input ShotRevisionInput, fallbackDescription string, fallbackDuration int64, now time.Time) (model.ShotRevision, error) {
	plotDescription := strings.TrimSpace(input.PlotDescription)
	if plotDescription == "" {
		plotDescription = strings.TrimSpace(fallbackDescription)
	}
	if plotDescription == "" {
		return model.ShotRevision{}, kernel.BadAuthRequest("镜头画面描述不能为空")
	}
	durationMs := input.DurationMs
	if durationMs == 0 {
		durationMs = fallbackDuration
	}
	if durationMs < 0 {
		return model.ShotRevision{}, kernel.BadAuthRequest("镜头时长不能为负数")
	}
	actionBeatsJSON := "[]"
	if input.ActionBeats != nil {
		encoded, err := json.Marshal(input.ActionBeats)
		if err != nil {
			return model.ShotRevision{}, kernel.BadAuthRequest("动作节拍格式无效")
		}
		actionBeatsJSON = string(encoded)
	}
	return model.ShotRevision{
		ID: kernel.NewID(), ShotID: shotID, PlotDescription: plotDescription, Action: strings.TrimSpace(input.Action), Dialogue: strings.TrimSpace(input.Dialogue),
		ShotSize: strings.TrimSpace(input.ShotSize), CameraAngle: strings.TrimSpace(input.CameraAngle), CameraMovement: strings.TrimSpace(input.CameraMovement), DurationMs: durationMs,
		ImagePrompt: strings.TrimSpace(input.ImagePrompt), VideoPrompt: strings.TrimSpace(input.VideoPrompt), NegativePrompt: strings.TrimSpace(input.NegativePrompt),
		ContinuityNotes: strings.TrimSpace(input.ContinuityNotes), ActionBeatsJSON: actionBeatsJSON, CreatedBy: userID, CreatedAt: now,
	}, nil
}

func validShotStatus(status string) bool {
	switch status {
	case "draft", "ready", "running", "review", "completed", "failed":
		return true
	default:
		return false
	}
}

func (s *Service) LinkShotAsset(userID string, projectID string, shotID string, req LinkShotAssetRequest) (model.ShotAssetReference, error) {
	if _, err := s.Active(userID, projectID); err != nil {
		return model.ShotAssetReference{}, err
	}
	if _, err := s.repo.ShotForProject(projectID, shotID); err != nil {
		return model.ShotAssetReference{}, err
	}
	versionID := strings.TrimSpace(req.AssetVersionID)
	if _, err := s.repo.AssetVersionForProject(projectID, versionID); err != nil {
		return model.ShotAssetReference{}, err
	}
	role := strings.TrimSpace(req.Role)
	if !validShotAssetRole(role) {
		return model.ShotAssetReference{}, kernel.BadAuthRequest("不支持的镜头素材用途")
	}
	now := time.Now()
	reference := model.ShotAssetReference{ID: kernel.NewID(), ShotID: shotID, AssetVersionID: versionID, Role: role, Status: "linked", CreatedAt: now}
	if err := s.repo.UpsertShotAssetReferenceActive(userID, projectID, &reference, now); err != nil {
		return model.ShotAssetReference{}, mapProjectWriteError(err)
	}
	return reference, nil
}

func (s *Service) UnlinkShotAsset(userID string, projectID string, shotID string, referenceID string) error {
	if _, err := s.Active(userID, projectID); err != nil {
		return err
	}
	if _, err := s.repo.ShotForProject(projectID, shotID); err != nil {
		return err
	}
	referenceID = strings.TrimSpace(referenceID)
	if referenceID == "" {
		return kernel.BadAuthRequest("镜头资产引用不能为空")
	}
	deleted, err := s.repo.DeleteShotAssetReferenceActive(userID, projectID, shotID, referenceID, time.Now())
	if err != nil {
		return mapProjectWriteError(err)
	}
	if !deleted {
		return kernel.NotFound("镜头资产引用不存在")
	}
	return nil
}

func (s *Service) CreateProjectAssetCandidates(userID string, projectID string, req CreateAssetCandidatesRequest) ([]model.ProjectAssetCandidate, error) {
	if _, err := s.Active(userID, projectID); err != nil {
		return nil, err
	}
	sourceTaskID := strings.TrimSpace(req.SourceTaskID)
	if len(req.Candidates) > 100 || (len(req.Candidates) == 0 && sourceTaskID == "") {
		return nil, kernel.BadAuthRequest("资产候选数量必须在 1 到 100 之间")
	}
	source := strings.TrimSpace(req.Source)
	existingCandidates, err := s.repo.ProjectAssetCandidates(projectID)
	if err != nil {
		return nil, err
	}
	projectAssets, err := s.repo.ProjectAssets(userID, projectID)
	if err != nil {
		return nil, err
	}
	knownKeys := projectAssetCandidateIdentityKeys(existingCandidates, projectAssets)
	now := time.Now()
	pending := make([]model.ProjectAssetCandidate, 0, len(req.Candidates))
	for _, input := range req.Candidates {
		name := strings.TrimSpace(input.Name)
		nameKey := model.AssetCandidateNameKey(name)
		category := model.AssetCategory(strings.TrimSpace(input.Category))
		if name == "" || nameKey == "" || !validAssetCategory(category) {
			return nil, kernel.BadAuthRequest("资产候选名称或分类无效")
		}
		if category == model.AssetCategoryCharacter && source != AssetCandidateSourceChapterCharacter {
			return nil, kernel.BadAuthRequest("角色候选只能从剧情章节的角色提取流程创建")
		}
		if category == model.AssetCategoryCharacter && strings.TrimSpace(input.UnitID) == "" {
			return nil, kernel.BadAuthRequest("角色候选必须关联剧情章节")
		}
		if input.UnitID != "" {
			if _, err := s.repo.ProjectUnit(projectID, input.UnitID); err != nil {
				return nil, err
			}
		}
		if input.ShotID != "" {
			if _, err := s.repo.ShotForProject(projectID, input.ShotID); err != nil {
				return nil, err
			}
		}
		detailsJSON, err := marshalProjectDetails(input.Details)
		if err != nil {
			return nil, kernel.BadAuthRequest("资产候选详情格式无效")
		}
		if category == model.AssetCategoryCharacter {
			if err := validateCharacterCandidateDetails(input.Details); err != nil {
				return nil, err
			}
		}
		identityKeys := assetCandidateInputIdentityKeys(name, input.Details)
		if assetCandidateIdentityExists(knownKeys, category, identityKeys) {
			continue
		}
		pending = append(pending, model.ProjectAssetCandidate{ID: kernel.NewID(), ProjectID: projectID, UnitID: strings.TrimSpace(input.UnitID), ShotID: strings.TrimSpace(input.ShotID), Name: name, NameKey: nameKey, Category: category, Status: "pending_confirmation", Source: source, DetailsJSON: detailsJSON, CreatedAt: now, UpdatedAt: now})
		addAssetCandidateIdentityKeys(knownKeys, category, identityKeys)
	}
	applyUnitID := characterApplyUnitID(req)
	applySource, err := s.resolveChapterApplySource(userID, projectID, applyUnitID, sourceTaskID, chapterApplyCharacters, characterApplyPayloadFromRequest(req))
	if err != nil {
		return nil, err
	}
	if applySource.TaskID != "" {
		for _, input := range req.Candidates {
			if unitID := strings.TrimSpace(input.UnitID); unitID != "" && unitID != applySource.UnitID {
				return nil, kernel.Forbidden("不能把其他章节的生成结果写入本章")
			}
		}
	}
	if applySource.TaskID == "" {
		inserted, err := s.repo.CreateProjectAssetCandidatesAndBump(userID, projectID, pending)
		if err != nil {
			return nil, mapChapterApplyWriteError(err)
		}
		return inserted, nil
	}
	var inserted []model.ProjectAssetCandidate
	outcome, err := operations.NewStore(s.repo.DB()).Run(context.Background(), applySource.runRequest(userID), func(tx *gorm.DB) ([]byte, error) {
		created, runErr := s.repo.CreateProjectAssetCandidatesAndBumpTx(tx, userID, projectID, pending)
		if runErr != nil {
			return nil, runErr
		}
		inserted = created
		return marshalChapterApplyReceipt(chapterApplyReceipt{
			TaskID: applySource.TaskID, ProjectID: projectID, UnitID: applySource.UnitID, Kind: chapterApplyKindCharacters, Candidates: created,
		})
	})
	if err != nil {
		return nil, mapChapterApplyWriteError(err)
	}
	if outcome.Replayed {
		stored, replayErr := unmarshalChapterApplyReceipt(outcome.Result)
		if replayErr != nil {
			return nil, replayErr
		}
		return stored.Candidates, nil
	}
	return inserted, nil
}

func characterApplyUnitID(req CreateAssetCandidatesRequest) string {
	for _, candidate := range req.Candidates {
		if unitID := strings.TrimSpace(candidate.UnitID); unitID != "" {
			return unitID
		}
	}
	return ""
}

func projectAssetCandidateIdentityKeys(candidates []model.ProjectAssetCandidate, assets []model.Asset) map[string]struct{} {
	known := make(map[string]struct{}, len(candidates)+len(assets))
	for _, candidate := range candidates {
		keys := []string{candidate.NameKey}
		if strings.TrimSpace(candidate.DetailsJSON) != "" {
			var details map[string]any
			if json.Unmarshal([]byte(candidate.DetailsJSON), &details) == nil {
				keys = append(keys, assetCandidateAliases(details)...)
			}
		}
		addAssetCandidateIdentityKeys(known, candidate.Category, keys)
	}
	for _, asset := range assets {
		keys := []string{model.AssetCandidateNameKey(asset.Title)}
		if asset.Category == model.AssetCategoryCharacter {
			keys = append(keys, characterAssetAliasKeys(asset.PayloadJSON)...)
		}
		addAssetCandidateIdentityKeys(known, asset.Category, keys)
	}
	return known
}

func assetCandidateInputIdentityKeys(name string, details map[string]any) []string {
	return append([]string{model.AssetCandidateNameKey(name)}, assetCandidateAliases(details)...)
}

func assetCandidateAliases(details map[string]any) []string {
	if details == nil {
		return nil
	}
	values, ok := details["aliases"].([]any)
	if !ok {
		if stringsValue, stringsOK := details["aliases"].([]string); stringsOK {
			values = make([]any, len(stringsValue))
			for index, value := range stringsValue {
				values[index] = value
			}
		}
	}
	keys := make([]string, 0, len(values))
	for _, value := range values {
		if key := model.AssetCandidateNameKey(fmt.Sprint(value)); key != "" {
			keys = append(keys, key)
		}
	}
	return keys
}

func characterAssetAliasKeys(payloadJSON string) []string {
	var payload struct {
		Data struct {
			Definition map[string]any `json:"definition"`
		} `json:"data"`
	}
	if json.Unmarshal([]byte(payloadJSON), &payload) != nil {
		return nil
	}
	return assetCandidateAliases(payload.Data.Definition)
}

func assetCandidateIdentityExists(known map[string]struct{}, category model.AssetCategory, keys []string) bool {
	for _, key := range keys {
		if _, exists := known[string(category)+":"+key]; exists {
			return true
		}
	}
	return false
}

func addAssetCandidateIdentityKeys(known map[string]struct{}, category model.AssetCategory, keys []string) {
	for _, key := range keys {
		if key != "" {
			known[string(category)+":"+key] = struct{}{}
		}
	}
}

func validShotAssetRole(role string) bool {
	switch role {
	case "reference", "start_frame", "end_frame", "keyframe", "storyboard", "output":
		return true
	default:
		return false
	}
}

func marshalProjectDetails(value map[string]any) (string, error) {
	if value == nil {
		return "{}", nil
	}
	encoded, err := json.Marshal(value)
	return string(encoded), err
}

func validateCharacterCandidateDetails(details map[string]any) error {
	text := func(key string) string {
		value, _ := details[key].(string)
		return strings.TrimSpace(value)
	}
	descriptiveCount := 0
	for _, key := range []string{"appearance", "clothing", "physique", "personality", "consistencyPrompt", "multiViewPrompt"} {
		if text(key) != "" {
			descriptiveCount++
		}
	}
	if text("role") == "" || descriptiveCount < 3 || text("voiceLanguage") == "" || text("voiceAge") == "" || text("voiceTimbre") == "" {
		return kernel.BadAuthRequest("角色候选必须包含剧情定位、稳定设定和声音画像")
	}
	return nil
}
