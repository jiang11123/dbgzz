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

var builtinVoiceNames = []string{"alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer", "verse", "marin", "cedar"}

func (s *Service) ListVoiceProfiles(userID string) ([]VoiceProfileSummary, error) {
	now := time.Now()
	profiles := make([]model.VoiceProfile, 0, len(builtinVoiceNames))
	for _, key := range builtinVoiceNames {
		profiles = append(profiles, model.VoiceProfile{
			ID: kernel.NewID(), UserID: userID, Name: strings.ToUpper(key[:1]) + key[1:], Provider: "openai_compatible", VoiceKey: key,
			Language: "多语言", CompatibleModelsJSON: "[]", Status: "active", CreatedAt: now, UpdatedAt: now,
		})
	}
	if err := s.repo.EnsureVoiceProfiles(profiles); err != nil {
		return nil, err
	}
	stored, err := s.repo.VoiceProfiles(userID)
	if err != nil {
		return nil, err
	}
	result := make([]VoiceProfileSummary, 0, len(stored))
	for _, profile := range stored {
		result = append(result, voiceProfileSummary(profile))
	}
	return result, nil
}

func (s *Service) CreateProjectCharacter(userID string, projectID string, req CreateProjectCharacterRequest) (CharacterDetail, error) {
	if _, err := s.Active(userID, projectID); err != nil {
		return CharacterDetail{}, err
	}
	name := strings.TrimSpace(req.Name)
	if name == "" {
		return CharacterDetail{}, kernel.BadAuthRequest("角色名称不能为空")
	}
	definition, err := normalizedCharacterDefinition(req.Definition)
	if err != nil {
		return CharacterDetail{}, err
	}
	now := time.Now()
	assetID := kernel.NewID()
	versionID := kernel.NewID()
	payload, err := characterAssetPayload(assetID, versionID, name, definition, now, now)
	if err != nil {
		return CharacterDetail{}, err
	}
	asset := model.Asset{ID: assetID, UserID: userID, Kind: "entity", Category: model.AssetCategoryCharacter, Status: model.AssetVersionStatusConfirmed, PrimaryVersionID: versionID, Title: name, PayloadJSON: payload, CreatedAt: now, UpdatedAt: now}
	version := model.AssetVersion{ID: versionID, AssetID: assetID, Version: 1, Status: model.AssetVersionStatusConfirmed, DefinitionJSON: string(definition), CreatedAt: now, UpdatedAt: now}
	folderID, err := s.resolveAssetFolderID(projectID, nil)
	if err != nil {
		return CharacterDetail{}, err
	}
	position, err := s.repo.NextProjectAssetPosition(projectID, folderID)
	if err != nil {
		return CharacterDetail{}, err
	}
	link := model.ProjectAssetLink{ID: kernel.NewID(), ProjectID: projectID, AssetID: assetID, FolderID: folderID, Position: position, CreatedAt: now}
	if err := s.repo.CreateProjectCharacterActive(userID, projectID, &asset, &version, &link); err != nil {
		return CharacterDetail{}, mapProjectWriteError(err)
	}
	return s.characterDetail(userID, projectID, &asset)
}

func (s *Service) ProjectCharacter(userID string, projectID string, assetID string) (CharacterDetail, error) {
	if _, err := s.Owned(userID, projectID); err != nil {
		return CharacterDetail{}, err
	}
	asset, err := s.repo.ProjectCharacterAsset(userID, projectID, strings.TrimSpace(assetID))
	if err != nil || asset == nil {
		if err != nil {
			return CharacterDetail{}, err
		}
		return CharacterDetail{}, kernel.BadAuthRequest("角色资产不可用")
	}
	return s.characterDetail(userID, projectID, asset)
}

func (s *Service) UpdateProjectCharacter(userID string, projectID string, assetID string, req UpdateProjectCharacterRequest) (CharacterDetail, error) {
	if _, err := s.Active(userID, projectID); err != nil {
		return CharacterDetail{}, err
	}
	asset, err := s.repo.ProjectCharacterAsset(userID, projectID, strings.TrimSpace(assetID))
	if err != nil {
		return CharacterDetail{}, err
	}
	name := strings.TrimSpace(req.Name)
	if name == "" {
		return CharacterDetail{}, kernel.BadAuthRequest("角色名称不能为空")
	}
	definition, err := normalizedCharacterDefinition(req.Definition)
	if err != nil {
		return CharacterDetail{}, err
	}
	if _, err := s.createNextCharacterVersion(userID, projectID, asset, name, string(definition), nil, nil, false); err != nil {
		return CharacterDetail{}, err
	}
	return s.ProjectCharacter(userID, projectID, asset.ID)
}

func (s *Service) ReplaceProjectCharacterRepresentations(userID string, projectID string, assetID string, req ReplaceCharacterRepresentationsRequest) (CharacterDetail, error) {
	if _, err := s.Active(userID, projectID); err != nil {
		return CharacterDetail{}, err
	}
	asset, err := s.repo.ProjectCharacterAsset(userID, projectID, strings.TrimSpace(assetID))
	if err != nil {
		return CharacterDetail{}, err
	}
	if len(req.Representations) == 0 || len(req.Representations) > 8 {
		return CharacterDetail{}, kernel.BadAuthRequest("角色形象数量必须在 1 到 8 之间")
	}
	roles := make(map[string]struct{}, len(req.Representations))
	representations := make([]model.AssetRepresentation, 0, len(req.Representations))
	operationID := kernel.NewID()
	for _, input := range req.Representations {
		role := strings.TrimSpace(input.Role)
		if !validCharacterRepresentationRole(role) {
			return CharacterDetail{}, kernel.BadAuthRequest("不支持的角色形象视角")
		}
		if _, exists := roles[role]; exists {
			return CharacterDetail{}, kernel.BadAuthRequest("同一角色形象视角不能重复")
		}
		roles[role] = struct{}{}
		resourceID := strings.TrimSpace(input.ResourceID)
		resource, resourceErr := s.repo.ResourceForUser(userID, resourceID)
		if resourceErr != nil || resource.Kind != "image" || resource.Status != model.ResourceStatusReady {
			return CharacterDetail{}, kernel.BadAuthRequest("角色形象资源不可用")
		}
		metadata, marshalErr := json.Marshal(input.Metadata)
		if marshalErr != nil {
			return CharacterDetail{}, kernel.BadAuthRequest("角色形象元数据格式无效")
		}
		representations = append(representations, model.AssetRepresentation{ID: kernel.NewID(), TaskID: operationID, ResourceID: resourceID, MediaType: "image", Role: role, MetadataJSON: string(metadata), CreatedAt: time.Now()})
	}
	if _, err := s.createNextCharacterVersion(userID, projectID, asset, asset.Title, "", representations, nil, false); err != nil {
		return CharacterDetail{}, err
	}
	return s.ProjectCharacter(userID, projectID, asset.ID)
}

func (s *Service) BindCharacterTurnaround(userID, projectID, assetID, taskID, resourceID, prompt string) error {
	if _, err := s.Active(userID, projectID); err != nil {
		return err
	}
	asset, err := s.repo.ProjectCharacterAsset(userID, projectID, assetID)
	if err != nil {
		return err
	}
	resource, err := s.repo.ResourceForUser(userID, resourceID)
	if err != nil || resource.Kind != "image" || resource.Status != model.ResourceStatusReady {
		return kernel.BadAuthRequest("三视图任务生成的图片资源不可用")
	}
	sheetMetadata, err := json.Marshal(map[string]any{"prompt": prompt, "source": "character_turnaround"})
	if err != nil {
		return fmt.Errorf("序列化三视图表现元数据失败：%w", err)
	}
	primaryMetadata, err := json.Marshal(map[string]any{"source": "turnaround_sheet"})
	if err != nil {
		return fmt.Errorf("序列化角色主表现元数据失败：%w", err)
	}
	now := time.Now()
	representations := []model.AssetRepresentation{
		{ID: kernel.NewID(), TaskID: taskID, ResourceID: resourceID, MediaType: "image", Role: "turnaround_sheet", MetadataJSON: string(sheetMetadata), CreatedAt: now},
		{ID: kernel.NewID(), TaskID: taskID, ResourceID: resourceID, MediaType: "image", Role: "primary", MetadataJSON: string(primaryMetadata), CreatedAt: now},
	}
	_, err = s.createNextCharacterVersion(userID, projectID, asset, asset.Title, "", representations, nil, false)
	return err
}

func (s *Service) CharacterTurnaroundBound(taskID string) (bool, error) {
	representations, err := s.repo.AssetRepresentationsForTask(taskID)
	if err != nil {
		return false, err
	}
	roles := make(map[string]bool, len(representations))
	for _, representation := range representations {
		roles[representation.Role] = true
	}
	if len(representations) > 0 && (!roles["turnaround_sheet"] || !roles["primary"]) {
		return false, fmt.Errorf("三视图任务 %s 的角色表现绑定不完整", taskID)
	}
	return roles["turnaround_sheet"] && roles["primary"], nil
}

func (s *Service) BindProjectCharacterVoice(userID string, projectID string, assetID string, req BindCharacterVoiceRequest) (CharacterDetail, error) {
	if _, err := s.Active(userID, projectID); err != nil {
		return CharacterDetail{}, err
	}
	asset, err := s.repo.ProjectCharacterAsset(userID, projectID, strings.TrimSpace(assetID))
	if err != nil || asset == nil {
		if err != nil {
			return CharacterDetail{}, err
		}
		return CharacterDetail{}, kernel.BadAuthRequest("角色资产不可用")
	}
	var profile *model.VoiceProfile
	sampleResourceID := strings.TrimSpace(req.SampleResourceID)
	if sampleResourceID != "" {
		resource, resourceErr := s.repo.ResourceForUser(userID, sampleResourceID)
		if resourceErr != nil || resource == nil || resource.Kind != "audio" || resource.Status != model.ResourceStatusReady || !SupportedVoiceSampleMimeType(resource.MimeType) {
			return CharacterDetail{}, kernel.BadAuthRequest("请选择已上传完成的支持格式音频：MP3、WAV、M4A/AAC、FLAC、OGG/Opus 或 WebM")
		}
		var profileErr error
		profile, profileErr = s.repo.VoiceProfileBySampleResource(userID, sampleResourceID)
		if profileErr != nil {
			if !errors.Is(profileErr, gorm.ErrRecordNotFound) {
				return CharacterDetail{}, profileErr
			}
			voiceName := strings.TrimSpace(req.VoiceName)
			if voiceName == "" {
				voiceName = "上传声音 · " + sampleResourceID[:min(8, len(sampleResourceID))]
			}
			profile = &model.VoiceProfile{ID: kernel.NewID(), UserID: userID, Name: voiceName, Provider: "user_upload", VoiceKey: "sample:" + sampleResourceID, Language: "按样本使用", Timbre: "用户上传样本", SampleResourceID: sampleResourceID, CompatibleModelsJSON: "[]", Status: "active", CreatedAt: time.Now(), UpdatedAt: time.Now()}
			if err := s.repo.CreateVoiceProfile(profile); err != nil {
				return CharacterDetail{}, err
			}
		}
	} else {
		profile, err = s.repo.VoiceProfileForUser(userID, strings.TrimSpace(req.VoiceProfileID))
		if err != nil || profile == nil || profile.Status != "active" {
			return CharacterDetail{}, kernel.BadAuthRequest("选择的声音素材不可用")
		}
	}
	if profile == nil || strings.TrimSpace(profile.ID) == "" {
		return CharacterDetail{}, kernel.BadAuthRequest("声音素材不可用，请重新选择")
	}
	binding := &model.CharacterVoiceBinding{ID: kernel.NewID(), VoiceProfileID: profile.ID, Instructions: strings.TrimSpace(req.Instructions), CreatedAt: time.Now(), UpdatedAt: time.Now()}
	if _, err := s.createNextCharacterVersion(userID, projectID, asset, asset.Title, "", nil, binding, false); err != nil {
		return CharacterDetail{}, err
	}
	return s.ProjectCharacter(userID, projectID, asset.ID)
}

func SupportedVoiceSampleMimeType(value string) bool {
	mime := strings.ToLower(strings.TrimSpace(strings.SplitN(value, ";", 2)[0]))
	switch mime {
	case "audio/mpeg", "audio/mp3", "audio/x-mpeg",
		"audio/wav", "audio/x-wav", "audio/wave", "audio/vnd.wave", "audio/x-pn-wav",
		"audio/mp4", "audio/x-m4a", "audio/m4a", "audio/aac", "audio/aacp",
		"audio/flac", "audio/x-flac",
		"audio/ogg", "application/ogg", "audio/opus", "audio/webm":
		return true
	default:
		return false
	}
}

func (s *Service) UnbindProjectCharacterVoice(userID string, projectID string, assetID string) (CharacterDetail, error) {
	if _, err := s.Active(userID, projectID); err != nil {
		return CharacterDetail{}, err
	}
	asset, err := s.repo.ProjectCharacterAsset(userID, projectID, strings.TrimSpace(assetID))
	if err != nil || asset == nil {
		if err != nil {
			return CharacterDetail{}, err
		}
		return CharacterDetail{}, kernel.BadAuthRequest("角色资产不可用")
	}
	if _, err := s.createNextCharacterVersion(userID, projectID, asset, asset.Title, "", nil, nil, true); err != nil {
		return CharacterDetail{}, err
	}
	return s.ProjectCharacter(userID, projectID, asset.ID)
}

func (s *Service) createNextCharacterVersion(userID, projectID string, asset *model.Asset, name string, definitionJSON string, replacementRepresentations []model.AssetRepresentation, replacementVoice *model.CharacterVoiceBinding, dropVoice bool) (model.AssetVersion, error) {
	expectedPrimary := ""
	if asset != nil {
		expectedPrimary = asset.PrimaryVersionID
	}
	nextAsset, next, representations, voice, err := s.prepareNextCharacterVersion(asset, name, definitionJSON, replacementRepresentations, replacementVoice, dropVoice)
	if err != nil {
		return model.AssetVersion{}, err
	}
	if err := s.repo.SaveCharacterVersionActive(userID, projectID, expectedPrimary, &nextAsset, &next, representations, voice); err != nil {
		return model.AssetVersion{}, mapProjectWriteError(err)
	}
	*asset = nextAsset
	return next, nil
}

func (s *Service) prepareNextCharacterVersion(asset *model.Asset, name string, definitionJSON string, replacementRepresentations []model.AssetRepresentation, replacementVoice *model.CharacterVoiceBinding, dropVoice bool) (model.Asset, model.AssetVersion, []model.AssetRepresentation, *model.CharacterVoiceBinding, error) {
	if asset == nil {
		return model.Asset{}, model.AssetVersion{}, nil, nil, kernel.BadAuthRequest("角色资产不可用")
	}
	current, err := s.repo.AssetVersion(asset.PrimaryVersionID)
	if err != nil || current == nil {
		if err != nil {
			return model.Asset{}, model.AssetVersion{}, nil, nil, err
		}
		return model.Asset{}, model.AssetVersion{}, nil, nil, kernel.BadAuthRequest("角色当前版本不可用")
	}
	versions, err := s.repo.AssetVersions(asset.ID)
	if err != nil {
		return model.Asset{}, model.AssetVersion{}, nil, nil, err
	}
	nextNumber := 1
	if len(versions) > 0 {
		nextNumber = versions[0].Version + 1
	}
	if strings.TrimSpace(definitionJSON) == "" {
		definitionJSON = current.DefinitionJSON
	}
	now := time.Now()
	next := model.AssetVersion{ID: kernel.NewID(), AssetID: asset.ID, Version: nextNumber, Status: model.AssetVersionStatusConfirmed, DefinitionJSON: definitionJSON, Prompt: current.Prompt, Note: current.Note, CreatedAt: now, UpdatedAt: now}
	representations := replacementRepresentations
	if representations == nil {
		currentRepresentations, representationErr := s.repo.AssetRepresentations(current.ID)
		if representationErr != nil {
			return model.Asset{}, model.AssetVersion{}, nil, nil, representationErr
		}
		operationID := kernel.NewID()
		representations = make([]model.AssetRepresentation, 0, len(currentRepresentations))
		for _, representation := range currentRepresentations {
			representations = append(representations, model.AssetRepresentation{ID: kernel.NewID(), TaskID: operationID, AssetVersionID: next.ID, ResourceID: representation.ResourceID, MediaType: representation.MediaType, Role: representation.Role, MetadataJSON: representation.MetadataJSON, CreatedAt: now})
		}
	} else {
		for index := range representations {
			representations[index].AssetVersionID = next.ID
		}
	}
	voice := replacementVoice
	if voice == nil && !dropVoice {
		currentVoice, voiceErr := s.repo.CharacterVoiceBinding(current.ID)
		if voiceErr == nil && currentVoice != nil {
			voice = &model.CharacterVoiceBinding{ID: kernel.NewID(), AssetVersionID: next.ID, VoiceProfileID: currentVoice.VoiceProfileID, Instructions: currentVoice.Instructions, CreatedAt: now, UpdatedAt: now}
		} else if voiceErr == nil {
			return model.Asset{}, model.AssetVersion{}, nil, nil, kernel.BadAuthRequest("角色声音绑定数据不完整")
		} else if !errors.Is(voiceErr, gorm.ErrRecordNotFound) {
			return model.Asset{}, model.AssetVersion{}, nil, nil, voiceErr
		}
	}
	if voice != nil {
		voice.ID = kernel.NewID()
		voice.AssetVersionID = next.ID
		voice.CreatedAt = now
		voice.UpdatedAt = now
	}
	payload, err := characterAssetPayload(asset.ID, next.ID, name, json.RawMessage(definitionJSON), asset.CreatedAt, now)
	if err != nil {
		return model.Asset{}, model.AssetVersion{}, nil, nil, err
	}
	nextAsset := *asset
	nextAsset.Title = name
	nextAsset.Kind = "entity"
	nextAsset.Category = model.AssetCategoryCharacter
	nextAsset.Status = model.AssetVersionStatusConfirmed
	nextAsset.PrimaryVersionID = next.ID
	nextAsset.PayloadJSON = payload
	nextAsset.UpdatedAt = now
	return nextAsset, next, representations, voice, nil
}

func (s *Service) characterDetail(userID string, projectID string, asset *model.Asset) (CharacterDetail, error) {
	summary, err := s.assetSummary(userID, projectID, asset)
	if err != nil {
		return CharacterDetail{}, err
	}
	if summary.Character == nil {
		return CharacterDetail{}, kernel.BadAuthRequest("角色素材缺少角色设定")
	}
	return CharacterDetail{Asset: summary, Character: *summary.Character}, nil
}

func (s *Service) characterCard(userID string, asset *model.Asset) (CharacterCardSummary, error) {
	version, err := s.repo.AssetVersion(asset.PrimaryVersionID)
	if err != nil {
		return CharacterCardSummary{}, err
	}
	definition := map[string]any{}
	if err := json.Unmarshal([]byte(version.DefinitionJSON), &definition); err != nil {
		return CharacterCardSummary{}, err
	}
	stored, err := s.repo.AssetRepresentations(version.ID)
	if err != nil {
		return CharacterCardSummary{}, err
	}
	representations := make([]CharacterRepresentationSummary, 0, len(stored))
	roles := make(map[string]bool, len(stored))
	for _, representation := range stored {
		representations = append(representations, CharacterRepresentationSummary{ID: representation.ID, ResourceID: representation.ResourceID, MediaType: representation.MediaType, Role: representation.Role})
		roles[representation.Role] = true
	}
	visualStatus := "missing"
	if roles["turnaround_sheet"] || (roles["front"] && roles["side"] && roles["back"]) {
		visualStatus = "ready"
	} else if len(representations) > 0 {
		visualStatus = "partial"
	}
	var voice *CharacterVoiceSummary
	voiceStatus := "missing"
	binding, bindingErr := s.repo.CharacterVoiceBinding(version.ID)
	if bindingErr == nil && binding != nil {
		profile, profileErr := s.repo.VoiceProfileForUser(userID, binding.VoiceProfileID)
		if profileErr == nil && profile != nil && profile.Status == "active" {
			voice = &CharacterVoiceSummary{Profile: voiceProfileSummary(*profile), Instructions: binding.Instructions}
			voiceStatus = "ready"
		} else {
			voiceStatus = "unavailable"
		}
	} else if !errors.Is(bindingErr, gorm.ErrRecordNotFound) {
		return CharacterCardSummary{}, bindingErr
	}
	return CharacterCardSummary{VersionID: version.ID, Version: version.Version, Definition: definition, Representations: representations, Voice: voice, VisualStatus: visualStatus, VoiceStatus: voiceStatus}, nil
}

func normalizedCharacterDefinition(value map[string]any) (json.RawMessage, error) {
	if value == nil {
		value = map[string]any{}
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil, kernel.BadAuthRequest("角色设定格式无效")
	}
	return encoded, nil
}

func characterAssetPayload(assetID string, versionID string, name string, definition json.RawMessage, createdAt time.Time, updatedAt time.Time) (string, error) {
	var value map[string]any
	if err := json.Unmarshal(definition, &value); err != nil {
		return "", err
	}
	payload, err := json.Marshal(map[string]any{
		"id": assetID, "kind": "entity", "category": model.AssetCategoryCharacter, "status": model.AssetVersionStatusConfirmed,
		"primaryVersionId": versionID, "title": name, "coverUrl": "", "tags": []string{}, "data": map[string]any{"definition": value},
		"createdAt": createdAt.Format(time.RFC3339Nano), "updatedAt": updatedAt.Format(time.RFC3339Nano),
	})
	return string(payload), err
}

func voiceProfileSummary(profile model.VoiceProfile) VoiceProfileSummary {
	compatible := []string{}
	_ = json.Unmarshal([]byte(profile.CompatibleModelsJSON), &compatible)
	return VoiceProfileSummary{ID: profile.ID, Name: profile.Name, Provider: profile.Provider, VoiceKey: profile.VoiceKey, Language: profile.Language, Timbre: profile.Timbre, SampleResourceID: profile.SampleResourceID, CompatibleModels: compatible, Status: profile.Status}
}

func validCharacterRepresentationRole(role string) bool {
	switch role {
	case "primary", "front", "side", "back", "turnaround_sheet", "expression_sheet":
		return true
	default:
		return false
	}
}
