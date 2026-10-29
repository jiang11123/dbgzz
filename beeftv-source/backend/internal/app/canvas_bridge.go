package app

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"gorm.io/gorm"

	"infinite-canvas/backend/internal/assets"
	"infinite-canvas/backend/internal/canvas"
	"infinite-canvas/backend/internal/conversation"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/operations"
	"infinite-canvas/backend/internal/repository"
	localtask "infinite-canvas/backend/internal/task"
	"infinite-canvas/backend/internal/taskbinding"
)

type (
	AssetsSyncRequest    = canvas.AssetsSyncRequest
	CanvasHistoryList    = canvas.CanvasHistoryList
	UserDataSummary      = canvas.UserDataSummary
	UserDataSnapshot     = canvas.UserDataSnapshot
	CanvasLibrarySummary = canvas.CanvasLibrarySummary
	CanvasLibraryPage    = canvas.CanvasLibraryPage
	UserAssetPage        = canvas.UserAssetPage
	UserAssetPageFilter  = canvas.UserAssetPageFilter
)

type canvasHost struct {
	encryptSecret              func(string) (string, error)
	decryptSecret              func(string) (string, error)
	openResourceRange          func(string, *model.Resource, string) (*assets.ResourceStream, error)
	prepareResourceDelivery    func(string, *model.Resource, assets.ResourceDeliveryOptions) (*assets.ResourceDelivery, error)
	withStorageLock            func(func() error) error
	structuredQuota            func(string, string, bool, int64) error
	structuredBatchQuota       func(string, string, int, int64) error
	admitStructuredQuota       func(repository.UserStorageUsage, string, bool, int64) error
	structuredReplacementQuota func(string, string, int, int64) error
	deleteAsset                func(string, string, ...string) error
	recordActivity             func(string, string, int)
}

func (h canvasHost) EncryptSecret(value string) (string, error) {
	if h.encryptSecret == nil {
		return value, nil
	}
	return h.encryptSecret(value)
}

func (h canvasHost) DecryptSecret(value string) (string, error) {
	if h.decryptSecret == nil {
		return value, nil
	}
	return h.decryptSecret(value)
}

func (h canvasHost) OpenResourceRange(userID string, resource *model.Resource, rangeHeader string) (*assets.ResourceStream, error) {
	if h.openResourceRange == nil {
		return nil, nil
	}
	return h.openResourceRange(userID, resource, rangeHeader)
}

func (h canvasHost) PrepareResourceDelivery(userID string, resource *model.Resource, options assets.ResourceDeliveryOptions) (*assets.ResourceDelivery, error) {
	if h.prepareResourceDelivery == nil {
		return nil, nil
	}
	return h.prepareResourceDelivery(userID, resource, options)
}

func (h canvasHost) WithStorageLock(fn func() error) error {
	if h.withStorageLock == nil {
		if fn == nil {
			return nil
		}
		return fn()
	}
	return h.withStorageLock(fn)
}

func (h canvasHost) StructuredQuota(userID, kind string, creating bool, deltaBytes int64) error {
	if h.structuredQuota == nil {
		return nil
	}
	return h.structuredQuota(userID, kind, creating, deltaBytes)
}

func (h canvasHost) StructuredBatchQuota(userID, kind string, createdCount int, deltaBytes int64) error {
	if h.structuredBatchQuota == nil {
		return nil
	}
	return h.structuredBatchQuota(userID, kind, createdCount, deltaBytes)
}

func (h canvasHost) AdmitStructuredQuota(usage repository.UserStorageUsage, kind string, creating bool, deltaBytes int64) error {
	if h.admitStructuredQuota == nil {
		return nil
	}
	return h.admitStructuredQuota(usage, kind, creating, deltaBytes)
}

func (h canvasHost) StructuredReplacementQuota(userID, kind string, count int, bytes int64) error {
	if h.structuredReplacementQuota == nil {
		return nil
	}
	return h.structuredReplacementQuota(userID, kind, count, bytes)
}

func (h canvasHost) DeleteUserAssetWithResources(userID, assetID string, expectedStatus ...string) error {
	if h.deleteAsset == nil {
		return nil
	}
	return h.deleteAsset(userID, assetID, expectedStatus...)
}

func (h canvasHost) RecordActivity(userID, event string, count int) {
	if h.recordActivity == nil {
		return
	}
	h.recordActivity(userID, event, count)
}

// newCanvasHost 使用根仓储构造 host（常规请求路径）。
func newCanvasHost(service *Service) canvasHost {
	var repo *repository.Repository
	if service != nil {
		repo = service.repo
	}
	return newCanvasHostWithRepo(service, repo)
}

// repoHoldsTransaction reports that repo is already the caller's GORM
// transaction. The desktop pool has one SQLite connection; a nested
// storageMu here inverts createTaskWithinStorageQuota / 创作 Execute.
func repoHoldsTransaction(repo *repository.Repository) bool {
	return repo.HoldsTransaction()
}

// newCanvasHostWithRepo 与 newCanvasHost 完全一致，但配额/用量读取绑定到给定仓储。
// 事务内的领域写入必须走这里，否则会回到根连接取用量而与自己的事务互相等待。
func newCanvasHostWithRepo(service *Service, repo *repository.Repository) canvasHost {
	if service == nil {
		return canvasHost{}
	}
	return canvasHost{
		encryptSecret: service.encryptSettingSecret, decryptSecret: service.decryptSettingSecret,
		openResourceRange: service.openResourceRange, prepareResourceDelivery: service.prepareResourceDelivery,
		withStorageLock: func(fn func() error) error {
			insideTx := repoHoldsTransaction(repo)
			if insideTx {
				// 写事务已经占着唯一连接并串行化 SQLite 写者；配额读同一条连接。
				return fn()
			}
			service.storageMu.Lock()
			defer service.storageMu.Unlock()
			return fn()
		},
		structuredQuota: func(userID, kind string, creating bool, deltaBytes int64) error {
			policy, err := service.runtimePolicyWithRepo(repo)
			if err != nil {
				return err
			}
			usage, err := repo.UserStorageUsage(userID)
			if err != nil {
				return err
			}
			return validateStructuredStorageQuotaWithPolicy(usage, kind, creating, deltaBytes, policy.Resource)
		},
		structuredBatchQuota: func(userID, kind string, createdCount int, deltaBytes int64) error {
			policy, err := service.runtimePolicyWithRepo(repo)
			if err != nil {
				return err
			}
			usage, err := repo.UserStorageUsage(userID)
			if err != nil {
				return err
			}
			return validateStructuredCountQuotaWithPolicy(usage, kind, createdCount, deltaBytes, policy.Resource)
		},
		admitStructuredQuota: func(usage repository.UserStorageUsage, kind string, creating bool, deltaBytes int64) error {
			policy, err := service.runtimePolicyWithRepo(repo)
			if err != nil {
				return err
			}
			return validateStructuredStorageQuotaWithPolicy(usage, kind, creating, deltaBytes, policy.Resource)
		},
		structuredReplacementQuota: func(userID, kind string, count int, bytes int64) error {
			policy, err := service.runtimePolicyWithRepo(repo)
			if err != nil {
				return err
			}
			usage, err := repo.UserStorageUsage(userID)
			if err != nil {
				return err
			}
			return validateStructuredReplacementQuotaWithPolicy(usage, kind, count, bytes, policy.Resource)
		},
		deleteAsset: service.deleteUserAssetWithResources, recordActivity: service.recordActivity,
	}
}

func (s *Service) canvasDomain() *canvas.Service {
	if s == nil {
		return canvas.New(nil, nil)
	}
	if s.canvas != nil {
		return s.canvas
	}
	return canvas.New(s.repo, newCanvasHost(s))
}

func (s *Service) validateCanvasMediaAssets(userID string, raw json.RawMessage) error {
	return s.canvasDomain().ValidateCanvasMediaAssets(userID, raw)
}

func (s *Service) validateAssetCanvasReferences(userID string, asset model.Asset) error {
	return s.canvasDomain().ValidateAssetCanvasReferences(userID, asset)
}

func (s *Service) validateAssetReplacementCanvasReferences(userID string, replacement []model.Asset) error {
	return s.canvasDomain().ValidateAssetReplacementCanvasReferences(userID, replacement)
}

func (s *Service) UserDataSnapshot(userID string) (UserDataSnapshot, error) {
	return s.canvasDomain().UserDataSnapshot(userID)
}

func (s *Service) UserAssetSummaries(userID string) ([]UserDataSummary, error) {
	return s.canvasDomain().UserAssetSummaries(userID)
}

func (s *Service) UserAsset(userID string, id string) (json.RawMessage, error) {
	return s.canvasDomain().UserAsset(userID, id)
}

func (s *Service) UpsertUserAsset(userID string, raw json.RawMessage) (UserDataSummary, error) {
	return s.canvasDomain().UpsertUserAsset(userID, raw)
}

func (s *Service) DeleteUserAsset(userID string, id string, expectedStatus ...string) error {
	return s.canvasDomain().DeleteUserAsset(userID, id, expectedStatus...)
}

func (s *Service) UserAssets(userID string) ([]json.RawMessage, error) {
	return s.canvasDomain().UserAssets(userID)
}

func (s *Service) ReplaceUserAssets(userID string, req AssetsSyncRequest) ([]json.RawMessage, error) {
	return s.canvasDomain().ReplaceUserAssets(userID, req)
}

func (s *Service) UserCanvasProjects(userID string) ([]json.RawMessage, error) {
	return s.canvasDomain().UserCanvasProjects(userID)
}

func (s *Service) UserCanvasProjectSummaries(userID string) ([]UserDataSummary, error) {
	return s.canvasDomain().UserCanvasProjectSummaries(userID)
}

func (s *Service) UserCanvasProject(userID string, id string) (json.RawMessage, error) {
	return s.canvasDomain().UserCanvasProject(userID, id)
}

func (s *Service) UpsertUserCanvasProject(userID string, raw json.RawMessage) (UserDataSummary, error) {
	return s.canvasDomain().UpsertUserCanvasProject(userID, raw)
}

// Database 暴露本进程使用的数据库连接，供操作层与业务写入共用同一事务边界。
func (s *Service) Database() *gorm.DB {
	if s == nil || s.repo == nil {
		return nil
	}
	return s.repo.DB()
}

// canvasDomainWithTx 返回完全绑定到同一事务的画布领域服务：仓储与 host 的配额读取都用同一个连接。
func (s *Service) canvasDomainWithTx(tx *gorm.DB) *canvas.Service {
	repo := s.repo.WithTx(tx)
	return s.canvasDomain().WithRepository(repo).WithHost(newCanvasHostWithRepo(s, repo))
}

// UpsertUserCanvasProjectWithTx 把画布写入放进调用方给出的事务，使操作记录与业务写入原子提交。
func (s *Service) UpsertUserCanvasProjectWithTx(tx *gorm.DB, userID string, raw json.RawMessage) (UserDataSummary, error) {
	return s.canvasDomainWithTx(tx).UpsertUserCanvasProject(userID, raw)
}

func (s *Service) DeleteUserCanvasProject(userID string, id string) error {
	return s.canvasDomain().DeleteUserCanvasProject(userID, id)
}

func (s *Service) UserCanvasFolders(userID string) ([]model.CanvasLibraryFolder, error) {
	return s.canvasDomain().UserCanvasFolders(userID)
}

func (s *Service) UpsertUserCanvasFolder(userID, id string, raw json.RawMessage) (model.CanvasLibraryFolder, error) {
	var folder model.CanvasLibraryFolder
	err := s.runCanvasLibraryWrite(func(domain *canvas.Service) error {
		var writeErr error
		folder, writeErr = domain.UpsertUserCanvasFolder(userID, id, raw)
		return writeErr
	})
	return folder, err
}

func (s *Service) DeleteUserCanvasFolder(userID, id string) error {
	return s.runCanvasLibraryWrite(func(domain *canvas.Service) error {
		return domain.DeleteUserCanvasFolder(userID, id)
	})
}

func (s *Service) UserCanvasDrawings(userID, canvasID string) ([]canvas.CanvasDrawingDocument, error) {
	return s.canvasDomain().UserCanvasDrawings(userID, canvasID)
}

func (s *Service) UserCanvasDrawing(userID, canvasID, drawingID string) (canvas.CanvasDrawingDocument, error) {
	return s.canvasDomain().UserCanvasDrawing(userID, canvasID, drawingID)
}

func (s *Service) UpsertUserCanvasDrawing(userID, canvasID, drawingID string, raw json.RawMessage) (canvas.CanvasDrawingDocument, error) {
	var drawing canvas.CanvasDrawingDocument
	err := s.runCanvasLibraryWrite(func(domain *canvas.Service) error {
		var writeErr error
		drawing, writeErr = domain.UpsertUserCanvasDrawing(userID, canvasID, drawingID, raw)
		return writeErr
	})
	return drawing, err
}

func (s *Service) DeleteUserCanvasDrawing(userID, canvasID, drawingID string) error {
	return s.runCanvasLibraryWrite(func(domain *canvas.Service) error {
		return domain.DeleteUserCanvasDrawing(userID, canvasID, drawingID)
	})
}

// runCanvasLibraryWrite 在组合根开启写事务，并把 host 绑到同一条连接。
// 领域 withWriteTx 见到 HoldsTransaction 后不再嵌套 BEGIN。
func (s *Service) runCanvasLibraryWrite(fn func(*canvas.Service) error) error {
	if s == nil || s.repo == nil {
		return fn(s.canvasDomain())
	}
	if s.repo.HoldsTransaction() {
		return fn(s.canvasDomainWithTx(s.repo.DB()))
	}
	return newCanvasHost(s).WithStorageLock(func() error {
		return s.repo.Transaction(func(txRepo *repository.Repository) error {
			return fn(s.canvasDomainWithTx(txRepo.DB()))
		})
	})
}

func (s *Service) CanvasHistory(userID, canvasID string) (CanvasHistoryList, error) {
	return s.canvasDomain().CanvasHistory(userID, canvasID)
}

func (s *Service) CanvasHistorySnapshot(userID, canvasID, snapshotID string) (*model.CanvasSnapshot, error) {
	return s.canvasDomain().CanvasHistorySnapshot(userID, canvasID, snapshotID)
}

func (s *Service) RestoreCanvasHistory(userID, canvasID, snapshotID string, revision *int64) (UserDataSummary, error) {
	return s.canvasDomain().RestoreCanvasHistory(userID, canvasID, snapshotID, revision)
}

func saveCreationCanvasWithHistory(repo *repository.Repository, project *model.CanvasProject, previous string) error {
	before, err := repo.CanvasProjectForUser(project.UserID, project.ID)
	if err != nil {
		return err
	}
	if before.PayloadJSON != previous || before.Revision != project.Revision {
		return repository.ErrCreationConflict
	}
	project.UpdatedAt = time.Now().UTC()
	err = canvas.SaveDocumentWithHistory(repo, before, project, "automatic")
	if errors.Is(err, repository.ErrCanvasRevisionConflict) {
		return repository.ErrCreationConflict
	}
	return err
}

func (s *Service) UserAssetsByIDs(userID string, ids []string) ([]json.RawMessage, error) {
	return s.canvasDomain().UserAssetsByIDs(userID, ids)
}

func (s *Service) UserAssetsPage(userID string, page int, pageSize int, filter UserAssetPageFilter) (UserAssetPage, error) {
	return s.canvasDomain().UserAssetsPage(userID, page, pageSize, filter)
}

func (s *Service) UserCanvasProjectsPage(userID string, page int, pageSize int, projectID string, search string, sort string) (CanvasLibraryPage, error) {
	return s.canvasDomain().UserCanvasProjectsPage(userID, page, pageSize, projectID, search, sort)
}

func clientAssetPayload(asset model.Asset) json.RawMessage {
	return canvas.ClientAssetPayload(asset)
}

func validateSyncedPayload(raw json.RawMessage, label string) error {
	return canvas.ValidateSyncedPayload(raw, label)
}

func containsInlineMediaDataURL(value interface{}) bool {
	return canvas.ContainsInlineMediaDataURL(value)
}

func assetFromJSON(userID string, raw json.RawMessage) (model.Asset, error) {
	return canvas.AssetFromJSON(userID, raw)
}

// DataDir 返回本进程的数据目录，供操作层的本机客户端登记等本地状态使用。
func (s *Service) DataDir() string {
	if s == nil {
		return ""
	}
	return s.dataDir
}

// UserCanvasProjectWithTx 在调用方事务里读取画布，让操作层读写共用同一条连接。
func (s *Service) UserCanvasProjectWithTx(tx *gorm.DB, userID string, id string) (json.RawMessage, error) {
	return s.canvasDomainWithTx(tx).UserCanvasProject(userID, id)
}

// UserAssetWithTx 在调用方事务里读取素材，与写操作同事务。
func (s *Service) UserAssetWithTx(tx *gorm.DB, userID string, id string) (json.RawMessage, error) {
	return s.canvasDomainWithTx(tx).UserAsset(userID, id)
}

// 以下是内置 Agent/CLI/MCP 的统一写入口：领域实现拥有规格与连接规则，
// 操作层只做参数与幂等，写入与操作记录共用同一事务（tx 绑定仓储与 host）。
func (s *Service) CreateUserCanvasNodesWithTx(tx *gorm.DB, userID, canvasID string, drafts []canvas.NodeDraft, expectedRevision int64) (UserDataSummary, []canvas.CreatedNode, error) {
	return s.canvasDomainWithTx(tx).CreateUserCanvasNodes(userID, canvasID, drafts, expectedRevision)
}

func (s *Service) UpdateUserCanvasNodeFieldsWithTx(tx *gorm.DB, userID, canvasID, nodeID string, patch map[string]any, expectedRevision int64) (UserDataSummary, error) {
	return s.canvasDomainWithTx(tx).UpdateUserCanvasNodeFields(userID, canvasID, nodeID, patch, expectedRevision)
}

func (s *Service) ConnectUserCanvasNodesWithTx(tx *gorm.DB, userID, canvasID, fromNodeID, toNodeID string, expectedRevision int64) (UserDataSummary, error) {
	return s.canvasDomainWithTx(tx).ConnectUserCanvasNodesAtRevision(userID, canvasID, fromNodeID, toNodeID, expectedRevision)
}

// BindDomain 把当前事务绑成操作层 Domain：画布读写走同一条连接，任务/模型快照仍由组合根提供。
// 对话写入必须 WithTx(tx)，不能只换仓储再开第二层 Transaction，SQLite 会自锁。
func (s *Service) BindDomain(tx *gorm.DB) operations.Domain {
	if tx == nil {
		return &operationSession{canvas: s.canvasDomain(), service: s, repo: s.repo}
	}
	return &operationSession{canvas: s.canvasDomainWithTx(tx), service: s, repo: s.repo.WithTx(tx), tx: tx}
}

type operationSession struct {
	canvas  *canvas.Service
	service *Service
	repo    *repository.Repository
	tx      *gorm.DB
}

func (s *operationSession) UserCanvasProject(userID string, id string) (json.RawMessage, error) {
	return s.canvas.UserCanvasProject(userID, id)
}

func (s *operationSession) UserCanvasProjectsPage(userID string, page int, pageSize int, projectID string, search string, sort string) (canvas.CanvasLibraryPage, error) {
	return s.canvas.UserCanvasProjectsPage(userID, page, pageSize, projectID, search, sort)
}

func (s *operationSession) UserAssetsPage(userID string, page int, pageSize int, filter canvas.UserAssetPageFilter) (canvas.UserAssetPage, error) {
	return s.canvas.UserAssetsPage(userID, page, pageSize, filter)
}

func (s *operationSession) UserAsset(userID string, id string) (json.RawMessage, error) {
	return s.canvas.UserAsset(userID, id)
}

func (s *operationSession) Task(userID string, id string) (*model.Task, error) {
	return s.service.Task(userID, id)
}

func (s *operationSession) ResolveAssistantGenerationModel(kind, selectedModel string) (operations.AssistantGenerationModel, error) {
	display, modelKey, revision, kindMismatch, err := s.service.ResolveAssistantGenerationModel(kind, selectedModel)
	if err != nil {
		return operations.AssistantGenerationModel{}, err
	}
	return operations.AssistantGenerationModel{
		Display: display, ModelKey: modelKey, Revision: revision, KindMismatch: kindMismatch,
	}, nil
}

func (s *operationSession) CreateUserCanvasNodes(userID string, canvasID string, drafts []canvas.NodeDraft, expectedRevision int64) (canvas.UserDataSummary, []canvas.CreatedNode, error) {
	return s.canvas.CreateUserCanvasNodes(userID, canvasID, drafts, expectedRevision)
}

func (s *operationSession) PrepareUserCanvasStoryboard(userID, canvasID, nodeID string, input canvas.StoryboardPreparation, expectedRevision int64) (canvas.UserDataSummary, canvas.StoryboardPreparationResult, error) {
	return s.canvas.PrepareUserCanvasStoryboard(userID, canvasID, nodeID, input, expectedRevision)
}

func (s *operationSession) UpdateUserCanvasNodeFields(userID string, canvasID string, nodeID string, patch map[string]any, expectedRevision int64) (canvas.UserDataSummary, error) {
	return s.canvas.UpdateUserCanvasNodeFields(userID, canvasID, nodeID, patch, expectedRevision)
}

func (s *operationSession) ConnectUserCanvasNodesAtRevision(userID string, canvasID string, fromNodeID string, toNodeID string, expectedRevision int64) (canvas.UserDataSummary, error) {
	return s.canvas.ConnectUserCanvasNodesAtRevision(userID, canvasID, fromNodeID, toNodeID, expectedRevision)
}

func (s *operationSession) AppendUserCanvasStoryboardRows(userID string, canvasID string, nodeID string, drafts []canvas.StoryboardRowDraft, expectedRevision int64) (canvas.UserDataSummary, []canvas.StoryboardRowIdentity, error) {
	return s.canvas.AppendUserCanvasStoryboardRows(userID, canvasID, nodeID, drafts, expectedRevision)
}

func (s *operationSession) UpdateUserCanvasStoryboardRows(userID string, canvasID string, nodeID string, patches []canvas.StoryboardRowPatch, expectedRevision int64) (canvas.UserDataSummary, canvas.StoryboardRowUpdate, error) {
	return s.canvas.UpdateUserCanvasStoryboardRows(userID, canvasID, nodeID, patches, expectedRevision)
}

func (s *operationSession) RemoveUserCanvasStoryboardRows(userID string, canvasID string, nodeID string, rowIDs []string, expectedRevision int64) (canvas.UserDataSummary, int, error) {
	return s.canvas.RemoveUserCanvasStoryboardRows(userID, canvasID, nodeID, rowIDs, expectedRevision)
}

func (s *operationSession) CommitUserCanvasDocument(userID string, canvasID string, expectedRevision int64, document json.RawMessage) (canvas.UserDataSummary, json.RawMessage, error) {
	return s.canvas.CommitUserCanvasDocument(userID, canvasID, expectedRevision, document)
}

func (s *operationSession) WorkspaceTask(userID string, id string) (*model.Task, error) {
	if s.repo == nil {
		return nil, gorm.ErrRecordNotFound
	}
	task, err := s.repo.TaskForUser(userID, id)
	if err != nil {
		return nil, err
	}
	return task, nil
}

func (s *operationSession) GenerationOutputs(taskID string) ([]localtask.CanonicalOutput, error) {
	if s.repo == nil {
		return nil, nil
	}
	results, err := s.repo.GenerationOutputResults(taskID)
	if err != nil {
		return nil, err
	}
	outputs, err := localtask.DecodeOutputResults(results)
	if err != nil {
		return nil, &taskbinding.Error{Status: 412, Reason: localtask.MaterializeErrorDeliveryUnreadable, Message: "任务产物无法读取，不能当作已就绪结果绑定"}
	}
	return outputs, nil
}

func (s *operationSession) OwnedReadyResource(userID, resourceID string) (*model.Resource, error) {
	resourceID = strings.TrimSpace(resourceID)
	if s.repo == nil || resourceID == "" {
		return nil, &taskbinding.Error{Status: 412, Reason: localtask.MaterializeErrorResourceMissing, Message: "任务资源不存在"}
	}
	resource, err := s.repo.ResourceForUser(userID, resourceID)
	if err == nil {
		if resource.Status != model.ResourceStatusReady {
			return nil, &taskbinding.Error{Status: 412, Reason: localtask.MaterializeErrorResourceNotReady, Message: "任务资源未就绪"}
		}
		return resource, nil
	}
	if !errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, err
	}
	if _, lookupErr := s.repo.Resource(resourceID); lookupErr == nil {
		return nil, &taskbinding.Error{Status: 403, Reason: localtask.MaterializeErrorResourceForeign, Message: "任务资源不属于当前用户"}
	}
	return nil, &taskbinding.Error{Status: 412, Reason: localtask.MaterializeErrorResourceMissing, Message: "任务资源不存在"}
}

func (s *operationSession) OwnedAsset(userID, assetID string) (*model.Asset, error) {
	assetID = strings.TrimSpace(assetID)
	if s.repo == nil || assetID == "" {
		return nil, &taskbinding.Error{Status: 412, Reason: "output_not_ready", Message: "任务素材尚未就绪"}
	}
	asset, err := s.repo.AssetForUser(userID, assetID)
	if err == nil {
		return asset, nil
	}
	if !errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, err
	}
	existing, lookupErr := s.repo.Asset(assetID)
	if lookupErr == nil && existing != nil && existing.UserID != userID {
		return nil, &taskbinding.Error{Status: 403, Reason: localtask.MaterializeErrorAssetForeign, Message: "任务素材不属于当前用户"}
	}
	return nil, &taskbinding.Error{Status: 412, Reason: "output_not_ready", Message: "任务素材尚未就绪"}
}

func (s *operationSession) BindExistingCanvasNode(userID string, patch canvas.TaskOutputBind) (result canvas.TaskOutputBindResult, err error) {
	patch.AllowEmptyVideo = false
	patch.PendingClientOperationID = ""
	patch.TaskType = ""
	task, err := s.repo.TaskForUser(userID, patch.TaskID)
	if err != nil {
		return canvas.TaskOutputBindResult{}, err
	}
	if task != nil {
		patch.TaskType = task.Type
		fields := taskSupportFields(*task)
		fields.NodeID, fields.CanvasID = patch.NodeID, patch.CanvasID
		_, finishTrace := s.service.SupportTrace().Start(taskSupportContext(context.Background(), *task), "canvas.bind", fields)
		defer func() { finishTrace(supportFailureReason(err)) }()
	}
	if task != nil && task.UserID == userID && task.ProjectID == patch.CanvasID && task.Type == model.TaskTypeTimelineRender && task.Provider == "local" && task.Model == "ffmpeg" && task.Status == model.TaskStatusSucceeded {
		patch.AllowEmptyVideo = true
	}
	if task != nil && task.UserID == userID && task.ProjectID == patch.CanvasID && (task.Type == model.TaskTypeDepthCapture || task.Type == "canvas_video") && task.Status == model.TaskStatusSucceeded && task.ClientOperationID != nil {
		target := localtask.TargetBindingFromInput(task.InputJSON)
		if target.NodeID == patch.NodeID && target.Source == "canvas" {
			patch.PendingClientOperationID = strings.TrimSpace(*task.ClientOperationID)
		}
	}
	return s.canvas.BindTaskOutputToExistingNode(userID, patch)
}

func (s *operationSession) conversations() *conversation.Service {
	if s == nil || s.repo == nil {
		return conversation.New(nil)
	}
	svc := conversation.New(conversation.NewStore(s.repo))
	if s.tx != nil {
		return svc.WithTx(s.tx)
	}
	return svc
}

func (s *operationSession) UserConversation(userID, conversationID string) (taskbinding.ConversationView, error) {
	if s == nil || s.repo == nil {
		return taskbinding.ConversationView{}, gorm.ErrRecordNotFound
	}
	row, err := s.repo.CreationConversation(s.tx, userID, conversationID)
	if err != nil {
		return taskbinding.ConversationView{}, err
	}
	view := taskbinding.ConversationView{
		ID:       row.ConversationID,
		Revision: row.Revision,
		Deleted:  row.Deleted,
	}
	if !row.Deleted {
		view.Document = []byte(row.Document)
	}
	return view, nil
}

func (s *operationSession) AttachConversationMessage(userID string, input taskbinding.MessageAttachInput) (taskbinding.ConversationView, error) {
	record, err := s.conversations().AttachMessageResult(userID, conversation.AttachInput{
		ConversationID: input.ConversationID,
		MessageID:      input.MessageID,
		TaskID:         input.TaskID,
		EffectKey:      input.EffectKey,
		ResultURLs:     input.ResultURLs,
		Status:         input.Status,
		Content:        input.Content,
	})
	if err != nil {
		return taskbinding.ConversationView{}, mapConversationAttachError(err)
	}
	return taskbinding.ConversationView{
		ID:       record.ID,
		Revision: record.Revision,
		Deleted:  record.Deleted,
		Document: record.Document,
	}, nil
}

func mapConversationAttachError(err error) error {
	if err == nil {
		return nil
	}
	var convErr *conversation.Error
	if !errors.As(err, &convErr) {
		return err
	}
	switch convErr.Reason {
	case conversation.ReasonNotFound:
		return &taskbinding.Error{Status: 404, Reason: "conversation_deleted", Message: convErr.Message}
	case conversation.ReasonDeleted:
		return &taskbinding.Error{Status: 409, Reason: "conversation_deleted", Message: convErr.Message}
	case conversation.ReasonMessageTaskMismatch:
		return &taskbinding.Error{Status: 409, Reason: "message_task_mismatch", Message: convErr.Message}
	case conversation.ReasonStaleRevision, conversation.ReasonConflict:
		return &taskbinding.Error{Status: 409, Reason: "stale_revision", Message: convErr.Message}
	default:
		return &taskbinding.Error{Status: convErr.Status, Reason: convErr.Reason, Message: convErr.Message}
	}
}

var (
	_ operations.DomainBinder = (*Service)(nil)
	_ operations.Domain       = (*operationSession)(nil)
)
