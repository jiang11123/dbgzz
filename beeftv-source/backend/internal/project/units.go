package project

import (
	"strings"
	"time"

	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
)

func (s *Service) CreateProjectUnit(userID string, projectID string, req CreateProjectUnitRequest) (model.ProjectUnit, error) {
	if _, err := s.Active(userID, projectID); err != nil {
		return model.ProjectUnit{}, err
	}
	unit, err := newProjectUnit(projectID, req, req.Position)
	if err != nil {
		return model.ProjectUnit{}, err
	}
	if err := s.repo.CreateProjectUnitAndBump(userID, projectID, &unit); err != nil {
		return model.ProjectUnit{}, mapProjectWriteError(err)
	}
	return unit, nil
}

func (s *Service) GetProjectUnit(userID string, projectID string, unitID string) (model.ProjectUnit, error) {
	if _, err := s.Owned(userID, projectID); err != nil {
		return model.ProjectUnit{}, err
	}
	unit, err := s.repo.ProjectUnit(projectID, strings.TrimSpace(unitID))
	if err != nil {
		return model.ProjectUnit{}, err
	}
	return *unit, nil
}

func (s *Service) ImportProjectUnits(userID string, projectID string, req ImportProjectUnitsRequest) ([]model.ProjectUnit, error) {
	if _, err := s.Active(userID, projectID); err != nil {
		return nil, err
	}
	if len(req.Units) == 0 || len(req.Units) > 2500 {
		return nil, kernel.BadAuthRequest("一次导入的章节数量必须在 1 到 2500 之间")
	}
	existing, err := s.repo.ProjectUnits(projectID)
	if err != nil {
		return nil, err
	}
	units := make([]model.ProjectUnit, 0, len(req.Units))
	for index, input := range req.Units {
		unit, unitErr := newProjectUnit(projectID, input, len(existing)+index)
		if unitErr != nil {
			return nil, unitErr
		}
		units = append(units, unit)
	}
	if err := s.repo.ImportProjectUnitsActive(userID, projectID, units); err != nil {
		return nil, mapProjectWriteError(err)
	}
	return units, nil
}

func (s *Service) ReorderProjectUnits(userID string, projectID string, req ReorderProjectUnitsRequest) error {
	if _, err := s.Active(userID, projectID); err != nil {
		return err
	}
	units, err := s.repo.ProjectUnits(projectID)
	if err != nil {
		return err
	}
	if len(req.UnitIDs) != len(units) {
		return kernel.BadAuthRequest("章节排序列表不完整")
	}
	existing := make(map[string]struct{}, len(units))
	for _, unit := range units {
		existing[unit.ID] = struct{}{}
	}
	seen := make(map[string]struct{}, len(req.UnitIDs))
	normalizedIDs := make([]string, 0, len(req.UnitIDs))
	for _, rawID := range req.UnitIDs {
		id := strings.TrimSpace(rawID)
		if _, ok := existing[id]; !ok {
			return kernel.BadAuthRequest("章节排序包含无效章节")
		}
		if _, duplicate := seen[id]; duplicate {
			return kernel.BadAuthRequest("章节排序包含重复章节")
		}
		seen[id] = struct{}{}
		normalizedIDs = append(normalizedIDs, id)
	}
	return mapProjectWriteError(s.repo.ReorderProjectUnitsActive(userID, projectID, normalizedIDs))
}

func (s *Service) DeleteProjectUnit(userID string, projectID string, unitID string) error {
	if _, err := s.Active(userID, projectID); err != nil {
		return err
	}
	if _, err := s.repo.ProjectUnit(projectID, unitID); err != nil {
		return err
	}
	return mapProjectWriteError(s.repo.DeleteProjectUnitActive(userID, projectID, unitID))
}

func newProjectUnit(projectID string, req CreateProjectUnitRequest, position int) (model.ProjectUnit, error) {
	kind := model.ProjectUnitKind(strings.TrimSpace(req.Kind))
	if kind == "" {
		kind = model.ProjectUnitKindChapter
	}
	if kind != model.ProjectUnitKindChapter && kind != model.ProjectUnitKindEpisode {
		return model.ProjectUnit{}, kernel.BadAuthRequest("不支持的项目单元类型")
	}
	title := strings.TrimSpace(req.Title)
	if title == "" {
		return model.ProjectUnit{}, kernel.BadAuthRequest("章节标题不能为空")
	}
	if position < 0 {
		position = 0
	}
	now := time.Now()
	unit := model.ProjectUnit{
		ID: kernel.NewID(), ProjectID: projectID, Kind: kind, Title: title, SourceText: req.SourceText,
		WordCount: model.ProjectUnitWordCount(req.SourceText), Status: model.ProjectUnitStatusDraft,
		Position: position, CreatedAt: now, UpdatedAt: now,
	}
	return unit, nil
}

func (s *Service) UpdateProjectUnit(userID string, projectID string, unitID string, req UpdateProjectUnitRequest) (model.ProjectUnit, error) {
	project, err := s.Active(userID, projectID)
	if err != nil {
		return model.ProjectUnit{}, err
	}
	unit, err := s.repo.ProjectUnit(projectID, unitID)
	if err != nil {
		return model.ProjectUnit{}, err
	}
	sourceChanged := unit.SourceText != req.SourceText
	if title := strings.TrimSpace(req.Title); title != "" {
		unit.Title = title
	}
	unit.SourceText = req.SourceText
	unit.WordCount = model.ProjectUnitWordCount(req.SourceText)
	if status := model.ProjectUnitStatus(strings.TrimSpace(req.Status)); status != "" {
		if status != model.ProjectUnitStatusDraft && status != model.ProjectUnitStatusReady && status != model.ProjectUnitStatusCompleted {
			return model.ProjectUnit{}, kernel.BadAuthRequest("不支持的章节状态")
		}
		unit.Status = status
	}
	unit.UpdatedAt = time.Now()
	if err := s.repo.UpdateProjectUnitActive(userID, project.Revision, unit, sourceChanged); err != nil {
		return model.ProjectUnit{}, mapProjectWriteError(err)
	}
	return *unit, nil
}
