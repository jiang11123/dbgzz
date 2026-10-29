package repository

import (
	"slices"
	"strings"

	"infinite-canvas/backend/internal/assets"
	"infinite-canvas/backend/internal/model"

	"gorm.io/gorm"
)

// ResourceReferenceDocument 是资源删除校验使用的只读业务文档快照。
// repository 只按用户范围读取记录；JSON 中的资源引用合同由 service 统一解释。
type ResourceReferenceDocument struct {
	Kind          string
	ID            string
	Title         string
	PrimaryJSON   string
	SecondaryJSON string
	TaskStatus    model.TaskStatus
}

type ResourceDirectReference struct {
	Kind       string
	ID         string
	Title      string
	ResourceID string
}

type ResourceReferenceSnapshot struct {
	Documents []ResourceReferenceDocument
	Direct    []ResourceDirectReference
}

func (r *Repository) AssetResourceRecords(assetID string) ([]model.AssetVersion, []model.AssetRepresentation, error) {
	var versions []model.AssetVersion
	if err := r.db.Where("asset_id = ?", assetID).Find(&versions).Error; err != nil {
		return nil, nil, err
	}
	if len(versions) == 0 {
		return versions, nil, nil
	}
	versionIDs := make([]string, 0, len(versions))
	for _, version := range versions {
		versionIDs = append(versionIDs, version.ID)
	}
	var representations []model.AssetRepresentation
	if err := r.db.Where("asset_version_id IN ?", versionIDs).Find(&representations).Error; err != nil {
		return nil, nil, err
	}
	return versions, representations, nil
}

func (r *Repository) ResourcesForUserIDs(userID string, resourceIDs []string) ([]model.Resource, error) {
	if len(resourceIDs) == 0 {
		return []model.Resource{}, nil
	}
	var resources []model.Resource
	err := r.db.Where("user_id = ? AND id IN ?", userID, resourceIDs).Find(&resources).Error
	return resources, err
}

// ResourceStorageReferenceCount 返回未包含在 excludedResourceIDs 中、但指向同一物理对象的资源记录数。
// 这用于兼容历史数据中多个 Resource 行复用一个对象路径的情况。
func (r *Repository) ResourceStorageReferenceCount(resource *model.Resource, excludedResourceIDs []string) (int64, error) {
	if resource == nil {
		return 0, nil
	}
	query := r.db.Model(&model.Resource{}).
		Where("endpoint = ? AND bucket = ? AND object_key = ?", resource.Endpoint, resource.Bucket, resource.ObjectKey)
	if strings.TrimSpace(resource.Provider) == "" || strings.EqualFold(strings.TrimSpace(resource.Provider), "local") {
		query = query.Where("provider IN ?", []string{"", "local"})
	} else {
		query = query.Where("provider = ?", resource.Provider)
	}
	if len(excludedResourceIDs) > 0 {
		query = query.Where("id NOT IN ?", excludedResourceIDs)
	}
	var count int64
	err := query.Count(&count).Error
	return count, err
}

func (r *Repository) ResourceReferenceSnapshot(userID string, excludingAssetID string, resourceIDs []string) (ResourceReferenceSnapshot, error) {
	snapshot := ResourceReferenceSnapshot{Documents: []ResourceReferenceDocument{}, Direct: []ResourceDirectReference{}}
	if len(resourceIDs) == 0 {
		return snapshot, nil
	}
	history, err := r.CanvasHistoryResourceReferences(resourceIDs)
	if err != nil {
		return snapshot, err
	}
	snapshot.Direct = append(snapshot.Direct, history...)
	exports, err := r.ProjectExportResourceReferences(userID, resourceIDs)
	if err != nil {
		return snapshot, err
	}
	snapshot.Direct = append(snapshot.Direct, exports...)
	if r.db.Migrator().HasTable(&model.CanvasWorkflowResource{}) {
		var refs []model.CanvasWorkflowResource
		if err := r.db.Where("user_id = ? AND resource_id IN ?", userID, resourceIDs).Find(&refs).Error; err != nil {
			return snapshot, err
		}
		for _, ref := range refs {
			snapshot.Direct = append(snapshot.Direct, ResourceDirectReference{Kind: "可复用工作流", ID: ref.OwnerID, Title: "工作流模板或运行结果", ResourceID: ref.ResourceID})
		}
	}

	var assets []model.Asset
	assetQuery := r.db.Where("user_id = ? AND id <> ?", userID, excludingAssetID)
	if err := assetQuery.Find(&assets).Error; err != nil {
		return snapshot, err
	}
	for _, asset := range assets {
		snapshot.Documents = append(snapshot.Documents, ResourceReferenceDocument{Kind: "素材", ID: asset.ID, Title: asset.Title, PrimaryJSON: asset.PayloadJSON})
	}

	var canvases []model.CanvasProject
	if err := r.db.Where("user_id = ?", userID).Find(&canvases).Error; err != nil {
		return snapshot, err
	}
	for _, canvas := range canvases {
		snapshot.Documents = append(snapshot.Documents, ResourceReferenceDocument{Kind: "画布", ID: canvas.ID, Title: canvas.Title, PrimaryJSON: canvas.PayloadJSON})
	}

	var tasks []model.Task
	if err := r.db.Select("id", "prompt", "status", "input_json", "result_json").Where("user_id = ?", userID).Find(&tasks).Error; err != nil {
		return snapshot, err
	}
	taskStatuses := make(map[string]model.TaskStatus, len(tasks))
	for _, task := range tasks {
		taskStatuses[task.ID] = task.Status
		snapshot.Documents = append(snapshot.Documents, ResourceReferenceDocument{Kind: "任务", ID: task.ID, Title: task.Prompt, PrimaryJSON: task.InputJSON, SecondaryJSON: task.ResultJSON, TaskStatus: task.Status})
	}

	var runs []model.CreationRun
	if err := r.db.Where("user_id = ?", userID).Find(&runs).Error; err != nil {
		return snapshot, err
	}
	for _, run := range runs {
		snapshot.Documents = append(snapshot.Documents, ResourceReferenceDocument{Kind: "创作会话", ID: run.ID, Title: "智能创作", PrimaryJSON: run.StateJSON, SecondaryJSON: run.ApprovedOperationsJSON})
	}
	var submissions []model.CreationSubmission
	if err := r.db.Where("user_id = ? AND revoked_at IS NULL", userID).Find(&submissions).Error; err != nil {
		return snapshot, err
	}
	for _, submission := range submissions {
		snapshot.Documents = append(snapshot.Documents, ResourceReferenceDocument{Kind: "创作执行项", ID: submission.ID, Title: submission.ItemKey, PrimaryJSON: submission.RequestJSON})
	}

	var taskLogs []model.TaskLog
	if err := r.db.Select("id", "task_id", "message", "payload").Where("user_id = ?", userID).Find(&taskLogs).Error; err != nil {
		return snapshot, err
	}
	for _, taskLog := range taskLogs {
		snapshot.Documents = append(snapshot.Documents, ResourceReferenceDocument{Kind: "任务日志", ID: taskLog.ID, Title: taskLog.Message, PrimaryJSON: taskLog.Payload, TaskStatus: taskStatuses[taskLog.TaskID]})
	}

	var results []model.Result
	if err := r.db.Select("id", "task_id", "kind", "url", "payload").Where("user_id = ?", userID).Find(&results).Error; err != nil {
		return snapshot, err
	}
	for _, result := range results {
		snapshot.Documents = append(snapshot.Documents, ResourceReferenceDocument{Kind: "任务结果", ID: result.ID, Title: result.Kind, PrimaryJSON: result.URL, SecondaryJSON: result.Payload, TaskStatus: taskStatuses[result.TaskID]})
	}

	var projects []model.Project
	if err := r.db.Where("user_id = ?", userID).Find(&projects).Error; err != nil {
		return snapshot, err
	}
	for _, project := range projects {
		snapshot.Documents = append(snapshot.Documents, ResourceReferenceDocument{Kind: "项目", ID: project.ID, Title: project.Name, PrimaryJSON: project.StyleProfileJSON})
		if project.CoverResourceID != "" && slices.Contains(resourceIDs, project.CoverResourceID) {
			snapshot.Direct = append(snapshot.Direct, ResourceDirectReference{Kind: "项目主图", ID: project.ID, Title: project.Name, ResourceID: project.CoverResourceID})
		}
	}

	var styles []model.StyleProfile
	if err := r.db.Where("user_id = ?", userID).Find(&styles).Error; err != nil {
		return snapshot, err
	}
	for _, style := range styles {
		snapshot.Documents = append(snapshot.Documents, ResourceReferenceDocument{Kind: "风格", ID: style.ID, Title: style.Name, PrimaryJSON: style.CoverURL, SecondaryJSON: style.ProfileJSON})
	}

	type joinedDocument struct {
		ID            string
		Title         string
		PrimaryJSON   string
		SecondaryJSON string
	}
	var versions []joinedDocument
	versionQuery := r.db.Table("asset_versions").
		Select("asset_versions.id, assets.title, asset_versions.definition_json AS primary_json").
		Joins("JOIN assets ON assets.id = asset_versions.asset_id").
		Where("assets.user_id = ? AND assets.id <> ?", userID, excludingAssetID)
	if err := versionQuery.Scan(&versions).Error; err != nil {
		return snapshot, err
	}
	for _, version := range versions {
		snapshot.Documents = append(snapshot.Documents, ResourceReferenceDocument{Kind: "素材", ID: version.ID, Title: version.Title, PrimaryJSON: version.PrimaryJSON})
	}

	var candidates []joinedDocument
	candidateQuery := r.db.Table("project_asset_candidates").
		Select("project_asset_candidates.id, projects.name AS title, project_asset_candidates.details_json AS primary_json").
		Joins("JOIN projects ON projects.id = project_asset_candidates.project_id").
		Where("projects.user_id = ?", userID)
	if err := candidateQuery.Scan(&candidates).Error; err != nil {
		return snapshot, err
	}
	for _, candidate := range candidates {
		snapshot.Documents = append(snapshot.Documents, ResourceReferenceDocument{Kind: "项目", ID: candidate.ID, Title: candidate.Title, PrimaryJSON: candidate.PrimaryJSON})
	}

	var steps []joinedDocument
	stepQuery := r.db.Table("workflow_step_instances").
		Select("workflow_step_instances.id, workflow_step_instances.name AS title, workflow_step_instances.input_json AS primary_json, workflow_step_instances.output_json AS secondary_json").
		Joins("JOIN workflow_instances ON workflow_instances.id = workflow_step_instances.workflow_instance_id").
		Joins("JOIN projects ON projects.id = workflow_instances.project_id").
		Where("projects.user_id = ?", userID)
	if err := stepQuery.Scan(&steps).Error; err != nil {
		return snapshot, err
	}
	for _, step := range steps {
		snapshot.Documents = append(snapshot.Documents, ResourceReferenceDocument{Kind: "工作流", ID: step.ID, Title: step.Title, PrimaryJSON: step.PrimaryJSON, SecondaryJSON: step.SecondaryJSON})
	}

	var shotArtifacts []joinedDocument
	artifactDocumentQuery := r.db.Table("shot_artifacts").
		Select("shot_artifacts.id, shots.title, shot_artifacts.metadata_json AS primary_json").
		Joins("JOIN shots ON shots.id = shot_artifacts.shot_id").
		Joins("JOIN projects ON projects.id = shots.project_id").
		Where("projects.user_id = ?", userID)
	if err := artifactDocumentQuery.Scan(&shotArtifacts).Error; err != nil {
		return snapshot, err
	}
	for _, artifact := range shotArtifacts {
		snapshot.Documents = append(snapshot.Documents, ResourceReferenceDocument{Kind: "镜头产物", ID: artifact.ID, Title: artifact.Title, PrimaryJSON: artifact.PrimaryJSON})
	}

	type joinedRepresentation struct {
		ID         string
		Title      string
		ResourceID string
	}
	var representations []joinedRepresentation
	if err := r.db.Table("asset_representations").
		Select("asset_representations.id, assets.title, asset_representations.resource_id").
		Joins("JOIN asset_versions ON asset_versions.id = asset_representations.asset_version_id").
		Joins("JOIN assets ON assets.id = asset_versions.asset_id").
		Where("assets.user_id = ? AND assets.id <> ? AND asset_representations.resource_id IN ?", userID, excludingAssetID, resourceIDs).
		Scan(&representations).Error; err != nil {
		return snapshot, err
	}
	for _, representation := range representations {
		snapshot.Direct = append(snapshot.Direct, ResourceDirectReference{Kind: "素材", ID: representation.ID, Title: representation.Title, ResourceID: representation.ResourceID})
	}

	var voices []model.VoiceProfile
	if err := r.db.Where("user_id = ? AND sample_resource_id IN ?", userID, resourceIDs).Find(&voices).Error; err != nil {
		return snapshot, err
	}
	for _, voice := range voices {
		snapshot.Direct = append(snapshot.Direct, ResourceDirectReference{Kind: "声音", ID: voice.ID, Title: voice.Name, ResourceID: voice.SampleResourceID})
	}

	type joinedShotArtifact struct {
		ID         string
		Title      string
		ResourceID string
	}
	var artifacts []joinedShotArtifact
	if err := r.db.Table("shot_artifacts").
		Select("shot_artifacts.id, shots.title, shot_artifacts.resource_id").
		Joins("JOIN shots ON shots.id = shot_artifacts.shot_id").
		Joins("JOIN projects ON projects.id = shots.project_id").
		Where("projects.user_id = ? AND shot_artifacts.resource_id IN ?", userID, resourceIDs).
		Scan(&artifacts).Error; err != nil {
		return snapshot, err
	}
	for _, artifact := range artifacts {
		snapshot.Direct = append(snapshot.Direct, ResourceDirectReference{Kind: "镜头产物", ID: artifact.ID, Title: artifact.Title, ResourceID: artifact.ResourceID})
	}

	libraryRefs, err := r.CanvasLibraryResourceReferences(userID, resourceIDs)
	if err != nil {
		return snapshot, err
	}
	snapshot.Direct = append(snapshot.Direct, libraryRefs...)

	return snapshot, nil
}

func (r *Repository) AssetBusinessReferences(userID string, assetID string) ([]ResourceDirectReference, error) {
	type projectReference struct {
		ID    string
		Title string
	}
	var projects []projectReference
	if err := r.db.Table("project_asset_links").
		Distinct("projects.id, projects.name AS title").
		Joins("JOIN projects ON projects.id = project_asset_links.project_id").
		Where("projects.user_id = ? AND project_asset_links.asset_id = ?", userID, assetID).
		Scan(&projects).Error; err != nil {
		return nil, err
	}
	var shotProjects []projectReference
	if err := r.db.Table("shot_asset_references").
		Distinct("projects.id, projects.name AS title").
		Joins("JOIN asset_versions ON asset_versions.id = shot_asset_references.asset_version_id").
		Joins("JOIN shots ON shots.id = shot_asset_references.shot_id").
		Joins("JOIN projects ON projects.id = shots.project_id").
		Where("projects.user_id = ? AND asset_versions.asset_id = ?", userID, assetID).
		Scan(&shotProjects).Error; err != nil {
		return nil, err
	}
	var candidateProjects []projectReference
	if err := r.db.Table("project_asset_candidates").
		Distinct("projects.id, projects.name AS title").
		Joins("JOIN projects ON projects.id = project_asset_candidates.project_id").
		Where("projects.user_id = ? AND project_asset_candidates.resolved_asset_id = ?", userID, assetID).
		Scan(&candidateProjects).Error; err != nil {
		return nil, err
	}
	result := make([]ResourceDirectReference, 0, len(projects)+len(shotProjects)+len(candidateProjects))
	for _, project := range append(append(projects, shotProjects...), candidateProjects...) {
		result = append(result, ResourceDirectReference{Kind: "项目", ID: project.ID, Title: project.Title})
	}
	return result, nil
}

// DeleteAssetAndResources removes the owned asset and its resources in one
// IMMEDIATE writer transaction. expectedStatus, when set, is checked against
// the row and applied to the delete so a restore cannot commit with this TX.
func (r *Repository) DeleteAssetAndResources(userID string, assetID string, resourceIDs []string, deletionJobs []model.ResourceDeletionJob, expectedStatus ...string) error {
	expected := ""
	if len(expectedStatus) > 0 {
		expected = strings.TrimSpace(expectedStatus[0])
	}
	return withImmediateTransaction(r.db, func(tx *gorm.DB) error {
		var asset model.Asset
		if err := tx.Where("id = ? AND user_id = ?", assetID, userID).First(&asset).Error; err != nil {
			return err
		}
		if expected != "" && string(asset.Status) != expected {
			return ErrAssetExpectedStatusMismatch
		}
		if err := guardAssetDeletionReferences(tx, userID, assetID, resourceIDs); err != nil {
			return err
		}
		if err := New(tx).RequireNoCanvasHistoryReferences(resourceIDs); err != nil {
			return err
		}
		versionIDs := tx.Model(&model.AssetVersion{}).Select("id").Where("asset_id = ?", assetID)
		if err := tx.Where("asset_version_id IN (?)", versionIDs).Delete(&model.ShotAssetReference{}).Error; err != nil {
			return err
		}
		if err := tx.Where("asset_version_id IN (?)", versionIDs).Delete(&model.CharacterVoiceBinding{}).Error; err != nil {
			return err
		}
		if err := tx.Where("asset_version_id IN (?)", versionIDs).Delete(&model.AssetRepresentation{}).Error; err != nil {
			return err
		}
		if err := tx.Where("asset_id = ?", assetID).Delete(&model.ProjectAssetLink{}).Error; err != nil {
			return err
		}
		if err := tx.Where("resolved_asset_id = ?", assetID).Delete(&model.ProjectAssetCandidate{}).Error; err != nil {
			return err
		}
		if err := tx.Where("asset_id = ?", assetID).Delete(&model.AssetVersion{}).Error; err != nil {
			return err
		}
		if expected != "" {
			result := tx.Where("id = ? AND user_id = ? AND status = ?", assetID, userID, expected).Delete(&model.Asset{})
			if result.Error != nil {
				return result.Error
			}
			if result.RowsAffected == 0 {
				return ErrAssetExpectedStatusMismatch
			}
		} else if err := tx.Delete(&model.Asset{}, "id = ? AND user_id = ?", assetID, userID).Error; err != nil {
			return err
		}
		if len(deletionJobs) > 0 {
			if err := tx.Create(&deletionJobs).Error; err != nil {
				return err
			}
		}
		if len(resourceIDs) == 0 {
			return nil
		}
		if err := tx.Where("resource_id IN ?", resourceIDs).Delete(&model.ArkPrivateAssetBinding{}).Error; err != nil {
			return err
		}
		var resources []model.Resource
		if err := tx.Where("user_id = ? AND id IN ?", userID, resourceIDs).Find(&resources).Error; err != nil {
			return err
		}
		if err := settleDeletedResources(tx, resources); err != nil {
			return err
		}
		return tx.Where("user_id = ? AND id IN ?", userID, resourceIDs).Delete(&model.Resource{}).Error
	})
}

// guardAssetDeletionReferences re-checks live documents and direct links inside
// the delete transaction so a reference added after the service snapshot cannot
// commit with the resource rows and outbox.
func guardAssetDeletionReferences(tx *gorm.DB, userID string, assetID string, resourceIDs []string) error {
	if err := guardAssetBusinessLinks(tx, assetID); err != nil {
		return err
	}
	if len(resourceIDs) == 0 {
		return nil
	}
	var assetDocuments []string
	if err := tx.Model(&model.Asset{}).Where("user_id = ? AND id <> ?", userID, assetID).Pluck("payload_json", &assetDocuments).Error; err != nil {
		return err
	}
	var canvasDocuments []string
	if err := tx.Model(&model.CanvasProject{}).Where("user_id = ?", userID).Pluck("payload_json", &canvasDocuments).Error; err != nil {
		return err
	}
	documents := append(assetDocuments, canvasDocuments...)
	for _, resourceID := range resourceIDs {
		storageKey := "resource:" + resourceID + `"`
		fileURL := "/api/resources/" + resourceID + "/"
		for _, document := range documents {
			if strings.Contains(document, storageKey) || strings.Contains(document, fileURL) {
				return ErrResourceCleanupStillReferenced
			}
		}
	}
	var representationCount int64
	if err := tx.Table("asset_representations").
		Joins("JOIN asset_versions ON asset_versions.id = asset_representations.asset_version_id").
		Where("asset_versions.asset_id <> ? AND asset_representations.resource_id IN ?", assetID, resourceIDs).
		Count(&representationCount).Error; err != nil {
		return err
	}
	if representationCount > 0 {
		return ErrResourceCleanupStillReferenced
	}
	for _, check := range []struct {
		model any
		query string
	}{
		{&model.VoiceProfile{}, "sample_resource_id IN ?"},
		{&model.ShotArtifact{}, "resource_id IN ?"},
	} {
		var count int64
		if err := tx.Model(check.model).Where(check.query, resourceIDs).Count(&count).Error; err != nil {
			return err
		}
		if count > 0 {
			return ErrResourceCleanupStillReferenced
		}
	}
	if err := guardCanvasLibraryResourceReferences(tx, userID, resourceIDs); err != nil {
		return err
	}
	if err := guardCanvasWorkflowResourceReferences(tx, userID, resourceIDs); err != nil {
		return err
	}
	return guardTaskResourceReferences(tx, userID, resourceIDs, true)
}

func guardCanvasWorkflowResourceReferences(tx *gorm.DB, userID string, resourceIDs []string) error {
	if len(resourceIDs) == 0 || !tx.Migrator().HasTable(&model.CanvasWorkflowResource{}) {
		return nil
	}
	var count int64
	if err := tx.Model(&model.CanvasWorkflowResource{}).Where("user_id = ? AND resource_id IN ?", userID, resourceIDs).Count(&count).Error; err != nil {
		return err
	}
	if count > 0 {
		return ErrResourceCleanupStillReferenced
	}
	return nil
}

func guardCanvasLibraryResourceReferences(tx *gorm.DB, userID string, resourceIDs []string) error {
	if len(resourceIDs) == 0 {
		return nil
	}
	if tx.Migrator().HasTable(&model.CanvasDrawing{}) {
		var count int64
		if err := liveCanvasDrawings(tx.Model(&model.CanvasDrawing{})).
			Where("user_id = ? AND (preview_resource_id IN ? OR render_resource_id IN ?)", userID, resourceIDs, resourceIDs).
			Count(&count).Error; err != nil {
			return err
		}
		if count > 0 {
			return ErrResourceCleanupStillReferenced
		}
	}
	if tx.Migrator().HasTable(&model.CanvasLibraryFolder{}) {
		var count int64
		if err := liveCanvasLibraryFolders(tx.Model(&model.CanvasLibraryFolder{})).
			Where("user_id = ? AND cover_resource_id IN ?", userID, resourceIDs).
			Count(&count).Error; err != nil {
			return err
		}
		if count > 0 {
			return ErrResourceCleanupStillReferenced
		}
	}
	return nil
}

func guardActiveTaskResourceReferences(tx *gorm.DB, userID string, resourceIDs []string) error {
	return guardTaskResourceReferences(tx, userID, resourceIDs, true)
}

func guardTaskResourceReferences(tx *gorm.DB, userID string, resourceIDs []string, skipCompletedOutput bool) error {
	if len(resourceIDs) == 0 {
		return nil
	}
	owned := make(map[string]struct{}, len(resourceIDs))
	for _, resourceID := range resourceIDs {
		owned[resourceID] = struct{}{}
	}
	var tasks []model.Task
	if err := tx.Select("id", "prompt", "status", "input_json", "result_json").Where("user_id = ?", userID).Find(&tasks).Error; err != nil {
		return err
	}
	statuses := make(map[string]model.TaskStatus, len(tasks))
	for _, task := range tasks {
		statuses[task.ID] = task.Status
		primary, secondary := task.InputJSON, task.ResultJSON
		if skipCompletedOutput {
			switch task.Status {
			case model.TaskStatusSucceeded, model.TaskStatusFailed, model.TaskStatusCancelled:
				secondary = ""
			}
		}
		if len(assets.DocumentReferencedIDs(primary, owned)) > 0 || len(assets.DocumentReferencedIDs(secondary, owned)) > 0 {
			return ErrResourceCleanupStillReferenced
		}
	}
	var logs []model.TaskLog
	if err := tx.Select("id", "task_id", "payload").Where("user_id = ?", userID).Find(&logs).Error; err != nil {
		return err
	}
	for _, log := range logs {
		if skipCompletedOutput {
			switch statuses[log.TaskID] {
			case model.TaskStatusSucceeded, model.TaskStatusFailed, model.TaskStatusCancelled:
				continue
			}
		}
		if len(assets.DocumentReferencedIDs(log.Payload, owned)) > 0 {
			return ErrResourceCleanupStillReferenced
		}
	}
	var results []model.Result
	if err := tx.Select("id", "task_id", "url", "payload").Where("user_id = ?", userID).Find(&results).Error; err != nil {
		return err
	}
	for _, result := range results {
		if skipCompletedOutput {
			switch statuses[result.TaskID] {
			case model.TaskStatusSucceeded, model.TaskStatusFailed, model.TaskStatusCancelled:
				continue
			}
		}
		if len(assets.DocumentReferencedIDs(result.URL, owned)) > 0 || len(assets.DocumentReferencedIDs(result.Payload, owned)) > 0 {
			return ErrResourceCleanupStillReferenced
		}
	}
	return nil
}

func withImmediateTransaction(db *gorm.DB, fn func(*gorm.DB) error) error {
	if db == nil {
		return gorm.ErrInvalidDB
	}
	// Creation approval already owns a transaction. Taking another pooled
	// connection here would deadlock the single-connection desktop database
	// and detach task admission from its approval/receipt rollback.
	if _, insideTransaction := db.Statement.ConnPool.(gorm.TxCommitter); insideTransaction {
		return db.Transaction(fn)
	}
	return db.Connection(func(conn *gorm.DB) error {
		tx := conn.Session(&gorm.Session{SkipDefaultTransaction: true, NewDB: true})
		if err := tx.Exec("BEGIN IMMEDIATE").Error; err != nil {
			return err
		}
		committed := false
		defer func() {
			if !committed {
				_ = tx.Exec("ROLLBACK").Error
			}
		}()
		if err := fn(tx); err != nil {
			return err
		}
		if err := tx.Exec("COMMIT").Error; err != nil {
			return err
		}
		committed = true
		return nil
	})
}

// RequireReadyOwnedResourcesTx is the admission-side counterpart of
// DeleteAssetAndResources. CreateTaskWithActiveLimit and RetryTask call it
// after resolving input resource IDs and before Create/Updates, in the same
// transaction as the task write.
//
// The no-op UPDATE takes SQLite's writer lock so WAL cannot commit a delete
// between the readiness check and the task insert. A plain SELECT is not
// enough: WAL readers do not block BEGIN IMMEDIATE. This package does not
// change the task worker.
func RequireReadyOwnedResourcesTx(tx *gorm.DB, userID string, resourceIDs []string) error {
	if tx == nil {
		return gorm.ErrInvalidDB
	}
	unique, err := uniqueResourceIDs(resourceIDs)
	if err != nil {
		return err
	}
	if len(unique) == 0 {
		return nil
	}
	result := tx.Model(&model.Resource{}).
		Where("user_id = ? AND id IN ? AND status = ?", userID, unique, model.ResourceStatusReady).
		UpdateColumn("id", gorm.Expr("id"))
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected != int64(len(unique)) {
		return ErrResourceNotReadyForAdmission
	}
	return nil
}

func uniqueResourceIDs(resourceIDs []string) ([]string, error) {
	seen := make(map[string]struct{}, len(resourceIDs))
	unique := make([]string, 0, len(resourceIDs))
	for _, id := range resourceIDs {
		id = strings.TrimSpace(id)
		if id == "" {
			return nil, ErrResourceNotReadyForAdmission
		}
		if _, exists := seen[id]; exists {
			continue
		}
		seen[id] = struct{}{}
		unique = append(unique, id)
	}
	return unique, nil
}

func (r *Repository) RequireReadyOwnedResources(userID string, resourceIDs []string) error {
	if r == nil || r.db == nil {
		return gorm.ErrInvalidDB
	}
	return RequireReadyOwnedResourcesTx(r.db, userID, resourceIDs)
}

func guardAssetBusinessLinks(tx *gorm.DB, assetID string) error {
	for _, check := range []struct {
		model any
		query string
		args  []any
	}{
		{&model.ProjectAssetLink{}, "asset_id = ?", []any{assetID}},
		{&model.ProjectAssetCandidate{}, "resolved_asset_id = ?", []any{assetID}},
	} {
		var count int64
		if err := tx.Model(check.model).Where(check.query, check.args...).Count(&count).Error; err != nil {
			return err
		}
		if count > 0 {
			return ErrResourceCleanupStillReferenced
		}
	}
	var shotCount int64
	if err := tx.Table("shot_asset_references").
		Joins("JOIN asset_versions ON asset_versions.id = shot_asset_references.asset_version_id").
		Where("asset_versions.asset_id = ?", assetID).
		Count(&shotCount).Error; err != nil {
		return err
	}
	if shotCount > 0 {
		return ErrResourceCleanupStillReferenced
	}
	return nil
}
