package project

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

type recordingWorkflows struct {
	ensured int
	created []string
	fail    error
}

func (r *recordingWorkflows) EnsureBuiltinTemplate() error {
	r.ensured++
	return nil
}

func (r *recordingWorkflows) PrepareDefault(projectID string) (WorkflowSeed, error) {
	if r.fail != nil {
		return WorkflowSeed{}, r.fail
	}
	r.created = append(r.created, projectID)
	now := time.Now()
	instance := model.WorkflowInstance{
		ID: kernel.NewID(), ProjectID: projectID, TemplateVersionID: "test-template",
		Scope: "project", Status: model.WorkflowStatusActive, Revision: 1, CreatedAt: now, UpdatedAt: now,
	}
	steps := []model.WorkflowStepInstance{{
		ID: kernel.NewID(), WorkflowInstanceID: instance.ID, StepKey: "story", Name: "剧情",
		Position: 0, Status: model.WorkflowStepStatusReady, InputJSON: "{}", OutputJSON: "{}",
		CreatedAt: now, UpdatedAt: now,
	}}
	return WorkflowSeed{Instance: instance, Steps: steps}, nil
}

func newTestService(t *testing.T, workflows Workflows) (*Service, *gorm.DB) {
	t.Helper()
	db, err := gorm.Open(sqlite.Open("file:"+kernel.NewID()+"?mode=memory&cache=shared"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(
		&model.Project{},
		&model.ProjectFolder{},
		&model.ProjectUnit{},
		&model.CanvasProject{},
		&model.CanvasSnapshot{},
		&model.CanvasSnapshotResource{},
		&model.CanvasUnitLink{},
		&model.ProjectAssetLink{},
		&model.ProjectAssetFolder{},
		&model.ProjectAssetCandidate{},
		&model.Asset{},
		&model.AssetVersion{},
		&model.AssetRepresentation{},
		&model.CharacterVoiceBinding{},
		&model.VoiceProfile{},
		&model.Resource{},
		&model.Task{},
		&model.Shot{},
		&model.ShotRevision{},
		&model.ShotArtifact{},
		&model.ShotAssetReference{},
		&model.WorkflowTemplateVersion{},
		&model.WorkflowInstance{},
		&model.WorkflowStepInstance{},
		&model.WorkflowStepTask{},
		&model.ProductionTaskLink{},
		&model.AgentOpRecord{},
	); err != nil {
		t.Fatal(err)
	}
	return New(repository.New(db), Dependencies{Workflows: workflows}), db
}

func ownedRevision(t *testing.T, svc *Service, projectID string) int64 {
	t.Helper()
	owned, err := svc.Owned("user-1", projectID)
	if err != nil {
		t.Fatal(err)
	}
	return owned.Revision
}

func seedProject(t *testing.T, db *gorm.DB, project model.Project) model.Project {
	t.Helper()
	if project.Revision < 1 {
		project.Revision = 1
	}
	if project.Status == "" {
		project.Status = model.ProjectStatusActive
	}
	now := time.Now()
	if project.CreatedAt.IsZero() {
		project.CreatedAt = now
	}
	if project.UpdatedAt.IsZero() {
		project.UpdatedAt = now
	}
	if err := db.Create(&project).Error; err != nil {
		t.Fatal(err)
	}
	return project
}

func TestServiceRejectsInvalidProjectRevision(t *testing.T) {
	svc, db := newTestService(t, nil)
	if err := db.Create(&model.Project{ID: "p", UserID: "local", Name: "无修订", Status: model.ProjectStatusActive, Revision: 0}).Error; err != nil {
		t.Fatal(err)
	}
	if _, err := svc.ListProjects("local"); err == nil {
		t.Fatal("project without a durable revision was accepted")
	}
}

func TestOwnedRejectsForeignProject(t *testing.T) {
	svc, db := newTestService(t, nil)
	seedProject(t, db, model.Project{ID: "project-1", UserID: "user-1", Name: "短剧"})
	if _, err := svc.Owned("user-2", "project-1"); !IsNotFound(err) {
		t.Fatalf("Owned foreign project error = %v, want not found", err)
	}
	if _, err := svc.UpdateProject("user-2", "project-1", UpdateProjectRequest{Name: "劫持"}); !IsNotFound(err) {
		t.Fatalf("UpdateProject foreign error = %v, want not found", err)
	}
	if err := svc.DeleteProject("user-2", "project-1"); !IsNotFound(err) {
		t.Fatalf("DeleteProject foreign error = %v, want not found", err)
	}
	if _, err := svc.CreateProjectUnit("user-2", "project-1", CreateProjectUnitRequest{Title: "第一章"}); !IsNotFound(err) {
		t.Fatalf("CreateProjectUnit foreign error = %v, want not found", err)
	}
}

func TestCreateUpdateAndRevision(t *testing.T) {
	workflows := &recordingWorkflows{}
	svc, db := newTestService(t, workflows)

	created, err := svc.CreateProject("user-1", CreateProjectRequest{Name: " 短剧一 ", DefaultImageModel: " system-channel::image "})
	if err != nil {
		t.Fatal(err)
	}
	if created.Name != "短剧一" || created.Type != "short-drama" || created.AspectRatio != "9:16" || created.SourceType != "blank" {
		t.Fatalf("created defaults = %+v", created)
	}
	if created.Revision != 2 {
		t.Fatalf("created revision = %d, want 2 after workflow bootstrap", created.Revision)
	}
	if created.DefaultImageModel != "system-channel::image" {
		t.Fatalf("default image model = %q", created.DefaultImageModel)
	}
	if workflows.ensured != 1 || len(workflows.created) != 1 || workflows.created[0] != created.ID {
		t.Fatalf("workflow bootstrap = %+v", workflows)
	}
	var workflowCount int64
	if err := db.Model(&model.WorkflowInstance{}).Where("project_id = ?", created.ID).Count(&workflowCount).Error; err != nil {
		t.Fatal(err)
	}
	if workflowCount != 1 {
		t.Fatalf("workflow instance count = %d, want 1", workflowCount)
	}

	updated, err := svc.UpdateProject("user-1", created.ID, UpdateProjectRequest{Name: "短剧一改"})
	if err != nil {
		t.Fatal(err)
	}
	if updated.Revision != created.Revision+1 || updated.Name != "短剧一改" {
		t.Fatalf("updated = %+v", updated)
	}
	var persisted model.Project
	if err := db.First(&persisted, "id = ?", created.ID).Error; err != nil {
		t.Fatal(err)
	}
	if persisted.Revision != updated.Revision || persisted.Name != "短剧一改" {
		t.Fatalf("persisted = %+v", persisted)
	}
}

func TestCreateProjectRollsBackWhenWorkflowFails(t *testing.T) {
	svc, db := newTestService(t, &recordingWorkflows{fail: errors.New("workflow unavailable")})
	if _, err := svc.CreateProject("user-1", CreateProjectRequest{Name: "失败项目"}); err == nil {
		t.Fatal("CreateProject succeeded with workflow failure")
	}
	var count int64
	if err := db.Model(&model.Project{}).Count(&count).Error; err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("project count = %d, want 0 after rollback", count)
	}
}

func TestUpdateProjectCoverRequiresOwnedReadyImage(t *testing.T) {
	svc, db := newTestService(t, nil)
	project := seedProject(t, db, model.Project{ID: "project-cover", UserID: "user-1", Name: "短剧"})
	resources := []model.Resource{
		{ID: "cover-ready", UserID: "user-1", Kind: "image", Status: model.ResourceStatusReady},
		{ID: "cover-pending", UserID: "user-1", Kind: "image", Status: model.ResourceStatusPending},
		{ID: "cover-video", UserID: "user-1", Kind: "video", Status: model.ResourceStatusReady},
		{ID: "cover-other-user", UserID: "user-2", Kind: "image", Status: model.ResourceStatusReady},
	}
	if err := db.Create(&resources).Error; err != nil {
		t.Fatal(err)
	}
	coverID := "cover-ready"
	updated, err := svc.UpdateProject("user-1", project.ID, UpdateProjectRequest{CoverResourceID: &coverID})
	if err != nil {
		t.Fatal(err)
	}
	if updated.CoverResourceID != coverID || updated.Revision != 2 {
		t.Fatalf("updated cover = %+v", updated)
	}
	for _, invalidID := range []string{"cover-pending", "cover-video", "cover-other-user", "missing"} {
		if _, err := svc.UpdateProject("user-1", project.ID, UpdateProjectRequest{CoverResourceID: &invalidID}); err == nil {
			t.Fatalf("UpdateProject cover %q succeeded, want validation error", invalidID)
		}
	}
}

func TestFolderMoveRequiresOwnedFolderAndProject(t *testing.T) {
	svc, db := newTestService(t, nil)
	project := seedProject(t, db, model.Project{ID: "project-1", UserID: "user-1", Name: "短剧"})
	ownFolder, err := svc.CreateProjectFolder("user-1", CreateProjectFolderRequest{Name: "进行中"})
	if err != nil {
		t.Fatal(err)
	}
	foreignFolder, err := svc.CreateProjectFolder("user-2", CreateProjectFolderRequest{Name: "别人的夹"})
	if err != nil {
		t.Fatal(err)
	}
	if err := svc.MoveProjectToFolder("user-1", project.ID, ownFolder.ID); err != nil {
		t.Fatal(err)
	}
	var stored model.Project
	if err := db.First(&stored, "id = ?", project.ID).Error; err != nil {
		t.Fatal(err)
	}
	if stored.FolderID != ownFolder.ID {
		t.Fatalf("folder id = %q, want %q", stored.FolderID, ownFolder.ID)
	}
	if err := svc.MoveProjectToFolder("user-1", project.ID, foreignFolder.ID); !IsNotFound(err) {
		t.Fatalf("move to foreign folder error = %v, want not found", err)
	}
	if err := svc.MoveProjectToFolder("user-2", project.ID, ownFolder.ID); !IsNotFound(err) {
		t.Fatalf("foreign user move error = %v, want not found", err)
	}
	if err := svc.MoveProjectToFolder("user-1", project.ID, ""); err != nil {
		t.Fatal(err)
	}
	if err := db.First(&stored, "id = ?", project.ID).Error; err != nil {
		t.Fatal(err)
	}
	if stored.FolderID != "" {
		t.Fatalf("folder id after clear = %q", stored.FolderID)
	}
}

func TestDuplicateProjectPreservesUnitContents(t *testing.T) {
	svc, db := newTestService(t, nil)
	project := seedProject(t, db, model.Project{ID: "project-1", UserID: "user-1", Name: "原作", FolderID: "folder-1", Revision: 4})
	parent := model.ProjectUnit{ID: "unit-parent", ProjectID: project.ID, Title: "第一卷", SourceText: "卷引言", Position: 0, Status: model.ProjectUnitStatusReady, Kind: model.ProjectUnitKindChapter}
	child := model.ProjectUnit{ID: "unit-child", ProjectID: project.ID, ParentID: parent.ID, Title: "第一章", SourceText: "<p>正文</p>", Position: 1, Status: model.ProjectUnitStatusDraft, Kind: model.ProjectUnitKindChapter, WordCount: 2}
	if err := db.Create(&parent).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&child).Error; err != nil {
		t.Fatal(err)
	}

	clone, err := svc.DuplicateProject("user-1", project.ID)
	if err != nil {
		t.Fatal(err)
	}
	if clone.ID == project.ID || clone.Name != "原作 副本" || clone.FolderID != "folder-1" || clone.Revision != 1 {
		t.Fatalf("clone = %+v", clone)
	}
	units, err := svc.repo.ProjectUnits(clone.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(units) != 2 {
		t.Fatalf("cloned units = %d, want 2", len(units))
	}
	byTitle := map[string]model.ProjectUnit{}
	for _, unit := range units {
		if unit.ID == parent.ID || unit.ID == child.ID {
			t.Fatalf("cloned unit reused source id %s", unit.ID)
		}
		byTitle[unit.Title] = unit
	}
	clonedParent := byTitle["第一卷"]
	clonedChild := byTitle["第一章"]
	if clonedParent.SourceText != "卷引言" || clonedChild.SourceText != "<p>正文</p>" {
		t.Fatalf("cloned contents = %+v %+v", clonedParent, clonedChild)
	}
	if clonedChild.ParentID != clonedParent.ID {
		t.Fatalf("cloned parent id = %q, want %q", clonedChild.ParentID, clonedParent.ID)
	}
	sourceUnits, err := svc.repo.ProjectUnits(project.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(sourceUnits) != 2 || sourceUnits[0].ID != parent.ID {
		t.Fatalf("source units mutated: %+v", sourceUnits)
	}
}

func TestListProjectsIsolatesUsersAndCountsUnits(t *testing.T) {
	svc, db := newTestService(t, nil)
	mine := seedProject(t, db, model.Project{ID: "mine", UserID: "user-1", Name: "我的"})
	seedProject(t, db, model.Project{ID: "theirs", UserID: "user-2", Name: "别人的"})
	if err := db.Create(&model.ProjectUnit{ID: "u1", ProjectID: mine.ID, Title: "一", Status: model.ProjectUnitStatusCompleted}).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.ProjectUnit{ID: "u2", ProjectID: mine.ID, Title: "二", Status: model.ProjectUnitStatusDraft}).Error; err != nil {
		t.Fatal(err)
	}
	listed, err := svc.ListProjects("user-1")
	if err != nil {
		t.Fatal(err)
	}
	if len(listed) != 1 || listed[0].Project.ID != mine.ID || listed[0].UnitCount != 2 || listed[0].CompletedUnitCount != 1 {
		t.Fatalf("listed = %+v", listed)
	}
}

func TestCanvasUnitLinkIntegrityAndDeleteBehavior(t *testing.T) {
	svc, db := newTestService(t, nil)
	project := seedProject(t, db, model.Project{ID: "project-1", UserID: "user-1", Name: "短剧"})
	foreign := seedProject(t, db, model.Project{ID: "project-2", UserID: "user-2", Name: "别人"})
	unit, err := svc.CreateProjectUnit("user-1", project.ID, CreateProjectUnitRequest{Title: "第一集", SourceText: "对白"})
	if err != nil {
		t.Fatal(err)
	}
	canvas := model.CanvasProject{
		ID: "canvas-1", UserID: "user-1", Title: "分镜", Revision: 3,
		PayloadJSON: `{"projectId":"project-1","nodes":[{"id":"n1"}],"futureField":true,"nested":{"keep":1}}`,
	}
	foreignCanvas := model.CanvasProject{ID: "canvas-foreign", UserID: "user-2", Title: "别人的画布", PayloadJSON: `{"nodes":[]}`}
	if err := db.Create(&canvas).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&foreignCanvas).Error; err != nil {
		t.Fatal(err)
	}

	if _, err := svc.LinkCanvasUnit("user-1", project.ID, LinkCanvasUnitRequest{CanvasID: foreignCanvas.ID, UnitID: unit.ID}); !IsNotFound(err) {
		t.Fatalf("link foreign canvas error = %v, want not found", err)
	}
	if _, err := svc.LinkCanvasUnit("user-2", foreign.ID, LinkCanvasUnitRequest{CanvasID: canvas.ID, UnitID: unit.ID}); !IsNotFound(err) {
		t.Fatalf("foreign user link own-user canvas error = %v, want not found", err)
	}

	link, err := svc.LinkCanvasUnit("user-1", project.ID, LinkCanvasUnitRequest{CanvasID: canvas.ID, UnitID: unit.ID})
	if err != nil {
		t.Fatal(err)
	}
	if link.Role != "storyboard" || link.ProjectID != project.ID {
		t.Fatalf("link = %+v", link)
	}
	var storedCanvas model.CanvasProject
	if err := db.First(&storedCanvas, "id = ?", canvas.ID).Error; err != nil {
		t.Fatal(err)
	}
	if storedCanvas.ProjectID != project.ID {
		t.Fatalf("canvas project id = %q", storedCanvas.ProjectID)
	}

	if err := svc.UnlinkCanvasUnit("user-1", project.ID, canvas.ID, "missing-unit"); !IsNotFound(err) {
		t.Fatalf("unlink missing unit error = %v, want not found", err)
	}
	if err := svc.UnlinkCanvasProject("user-1", foreign.ID, canvas.ID); err == nil {
		t.Fatal("unlinked canvas from a foreign project")
	}

	if err := svc.UnlinkCanvasProject("user-1", project.ID, canvas.ID); err != nil {
		t.Fatal(err)
	}
	if err := db.First(&storedCanvas, "id = ?", canvas.ID).Error; err != nil {
		t.Fatal(err)
	}
	if storedCanvas.ProjectID != "" {
		t.Fatalf("canvas still assigned: %q", storedCanvas.ProjectID)
	}
	var payload map[string]any
	if err := json.Unmarshal([]byte(storedCanvas.PayloadJSON), &payload); err != nil {
		t.Fatal(err)
	}
	if _, exists := payload["projectId"]; exists {
		t.Fatalf("payload still has projectId: %s", storedCanvas.PayloadJSON)
	}
	if payload["futureField"] != true {
		t.Fatalf("unknown payload field dropped: %s", storedCanvas.PayloadJSON)
	}
	nested, _ := payload["nested"].(map[string]any)
	if nested["keep"] != float64(1) {
		t.Fatalf("nested unknown data dropped: %s", storedCanvas.PayloadJSON)
	}
	if strings.TrimSpace(fmtString(payload["updatedAt"])) == "" {
		t.Fatalf("updatedAt missing: %s", storedCanvas.PayloadJSON)
	}

	if _, err := svc.LinkCanvasUnit("user-1", project.ID, LinkCanvasUnitRequest{CanvasID: canvas.ID, UnitID: unit.ID, Role: "primary"}); err != nil {
		t.Fatal(err)
	}
	asset := model.Asset{ID: "asset-1", UserID: "user-1", Title: "角色", Status: model.AssetVersionStatusConfirmed}
	finished := model.Task{ID: "task-1", UserID: "user-1", ProjectID: project.ID, Status: model.TaskStatusSucceeded, Prompt: "完成"}
	canvasTask := model.Task{ID: "task-2", UserID: "user-1", ProjectID: canvas.ID, Status: model.TaskStatusSucceeded, Prompt: "画布任务"}
	for _, item := range []any{
		&asset,
		&model.ProjectAssetLink{ID: "asset-link-1", ProjectID: project.ID, AssetID: asset.ID},
		&finished,
		&canvasTask,
	} {
		if err := db.Create(item).Error; err != nil {
			t.Fatal(err)
		}
	}

	if err := svc.DeleteProject("user-1", project.ID); err != nil {
		t.Fatal(err)
	}
	var storedProject model.Project
	if err := db.First(&storedProject, "id = ?", project.ID).Error; !errors.Is(err, gorm.ErrRecordNotFound) {
		t.Fatalf("project error = %v, want not found", err)
	}
	if err := db.First(&storedCanvas, "id = ?", canvas.ID).Error; err != nil {
		t.Fatal(err)
	}
	if storedCanvas.ProjectID != "" {
		t.Fatalf("deleted project left canvas assignment %q", storedCanvas.ProjectID)
	}
	if err := json.Unmarshal([]byte(storedCanvas.PayloadJSON), &payload); err != nil {
		t.Fatal(err)
	}
	if _, exists := payload["projectId"]; exists {
		t.Fatalf("deleted project left projectId in payload: %s", storedCanvas.PayloadJSON)
	}
	if payload["futureField"] != true {
		t.Fatalf("delete dropped unknown canvas data: %s", storedCanvas.PayloadJSON)
	}
	var storedAsset model.Asset
	if err := db.First(&storedAsset, "id = ?", asset.ID).Error; err != nil {
		t.Fatalf("linked library asset was deleted: %v", err)
	}
	var storedCanvasTask model.Task
	if err := db.First(&storedCanvasTask, "id = ?", canvasTask.ID).Error; err != nil {
		t.Fatal(err)
	}
	if storedCanvasTask.ProjectID != canvas.ID {
		t.Fatalf("canvas task scope = %q, want canvas id", storedCanvasTask.ProjectID)
	}
}

func TestDeleteProjectRejectsActiveCanvasTasks(t *testing.T) {
	svc, db := newTestService(t, nil)
	project := seedProject(t, db, model.Project{ID: "project-1", UserID: "user-1", Name: "短剧"})
	canvas := model.CanvasProject{ID: "canvas-1", UserID: "user-1", ProjectID: project.ID, Title: "分镜", PayloadJSON: `{"projectId":"project-1"}`}
	if err := db.Create(&canvas).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.Task{ID: "task-1", UserID: "user-1", ProjectID: canvas.ID, Status: model.TaskStatusRunning, Prompt: "生成中"}).Error; err != nil {
		t.Fatal(err)
	}
	err := svc.DeleteProject("user-1", project.ID)
	if err == nil || err.Error() != "项目仍有进行中的生成任务，请等待任务完成或取消后再删除" {
		t.Fatalf("DeleteProject() error = %v", err)
	}
}

func TestEnsureTaskScopeActive(t *testing.T) {
	svc, db := newTestService(t, nil)
	active := seedProject(t, db, model.Project{ID: "project-active", UserID: "user-1", Name: "在产"})
	archived := seedProject(t, db, model.Project{ID: "archived", UserID: "user-1", Name: "旧项目", Status: model.ProjectStatusArchived})
	foreign := seedProject(t, db, model.Project{ID: "project-foreign", UserID: "user-2", Name: "别人的项目"})
	personal := model.CanvasProject{ID: "canvas-personal", UserID: "user-1", Title: "个人画布", PayloadJSON: `{}`}
	linked := model.CanvasProject{ID: "canvas-linked", UserID: "user-1", ProjectID: active.ID, Title: "项目画布", PayloadJSON: `{}`}
	archivedCanvas := model.CanvasProject{ID: "canvas-archived", UserID: "user-1", ProjectID: archived.ID, Title: "旧画布", PayloadJSON: `{}`}
	foreignCanvas := model.CanvasProject{ID: "canvas-foreign", UserID: "user-2", Title: "别人的画布", PayloadJSON: `{}`}
	deleted := model.CanvasProject{ID: "canvas-deleted", UserID: "user-1", Title: "将被删除", PayloadJSON: `{}`}
	for _, item := range []model.CanvasProject{personal, linked, archivedCanvas, foreignCanvas, deleted} {
		if err := db.Create(&item).Error; err != nil {
			t.Fatal(err)
		}
	}
	if err := db.Delete(&model.CanvasProject{}, "id = ?", deleted.ID).Error; err != nil {
		t.Fatal(err)
	}

	if err := svc.EnsureTaskScopeActive("user-1", ""); err != nil {
		t.Fatalf("empty scope error = %v", err)
	}
	if err := svc.EnsureTaskScopeActive("user-1", personal.ID); err != nil {
		t.Fatalf("personal canvas error = %v", err)
	}
	if err := svc.EnsureTaskScopeActive("user-1", active.ID); err != nil {
		t.Fatalf("active project error = %v", err)
	}
	if err := svc.EnsureTaskScopeActive("user-1", linked.ID); err != nil {
		t.Fatalf("linked canvas error = %v", err)
	}

	for _, id := range []string{archived.ID, archivedCanvas.ID} {
		err := svc.EnsureTaskScopeActive("user-1", id)
		if err == nil || err.Error() != "项目已归档，无法创建生成任务" {
			t.Fatalf("archived %s error = %v", id, err)
		}
	}
	for _, id := range []string{"missing", foreign.ID, foreignCanvas.ID, deleted.ID} {
		err := svc.EnsureTaskScopeActive("user-1", id)
		if err == nil || err.Error() != "当前画布或项目不可用，无法创建生成任务" {
			t.Fatalf("unavailable %s error = %v", id, err)
		}
	}
}

func TestUnitOperationsStayInsideOwnedProject(t *testing.T) {
	svc, db := newTestService(t, nil)
	project := seedProject(t, db, model.Project{ID: "project-1", UserID: "user-1", Name: "短剧"})
	other := seedProject(t, db, model.Project{ID: "project-2", UserID: "user-1", Name: "另一个"})
	first, err := svc.CreateProjectUnit("user-1", project.ID, CreateProjectUnitRequest{Title: "一", SourceText: "<p>张振天&nbsp;归来</p>"})
	if err != nil {
		t.Fatal(err)
	}
	if first.WordCount != 6 {
		t.Fatalf("word count = %d, want 6", first.WordCount)
	}
	second, err := svc.CreateProjectUnit("user-1", project.ID, CreateProjectUnitRequest{Title: "二"})
	if err != nil {
		t.Fatal(err)
	}
	if err := svc.ReorderProjectUnits("user-1", project.ID, ReorderProjectUnitsRequest{UnitIDs: []string{second.ID, first.ID}}); err != nil {
		t.Fatal(err)
	}
	if err := svc.ReorderProjectUnits("user-1", other.ID, ReorderProjectUnitsRequest{UnitIDs: []string{first.ID}}); err == nil {
		t.Fatal("reordered units onto a different project")
	}
	updated, err := svc.UpdateProjectUnit("user-1", project.ID, first.ID, UpdateProjectUnitRequest{Title: "一改", SourceText: "<p>新的正文</p>", Status: string(model.ProjectUnitStatusReady)})
	if err != nil {
		t.Fatal(err)
	}
	if updated.WordCount != 4 || updated.Status != model.ProjectUnitStatusReady {
		t.Fatalf("updated unit = %+v", updated)
	}
	if _, err := svc.GetProjectUnit("user-1", other.ID, first.ID); !IsNotFound(err) {
		t.Fatalf("read unit through another project error = %v, want not found", err)
	}
	if err := svc.DeleteProjectUnit("user-1", other.ID, first.ID); !IsNotFound(err) {
		t.Fatalf("delete unit through another project error = %v, want not found", err)
	}
	imported, err := svc.ImportProjectUnits("user-1", project.ID, ImportProjectUnitsRequest{Units: []CreateProjectUnitRequest{{Title: "导入章", SourceText: "文本"}}})
	if err != nil {
		t.Fatal(err)
	}
	if len(imported) != 1 || imported[0].SourceText != "文本" {
		t.Fatalf("imported = %+v", imported)
	}
	var stored model.Project
	if err := db.First(&stored, "id = ?", project.ID).Error; err != nil {
		t.Fatal(err)
	}
	if stored.Revision < 2 {
		t.Fatalf("revision after unit writes = %d", stored.Revision)
	}
}

func fmtString(value any) string {
	text, _ := value.(string)
	return text
}
