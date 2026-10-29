package task

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"

	"infinite-canvas/backend/internal/assets"
	"infinite-canvas/backend/internal/model"
)

const (
	ResultKindGenerationOutput = "generation_output"

	ResultStateNotAvailable           = "NOT_AVAILABLE"
	ResultStatePendingMaterialization = "PENDING_MATERIALIZATION"
	ResultStateMaterializing          = "MATERIALIZING"
	ResultStateReady                  = "READY"
	ResultStateFailedRetryable        = "FAILED_RETRYABLE"
	ResultStateFailedPermanent        = "FAILED_PERMANENT"

	MaterializeErrorResourceMissing    = "resource_missing"
	MaterializeErrorResourceNotReady   = "resource_not_ready"
	MaterializeErrorResourceForeign    = "resource_foreign"
	MaterializeErrorPersistFailed      = "persist_failed"
	MaterializeErrorDeliveryUnreadable = "delivery_unreadable"
	MaterializeErrorUnsupportedShape   = "unsupported_result_shape"
	MaterializeErrorAssetForeign       = "asset_foreign"
)

// CanonicalOutput is the durable generation product identity the backend owns
// after a supplier success. Frontend materializers currently reconstruct this
// from resultJson; GET/list now expose the same fields so UI close/reopen can
// recover the same asset and target slot.
type CanonicalOutput struct {
	OutputIndex              int            `json:"outputIndex"`
	MediaType                string         `json:"mediaType"`
	ProviderArtifactRef      string         `json:"providerArtifactRef,omitempty"`
	MaterializedAssetID      string         `json:"materializedAssetId,omitempty"`
	MaterializationErrorCode string         `json:"materializationErrorCode,omitempty"`
	ResourceID               string         `json:"resourceId,omitempty"`
	EffectKey                string         `json:"effectKey,omitempty"`
	TargetBinding            *TargetBinding `json:"targetBinding,omitempty"`
}

type TargetBinding struct {
	NodeID         string `json:"nodeId,omitempty"`
	MessageID      string `json:"messageId,omitempty"`
	ConversationID string `json:"conversationId,omitempty"`
	Source         string `json:"source,omitempty"`
}

func (b TargetBinding) Empty() bool {
	return strings.TrimSpace(b.NodeID) == "" && strings.TrimSpace(b.MessageID) == "" && strings.TrimSpace(b.ConversationID) == "" && strings.TrimSpace(b.Source) == ""
}

func MaterializeEffectKey(taskID string, outputIndex int) string {
	return "materialize:" + strings.TrimSpace(taskID) + ":" + strconv.Itoa(outputIndex)
}

func AttachNodeEffectKey(taskID, nodeID string, outputIndex int) string {
	return "attach-node:" + strings.TrimSpace(taskID) + ":" + strings.TrimSpace(nodeID) + ":" + strconv.Itoa(outputIndex)
}

func AttachMessageEffectKey(taskID, messageID string, outputIndex int) string {
	return "attach-message:" + strings.TrimSpace(taskID) + ":" + strings.TrimSpace(messageID) + ":" + strconv.Itoa(outputIndex)
}

// MaterializedAssetID matches the browser generation asset identity
// generation_${sha256("materialize:"+taskID+":"+index)} so a later frontend
// cutover can adopt backend IDs without remapping.
func MaterializedAssetID(taskID string, outputIndex int) string {
	sum := sha256.Sum256([]byte(MaterializeEffectKey(taskID, outputIndex)))
	return "generation_" + hex.EncodeToString(sum[:])
}

func StableEntityID(parts ...string) string {
	sum := sha256.Sum256([]byte(strings.Join(parts, ":")))
	return hex.EncodeToString(sum[:16])
}

func OutputResultID(taskID string, outputIndex int) string {
	return StableEntityID("generation_output", strings.TrimSpace(taskID), strconv.Itoa(outputIndex))
}

func OutputVersionID(taskID string, outputIndex int) string {
	taskID = strings.TrimSpace(taskID)
	if outputIndex == 0 {
		return StableEntityID("version", taskID)
	}
	return StableEntityID("version", taskID, strconv.Itoa(outputIndex))
}

func OutputRepresentationID(taskID string, outputIndex int) string {
	return StableEntityID("representation", strings.TrimSpace(taskID), strconv.Itoa(outputIndex))
}

func OutputRole(outputIndex int) string {
	if outputIndex == 0 {
		return "output"
	}
	return "output:" + strconv.Itoa(outputIndex)
}

func CanonicalOutputs(resultJSON string, taskType string) []CanonicalOutput {
	if strings.TrimSpace(resultJSON) == "" {
		return nil
	}
	var payload map[string]any
	if json.Unmarshal([]byte(resultJSON), &payload) != nil {
		return nil
	}
	if taskType == model.TaskTypeDepthCapture {
		if output, ok := outputFromValue(payload, "video", 0); ok && output.ResourceID != "" {
			return []CanonicalOutput{output}
		}
		return nil
	}
	if images, ok := payload["images"]; ok {
		if outputs := outputsFromList(images, "image"); len(outputs) > 0 {
			return outputs
		}
	}
	if image, ok := payload["image"]; ok {
		if output, ok := outputFromValue(image, "image", 0); ok {
			return []CanonicalOutput{output}
		}
	}
	if video, ok := payload["video"]; ok {
		if output, ok := outputFromValue(video, "video", 0); ok {
			return []CanonicalOutput{output}
		}
	}
	if audio, ok := payload["audio"]; ok {
		if output, ok := outputFromValue(audio, "audio", 0); ok {
			return []CanonicalOutput{output}
		}
	}
	return nil
}

func TargetBindingFromInput(inputJSON string) TargetBinding {
	if strings.TrimSpace(inputJSON) == "" {
		return TargetBinding{}
	}
	var input struct {
		Metadata struct {
			Source         string `json:"source"`
			NodeID         string `json:"nodeId"`
			ConversationID string `json:"conversationId"`
			MessageID      string `json:"messageId"`
		} `json:"metadata"`
	}
	if json.Unmarshal([]byte(inputJSON), &input) != nil {
		return TargetBinding{}
	}
	return TargetBinding{
		NodeID:         strings.TrimSpace(input.Metadata.NodeID),
		MessageID:      strings.TrimSpace(input.Metadata.MessageID),
		ConversationID: strings.TrimSpace(input.Metadata.ConversationID),
		Source:         strings.TrimSpace(input.Metadata.Source),
	}
}

// HasWorkflowOutputIntent reports a short-drama step that already owns the
// Asset/Representation identity. Canvas and create-page tasks stay on the
// generation_ asset ID that matches the browser materializer.
func HasWorkflowOutputIntent(inputJSON string) bool {
	if strings.TrimSpace(inputJSON) == "" {
		return false
	}
	var input struct {
		WorkflowStepID string `json:"workflowStepId"`
		Metadata       struct {
			WorkflowStepID string `json:"workflowStepId"`
		} `json:"metadata"`
	}
	if json.Unmarshal([]byte(inputJSON), &input) != nil {
		return false
	}
	return strings.TrimSpace(input.WorkflowStepID) != "" || strings.TrimSpace(input.Metadata.WorkflowStepID) != ""
}

func BindOutput(output CanonicalOutput, taskID string, binding TargetBinding) CanonicalOutput {
	output.EffectKey = MaterializeEffectKey(taskID, output.OutputIndex)
	if output.ProviderArtifactRef == "" && output.ResourceID != "" {
		output.ProviderArtifactRef = "resource:" + output.ResourceID
	}
	if !binding.Empty() {
		copy := binding
		output.TargetBinding = &copy
	}
	return output
}

func DecodeOutputPayload(raw string) (CanonicalOutput, error) {
	var output CanonicalOutput
	if strings.TrimSpace(raw) == "" {
		return output, nil
	}
	err := json.Unmarshal([]byte(raw), &output)
	return output, err
}

func EncodeOutputPayload(output CanonicalOutput) (string, error) {
	encoded, err := json.Marshal(output)
	if err != nil {
		return "", err
	}
	return string(encoded), nil
}

func ResultState(status model.TaskStatus, outputs []CanonicalOutput, failedRetryBlocked bool) string {
	switch status {
	case model.TaskStatusSucceeded:
		if len(outputs) == 0 {
			return ResultStateReady
		}
		ready := true
		retryable := false
		permanent := false
		for _, output := range outputs {
			if output.MaterializedAssetID != "" {
				continue
			}
			ready = false
			switch output.MaterializationErrorCode {
			case MaterializeErrorResourceForeign, MaterializeErrorAssetForeign, MaterializeErrorUnsupportedShape:
				permanent = true
			case MaterializeErrorResourceNotReady, MaterializeErrorResourceMissing, MaterializeErrorPersistFailed, MaterializeErrorDeliveryUnreadable:
				retryable = true
			default:
				if output.MaterializationErrorCode != "" {
					retryable = true
				}
			}
		}
		if ready {
			return ResultStateReady
		}
		if permanent && !retryable {
			return ResultStateFailedPermanent
		}
		if retryable || permanent {
			return ResultStateFailedRetryable
		}
		return ResultStatePendingMaterialization
	case model.TaskStatusFailed:
		if failedRetryBlocked {
			return ResultStateFailedPermanent
		}
		return ResultStateFailedRetryable
	default:
		return ResultStateNotAvailable
	}
}

func OutputSettled(output CanonicalOutput) bool {
	return strings.TrimSpace(output.MaterializedAssetID) != "" || terminalMaterializeError(output.MaterializationErrorCode)
}

func DeliveryComplete(resultJSON string, stored []CanonicalOutput, taskType string) bool {
	expected := CanonicalOutputs(resultJSON, taskType)
	if len(expected) == 0 {
		return true
	}
	byIndex := map[int]CanonicalOutput{}
	for _, output := range stored {
		byIndex[output.OutputIndex] = output
	}
	for _, output := range expected {
		got, ok := byIndex[output.OutputIndex]
		if !ok || !OutputSettled(got) {
			return false
		}
	}
	return true
}

func terminalMaterializeError(code string) bool {
	switch code {
	case MaterializeErrorResourceForeign, MaterializeErrorAssetForeign, MaterializeErrorUnsupportedShape:
		return true
	default:
		return false
	}
}

func PersistableArtifactURL(ref string) bool {
	ref = strings.TrimSpace(ref)
	return strings.HasPrefix(ref, "data:") || strings.HasPrefix(ref, "http://") || strings.HasPrefix(ref, "https://")
}

func UnsupportedResultShape(output CanonicalOutput) string {
	if strings.TrimSpace(output.ResourceID) != "" {
		return ""
	}
	ref := strings.TrimSpace(output.ProviderArtifactRef)
	if PersistableArtifactURL(ref) {
		return ""
	}
	if ref == "" {
		return "empty_media_ref"
	}
	if strings.HasPrefix(ref, "blob:") {
		return "blob_url"
	}
	return "unrecognized_artifact"
}

func InspectResultJSON(resultJSON string, taskType string) (outputs []CanonicalOutput, unusable string) {
	outputs = CanonicalOutputs(resultJSON, taskType)
	if len(outputs) > 0 {
		return outputs, ""
	}
	if strings.TrimSpace(resultJSON) == "" {
		return nil, ""
	}
	var payload map[string]any
	if json.Unmarshal([]byte(resultJSON), &payload) != nil {
		return nil, "invalid_result_json"
	}
	for _, key := range []string{"images", "image", "video", "audio"} {
		if _, ok := payload[key]; ok {
			return nil, "unusable_" + key
		}
	}
	return nil, ""
}

// CanvasBindingIntent is durable attach intent only. Canvas/operations workers
// apply it; this slice does not write canvas documents. Schema version 10 is
// owned by assistantturns; do not add a delivery migration for apply-ack.
type CanvasBindingIntent struct {
	TaskID                 string         `json:"taskId"`
	OutputIndex            int            `json:"outputIndex"`
	AssetID                string         `json:"assetId,omitempty"`
	ResourceID             string         `json:"resourceId,omitempty"`
	TargetBinding          *TargetBinding `json:"targetBinding,omitempty"`
	MaterializeEffectKey   string         `json:"materializeEffectKey"`
	AttachNodeEffectKey    string         `json:"attachNodeEffectKey,omitempty"`
	AttachMessageEffectKey string         `json:"attachMessageEffectKey,omitempty"`
}

func CanvasBindingIntents(taskID string, outputs []CanonicalOutput) []CanvasBindingIntent {
	intents := make([]CanvasBindingIntent, 0, len(outputs))
	for _, output := range outputs {
		if output.TargetBinding == nil || output.TargetBinding.Empty() {
			continue
		}
		intent := CanvasBindingIntent{
			TaskID:               strings.TrimSpace(taskID),
			OutputIndex:          output.OutputIndex,
			AssetID:              output.MaterializedAssetID,
			ResourceID:           output.ResourceID,
			TargetBinding:        output.TargetBinding,
			MaterializeEffectKey: MaterializeEffectKey(taskID, output.OutputIndex),
		}
		if output.TargetBinding.NodeID != "" {
			intent.AttachNodeEffectKey = AttachNodeEffectKey(taskID, output.TargetBinding.NodeID, output.OutputIndex)
		}
		if output.TargetBinding.MessageID != "" {
			intent.AttachMessageEffectKey = AttachMessageEffectKey(taskID, output.TargetBinding.MessageID, output.OutputIndex)
		}
		intents = append(intents, intent)
	}
	if len(intents) == 0 {
		return nil
	}
	return intents
}

func DecodeOutputResults(results []model.Result) ([]CanonicalOutput, error) {
	outputs := make([]CanonicalOutput, 0, len(results))
	for _, result := range results {
		output, err := DecodeOutputPayload(result.Payload)
		if err != nil {
			return nil, fmt.Errorf("generation_output %s: %w", result.ID, err)
		}
		outputs = append(outputs, output)
	}
	return outputs, nil
}

func outputsFromList(value any, mediaType string) []CanonicalOutput {
	items, ok := value.([]any)
	if !ok || len(items) == 0 {
		return nil
	}
	outputs := make([]CanonicalOutput, 0, len(items))
	for index, item := range items {
		output, ok := outputFromValue(item, mediaType, index)
		if !ok {
			continue
		}
		outputs = append(outputs, output)
	}
	return outputs
}

func outputFromValue(value any, mediaType string, index int) (CanonicalOutput, bool) {
	output := CanonicalOutput{OutputIndex: index, MediaType: mediaType}
	switch item := value.(type) {
	case string:
		text := strings.TrimSpace(item)
		if text == "" {
			return CanonicalOutput{}, false
		}
		if id := assets.ResourceID(text); id != "" {
			output.ResourceID = id
			output.ProviderArtifactRef = "resource:" + id
			return output, true
		}
		output.ProviderArtifactRef = text
		return output, true
	case map[string]any:
		if id := stringValue(item["resourceId"]); id != "" {
			if valid := assets.ValidID(id); valid != "" {
				output.ResourceID = valid
			}
		}
		for _, key := range []string{"storageKey", "url", "dataUrl", "resultUrl", "outputUrl"} {
			text := stringValue(item[key])
			if text == "" {
				continue
			}
			if id := assets.ResourceID(text); id != "" {
				if output.ResourceID == "" {
					output.ResourceID = id
				}
				if output.ProviderArtifactRef == "" {
					output.ProviderArtifactRef = "resource:" + id
				}
				continue
			}
			if output.ProviderArtifactRef == "" {
				output.ProviderArtifactRef = text
			}
		}
		if output.ResourceID == "" && output.ProviderArtifactRef == "" {
			return CanonicalOutput{}, false
		}
		if output.ProviderArtifactRef == "" && output.ResourceID != "" {
			output.ProviderArtifactRef = "resource:" + output.ResourceID
		}
		return output, true
	default:
		return CanonicalOutput{}, false
	}
}

func stringValue(value any) string {
	text, _ := value.(string)
	return strings.TrimSpace(text)
}
