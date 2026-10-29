package app

import (
	"encoding/json"
	"errors"
	"log"
	"strings"

	"infinite-canvas/backend/internal/model"
	localproject "infinite-canvas/backend/internal/project"
)

type CreateProjectCharacterRequest = localproject.CreateProjectCharacterRequest
type UpdateProjectCharacterRequest = localproject.UpdateProjectCharacterRequest
type CharacterRepresentationInput = localproject.CharacterRepresentationInput
type ReplaceCharacterRepresentationsRequest = localproject.ReplaceCharacterRepresentationsRequest
type BindCharacterVoiceRequest = localproject.BindCharacterVoiceRequest
type CharacterRepresentationSummary = localproject.CharacterRepresentationSummary
type VoiceProfileSummary = localproject.VoiceProfileSummary
type CharacterVoiceSummary = localproject.CharacterVoiceSummary
type CharacterCardSummary = localproject.CharacterCardSummary
type ProjectCharacterDetail = localproject.CharacterDetail

type characterTurnaroundTaskInput struct {
	Metadata struct {
		Operation        string `json:"operation"`
		CharacterAssetID string `json:"characterAssetId"`
	} `json:"metadata"`
}

type characterTurnaroundTaskResult struct {
	Images []struct {
		ResourceID string `json:"resourceId"`
	} `json:"images"`
}

func (s *Service) ListVoiceProfiles(userID string) ([]VoiceProfileSummary, error) {
	return s.projectDomain().ListVoiceProfiles(userID)
}

func (s *Service) CreateProjectCharacter(userID string, projectID string, req CreateProjectCharacterRequest) (ProjectCharacterDetail, error) {
	return s.projectDomain().CreateProjectCharacter(userID, projectID, req)
}

func (s *Service) ProjectCharacter(userID string, projectID string, assetID string) (ProjectCharacterDetail, error) {
	return s.projectDomain().ProjectCharacter(userID, projectID, assetID)
}

func (s *Service) UpdateProjectCharacter(userID string, projectID string, assetID string, req UpdateProjectCharacterRequest) (ProjectCharacterDetail, error) {
	return s.projectDomain().UpdateProjectCharacter(userID, projectID, assetID, req)
}

func (s *Service) ReplaceProjectCharacterRepresentations(userID string, projectID string, assetID string, req ReplaceCharacterRepresentationsRequest) (ProjectCharacterDetail, error) {
	return s.projectDomain().ReplaceProjectCharacterRepresentations(userID, projectID, assetID, req)
}

func (s *Service) BindProjectCharacterVoice(userID string, projectID string, assetID string, req BindCharacterVoiceRequest) (ProjectCharacterDetail, error) {
	return s.projectDomain().BindProjectCharacterVoice(userID, projectID, assetID, req)
}

func (s *Service) UnbindProjectCharacterVoice(userID string, projectID string, assetID string) (ProjectCharacterDetail, error) {
	return s.projectDomain().UnbindProjectCharacterVoice(userID, projectID, assetID)
}

// 三视图生成是强校验写路径：任务只有在资源已绑定到新角色版本后才能对外显示成功。
func (s *Service) finalizeCharacterTurnaroundTask(task model.Task, result map[string]interface{}) (bool, error) {
	if !strings.Contains(task.InputJSON, "character_turnaround") {
		return false, nil
	}
	decrypted, err := s.decryptTaskInputJSON(task.InputJSON)
	if err != nil {
		return false, err
	}
	var input characterTurnaroundTaskInput
	if err := json.Unmarshal([]byte(decrypted), &input); err != nil {
		return false, err
	}
	if input.Metadata.Operation != "character_turnaround" {
		return false, nil
	}
	projectID := strings.TrimSpace(task.ProjectID)
	assetID := strings.TrimSpace(input.Metadata.CharacterAssetID)
	if projectID == "" || assetID == "" {
		return false, errors.New("三视图任务缺少项目或角色标识")
	}
	encodedResult, err := json.Marshal(result)
	if err != nil {
		return false, err
	}
	var output characterTurnaroundTaskResult
	if err := json.Unmarshal(encodedResult, &output); err != nil {
		return false, err
	}
	if len(output.Images) == 0 || strings.TrimSpace(output.Images[0].ResourceID) == "" {
		return false, errors.New("三视图任务没有返回已持久化的图片资源")
	}

	s.characterTaskMu.Lock()
	defer s.characterTaskMu.Unlock()
	bound, err := s.projectDomain().CharacterTurnaroundBound(task.ID)
	if err != nil || bound {
		return false, err
	}
	resourceID := strings.TrimSpace(output.Images[0].ResourceID)
	if err := s.projectDomain().BindCharacterTurnaround(task.UserID, projectID, assetID, task.ID, resourceID, task.Prompt); err != nil {
		if bound, checkErr := s.projectDomain().CharacterTurnaroundBound(task.ID); checkErr == nil && bound {
			return false, nil
		}
		return false, err
	}
	return true, nil
}

// reconcileCharacterTurnaroundTasks restores unbound turnaround cards for an
// explicit lifecycle or background scan. GET project/task must not call it.
func (s *Service) reconcileCharacterTurnaroundTasks(userID string, projectID string) bool {
	tasks, err := s.repo.UnboundCharacterTurnaroundTasks(userID, projectID)
	if err != nil {
		log.Printf("reconcile character turnaround tasks failed: user=%s project=%s error=%v", userID, projectID, err)
		return false
	}
	recovered := false
	for _, task := range tasks {
		var result map[string]interface{}
		if err := json.Unmarshal([]byte(task.ResultJSON), &result); err != nil {
			log.Printf("restore character turnaround result failed: user=%s project=%s task=%s error=%v", userID, projectID, task.ID, err)
			continue
		}
		applied, err := s.finalizeCharacterTurnaroundTask(task, result)
		if err != nil {
			log.Printf("restore character turnaround task failed: user=%s project=%s task=%s error=%v", userID, projectID, task.ID, err)
			continue
		}
		if applied {
			recovered = true
			_ = s.log(userID, task.ID, "info", "已将历史三视图任务恢复到角色卡", "")
		}
	}
	return recovered
}

func isSupportedVoiceSampleMimeType(value string) bool {
	return localproject.SupportedVoiceSampleMimeType(value)
}
