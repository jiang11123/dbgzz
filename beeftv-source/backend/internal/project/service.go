package project

import (
	"errors"
	"fmt"
	"strings"
	"time"

	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/prompts"
	"infinite-canvas/backend/internal/repository"

	"gorm.io/gorm"
)

// Workflows optionally supplies the default production seed when a project is created.
// PrepareDefault must not write; the project row and returned records share one transaction.
// The workflow step machine, asset version rules and production writes live on Service.
type Workflows interface {
	EnsureBuiltinTemplate() error
	PrepareDefault(projectID string) (WorkflowSeed, error)
}

type Dependencies struct {
	Workflows Workflows
}

// Service owns project identity, folders, units, revision, canvas membership,
// workflow steps, asset versions, characters and shots.
type Service struct {
	repo      *repository.Repository
	workflows Workflows
}

func New(repo *repository.Repository, deps Dependencies) *Service {
	service := &Service{repo: repo, workflows: deps.Workflows}
	if service.workflows == nil {
		service.workflows = builtinWorkflows{service}
	}
	return service
}

// Default workflow records belong to the project domain. The host need not
// call back through app to obtain records from this same service.
type builtinWorkflows struct{ service *Service }

func (w builtinWorkflows) EnsureBuiltinTemplate() error { return w.service.EnsureBuiltinTemplate() }
func (w builtinWorkflows) PrepareDefault(projectID string) (WorkflowSeed, error) {
	return w.service.PrepareDefaultWorkflow(projectID)
}

func IsNotFound(err error) bool {
	return errors.Is(err, gorm.ErrRecordNotFound)
}

func IsConflict(err error) bool {
	var appErr *kernel.AppError
	return errors.As(err, &appErr) && appErr.Status == kernel.CodeConflict
}

func mapProjectWriteError(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, repository.ErrProjectRevisionConflict) {
		return kernel.WrapAppError(kernel.CodeConflict, "项目已被其他操作更新，请重新加载后再保存", err)
	}
	if errors.Is(err, repository.ErrExpectedRevisionRequired) {
		return kernel.BadAuthRequest("请刷新后再保存分镜")
	}
	if errors.Is(err, repository.ErrCanvasRevisionConflict) {
		return kernel.WrapAppError(kernel.CodeConflict, "画布已被其他操作更新，无法完成项目关联", err)
	}
	if errors.Is(err, repository.ErrProjectArchived) {
		return kernel.BadAuthRequest("项目已归档，不能修改短剧生产数据")
	}
	if errors.Is(err, repository.ErrProjectUnitShotsChanged) {
		return kernel.BadAuthRequest("本章分镜已发生变化，请刷新后重新确认")
	}
	if errors.Is(err, repository.ErrProjectAssetStillReferenced) {
		return kernel.BadAuthRequest("素材仍被项目镜头引用，请先解除镜头用途")
	}
	if errors.Is(err, repository.ErrProjectAssetFolderNotEmpty) {
		return kernel.BadAuthRequest("文件夹非空，请先移动其中的素材和子文件夹")
	}
	return err
}

func (s *Service) Owned(userID, projectID string) (*model.Project, error) {
	return s.repo.ProjectForUser(userID, projectID)
}

func (s *Service) Active(userID, projectID string) (*model.Project, error) {
	project, err := s.Owned(userID, projectID)
	if err != nil {
		return nil, err
	}
	if project.Status == model.ProjectStatusArchived {
		return nil, kernel.BadAuthRequest("项目已归档，不能修改短剧生产数据")
	}
	return project, nil
}

// EnsureTaskScopeActive accepts an owned canvas id or owned active business
// project id. Empty stays allowed for standalone text/media. Unknown, foreign,
// deleted, and archived nonempty ids fail closed.
func (s *Service) EnsureTaskScopeActive(userID, canvasOrProjectID string) error {
	if err := s.repo.RequireTaskScopeActive(userID, canvasOrProjectID); err != nil {
		if errors.Is(err, repository.ErrTaskScopeArchived) {
			return kernel.BadAuthRequest("项目已归档，无法创建生成任务")
		}
		if errors.Is(err, repository.ErrTaskScopeNotActive) {
			return kernel.BadAuthRequest("当前画布或项目不可用，无法创建生成任务")
		}
		return err
	}
	return nil
}

func (s *Service) ListProjects(userID string) ([]Summary, error) {
	projects, err := s.repo.Projects(userID)
	if err != nil {
		return nil, err
	}
	return s.summarizeProjects(userID, projects)
}

func (s *Service) ListProjectsPage(userID string, page int, pageSize int) (ListPage, error) {
	projects, total, err := s.repo.ProjectsPage(userID, page, pageSize)
	if err != nil {
		return ListPage{}, err
	}
	result, err := s.summarizeProjects(userID, projects)
	if err != nil {
		return ListPage{}, err
	}
	return ListPage{Projects: result, Page: page, PageSize: pageSize, Total: total, HasMore: int64(page*pageSize) < total}, nil
}

func (s *Service) summarizeProjects(userID string, projects []model.Project) ([]Summary, error) {
	result := make([]Summary, 0, len(projects))
	for _, item := range projects {
		summary := Summary{Project: item}
		if err := requireDurableRevision(summary); err != nil {
			return nil, err
		}
		units, unitsErr := s.repo.ProjectUnitSummaries(item.ID)
		if unitsErr != nil {
			return nil, unitsErr
		}
		canvases, canvasesErr := s.repo.ProjectCanvasSummaries(userID, item.ID)
		if canvasesErr != nil {
			return nil, canvasesErr
		}
		assetCount, assetCountErr := s.repo.ProjectAssetCount(item.ID)
		if assetCountErr != nil {
			return nil, assetCountErr
		}
		completed := 0
		for _, unit := range units {
			if unit.Status == model.ProjectUnitStatusCompleted {
				completed++
			}
		}
		summary.CanvasCount = len(canvases)
		summary.AssetCount = assetCount
		summary.UnitCount = len(units)
		summary.CompletedUnitCount = completed
		result = append(result, summary)
	}
	return result, nil
}

func requireDurableRevision(item Summary) error {
	if item.Project.ID == "" || item.Project.Revision < 1 {
		return fmt.Errorf("项目缺少有效的本地修订版本")
	}
	return nil
}

func (s *Service) ListProjectFolders(userID string) ([]model.ProjectFolder, error) {
	return s.repo.ProjectFolders(userID)
}

func (s *Service) CreateProjectFolder(userID string, req CreateProjectFolderRequest) (model.ProjectFolder, error) {
	name := strings.TrimSpace(req.Name)
	if name == "" {
		return model.ProjectFolder{}, kernel.BadAuthRequest("文件夹名称不能为空")
	}
	parentID := strings.TrimSpace(req.ParentID)
	if parentID != "" {
		if _, err := s.repo.ProjectFolderForUser(userID, parentID); err != nil {
			return model.ProjectFolder{}, err
		}
	}
	now := time.Now()
	folder := model.ProjectFolder{ID: kernel.NewID(), UserID: userID, ParentID: parentID, Name: name, CreatedAt: now, UpdatedAt: now}
	if err := s.repo.CreateProjectFolderChecked(&folder); err != nil {
		return model.ProjectFolder{}, err
	}
	return folder, nil
}

func (s *Service) MoveProjectToFolder(userID, projectID, folderID string) error {
	if _, err := s.Owned(userID, projectID); err != nil {
		return err
	}
	return mapProjectWriteError(s.repo.MoveProjectAndBump(userID, projectID, strings.TrimSpace(folderID)))
}

func (s *Service) DuplicateProject(userID, projectID string) (model.Project, error) {
	source, err := s.Owned(userID, projectID)
	if err != nil {
		return model.Project{}, err
	}
	now := time.Now()
	clone := *source
	clone.ID = kernel.NewID()
	clone.Name = strings.TrimSpace(source.Name) + " 副本"
	clone.FolderID = source.FolderID
	clone.Status = model.ProjectStatusActive
	clone.Revision = 1
	clone.CreatedAt, clone.UpdatedAt = now, now
	if err := s.repo.CloneProject(userID, projectID, &clone); err != nil {
		return model.Project{}, err
	}
	return clone, nil
}

func (s *Service) CreateProject(userID string, req CreateProjectRequest) (model.Project, error) {
	if s.workflows != nil {
		if err := s.workflows.EnsureBuiltinTemplate(); err != nil {
			return model.Project{}, err
		}
	}
	name := strings.TrimSpace(req.Name)
	if name == "" {
		return model.Project{}, kernel.BadAuthRequest("项目名称不能为空")
	}
	projectType := strings.TrimSpace(req.Type)
	if projectType == "" {
		projectType = "short-drama"
	}
	aspectRatio := strings.TrimSpace(req.AspectRatio)
	if aspectRatio == "" {
		aspectRatio = "9:16"
	}
	sourceType := strings.TrimSpace(req.SourceType)
	if sourceType == "" {
		sourceType = "blank"
	}
	styleProfileJSON, err := prompts.ValidateStyleProfileJSON(req.StyleProfileJSON)
	if err != nil {
		return model.Project{}, kernel.BadAuthRequest(err.Error())
	}
	stylePresetID := strings.TrimSpace(req.StylePresetID)
	if err := prompts.ValidateStyleProfilePreset(stylePresetID, styleProfileJSON); err != nil {
		return model.Project{}, kernel.BadAuthRequest(err.Error())
	}
	now := time.Now()
	defaultImageModel, err := normalizeProjectDefaultModel(req.DefaultImageModel)
	if err != nil {
		return model.Project{}, err
	}
	defaultVideoModel, err := normalizeProjectDefaultModel(req.DefaultVideoModel)
	if err != nil {
		return model.Project{}, err
	}
	item := model.Project{
		ID: kernel.NewID(), UserID: userID, Name: name, Type: projectType, AspectRatio: aspectRatio, SourceType: sourceType,
		Description: strings.TrimSpace(req.Description), StylePresetID: stylePresetID, StyleProfileJSON: styleProfileJSON,
		DefaultImageModel: defaultImageModel, DefaultVideoModel: defaultVideoModel, Status: model.ProjectStatusActive,
		Revision: 1, CreatedAt: now, UpdatedAt: now,
	}
	var instance *model.WorkflowInstance
	var steps []model.WorkflowStepInstance
	if s.workflows != nil {
		seed, seedErr := s.workflows.PrepareDefault(item.ID)
		if seedErr != nil {
			return model.Project{}, seedErr
		}
		instance = &seed.Instance
		steps = seed.Steps
	}
	if err := s.repo.CreateProjectWithWorkflow(&item, instance, steps); err != nil {
		return model.Project{}, err
	}
	return item, nil
}

func (s *Service) UpdateProject(userID string, id string, req UpdateProjectRequest) (model.Project, error) {
	item, err := s.Owned(userID, id)
	if err != nil {
		return model.Project{}, err
	}
	if name := strings.TrimSpace(req.Name); name != "" {
		item.Name = name
	}
	if value := strings.TrimSpace(req.Type); value != "" {
		item.Type = value
	}
	if value := strings.TrimSpace(req.AspectRatio); value != "" {
		item.AspectRatio = value
	}
	if value := strings.TrimSpace(req.SourceType); value != "" {
		item.SourceType = value
	}
	if req.Description != nil {
		item.Description = strings.TrimSpace(*req.Description)
	}
	if req.CoverResourceID != nil {
		coverResourceID := strings.TrimSpace(*req.CoverResourceID)
		if coverResourceID != "" {
			resource, resourceErr := s.repo.ResourceForUser(userID, coverResourceID)
			if resourceErr != nil {
				if errors.Is(resourceErr, gorm.ErrRecordNotFound) {
					return model.Project{}, kernel.BadAuthRequest("项目主图不存在或不属于当前用户")
				}
				return model.Project{}, resourceErr
			}
			if resource.Status != model.ResourceStatusReady || resource.Kind != "image" {
				return model.Project{}, kernel.BadAuthRequest("项目主图必须是已就绪的图片资源")
			}
		}
		item.CoverResourceID = coverResourceID
	}
	if req.StylePresetID != nil {
		item.StylePresetID = strings.TrimSpace(*req.StylePresetID)
	}
	if req.StyleProfileJSON != nil {
		styleProfileJSON, profileErr := prompts.ValidateStyleProfileJSON(*req.StyleProfileJSON)
		if profileErr != nil {
			return model.Project{}, kernel.BadAuthRequest(profileErr.Error())
		}
		item.StyleProfileJSON = styleProfileJSON
	}
	if req.DefaultImageModel != nil {
		defaultImageModel, modelErr := normalizeProjectDefaultModel(*req.DefaultImageModel)
		if modelErr != nil {
			return model.Project{}, modelErr
		}
		item.DefaultImageModel = defaultImageModel
	}
	if req.DefaultVideoModel != nil {
		defaultVideoModel, modelErr := normalizeProjectDefaultModel(*req.DefaultVideoModel)
		if modelErr != nil {
			return model.Project{}, modelErr
		}
		item.DefaultVideoModel = defaultVideoModel
	}
	if err := prompts.ValidateStyleProfilePreset(item.StylePresetID, item.StyleProfileJSON); err != nil {
		return model.Project{}, kernel.BadAuthRequest(err.Error())
	}
	if status := model.ProjectStatus(strings.TrimSpace(req.Status)); status != "" {
		if status != model.ProjectStatusActive && status != model.ProjectStatusArchived {
			return model.Project{}, kernel.BadAuthRequest("不支持的项目状态")
		}
		item.Status = status
	}
	expectedRevision := item.Revision
	item.Revision = expectedRevision + 1
	item.UpdatedAt = time.Now()
	if err := s.repo.UpdateProjectCAS(userID, expectedRevision, item); err != nil {
		return model.Project{}, mapProjectWriteError(err)
	}
	return *item, nil
}

func normalizeProjectDefaultModel(value string) (string, error) {
	modelRef := strings.TrimSpace(value)
	if len(modelRef) > 500 {
		return "", kernel.BadAuthRequest("项目默认模型标识过长")
	}
	return modelRef, nil
}

func (s *Service) DeleteProject(userID string, id string) error {
	if _, err := s.Owned(userID, id); err != nil {
		return err
	}
	canvases, err := s.repo.ProjectCanvasDocuments(userID, id)
	if err != nil {
		return err
	}
	projectScopeIDs := make([]string, 0, len(canvases)+1)
	projectScopeIDs = append(projectScopeIDs, id)
	canvasUpdates := make([]model.CanvasProject, 0, len(canvases))
	deleteTime := time.Now()
	for _, canvas := range canvases {
		payloadJSON, payloadErr := canvasPayloadWithoutProject(canvas.PayloadJSON, deleteTime)
		if payloadErr != nil {
			return payloadErr
		}
		canvas.PayloadJSON = payloadJSON
		canvas.UpdatedAt = deleteTime
		canvasUpdates = append(canvasUpdates, canvas)
		projectScopeIDs = append(projectScopeIDs, canvas.ID)
	}
	activeTaskCount, err := s.repo.ActiveTaskCountForProjectIDs(userID, projectScopeIDs)
	if err != nil {
		return err
	}
	if activeTaskCount > 0 {
		return kernel.BadAuthRequest("项目仍有进行中的生成任务，请等待任务完成或取消后再删除")
	}
	if err := s.repo.DeleteProject(userID, id, canvasUpdates); err != nil {
		if errors.Is(err, repository.ErrProjectHasActiveTasks) {
			return kernel.BadAuthRequest("项目仍有进行中的生成任务，请等待任务完成或取消后再删除")
		}
		return err
	}
	return nil
}

func NormalizePage(page int, pageSize int, maximum int) (int, int) {
	if page < 1 {
		page = 1
	}
	if pageSize < 1 {
		pageSize = 40
	}
	if pageSize > maximum {
		pageSize = maximum
	}
	return page, pageSize
}
