package app

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"path/filepath"
	"strings"
	"time"

	localasset "infinite-canvas/backend/internal/asset"
	"infinite-canvas/backend/internal/generation"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/outbound"
	"infinite-canvas/backend/internal/protocol"
	"infinite-canvas/backend/internal/repository"
	localtask "infinite-canvas/backend/internal/task"
	"infinite-canvas/backend/internal/taskdelivery"

	"gorm.io/gorm"
)

const generationDeliveryRecoveryInterval = 5 * time.Second

func (s *Service) DeliverSucceededTask(task model.Task) error {
	err := s.generationDeliverer().Deliver(task)
	if bindErr := s.recoverCanvasTaskBindings(task); bindErr != nil {
		log.Printf("generation canvas bind deferred: task_id=%s error=%v", task.ID, bindErr)
	}
	return err
}

func (s *Service) RecoverIncompleteGenerationDeliveries(limit int) error {
	err := s.generationDeliverer().RecoverIncomplete(limit)
	if bindErr := s.recoverPendingCanvasBindings(limit); bindErr != nil {
		log.Printf("generation canvas bind recovery paused: worker_id=%s error=%v", s.workerID, bindErr)
	}
	return err
}

func (s *Service) CanvasBindingIntents(task model.Task) []localtask.CanvasBindingIntent {
	stored, loadErr := s.generationDeliverer().LoadedOutputs(task.ID)
	proj := taskdelivery.Project(task, stored, loadErr, persistedFailureBlocksRetry(task.Error, task.Stage))
	return localtask.CanvasBindingIntents(task.ID, proj.Outputs)
}

func (s *Service) ensureSucceededTaskDelivery(task *model.Task) error {
	if task == nil || task.Status != model.TaskStatusSucceeded {
		return nil
	}
	stored, err := s.generationDeliverer().LoadedOutputs(task.ID)
	if err != nil {
		return err
	}
	if localtask.DeliveryComplete(task.ResultJSON, stored, task.Type) {
		return nil
	}
	return s.DeliverSucceededTask(*task)
}

func (s *Service) attachTaskDelivery(task *model.Task) {
	if task == nil {
		return
	}
	stored, loadErr := s.generationDeliverer().LoadedOutputs(task.ID)
	proj := taskdelivery.Project(*task, stored, loadErr, persistedFailureBlocksRetry(task.Error, task.Stage))
	task.Outputs = modelTaskOutputs(proj.Outputs)
	task.ResultState = proj.ResultState
	task.Stage = proj.Stage
	task.Delivery = s.deliveryProgressRegistry().forTask(task.ID)
	task.ReferenceProgress = s.referenceProgressForTask(task.ID)
}

func (s *Service) attachTaskSummaryDeliveries(tasks []model.Task, summaries []TaskSummary) {
	if len(tasks) == 0 || len(summaries) == 0 {
		return
	}
	ids := make([]string, 0, len(tasks))
	taskByID := make(map[string]model.Task, len(tasks))
	for _, task := range tasks {
		ids = append(ids, task.ID)
		taskByID[task.ID] = task
	}
	byTask, decodeErrs, loadErr := s.generationDeliverer().LoadedOutputsForTasks(ids)
	for index := range summaries {
		task, ok := taskByID[summaries[index].ID]
		if !ok {
			continue
		}
		taskLoadErr := loadErr
		if taskLoadErr == nil {
			taskLoadErr = decodeErrs[task.ID]
		}
		proj := taskdelivery.Project(task, byTask[task.ID], taskLoadErr, persistedFailureBlocksRetry(task.Error, task.Stage))
		summaries[index].Outputs = proj.Outputs
		summaries[index].ResultState = proj.ResultState
		summaries[index].Stage = proj.Stage
		summaries[index].Delivery = s.deliveryProgressRegistry().forTask(task.ID)
		summaries[index].ReferenceProgress = s.referenceProgressForTask(task.ID)
	}
}

func (s *Service) attachRecoveredProviderTask(task *model.Task) *model.Task {
	if task == nil {
		return nil
	}
	if err := s.DeliverSucceededTask(*task); err != nil {
		_ = s.log(task.UserID, task.ID, "error", "任务恢复成功但结果交付失败", err.Error())
	}
	projected := taskForOutput(*task)
	s.attachTaskDelivery(projected)
	return projected
}

func (s *Service) startGenerationDeliveryRecovery(context.Context) {
	s.runWorkerLoop(func(ctx context.Context) {
		recoverOnce := func() {
			if ctx.Err() != nil || s.IsDraining() {
				return
			}
			if err := s.RecoverIncompleteGenerationDeliveries(0); err != nil {
				log.Printf("generation delivery recovery paused: worker_id=%s error=%v", s.workerID, err)
			}
			s.recoverAssistantContinuations(ctx)
		}
		recoverOnce()
		ticker := time.NewTicker(generationDeliveryRecoveryInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				recoverOnce()
			}
		}
	})
}

func (s *Service) generationDeliverer() *taskdelivery.Deliverer {
	if s == nil {
		return taskdelivery.New(generationDeliveryStore{}, nil)
	}
	s.deliveryMu.Lock()
	defer s.deliveryMu.Unlock()
	if s.generationDelivery == nil {
		// One Deliverer per Service so recovery ticks keep the keyset cursor.
		s.generationDelivery = taskdelivery.New(generationDeliveryStore{repo: s.repo}, s.deliveryMedia())
	}
	return s.generationDelivery
}

func (s *Service) deliveryMedia() taskdelivery.Media {
	if s != nil && s.generationDeliveryMedia != nil {
		return s.generationDeliveryMedia
	}
	if s == nil || (s.platform == nil && strings.TrimSpace(s.dataDir) == "") {
		return nil
	}
	return generationDeliveryMediaAdapter{service: s}
}

func modelTaskOutputs(outputs []localtask.CanonicalOutput) []model.TaskOutput {
	if len(outputs) == 0 {
		return nil
	}
	result := make([]model.TaskOutput, 0, len(outputs))
	for _, output := range outputs {
		item := model.TaskOutput{
			OutputIndex:              output.OutputIndex,
			MediaType:                output.MediaType,
			ProviderArtifactRef:      output.ProviderArtifactRef,
			MaterializedAssetID:      output.MaterializedAssetID,
			MaterializationErrorCode: output.MaterializationErrorCode,
			ResourceID:               output.ResourceID,
			EffectKey:                output.EffectKey,
		}
		if output.TargetBinding != nil && !output.TargetBinding.Empty() {
			item.TargetBinding = &model.TaskOutputTarget{
				NodeID:         output.TargetBinding.NodeID,
				MessageID:      output.TargetBinding.MessageID,
				ConversationID: output.TargetBinding.ConversationID,
				Source:         output.TargetBinding.Source,
			}
		}
		result = append(result, item)
	}
	return result
}

type generationDeliveryStore struct {
	repo *repository.Repository
}

func (s generationDeliveryStore) WithTx(fn func(taskdelivery.Store) error) error {
	if s.repo == nil {
		return errors.New("generation delivery store is not initialized")
	}
	return s.repo.Transaction(func(tx *repository.Repository) error {
		return fn(generationDeliveryStore{repo: tx})
	})
}

func (s generationDeliveryStore) GenerationOutputResults(taskID string) ([]model.Result, error) {
	return s.repo.GenerationOutputResults(taskID)
}

func (s generationDeliveryStore) GenerationOutputResultsForTasks(taskIDs []string) ([]model.Result, error) {
	return s.repo.GenerationOutputResultsForTasks(taskIDs)
}

func (s generationDeliveryStore) AssetRepresentationsForTask(taskID string) ([]model.AssetRepresentation, error) {
	return s.repo.AssetRepresentationsForTask(taskID)
}

func (s generationDeliveryStore) ResourceForUser(userID, id string) (*model.Resource, error) {
	resource, err := s.repo.ResourceForUser(userID, id)
	return resource, mapDeliveryStoreErr(err)
}

func (s generationDeliveryStore) Resource(id string) (*model.Resource, error) {
	resource, err := s.repo.Resource(id)
	return resource, mapDeliveryStoreErr(err)
}

func (s generationDeliveryStore) Asset(id string) (*model.Asset, error) {
	asset, err := s.repo.Asset(id)
	return asset, mapDeliveryStoreErr(err)
}

func (s generationDeliveryStore) AssetVersion(id string) (*model.AssetVersion, error) {
	version, err := s.repo.AssetVersion(id)
	return version, mapDeliveryStoreErr(err)
}

func (s generationDeliveryStore) CommitOwned(item taskdelivery.OwnedDelivery) error {
	if err := mapDeliveryStoreErr(s.repo.CommitOwnedGenerationDelivery(repository.GenerationDeliveryItem{
		Result:         item.Result,
		Asset:          item.Asset,
		Version:        item.Version,
		Representation: item.Representation,
	})); err != nil {
		return err
	}
	// Completing every output clears both a resumed download and a concurrent
	// pause. Leave unrelated generation stages untouched.
	task, err := s.repo.Task(item.Result.TaskID)
	if err != nil || (!deliveryPaused(task.Stage) && task.Stage != "正在取回结果" && !strings.Contains(task.InputJSON, `"imageDeliveryCipher"`)) {
		return err
	}
	rows, err := s.repo.GenerationOutputResults(task.ID)
	if err != nil {
		return err
	}
	outputs, err := taskdelivery.DecodeStoredOutputs(rows)
	if err != nil {
		return err
	}
	if localtask.DeliveryComplete(task.ResultJSON, outputs, task.Type) {
		return s.repo.FinishGenerationDelivery(task.UserID, task.ID, task.InputJSON, publicTaskInputJSON(task.InputJSON))
	}
	return nil
}

func (s generationDeliveryStore) SucceededTasksForDelivery(afterID string, limit int) ([]model.Task, error) {
	return s.repo.SucceededTasksForDelivery(afterID, limit)
}

func mapDeliveryStoreErr(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return taskdelivery.ErrNotFound
	}
	if errors.Is(err, repository.ErrAssetOwnedByAnotherUser) {
		return taskdelivery.ErrForeignAsset
	}
	return err
}

type generationDeliveryMediaAdapter struct {
	service *Service
}

func (a generationDeliveryMediaAdapter) PersistRemoteArtifact(userID, mediaType, artifactURL, identity string) (*model.Resource, error) {
	if a.service == nil {
		return nil, errors.New("generation media adapter is not initialized")
	}
	userID = strings.TrimSpace(userID)
	artifactURL = strings.TrimSpace(artifactURL)
	identity = strings.TrimSpace(identity)
	if userID == "" || artifactURL == "" || identity == "" {
		return nil, fmt.Errorf("generation artifact identity is incomplete")
	}
	return a.service.resourceDomain().RecoverOwned(userID, identity, func() (localasset.RecoveredArtifact, error) {
		kind, data, mimeType, fileName, width, height, durationMs, err := a.decodeGenerationArtifact(userID, identity, mediaType, artifactURL)
		if err != nil {
			return localasset.RecoveredArtifact{}, err
		}
		return localasset.RecoveredArtifact{
			Kind: kind, FileName: fileName, MimeType: mimeType,
			Size: int64(len(data)), Width: width, Height: height, DurationMs: durationMs,
			Body: bytes.NewReader(data),
		}, nil
	})
}

func (a generationDeliveryMediaAdapter) decodeGenerationArtifact(userID, identity, mediaType, artifactURL string) (kind string, data []byte, mimeType, fileName string, width, height int, durationMs int64, err error) {
	kind = strings.TrimSpace(mediaType)
	switch {
	case strings.HasPrefix(artifactURL, "data:"):
		decodedType, decoded, decodeErr := a.service.decodeDataURL(artifactURL)
		if decodeErr != nil {
			return "", nil, "", "", 0, 0, 0, decodeErr
		}
		mimeType, data = decodedType, decoded
		kind = normalizeResourceKind(kind, mimeType)
		fileName = "generated." + extensionFromMimeType(mimeType)
		if kind == "image" {
			width, height = imageDimensions(data)
		}
		if kind == "video" {
			width, height, durationMs = probeGeneratedVideoMedia(data)
		}
		return kind, data, mimeType, fileName, width, height, durationMs, nil
	case strings.HasPrefix(artifactURL, "http://") || strings.HasPrefix(artifactURL, "https://"):
		ctx, finish, contextErr := a.service.beginGenerationDownload(userID, identity, generationDownloadTimeout)
		if contextErr != nil {
			return "", nil, "", "", 0, 0, 0, contextErr
		}
		defer func() { finish(err) }()
		if _, urlErr := validateRemoteResourceURL(artifactURL); urlErr != nil {
			return "", nil, "", "", 0, 0, 0, urlErr
		}
		policy, policyErr := a.service.RuntimePolicy()
		if policyErr != nil {
			return "", nil, "", "", 0, 0, 0, policyErr
		}
		maxBytes := megabytes(policy.Resource.GeneratedFileMB) + 1
		progress := a.service.deliveryProgressRegistry()
		headers, headerErr := a.imageDownloadHeaders(userID, identity, kind, artifactURL)
		if headerErr != nil {
			return "", nil, "", "", 0, 0, 0, headerErr
		}
		result, downloadErr := outbound.DownloadResumable(ctx, artifactURL, outbound.ResumableOptions{
			PartialPath: a.artifactDownloadPartialPath(userID, identity),
			Headers:     headers,
			MaxBytes:    maxBytes,
			OnProgress: func(update outbound.ResumableProgress) {
				progress.record(identity, deliveryProgressFromOutbound(identity, update))
			},
		})
		progress.clear(identity)
		if downloadErr != nil {
			if errors.Is(downloadErr, outbound.ErrResourceTooLarge) {
				return "", nil, "", "", 0, 0, 0, BadAuthRequest(fmt.Sprintf("远程资源必须小于 %s", formatStorageLimit(maxBytes)))
			}
			return "", nil, "", "", 0, 0, 0, downloadErr
		}
		mimeType, data = result.MimeType, result.Data
		if kind == "image" {
			if validationErr := generation.ValidateImageArtifact(data, mimeType); validationErr != nil {
				return "", nil, "", "", 0, 0, 0, validationErr
			}
		}
		kind = normalizeResourceKind(kind, mimeType)
		fileName = result.FileName
		if fileName == "" {
			fileName = "resource." + extensionFromMimeType(mimeType)
		}
		if kind == "image" {
			width, height = imageDimensions(data)
		}
		if kind == "video" {
			probedWidth, probedHeight, probedDurationMs := probeGeneratedVideoMedia(data)
			if width <= 0 {
				width = probedWidth
			}
			if height <= 0 {
				height = probedHeight
			}
			if durationMs <= 0 {
				durationMs = probedDurationMs
			}
		}
		return kind, data, mimeType, fileName, width, height, durationMs, nil
	default:
		return "", nil, "", "", 0, 0, 0, fmt.Errorf("unsupported generation artifact %q", artifactURL)
	}
}

// Retain same-origin provider authentication for deferred image downloads.
// Headers are request-local and never written to a download sidecar.
func (a generationDeliveryMediaAdapter) imageDownloadHeaders(userID, identity, kind, artifactURL string) (http.Header, error) {
	if kind != "image" {
		return nil, nil
	}
	taskID, _, ok := strings.Cut(identity, ":")
	if !ok {
		return nil, errors.New("generation artifact identity is incomplete")
	}
	task, err := a.service.repo.TaskForUser(userID, taskID)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(task.InputJSON) == "" {
		return nil, nil
	}
	plain, err := a.service.decryptTaskInputJSON(task.InputJSON)
	if err != nil {
		return nil, err
	}
	var input canvasGenerationInput
	if err := json.Unmarshal([]byte(plain), &input); err != nil {
		return nil, err
	}
	var retained struct {
		Cipher string `json:"imageDeliveryCipher"`
	}
	if err := json.Unmarshal([]byte(plain), &retained); err != nil {
		return nil, err
	}
	if retained.Cipher != "" {
		configJSON, err := a.service.decryptSettingSecret(retained.Cipher)
		if err != nil {
			return nil, err
		}
		if err := json.Unmarshal([]byte(configJSON), &input.Config); err != nil {
			return nil, err
		}
	}
	if input.Config.BaseURL == "" && input.Config.ChannelID == "" {
		return nil, nil
	}
	config, err := a.service.resolveProviderConfig(input.Config)
	if err != nil {
		return nil, err
	}
	if !generation.SameProviderOrigin(config.BaseURL, artifactURL) {
		return nil, nil
	}
	req, err := http.NewRequest(http.MethodGet, artifactURL, nil)
	if err != nil {
		return nil, err
	}
	if adapter, ok := a.service.protocolRegistry().Resolve(config.InterfaceType); ok {
		if auth, ok := adapter.(protocol.MediaAuthAdapter); ok {
			if err := generation.ApplyProtocolAuth(req, config, auth.MediaAuth()); err != nil {
				return nil, err
			}
		} else {
			generation.ApplyAuth(req, config)
		}
	} else {
		generation.ApplyAuth(req, config)
	}
	outbound.ApplyOutboundHeaders(req, config.Headers)
	return req.Header, nil
}

// artifactDownloadPartialPath keeps the resumable .part file per delivery
// identity so the 5s recovery loop and the success coordinator resume the same
// transfer instead of racing from byte zero.
func (a generationDeliveryMediaAdapter) artifactDownloadPartialPath(userID, identity string) string {
	sum := sha256.Sum256([]byte(userID + "\x00" + identity))
	return filepath.Join(a.service.dataDir, "cache", "artifact-downloads", hex.EncodeToString(sum[:])+".part")
}

// generationLocalArtifactPresent checks the same FileStore path storeResourceObject
// writes. asset.Service.validateLocalResource and any future Retry lock stay in
// the resource-worker domain; this adapter does not edit that package.
func (s *Service) generationLocalArtifactPresent(resource *model.Resource) bool {
	if s == nil || resource == nil || strings.TrimSpace(resource.ObjectKey) == "" {
		return false
	}
	body, err := localasset.NewFileStore(s.dataDir).Open(resource.ObjectKey)
	if err != nil {
		return false
	}
	_ = body.Close()
	return true
}
