package taskdelivery

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"infinite-canvas/backend/internal/assets"
	"infinite-canvas/backend/internal/model"
	localtask "infinite-canvas/backend/internal/task"
)

const recoveryBatchLimit = 64

type Deliverer struct {
	store   Store
	media   Media
	mu      sync.Mutex
	afterID string
}

func New(store Store, media Media) *Deliverer {
	return &Deliverer{store: store, media: media}
}

func (d *Deliverer) Deliver(task model.Task) error {
	if d == nil || d.store == nil || strings.TrimSpace(task.ID) == "" || task.Status != model.TaskStatusSucceeded {
		return nil
	}
	if task.Stage == "delivery_paused" || task.Stage == "delivery_timed_out" {
		return nil
	}
	stored, loadErr := d.loadedOutputs(task.ID)
	if loadErr == nil && localtask.DeliveryComplete(task.ResultJSON, stored, task.Type) {
		return nil
	}
	outputs, unusable := localtask.InspectResultJSON(task.ResultJSON, task.Type)
	if len(outputs) == 0 {
		if unusable == "" {
			return nil
		}
		return d.store.WithTx(func(tx Store) error {
			return d.commitUnsupported(tx, task, localtask.CanonicalOutput{OutputIndex: 0, ProviderArtifactRef: unusable}, unusable)
		})
	}
	storedByIndex := map[int]localtask.CanonicalOutput{}
	if loadErr == nil {
		for _, output := range stored {
			storedByIndex[output.OutputIndex] = output
		}
	}
	var persistErr error
	for i, output := range outputs {
		if got, ok := storedByIndex[output.OutputIndex]; ok {
			if localtask.OutputSettled(got) {
				outputs[i] = got
				continue
			}
			if strings.TrimSpace(got.ResourceID) != "" {
				outputs[i].ResourceID = got.ResourceID
				if strings.TrimSpace(outputs[i].ProviderArtifactRef) == "" {
					outputs[i].ProviderArtifactRef = got.ProviderArtifactRef
				}
				continue
			}
		}
		if strings.TrimSpace(outputs[i].ResourceID) != "" {
			continue
		}
		if shape := localtask.UnsupportedResultShape(outputs[i]); shape != "" {
			continue
		}
		if d.media == nil || !localtask.PersistableArtifactURL(outputs[i].ProviderArtifactRef) {
			continue
		}
		resource, err := d.media.PersistRemoteArtifact(task.UserID, outputs[i].MediaType, outputs[i].ProviderArtifactRef, task.ID+":"+fmt.Sprint(outputs[i].OutputIndex))
		if err != nil {
			persistErr = errors.Join(persistErr, err)
			continue
		}
		if resource == nil || strings.TrimSpace(resource.ID) == "" {
			persistErr = errors.Join(persistErr, fmt.Errorf("generation artifact persist returned empty resource"))
			continue
		}
		outputs[i].ResourceID = resource.ID
		outputs[i].ProviderArtifactRef = "resource:" + resource.ID
	}
	binding := localtask.TargetBindingFromInput(task.InputJSON)
	now := time.Now()
	txErr := d.store.WithTx(func(tx Store) error {
		existing, err := tx.AssetRepresentationsForTask(task.ID)
		if err != nil {
			return err
		}
		existingByRole := map[string]model.AssetRepresentation{}
		for _, representation := range existing {
			existingByRole[representation.Role] = representation
		}
		for _, output := range outputs {
			output = localtask.BindOutput(output, task.ID, binding)
			if err := d.deliverOne(tx, task, output, existingByRole[localtask.OutputRole(output.OutputIndex)], now); err != nil {
				return err
			}
		}
		return nil
	})
	return errors.Join(txErr, persistErr)
}

func (d *Deliverer) RecoverIncomplete(limit int) error {
	if d == nil || d.store == nil {
		return nil
	}
	if limit <= 0 {
		limit = recoveryBatchLimit
	}
	d.mu.Lock()
	afterID := d.afterID
	d.mu.Unlock()
	tasks, err := d.store.SucceededTasksForDelivery(afterID, limit)
	if err != nil {
		return err
	}
	if len(tasks) == 0 && afterID != "" {
		// Past the last id: wrap so later ticks still scan every persisted candidate.
		tasks, err = d.store.SucceededTasksForDelivery("", limit)
		if err != nil {
			return err
		}
	}
	d.mu.Lock()
	if len(tasks) == 0 || len(tasks) < limit {
		d.afterID = ""
	} else {
		d.afterID = tasks[len(tasks)-1].ID
	}
	d.mu.Unlock()
	var errs error
	for _, task := range tasks {
		stored, loadErr := d.loadedOutputs(task.ID)
		if loadErr == nil && localtask.DeliveryComplete(task.ResultJSON, stored, task.Type) {
			continue
		}
		if err := d.Deliver(task); err != nil {
			errs = errors.Join(errs, fmt.Errorf("task %s: %w", task.ID, err))
		}
	}
	return errs
}

func (d *Deliverer) LoadedOutputs(taskID string) ([]localtask.CanonicalOutput, error) {
	return d.loadedOutputs(taskID)
}

func (d *Deliverer) LoadedOutputsForTasks(taskIDs []string) (map[string][]localtask.CanonicalOutput, map[string]error, error) {
	if d == nil || d.store == nil {
		return nil, nil, nil
	}
	results, err := d.store.GenerationOutputResultsForTasks(taskIDs)
	if err != nil {
		return nil, nil, err
	}
	byTask, errs := DecodeStoredOutputsByTask(results)
	return byTask, errs, nil
}

func (d *Deliverer) loadedOutputs(taskID string) ([]localtask.CanonicalOutput, error) {
	results, err := d.store.GenerationOutputResults(taskID)
	if err != nil {
		return nil, err
	}
	return DecodeStoredOutputs(results)
}

func (d *Deliverer) deliverOne(tx Store, task model.Task, output localtask.CanonicalOutput, existing model.AssetRepresentation, now time.Time) error {
	item, err := resultItem(task, output, now)
	if err != nil {
		return err
	}
	if strings.TrimSpace(output.ResourceID) == "" {
		if shape := localtask.UnsupportedResultShape(output); shape != "" {
			return d.commitUnsupported(tx, task, output, shape)
		}
		return d.commitRecorded(tx, output, item, localtask.MaterializeErrorPersistFailed)
	}
	if existing.ID != "" {
		return d.bindExisting(tx, task, output, existing, item)
	}
	resource, resourceErr := ownedReadyResource(tx, task.UserID, output.ResourceID)
	if resource == nil {
		if resourceErr != nil && !knownResourceError(resourceErr) {
			return resourceErr
		}
		return d.commitRecorded(tx, output, item, resourceErrorCode(resourceErr))
	}
	if localtask.HasWorkflowOutputIntent(task.InputJSON) {
		return tx.CommitOwned(item)
	}
	assetID := localtask.MaterializedAssetID(task.ID, output.OutputIndex)
	versionID := localtask.OutputVersionID(task.ID, output.OutputIndex)
	representationID := localtask.OutputRepresentationID(task.ID, output.OutputIndex)
	existingAsset, assetErr := tx.Asset(assetID)
	if assetErr != nil && !errors.Is(assetErr, ErrNotFound) {
		return assetErr
	}
	if existingAsset != nil && existingAsset.UserID != task.UserID {
		return d.commitForeignAsset(tx, task, output)
	}
	output.MaterializedAssetID = assetID
	output.MaterializationErrorCode = ""
	encoded, err := localtask.EncodeOutputPayload(output)
	if err != nil {
		return err
	}
	item.Result.Payload = encoded
	item.Result.URL = assets.FileURL(resource.ID)
	if existingAsset != nil {
		if existingAsset.PrimaryVersionID != "" {
			versionID = existingAsset.PrimaryVersionID
		} else {
			item.Version = generationOutputVersion(task, assetID, versionID, now)
		}
		metadata, metaErr := json.Marshal(output)
		if metaErr != nil {
			return metaErr
		}
		item.Representation = generationOutputRepresentation(task, output, resource.ID, versionID, representationID, string(metadata), now)
		return tx.CommitOwned(item)
	}
	payload, err := generationAssetPayload(task, output, *resource, assetID, versionID, now)
	if err != nil {
		return err
	}
	metadata, err := json.Marshal(output)
	if err != nil {
		return err
	}
	item.Asset = &model.Asset{
		ID:               assetID,
		UserID:           task.UserID,
		Kind:             output.MediaType,
		Category:         model.AssetCategoryMaterial,
		Status:           model.AssetVersionStatusConfirmed,
		PrimaryVersionID: versionID,
		Title:            generationAssetTitle(output.MediaType),
		PayloadJSON:      payload,
		CreatedAt:        now,
		UpdatedAt:        now,
	}
	item.Version = generationOutputVersion(task, assetID, versionID, now)
	item.Representation = generationOutputRepresentation(task, output, resource.ID, versionID, representationID, string(metadata), now)
	return tx.CommitOwned(item)
}

func (d *Deliverer) bindExisting(tx Store, task model.Task, output localtask.CanonicalOutput, existing model.AssetRepresentation, item OwnedDelivery) error {
	resourceID := strings.TrimSpace(output.ResourceID)
	if resourceID == "" {
		resourceID = strings.TrimSpace(existing.ResourceID)
	}
	resource, resourceErr := ownedReadyResource(tx, task.UserID, resourceID)
	if resource == nil {
		if resourceErr != nil && !knownResourceError(resourceErr) {
			return resourceErr
		}
		if output.ResourceID == "" {
			output.ResourceID = resourceID
		}
		return d.commitRecorded(tx, output, item, resourceErrorCode(resourceErr))
	}
	output.ResourceID = resource.ID
	if strings.TrimSpace(existing.AssetVersionID) == "" {
		return d.commitRecorded(tx, output, item, localtask.MaterializeErrorPersistFailed)
	}
	version, err := tx.AssetVersion(existing.AssetVersionID)
	if err != nil || version == nil {
		if err != nil && !errors.Is(err, ErrNotFound) {
			return err
		}
		return d.commitRecorded(tx, output, item, localtask.MaterializeErrorPersistFailed)
	}
	asset, err := tx.Asset(version.AssetID)
	if err != nil || asset == nil {
		if err != nil && !errors.Is(err, ErrNotFound) {
			return err
		}
		return d.commitRecorded(tx, output, item, localtask.MaterializeErrorPersistFailed)
	}
	if asset.UserID != task.UserID {
		return d.commitForeignAsset(tx, task, output)
	}
	output.MaterializedAssetID = asset.ID
	output.MaterializationErrorCode = ""
	encoded, err := localtask.EncodeOutputPayload(output)
	if err != nil {
		return err
	}
	item.Result.Payload = encoded
	item.Result.URL = assets.FileURL(resource.ID)
	return tx.CommitOwned(item)
}

func (d *Deliverer) commitRecorded(tx Store, output localtask.CanonicalOutput, item OwnedDelivery, code string) error {
	output.MaterializedAssetID = ""
	output.MaterializationErrorCode = code
	encoded, err := localtask.EncodeOutputPayload(output)
	if err != nil {
		return err
	}
	item.Result.Payload = encoded
	if output.ResourceID != "" {
		item.Result.URL = assets.FileURL(output.ResourceID)
	} else {
		item.Result.URL = ""
	}
	return tx.CommitOwned(item)
}

func (d *Deliverer) commitUnsupported(tx Store, task model.Task, output localtask.CanonicalOutput, shape string) error {
	output.MaterializationErrorCode = localtask.MaterializeErrorUnsupportedShape
	if output.ProviderArtifactRef == "" {
		output.ProviderArtifactRef = shape
	}
	item, err := resultItem(task, output, time.Now())
	if err != nil {
		return err
	}
	return tx.CommitOwned(item)
}

func (d *Deliverer) commitForeignAsset(tx Store, task model.Task, output localtask.CanonicalOutput) error {
	output.MaterializedAssetID = ""
	output.MaterializationErrorCode = localtask.MaterializeErrorAssetForeign
	item, err := resultItem(task, output, time.Now())
	if err != nil {
		return err
	}
	return tx.CommitOwned(item)
}

func generationOutputVersion(task model.Task, assetID, versionID string, now time.Time) *model.AssetVersion {
	return &model.AssetVersion{
		ID:             versionID,
		AssetID:        assetID,
		Version:        1,
		Status:         model.AssetVersionStatusConfirmed,
		DefinitionJSON: "{}",
		Prompt:         task.Prompt,
		Note:           "生成任务产物",
		CreatedAt:      now,
		UpdatedAt:      now,
	}
}

func generationOutputRepresentation(task model.Task, output localtask.CanonicalOutput, resourceID, versionID, representationID, metadata string, now time.Time) *model.AssetRepresentation {
	return &model.AssetRepresentation{
		ID:             representationID,
		TaskID:         task.ID,
		AssetVersionID: versionID,
		ResourceID:     resourceID,
		MediaType:      output.MediaType,
		Role:           localtask.OutputRole(output.OutputIndex),
		MetadataJSON:   metadata,
		CreatedAt:      now,
	}
}

func resultItem(task model.Task, output localtask.CanonicalOutput, now time.Time) (OwnedDelivery, error) {
	payload, err := localtask.EncodeOutputPayload(output)
	if err != nil {
		return OwnedDelivery{}, err
	}
	item := OwnedDelivery{Result: model.Result{
		ID:        localtask.OutputResultID(task.ID, output.OutputIndex),
		UserID:    task.UserID,
		TaskID:    task.ID,
		Kind:      localtask.ResultKindGenerationOutput,
		Payload:   payload,
		CreatedAt: now,
	}}
	if output.ResourceID != "" {
		item.Result.URL = assets.FileURL(output.ResourceID)
	}
	return item, nil
}

func ownedReadyResource(tx Store, userID, resourceID string) (*model.Resource, error) {
	resourceID = strings.TrimSpace(resourceID)
	if resourceID == "" {
		return nil, ErrResourceMissing
	}
	resource, err := tx.ResourceForUser(userID, resourceID)
	if err == nil {
		if resource.Status != model.ResourceStatusReady {
			return nil, ErrResourceNotReady
		}
		return resource, nil
	}
	if !errors.Is(err, ErrNotFound) {
		return nil, err
	}
	if _, lookupErr := tx.Resource(resourceID); lookupErr == nil {
		return nil, ErrForeignResource
	} else if lookupErr != nil && !errors.Is(lookupErr, ErrNotFound) {
		return nil, lookupErr
	}
	return nil, ErrResourceMissing
}

func knownResourceError(err error) bool {
	return errors.Is(err, ErrResourceMissing) || errors.Is(err, ErrResourceNotReady) || errors.Is(err, ErrForeignResource)
}

func resourceErrorCode(err error) string {
	switch {
	case errors.Is(err, ErrForeignResource):
		return localtask.MaterializeErrorResourceForeign
	case errors.Is(err, ErrResourceNotReady):
		return localtask.MaterializeErrorResourceNotReady
	case errors.Is(err, ErrResourceMissing):
		return localtask.MaterializeErrorResourceMissing
	default:
		return localtask.MaterializeErrorPersistFailed
	}
}

func generationAssetTitle(mediaType string) string {
	switch mediaType {
	case "video":
		return "生成视频"
	case "audio":
		return "生成音频"
	default:
		return "生成图片"
	}
}

func generationAssetPayload(task model.Task, output localtask.CanonicalOutput, resource model.Resource, assetID, versionID string, now time.Time) (string, error) {
	resourceURL := assets.FileURL(resource.ID)
	width := resource.Width
	height := resource.Height
	if width <= 0 {
		width = 1
	}
	if height <= 0 {
		height = 1
	}
	data := map[string]any{
		"storageKey": "resource:" + resource.ID,
		"mimeType":   resource.MimeType,
		"bytes":      resource.Size,
		"width":      width,
		"height":     height,
	}
	if output.MediaType == "image" {
		data["dataUrl"] = resourceURL
	} else {
		data["url"] = resourceURL
		if resource.DurationMs > 0 {
			data["durationMs"] = resource.DurationMs
		}
	}
	metadata := map[string]any{
		"source":              "generation-task",
		"generationEffectKey": output.EffectKey,
		"taskId":              task.ID,
		"outputIndex":         output.OutputIndex,
	}
	if output.TargetBinding != nil {
		if output.TargetBinding.ConversationID != "" {
			metadata["conversationId"] = output.TargetBinding.ConversationID
		}
		if output.TargetBinding.MessageID != "" {
			metadata["messageId"] = output.TargetBinding.MessageID
		}
		if output.TargetBinding.NodeID != "" {
			metadata["nodeId"] = output.TargetBinding.NodeID
		}
	}
	payload, err := json.Marshal(map[string]any{
		"id":               assetID,
		"kind":             output.MediaType,
		"category":         model.AssetCategoryMaterial,
		"status":           model.AssetVersionStatusConfirmed,
		"primaryVersionId": versionID,
		"title":            generationAssetTitle(output.MediaType),
		"coverUrl":         resourceURL,
		"tags":             []string{"生成"},
		"source":           "生成任务",
		"createdAt":        now.UTC().Format(time.RFC3339Nano),
		"updatedAt":        now.UTC().Format(time.RFC3339Nano),
		"data":             data,
		"metadata":         metadata,
	})
	if err != nil {
		return "", fmt.Errorf("序列化生成素材失败：%w", err)
	}
	return string(payload), nil
}
