package taskdelivery

import (
	"infinite-canvas/backend/internal/model"
	localtask "infinite-canvas/backend/internal/task"
)

type Projection struct {
	Outputs     []localtask.CanonicalOutput
	ResultState string
	Stage       string
	Err         error
}

func Project(task model.Task, stored []localtask.CanonicalOutput, loadErr error, failedRetryBlocked bool) Projection {
	parsed, _ := localtask.InspectResultJSON(task.ResultJSON, task.Type)
	if loadErr != nil {
		outputs := parsed
		if len(outputs) == 0 {
			outputs = []localtask.CanonicalOutput{{OutputIndex: 0, MediaType: "image"}}
		}
		for i := range outputs {
			outputs[i].MaterializedAssetID = ""
			outputs[i].MaterializationErrorCode = localtask.MaterializeErrorDeliveryUnreadable
			outputs[i] = localtask.BindOutput(outputs[i], task.ID, localtask.OutputBinding(task, outputs[i].OutputIndex))
		}
		return Projection{Outputs: outputs, ResultState: localtask.ResultStateFailedRetryable, Stage: task.Stage, Err: loadErr}
	}
	if len(parsed) == 0 {
		parsed = stored
	}
	byIndex := map[int]localtask.CanonicalOutput{}
	for _, output := range stored {
		byIndex[output.OutputIndex] = output
	}
	merged := make([]localtask.CanonicalOutput, 0, len(parsed))
	for _, output := range parsed {
		if got, ok := byIndex[output.OutputIndex]; ok {
			output = got
		}
		if output.MaterializedAssetID == "" && (task.Stage == "delivery_paused" || task.Stage == "delivery_timed_out") {
			output.MaterializationErrorCode = task.Stage
		}
		merged = append(merged, localtask.BindOutput(output, task.ID, localtask.OutputBinding(task, output.OutputIndex)))
	}
	state := localtask.ResultState(task.Status, merged, failedRetryBlocked)
	stage := task.Stage
	// Ready outputs are authoritative even when an older delivery left a stale stage.
	if task.Status == model.TaskStatusSucceeded && state == localtask.ResultStateReady && len(merged) > 0 {
		switch stage {
		case "正在取回结果", "delivery_paused", "delivery_timed_out":
			stage = "生成完成"
		}
	}
	return Projection{
		Outputs:     merged,
		ResultState: state,
		Stage:       stage,
	}
}

func DecodeStoredOutputs(results []model.Result) ([]localtask.CanonicalOutput, error) {
	outputs, err := localtask.DecodeOutputResults(results)
	if err != nil {
		return nil, err
	}
	return outputs, nil
}

func DecodeStoredOutputsByTask(results []model.Result) (map[string][]localtask.CanonicalOutput, map[string]error) {
	byTask := map[string][]localtask.CanonicalOutput{}
	errs := map[string]error{}
	grouped := map[string][]model.Result{}
	for _, result := range results {
		grouped[result.TaskID] = append(grouped[result.TaskID], result)
	}
	for taskID, rows := range grouped {
		outputs, err := localtask.DecodeOutputResults(rows)
		if err != nil {
			errs[taskID] = err
			continue
		}
		byTask[taskID] = outputs
	}
	return byTask, errs
}
