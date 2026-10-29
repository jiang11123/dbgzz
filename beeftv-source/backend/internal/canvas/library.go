package canvas

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"

	"gorm.io/gorm"
)

const (
	canvasFolderNameMaxRunes  = 80
	canvasDrawingIDMaxRunes   = 80
	canvasDrawingEngineExcal  = "excalidraw"
	canvasDrawingDefaultPages = 1
)

type CanvasDrawingRender struct {
	ResourceID string `json:"resourceId,omitempty"`
	PageID     string `json:"pageId,omitempty"`
	Width      int    `json:"width,omitempty"`
	Height     int    `json:"height,omitempty"`
	MimeType   string `json:"mimeType,omitempty"`
	Background string `json:"background,omitempty"`
	StorageKey string `json:"storageKey,omitempty"`
}

type CanvasDrawingDocument struct {
	DrawingID         string               `json:"drawingId"`
	Engine            string               `json:"engine"`
	Revision          int64                `json:"revision"`
	Snapshot          json.RawMessage      `json:"snapshot,omitempty"`
	ShapeCount        int                  `json:"shapeCount"`
	PageCount         int                  `json:"pageCount"`
	PreviewResourceID string               `json:"previewResourceId,omitempty"`
	Render            *CanvasDrawingRender `json:"render,omitempty"`
	CreatedAt         time.Time            `json:"createdAt"`
	UpdatedAt         time.Time            `json:"updatedAt"`
}

func (s *Service) withWriteTx(fn func(*Service) error) error {
	if s == nil || s.repo == nil {
		return fn(s)
	}
	run := func() error {
		if s.repo.HoldsTransaction() {
			return fn(s)
		}
		return s.repo.Transaction(func(txRepo *repository.Repository) error {
			return fn(s.WithRepository(txRepo))
		})
	}
	if s.repo.HoldsTransaction() {
		return run()
	}
	return s.host.WithStorageLock(run)
}

func (s *Service) admitStructuredBytes(userID, kind string, creating bool, deltaBytes int64) error {
	if s.repo != nil && s.repo.HoldsTransaction() {
		usage, err := s.repo.UserStorageUsage(userID)
		if err != nil {
			return err
		}
		return s.host.AdmitStructuredQuota(usage, kind, creating, deltaBytes)
	}
	return s.host.StructuredQuota(userID, kind, creating, deltaBytes)
}

func (s *Service) UserCanvasFolders(userID string) ([]model.CanvasLibraryFolder, error) {
	return s.repo.CanvasLibraryFolders(userID)
}

func (s *Service) UpsertUserCanvasFolder(userID string, id string, raw json.RawMessage) (model.CanvasLibraryFolder, error) {
	var payload struct {
		ID              string `json:"id"`
		Name            string `json:"name"`
		CoverResourceID string `json:"coverResourceId"`
		CreatedAt       string `json:"createdAt"`
		UpdatedAt       string `json:"updatedAt"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return model.CanvasLibraryFolder{}, kernel.BadAuthRequest("文件夹数据格式错误")
	}
	folderID := strings.TrimSpace(id)
	if folderID == "" {
		folderID = strings.TrimSpace(payload.ID)
	}
	if folderID == "" {
		folderID = kernel.NewID()
	}
	if utf8.RuneCountInString(folderID) > 80 {
		return model.CanvasLibraryFolder{}, kernel.BadAuthRequest("文件夹 ID 无效")
	}
	if payload.ID != "" && strings.TrimSpace(payload.ID) != folderID {
		return model.CanvasLibraryFolder{}, kernel.BadAuthRequest("文件夹 ID 与请求路径不一致")
	}
	name := strings.TrimSpace(payload.Name)
	if name == "" {
		name = "未命名文件夹"
	}
	if utf8.RuneCountInString(name) > canvasFolderNameMaxRunes {
		return model.CanvasLibraryFolder{}, kernel.BadAuthRequest("文件夹名称过长")
	}
	coverID := strings.TrimSpace(payload.CoverResourceID)
	now := time.Now().UTC()
	folder := model.CanvasLibraryFolder{
		ID: folderID, UserID: userID, Name: name, CoverResourceID: coverID,
		CreatedAt: parseClientTime(payload.CreatedAt, now), UpdatedAt: now,
	}
	err := s.withWriteTx(func(svc *Service) error {
		if err := svc.ownedReadyResource(userID, coverID, "封面"); err != nil {
			return err
		}
		existing, existingErr := svc.repo.CanvasLibraryFolderIncludingDeleted(userID, folderID)
		if existingErr != nil && !errors.Is(existingErr, gorm.ErrRecordNotFound) {
			return existingErr
		}
		if existing != nil && existing.TombstonedAt != nil {
			return folderDeletedError()
		}
		if existing != nil {
			folder.CreatedAt = existing.CreatedAt
		}
		if err := svc.repo.UpsertCanvasLibraryFolder(&folder); err != nil {
			if errors.Is(err, repository.ErrCanvasLibraryFolderDeleted) {
				return folderDeletedError()
			}
			return err
		}
		return nil
	})
	if err != nil {
		return model.CanvasLibraryFolder{}, err
	}
	return folder, nil
}

func (s *Service) DeleteUserCanvasFolder(userID, id string) error {
	folderID := strings.TrimSpace(id)
	if folderID == "" {
		return kernel.BadAuthRequest("文件夹 ID 无效")
	}
	return s.withWriteTx(func(svc *Service) error {
		existing, err := svc.repo.CanvasLibraryFolderIncludingDeleted(userID, folderID)
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return kernel.NotFound("文件夹不存在")
		}
		if err != nil {
			return err
		}
		if existing.TombstonedAt != nil {
			return nil
		}
		projects, err := svc.repo.CanvasProjectsInLibraryFolder(userID, folderID)
		if err != nil {
			return err
		}
		now := time.Now().UTC()
		for index := range projects {
			before := projects[index]
			after := before
			after.LibraryFolderID = ""
			after.UpdatedAt = now
			payload, payloadErr := persistableCanvasPayload(after)
			if payloadErr != nil {
				return payloadErr
			}
			after.PayloadJSON = payload
			if err := SaveDocumentWithHistory(svc.repo, &before, &after, "automatic"); err != nil {
				if errors.Is(err, repository.ErrCanvasRevisionConflict) {
					return canvasRevisionConflict()
				}
				return err
			}
		}
		if err := svc.repo.TombstoneCanvasLibraryFolder(userID, folderID, now); err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return kernel.NotFound("文件夹不存在")
			}
			if errors.Is(err, repository.ErrCanvasLibraryFolderDeleted) {
				return nil
			}
			return err
		}
		return nil
	})
}

func (s *Service) UserCanvasDrawings(userID, canvasID string) ([]CanvasDrawingDocument, error) {
	if _, err := s.ownedCanvas(userID, canvasID); err != nil {
		return nil, err
	}
	items, err := s.repo.CanvasDrawings(userID, canvasID)
	if err != nil {
		return nil, err
	}
	result := make([]CanvasDrawingDocument, 0, len(items))
	for _, item := range items {
		result = append(result, canvasDrawingDocument(item, false))
	}
	return result, nil
}

func (s *Service) UserCanvasDrawing(userID, canvasID, drawingID string) (CanvasDrawingDocument, error) {
	if _, err := s.ownedCanvas(userID, canvasID); err != nil {
		return CanvasDrawingDocument{}, err
	}
	item, err := s.repo.CanvasDrawingForUser(userID, canvasID, strings.TrimSpace(drawingID))
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return CanvasDrawingDocument{}, kernel.NotFound("画板不存在")
	}
	if err != nil {
		return CanvasDrawingDocument{}, err
	}
	return canvasDrawingDocument(*item, true), nil
}

func (s *Service) UpsertUserCanvasDrawing(userID, canvasID, drawingID string, raw json.RawMessage) (CanvasDrawingDocument, error) {
	var payload struct {
		DrawingID         string               `json:"drawingId"`
		Engine            string               `json:"engine"`
		Revision          *int64               `json:"revision"`
		Snapshot          json.RawMessage      `json:"snapshot"`
		ShapeCount        int                  `json:"shapeCount"`
		PageCount         int                  `json:"pageCount"`
		PreviewResourceID string               `json:"previewResourceId"`
		Render            *CanvasDrawingRender `json:"render"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return CanvasDrawingDocument{}, kernel.BadAuthRequest("画板数据格式错误")
	}
	id := strings.TrimSpace(drawingID)
	if id == "" {
		return CanvasDrawingDocument{}, kernel.BadAuthRequest("画板 ID 无效")
	}
	if utf8.RuneCountInString(id) > canvasDrawingIDMaxRunes {
		return CanvasDrawingDocument{}, kernel.BadAuthRequest("画板 ID 无效")
	}
	if payload.DrawingID != "" && strings.TrimSpace(payload.DrawingID) != id {
		return CanvasDrawingDocument{}, kernel.BadAuthRequest("画板 ID 与请求路径不一致")
	}
	if payload.Revision == nil {
		return CanvasDrawingDocument{}, kernel.NewAppError(http.StatusPreconditionRequired, "缺少画板版本，请保留本地草稿后重新加载")
	}
	if *payload.Revision < 0 || *payload.Revision >= 9007199254740991 {
		return CanvasDrawingDocument{}, kernel.BadAuthRequest("画板版本无效")
	}
	engine := strings.TrimSpace(payload.Engine)
	if engine == "" {
		engine = canvasDrawingEngineExcal
	}
	if engine != canvasDrawingEngineExcal {
		return CanvasDrawingDocument{}, kernel.BadAuthRequest("画板引擎无效")
	}
	snapshot := payload.Snapshot
	if len(snapshot) == 0 {
		snapshot = json.RawMessage(`{}`)
	}
	if !json.Valid(snapshot) {
		return CanvasDrawingDocument{}, kernel.BadAuthRequest("画板数据格式错误")
	}
	previewID := strings.TrimSpace(payload.PreviewResourceID)
	render := payload.Render
	renderID := ""
	if render != nil {
		renderID = strings.TrimSpace(render.ResourceID)
		if render.Background != "" && render.Background != "white" {
			return CanvasDrawingDocument{}, kernel.BadAuthRequest("画板成品背景无效")
		}
	}
	pageCount := payload.PageCount
	if pageCount <= 0 {
		pageCount = canvasDrawingDefaultPages
	}
	if pageCount > 1 {
		pageCount = 1
	}
	now := time.Now().UTC()
	row := model.CanvasDrawing{
		UserID: userID, DrawingID: id, Engine: engine,
		Revision: *payload.Revision, SnapshotJSON: string(snapshot),
		ShapeCount: payload.ShapeCount, PageCount: pageCount,
		PreviewResourceID: previewID, CreatedAt: now, UpdatedAt: now,
	}
	if render != nil {
		row.RenderResourceID = renderID
		row.RenderPageID = strings.TrimSpace(render.PageID)
		row.RenderWidth = render.Width
		row.RenderHeight = render.Height
		row.RenderMimeType = strings.TrimSpace(render.MimeType)
		row.RenderBackground = strings.TrimSpace(render.Background)
		row.RenderStorageKey = strings.TrimSpace(render.StorageKey)
	}
	err := s.withWriteTx(func(svc *Service) error {
		canvasRow, err := svc.ownedCanvas(userID, canvasID)
		if err != nil {
			return err
		}
		row.CanvasID = canvasRow.ID
		if err := svc.ownedReadyResource(userID, previewID, "画板预览"); err != nil {
			return err
		}
		if render != nil {
			if err := svc.ownedReadyResource(userID, renderID, "画板成品"); err != nil {
				return err
			}
		}
		existing, existingErr := svc.repo.CanvasDrawingIncludingDeleted(userID, canvasRow.ID, id)
		if existingErr != nil && !errors.Is(existingErr, gorm.ErrRecordNotFound) {
			return existingErr
		}
		if existing != nil && existing.TombstonedAt != nil {
			return drawingDeletedError()
		}
		if existing != nil {
			row.CreatedAt = existing.CreatedAt
			if render == nil {
				row.RenderResourceID = existing.RenderResourceID
				row.RenderPageID = existing.RenderPageID
				row.RenderWidth = existing.RenderWidth
				row.RenderHeight = existing.RenderHeight
				row.RenderMimeType = existing.RenderMimeType
				row.RenderBackground = existing.RenderBackground
				row.RenderStorageKey = existing.RenderStorageKey
			}
			if row.Revision+1 == existing.Revision && drawingWriteMatches(*existing, row) {
				row = *existing
				return nil
			}
		}
		if (existing == nil && row.Revision != 0) || (existing != nil && row.Revision != existing.Revision) {
			return drawingRevisionConflict()
		}
		existingBytes := int64(0)
		if existing != nil {
			existingBytes = int64(len(existing.SnapshotJSON))
		}
		if err := svc.admitStructuredBytes(userID, "canvas", false, int64(len(row.SnapshotJSON))-existingBytes); err != nil {
			return err
		}
		if err := svc.repo.UpsertCanvasDrawing(&row); err != nil {
			if errors.Is(err, repository.ErrCanvasDrawingDeleted) {
				return drawingDeletedError()
			}
			if errors.Is(err, repository.ErrCanvasRevisionConflict) {
				return drawingRevisionConflict()
			}
			return err
		}
		return nil
	})
	if err != nil {
		return CanvasDrawingDocument{}, err
	}
	return canvasDrawingDocument(row, true), nil
}

func (s *Service) DeleteUserCanvasDrawing(userID, canvasID, drawingID string) error {
	id := strings.TrimSpace(drawingID)
	if id == "" {
		return kernel.BadAuthRequest("画板 ID 无效")
	}
	return s.withWriteTx(func(svc *Service) error {
		if _, err := svc.ownedCanvas(userID, canvasID); err != nil {
			return err
		}
		err := svc.repo.TombstoneCanvasDrawing(userID, canvasID, id, time.Now().UTC())
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return kernel.NotFound("画板不存在")
		}
		if errors.Is(err, repository.ErrCanvasDrawingDeleted) {
			return nil
		}
		return err
	})
}

func (s *Service) ownedCanvas(userID, canvasID string) (*model.CanvasProject, error) {
	id := strings.TrimSpace(canvasID)
	if id == "" {
		return nil, kernel.BadAuthRequest("画布 ID 无效")
	}
	project, err := s.repo.CanvasProjectForUser(userID, id)
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, kernel.NotFound("画布不存在或无权访问")
	}
	if err != nil {
		return nil, err
	}
	return project, nil
}

func (s *Service) ownedReadyResource(userID, id, label string) error {
	id = strings.TrimSpace(id)
	if id == "" {
		return nil
	}
	resource, err := s.repo.ResourceForUser(userID, id)
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return kernel.BadAuthRequest(label + "资源不存在")
	}
	if err != nil {
		return err
	}
	if resource.Status != model.ResourceStatusReady {
		return kernel.BadAuthRequest(label + "资源尚未就绪")
	}
	return nil
}

func (s *Service) requireCanvasLibraryFolder(userID, folderID string) error {
	folderID = strings.TrimSpace(folderID)
	if folderID == "" {
		return nil
	}
	_, err := s.repo.CanvasLibraryFolderForUser(userID, folderID)
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return kernel.BadAuthRequest("画布文件夹不存在")
	}
	return err
}

func persistableCanvasPayload(project model.CanvasProject) (string, error) {
	raw, err := canvasProjectPayload(project)
	if err != nil {
		return "", err
	}
	var payload map[string]json.RawMessage
	if err := json.Unmarshal(raw, &payload); err != nil {
		return "", err
	}
	delete(payload, "revision")
	delete(payload, "remoteContentHash")
	cleaned, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}
	return string(cleaned), nil
}

func canvasDrawingDocument(item model.CanvasDrawing, includeSnapshot bool) CanvasDrawingDocument {
	doc := CanvasDrawingDocument{
		DrawingID: item.DrawingID, Engine: item.Engine, Revision: item.Revision,
		ShapeCount: item.ShapeCount, PageCount: item.PageCount,
		PreviewResourceID: item.PreviewResourceID,
		CreatedAt:         item.CreatedAt, UpdatedAt: item.UpdatedAt,
	}
	if includeSnapshot && item.SnapshotJSON != "" {
		doc.Snapshot = json.RawMessage(item.SnapshotJSON)
	}
	if item.RenderResourceID != "" || item.RenderPageID != "" || item.RenderStorageKey != "" {
		doc.Render = &CanvasDrawingRender{
			ResourceID: item.RenderResourceID, PageID: item.RenderPageID,
			Width: item.RenderWidth, Height: item.RenderHeight,
			MimeType: item.RenderMimeType, Background: item.RenderBackground,
			StorageKey: item.RenderStorageKey,
		}
	}
	return doc
}

func drawingWriteMatches(existing, next model.CanvasDrawing) bool {
	return existing.Engine == next.Engine &&
		existing.SnapshotJSON == next.SnapshotJSON &&
		existing.ShapeCount == next.ShapeCount &&
		existing.PageCount == next.PageCount &&
		existing.PreviewResourceID == next.PreviewResourceID &&
		existing.RenderResourceID == next.RenderResourceID &&
		existing.RenderPageID == next.RenderPageID &&
		existing.RenderWidth == next.RenderWidth &&
		existing.RenderHeight == next.RenderHeight &&
		existing.RenderMimeType == next.RenderMimeType &&
		existing.RenderBackground == next.RenderBackground &&
		existing.RenderStorageKey == next.RenderStorageKey
}

func drawingRevisionConflict() error {
	return kernel.NewAppError(http.StatusConflict, "画板已有更新，已停止覆盖；请保留本地草稿并加载最新版本")
}

func drawingDeletedError() error {
	return &kernel.AppError{
		Status: http.StatusConflict, Code: kernel.CodeConflict,
		Reason: kernel.ReasonFailedPrecondition, Message: "画板已删除，不能重新导入",
	}
}

func folderDeletedError() error {
	return &kernel.AppError{
		Status: http.StatusConflict, Code: kernel.CodeConflict,
		Reason: kernel.ReasonFailedPrecondition, Message: "文件夹已删除，不能重新导入",
	}
}
