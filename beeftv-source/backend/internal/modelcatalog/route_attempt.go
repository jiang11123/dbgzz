package modelcatalog

import (
	"encoding/json"
	"errors"
	"log"
	"strings"
	"time"

	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
)

type ExistingAttemptAction int

const (
	AttemptContinueNew ExistingAttemptAction = iota
	AttemptReuse
	AttemptReuseAccepted
	AttemptUncertain
	AttemptRetryImage
	AttemptFail
	AttemptSwitchRoute
	AttemptCreateDirect
	AttemptCreateSelected
)

type ExistingAttemptDecision struct {
	Action              ExistingAttemptAction
	Attempt             *model.RouteAttempt
	SyncProviderRequest bool
	MarkAccepted        bool
	Error               error
}

func DecideExistingAttempt(task *model.Task, attempts []model.RouteAttempt, image ImageSubmissionView) ExistingAttemptDecision {
	if task == nil {
		return ExistingAttemptDecision{Action: AttemptContinueNew}
	}
	if len(attempts) == 0 {
		if task.LogicalModelID == "" {
			return ExistingAttemptDecision{Action: AttemptCreateDirect}
		}
		return ExistingAttemptDecision{Action: AttemptCreateSelected}
	}
	existing := &attempts[len(attempts)-1]
	if task.Type == "canvas_image" && (existing.DispatchState == "submission_unknown" || existing.DispatchState == "accepted") {
		if image.Err == nil && image.Found {
			return ExistingAttemptDecision{Action: AttemptReuse, Attempt: existing}
		}
	}
	switch existing.DispatchState {
	case "not_sent":
		return ExistingAttemptDecision{Action: AttemptReuse, Attempt: existing}
	case "accepted":
		if existing.ProviderRequestID != "" || task.ProviderRequestID != "" {
			return ExistingAttemptDecision{Action: AttemptReuseAccepted, Attempt: existing, SyncProviderRequest: task.ProviderRequestID == ""}
		}
		return ExistingAttemptDecision{Action: AttemptUncertain, Error: DispatchUncertainError{Message: "上游已接受请求，但没有可恢复的任务 ID"}}
	case "submission_unknown":
		if existing.ProviderRequestID != "" || task.ProviderRequestID != "" {
			return ExistingAttemptDecision{Action: AttemptReuseAccepted, Attempt: existing, SyncProviderRequest: task.ProviderRequestID == "", MarkAccepted: true}
		}
		return ExistingAttemptDecision{Action: AttemptUncertain, Error: DispatchUncertainError{Message: "上一次提交结果不明确，为避免重复创建上游任务已停止自动重发"}}
	case "rejected_no_job":
		if task.Type == "canvas_image" && existing.FailureCode == "image_throttled" && existing.AttemptNumber < 3 {
			return ExistingAttemptDecision{Action: AttemptRetryImage, Attempt: existing}
		}
		if task.Type == "canvas_image" {
			return ExistingAttemptDecision{Action: AttemptFail, Error: errors.New("上游已拒绝本次图片请求，请查看失败原因")}
		}
		if task.LogicalModelID == "" {
			return ExistingAttemptDecision{Action: AttemptFail, Error: errors.New("上游已拒绝本次请求，请检查渠道配置后再试")}
		}
		return ExistingAttemptDecision{Action: AttemptSwitchRoute, Attempt: existing}
	}
	if task.LogicalModelID == "" {
		return ExistingAttemptDecision{Action: AttemptCreateDirect}
	}
	return ExistingAttemptDecision{Action: AttemptCreateSelected}
}

func ShouldRetryImageThrottle(task *model.Task, attempt *model.RouteAttempt, info FailureInfo) bool {
	return task != nil && task.Type == "canvas_image" && attempt != nil && attempt.AttemptNumber < 3 && info.ImageThrottle
}

func ShouldSwitchRouteAfterFailure(task *model.Task, attempt *model.RouteAttempt, info FailureInfo) bool {
	if task == nil || task.LogicalModelID == "" || attempt == nil || attempt.DispatchState != "rejected_no_job" {
		return false
	}
	if task.Type == "canvas_image" {
		return false
	}
	if info.Canceled {
		return false
	}
	return true
}

func (r *Router) CreateRouteAttempt(store RouteStore, task *model.Task, routed *RoutedModel, attemptNumber int) (*model.RouteAttempt, error) {
	id, err := store.NextPrefixedID("ATTEMPT")
	if err != nil {
		return nil, err
	}
	channelModel, err := store.ChannelModelByID(routed.ChannelModel.ChannelID, routed.ChannelModel.ID)
	if err != nil {
		return nil, err
	}
	attempt := &model.RouteAttempt{ID: id, TaskID: task.ID, RouteRun: task.RouteRun, AttemptNumber: attemptNumber, LogicalModelID: routed.LogicalModel.ID, LogicalModelRevisionID: routed.Revision.ID, RouteID: routed.Route.ID, ChannelModelID: channelModel.ID, ChannelID: channelModel.ChannelID, Status: "selected", DispatchState: "not_sent", StartedAt: r.clock()}
	if err := store.CreateRouteAttempt(attempt); err != nil {
		return nil, err
	}
	return attempt, nil
}

func MarkRouteAttemptDispatching(store RouteStore, attempt *model.RouteAttempt) error {
	if attempt == nil || attempt.DispatchState != "not_sent" {
		return nil
	}
	if err := store.MarkRouteAttemptDispatching(attempt.ID); err != nil {
		return DispatchUncertainError{Message: "提交状态未能独占确认，为避免重复创建上游任务已停止自动重发"}
	}
	attempt.Status, attempt.DispatchState = "dispatching", "submission_unknown"
	return nil
}

func (r *Router) RoutedModelForTaskSelection(store RouteStore, task *model.Task) (*RoutedModel, error) {
	route, err := store.LogicalModelRoute(task.RouteID)
	if err != nil {
		return nil, err
	}
	if !route.Enabled || route.Weight <= 0 || route.LogicalModelRevisionID != task.LogicalModelRevisionID {
		return nil, errors.New("任务使用的模型服务配置已失效")
	}
	if route.ChannelModelID != task.ChannelModelID {
		return nil, errors.New("任务使用的模型服务配置已失效")
	}
	channelModel, err := store.ChannelModel(task.ChannelModelID)
	if err != nil {
		return nil, err
	}
	if !channelModel.Enabled {
		return nil, errors.New("任务使用的模型服务配置已失效")
	}
	if _, err := store.SystemChannel(channelModel.ChannelID); err != nil {
		return nil, err
	}
	logicalModel, err := store.LogicalModel(task.LogicalModelID)
	if err != nil {
		return nil, err
	}
	revision, err := store.LogicalModelRevision(task.LogicalModelRevisionID)
	if err != nil {
		return nil, err
	}
	if revision.LogicalModelID != logicalModel.ID {
		return nil, errors.New("任务前台模型版本不一致")
	}
	productSpec, err := DecodeCapabilitySpec(revision.CapabilitySpecJSON)
	if err != nil {
		return nil, err
	}
	defaults, err := DecodeLogicalDefaults(revision.DefaultOptionsJSON, productSpec)
	if err != nil {
		return nil, err
	}
	capabilitySpec, err := channelModelCapabilitySpec(*channelModel)
	if err != nil || r.LogicalRouteBlocked(CachedLogicalRoute{Route: *route, CapabilitySpec: capabilitySpec, ChannelModel: *channelModel}) {
		return nil, errors.New("当前模型服务暂不可用")
	}
	return &RoutedModel{LogicalModel: *logicalModel, Revision: *revision, Route: *route, ChannelModel: *channelModel, Defaults: defaults}, nil
}

func (r *Router) SwitchTaskToNextRoute(store RouteStore, codec TaskInputCodec, task *model.Task, attempts []model.RouteAttempt) (*model.RouteAttempt, error) {
	if codec.Decrypt == nil {
		return nil, kernel.BadAuthRequest("任务输入格式无效，无法恢复模型服务")
	}
	decrypted, err := codec.Decrypt(task.InputJSON)
	if err != nil {
		return nil, err
	}
	var input map[string]any
	if err := json.Unmarshal([]byte(decrypted), &input); err != nil {
		return nil, kernel.BadAuthRequest("任务输入格式无效，无法恢复模型服务")
	}
	logicalModel, err := store.LogicalModel(task.LogicalModelID)
	if err != nil {
		return nil, err
	}
	revision, err := store.LogicalModelRevision(task.LogicalModelRevisionID)
	if err != nil || revision.LogicalModelID != logicalModel.ID {
		return nil, errors.New("任务前台模型版本不存在或归属不一致")
	}
	productSpec, err := DecodeCapabilitySpec(revision.CapabilitySpecJSON)
	if err != nil {
		return nil, err
	}
	defaults, err := DecodeLogicalDefaults(revision.DefaultOptionsJSON, productSpec)
	if err != nil {
		return nil, err
	}
	intent := ModelRequestIntentFromTaskInput(input, task.Type, task.Operation)
	intent.Options = mergeIntentDefaults(intent.Options, defaults)
	if match := MatchCapability(productSpec, intent); !match.Matched {
		return nil, kernel.BadAuthRequest("任务参数不再符合前台模型能力：" + strings.Join(match.Reasons, "；"))
	}
	routes, err := store.LogicalModelRoutes(revision.ID, false)
	if err != nil {
		return nil, err
	}
	channelModelIDs := make([]string, 0, len(routes))
	for _, route := range routes {
		channelModelIDs = append(channelModelIDs, route.ChannelModelID)
	}
	channelModels, err := store.ChannelModelsByIDs(channelModelIDs)
	if err != nil {
		return nil, err
	}
	channelIDs := make([]string, 0, len(channelModels))
	for _, channelModel := range channelModels {
		channelIDs = append(channelIDs, channelModel.ChannelID)
	}
	systemChannels, err := store.SystemChannelsByIDs(channelIDs, false)
	if err != nil {
		return nil, err
	}
	enabledSystemChannels := make(map[string]bool, len(systemChannels))
	for _, channel := range systemChannels {
		enabledSystemChannels[channel.ID] = true
	}
	channelModelByID := make(map[string]model.ChannelModel, len(channelModels))
	for _, channelModel := range channelModels {
		if channelModel.Enabled && enabledSystemChannels[channelModel.ChannelID] {
			channelModelByID[channelModel.ID] = channelModel
		}
	}
	candidates := make([]CachedLogicalRoute, 0, len(routes))
	for _, route := range routes {
		channelModel, channelOK := channelModelByID[route.ChannelModelID]
		if !channelOK {
			continue
		}
		capabilitySpec, specErr := channelModelCapabilitySpec(channelModel)
		if specErr != nil {
			continue
		}
		candidates = append(candidates, CachedLogicalRoute{Route: route, CapabilitySpec: capabilitySpec, ChannelModel: channelModel})
	}
	tried := make(map[string]bool, len(attempts))
	for _, attempt := range attempts {
		tried[attempt.RouteID] = true
	}
	eligible := r.EligibleLogicalRoutes(candidates, intent, tried)
	if len(eligible) == 0 {
		return nil, kernel.BadAuthRequest("当前模型暂时无法满足这组输入和参数")
	}
	selected := WeightedRoute(eligible)
	variant := channelModelVariantForIntent(selected.ChannelModel, intent)
	routed := &RoutedModel{LogicalModel: *logicalModel, Revision: *revision, Route: selected.Route, ChannelModel: selected.ChannelModel, Variant: variant, Defaults: defaults}
	nextInput := ApplyRoutedProviderSelection(input, routed)
	if codec.ValidateCapability != nil {
		if err := codec.ValidateCapability(nextInput); err != nil {
			return nil, err
		}
	}
	if codec.ProtectSecrets != nil {
		if err := codec.ProtectSecrets(nextInput); err != nil {
			return nil, err
		}
	}
	encoded, err := json.Marshal(nextInput)
	if err != nil {
		return nil, err
	}
	previousRouteID := task.RouteID
	if err := store.SwitchTaskLogicalRoute(task.ID, previousRouteID, selected.Route.ID, string(encoded), selected.ChannelModel.ID); err != nil {
		return nil, err
	}
	task.RouteID = selected.Route.ID
	task.ChannelModelID = selected.ChannelModel.ID
	task.InputJSON = string(encoded)
	task.ProviderRequestID = ""
	return r.CreateRouteAttempt(store, task, routed, len(attempts)+1)
}

func (r *Router) PrepareLogicalTaskRetry(store RouteStore, codec TaskInputCodec, task *model.Task, input map[string]any) error {
	if task == nil || task.LogicalModelID == "" {
		return nil
	}
	intent := ModelRequestIntentFromTaskInput(input, task.Type, task.Operation)
	logicalModel, err := store.LogicalModel(task.LogicalModelID)
	if err != nil {
		return err
	}
	var routed *RoutedModel
	if logicalModel.ArchivedAt != nil {
		routed, err = r.ResolveArchivedTaskRoute(store, task, intent)
	} else {
		routed, err = r.ResolveLogicalModel(task.LogicalModelID, intent)
	}
	if err != nil {
		return err
	}
	input = ApplyRoutedProviderSelection(input, routed)
	if codec.ValidateCapability != nil {
		if err := codec.ValidateCapability(input); err != nil {
			return err
		}
	}
	if codec.ProtectSecrets != nil {
		if err := codec.ProtectSecrets(input); err != nil {
			return err
		}
	}
	encoded, err := json.Marshal(input)
	if err != nil {
		return err
	}
	task.LogicalModelRevisionID = routed.Revision.ID
	task.RouteID = routed.Route.ID
	task.ChannelModelID = routed.ChannelModel.ID
	task.Model = routed.LogicalModel.Code
	task.Provider = "managed"
	task.InputJSON = string(encoded)
	return nil
}

func (r *Router) ResolveArchivedTaskRoute(store RouteStore, task *model.Task, intent ModelRequestIntent) (*RoutedModel, error) {
	if task == nil || task.LogicalModelID == "" || task.LogicalModelRevisionID == "" || task.RouteID == "" || task.ChannelModelID == "" {
		return nil, kernel.BadAuthRequest("历史任务缺少完整的模型服务快照，无法重试")
	}
	logicalModel, err := store.LogicalModel(task.LogicalModelID)
	if err != nil {
		return nil, err
	}
	if logicalModel.ArchivedAt == nil {
		return nil, kernel.BadAuthRequest("任务模型已恢复为可用模型，请重新选择后重试")
	}
	revision, err := store.LogicalModelRevision(task.LogicalModelRevisionID)
	if err != nil || revision.LogicalModelID != logicalModel.ID {
		return nil, kernel.BadAuthRequest("历史任务前台模型版本不存在或归属不一致")
	}
	route, err := store.LogicalModelRoute(task.RouteID)
	if err != nil || route.LogicalModelRevisionID != revision.ID || route.ChannelModelID != task.ChannelModelID || !route.Enabled || route.Weight <= 0 {
		return nil, kernel.BadAuthRequest("历史任务原模型供应线路已失效，无法重试")
	}
	channelModel, err := store.ChannelModel(task.ChannelModelID)
	if err != nil || !channelModel.Enabled {
		return nil, kernel.BadAuthRequest("历史任务原模型服务已失效，无法重试")
	}
	if _, err := store.SystemChannel(channelModel.ChannelID); err != nil {
		return nil, kernel.BadAuthRequest("历史任务原模型渠道已失效，无法重试")
	}
	productSpec, err := DecodeCapabilitySpec(revision.CapabilitySpecJSON)
	if err != nil {
		return nil, err
	}
	defaults, err := DecodeLogicalDefaults(revision.DefaultOptionsJSON, productSpec)
	if err != nil {
		return nil, err
	}
	intent.Options = mergeIntentDefaults(intent.Options, defaults)
	if match := MatchCapability(productSpec, intent); !match.Matched {
		return nil, kernel.BadAuthRequest("历史任务不再符合前台模型能力：" + strings.Join(match.Reasons, "；"))
	}
	capabilitySpec, err := channelModelCapabilitySpec(*channelModel)
	if err != nil || r.LogicalRouteBlocked(CachedLogicalRoute{Route: *route, CapabilitySpec: capabilitySpec, ChannelModel: *channelModel}) {
		return nil, kernel.BadAuthRequest("历史任务原模型供应线路暂不可用，无法重试")
	}
	return &RoutedModel{LogicalModel: *logicalModel, Revision: *revision, Route: *route, ChannelModel: *channelModel, Defaults: defaults}, nil
}

func FinishRouteAttempt(store RouteStore, attempt *model.RouteAttempt, task *model.Task, taskErr error, failureMessage string, info FailureInfo, image ImageSubmissionView, now func() time.Time) {
	if attempt == nil {
		return
	}
	completed := now()
	attempt.CompletedAt = &completed
	if task != nil {
		attempt.ProviderRequestID = task.ProviderRequestID
	}
	if taskErr == nil {
		attempt.Status = "succeeded"
		attempt.DispatchState = "accepted"
	} else {
		attempt.Status = "failed"
		attempt.FailureMessage = kernel.TruncateRunes(failureMessage, 1000)
		attempt.FailureCode = RouteFailureCode(info)
		if task != nil && task.Type == "canvas_image" && info.ImageThrottle {
			attempt.FailureCode = "image_throttled"
		}
		if attempt.ProviderRequestID != "" || info.TerminalProviderFailure {
			attempt.DispatchState = "accepted"
		} else if SafeRouteRejection(info) {
			attempt.DispatchState = "rejected_no_job"
		} else {
			attempt.DispatchState = "submission_unknown"
		}
		if task != nil && task.Type == "canvas_image" {
			if image.Err == nil && image.Found && image.Accepted {
				attempt.DispatchState = "accepted"
			} else if image.Err != nil {
				attempt.DispatchState = "submission_unknown"
			}
		}
	}
	if err := store.SaveRouteAttempt(attempt); err != nil {
		log.Printf("route attempt terminal state save failed attempt_id=%s task_id=%s: %v", attempt.ID, attempt.TaskID, err)
	}
}

func IsDispatchUncertain(err error) bool {
	var target DispatchUncertainError
	return errors.As(err, &target)
}
