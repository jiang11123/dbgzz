package creation

import (
	"encoding/json"

	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

func (s *Service) Prepare(userID, id string, cmd Command) (*SubmissionOutput, error) {
	if cmd.ItemKey == "" || len(cmd.ItemKey) > 160 {
		return nil, kernel.BadAuthRequest("缺少稳定执行项键")
	}
	run, err := s.repo.CreationRun(userID, id)
	if err != nil {
		return nil, MapError(err)
	}
	now := s.deps.now()
	if err = validateGuard(run, cmd.Guard, now); err != nil {
		return nil, err
	}
	if err = ValidateSubmissionScope(run, cmd.ProposalVersion, cmd.Task); err != nil {
		return nil, err
	}
	item, original, err := s.buildSubmission(userID, s.repo, run, cmd.ItemKey, cmd.ProposalVersion, cmd.Task)
	if err != nil {
		return nil, err
	}
	err = s.repo.MutateCreationRun(userID, id, func(current *model.CreationRun, repo *repository.Repository) error {
		if e := validateGuard(current, cmd.Guard, s.deps.now()); e != nil {
			return e
		}
		if e := ValidateSubmissionScope(current, cmd.ProposalVersion, original); e != nil {
			return e
		}
		items, e := repo.CreationSubmissions(userID, id)
		if e != nil {
			return e
		}
		for _, old := range items {
			if old.ItemKey == cmd.ItemKey {
				if old.RequestHash != item.RequestHash || old.ProposalVersion != item.ProposalVersion {
					return repository.ErrCreationConflict
				}
				item = old
				return nil
			}
		}
		if e = s.validateRunQuota(userID, repo, false, int64(len(item.RequestJSON)+len(item.ExecutionJSON)+len(item.ConfigSignature))); e != nil {
			return e
		}
		return repo.SaveCreationSubmission(&item)
	})
	if err != nil {
		return nil, MapError(err)
	}
	out := SubmissionView(item)
	return &out, nil
}

func (s *Service) buildSubmission(userID string, repo *repository.Repository, run *model.CreationRun, itemKey string, proposalVersion int64, request TaskRequest) (model.CreationSubmission, TaskRequest, error) {
	normalized, err := cloneJSON(request)
	if err != nil {
		return model.CreationSubmission{}, TaskRequest{}, err
	}
	prepared, err := s.quoteTask(userID, repo, &normalized)
	if err != nil {
		return model.CreationSubmission{}, normalized, err
	}
	signature, err := repo.CreationConfigSignature(prepared.Task, stringValue(prepared.Config["channelId"]), stringValue(prepared.Config["model"]))
	if err != nil {
		return model.CreationSubmission{}, normalized, err
	}
	execution := executionFor(prepared.Task, signature)
	executionRaw, err := executionJSON(execution)
	if err != nil {
		return model.CreationSubmission{}, normalized, err
	}
	requestJSON, err := json.Marshal(normalized)
	if err != nil {
		return model.CreationSubmission{}, normalized, err
	}
	item := model.CreationSubmission{
		ID: s.deps.newID(), UserID: userID, RunID: run.ID, ItemKey: itemKey,
		ProposalVersion: proposalVersion, ProposalHash: run.ApprovedProposalHash,
		RequestJSON: string(requestJSON), RequestHash: Hash(normalized),
		ExecutionJSON: executionRaw, ConfigSignature: signature,
	}
	return item, normalized, nil
}

func (s *Service) quoteTask(userID string, repo *repository.Repository, req *TaskRequest) (*PreparedTask, error) {
	if s.deps.Tasks == nil {
		return nil, kernel.NewAppError(kernel.CodeInternal, "任务准备端口不可用")
	}
	if err := s.constrainTask(userID, repo, req); err != nil {
		return nil, err
	}
	requested, _ := req.Input["config"].(map[string]any)
	quote := *req
	quote.PrepareOnly = true
	prepared, err := s.deps.Tasks.Prepare(userID, quote)
	if err != nil {
		return nil, err
	}
	if prepared == nil || prepared.Task == nil {
		return nil, kernel.NewAppError(kernel.CodeInternal, "任务准备未返回可执行描述")
	}
	if err = matchResolvedSpec(requested, prepared.Config); err != nil {
		return nil, err
	}
	channelID := stringValue(prepared.Config["channelId"])
	if _, err = repo.SystemChannel(channelID); err != nil {
		return nil, err
	}
	expectedMode := map[string]string{"text": "text", "canvas_text": "text", "canvas_image": "image", "canvas_video": "video"}[req.Type]
	if expectedMode == "text" {
		if err = assertTextReferenceCapacity(repo, prepared.Task, channelID, stringValue(prepared.Config["model"]), preparedImageCount(prepared.Task.InputJSON)); err != nil {
			return nil, err
		}
		if err = validatePreparedProtocol(prepared.Task.InputJSON); err != nil {
			return nil, err
		}
	}
	return prepared, nil
}

func (s *Service) Approve(userID, id string, cmd Command) (map[string]any, error) {
	if len(cmd.SubmissionIDs) == 0 || len(cmd.SubmissionIDs) > 20 {
		return nil, kernel.BadAuthRequest("请选择 1 到 20 项生成任务")
	}
	prepared := map[string]*model.Task{}
	signatures := map[string]string{}
	for _, sid := range cmd.SubmissionIDs {
		item, err := s.repo.CreationSubmission(userID, id, sid)
		if err != nil {
			return nil, MapError(err)
		}
		var request TaskRequest
		if err = json.Unmarshal([]byte(item.RequestJSON), &request); err != nil {
			return nil, err
		}
		quoted, err := s.quoteTask(userID, s.repo, &request)
		if err != nil {
			return nil, err
		}
		sig, err := s.repo.CreationConfigSignature(quoted.Task, stringValue(quoted.Config["channelId"]), stringValue(quoted.Config["model"]))
		if err != nil {
			return nil, err
		}
		if executionFor(quoted.Task, sig).ConfigHash != SubmissionView(*item).Execution.ConfigHash {
			return nil, Conflict("执行配置已变化，请重新准备并确认")
		}
		prepared[sid] = quoted.Task
		signatures[sid] = sig
	}
	out := []SubmissionOutput{}
	err := s.repo.MutateCreationRun(userID, id, func(run *model.CreationRun, repo *repository.Repository) error {
		if e := validateGuard(run, cmd.Guard, s.deps.now()); e != nil {
			return e
		}
		now := s.deps.now()
		for _, sid := range cmd.SubmissionIDs {
			item, e := repo.CreationSubmission(userID, id, sid)
			if e != nil {
				return e
			}
			if item.RevokedAt != nil {
				return Conflict("执行项已撤销")
			}
			var request TaskRequest
			if e = json.Unmarshal([]byte(item.RequestJSON), &request); e != nil {
				return e
			}
			if e = ValidateSubmissionScope(run, item.ProposalVersion, request); e != nil {
				return e
			}
			if item.ProposalVersion > 0 && item.ProposalHash != run.ApprovedProposalHash {
				return repository.ErrCreationConflict
			}
			if e = checkConfigSignature(repo, prepared[sid], signatures[sid]); e != nil {
				return e
			}
			if item.ApprovedAt == nil {
				item.ApprovedAt = &now
				if e = repo.SaveCreationSubmission(item); e != nil {
					return e
				}
			}
			out = append(out, SubmissionView(*item))
		}
		return nil
	})
	return map[string]any{"submissions": out}, MapError(err)
}

func (s *Service) Execute(userID, id string, cmd Command) (*model.Task, error) {
	run, err := s.repo.CreationRun(userID, id)
	if err != nil {
		return nil, MapError(err)
	}
	if err = validateGuard(run, cmd.Guard, s.deps.now()); err != nil {
		return nil, err
	}
	item, err := s.repo.CreationSubmission(userID, id, cmd.SubmissionID)
	if err != nil {
		return nil, MapError(err)
	}
	if item.TaskID != nil {
		task, e := s.repo.TaskForUser(userID, *item.TaskID)
		if e != nil {
			return nil, e
		}
		return task, nil
	}
	var request TaskRequest
	if err = json.Unmarshal([]byte(item.RequestJSON), &request); err != nil {
		return nil, err
	}
	if err = ValidateSubmissionScope(run, item.ProposalVersion, request); err != nil {
		return nil, err
	}
	quoted, err := s.quoteTask(userID, s.repo, &request)
	if err != nil {
		return nil, err
	}
	if quoted == nil || quoted.Task == nil {
		return nil, kernel.NewAppError(kernel.CodeInternal, msgAdmitNilTask)
	}
	signature, err := s.repo.CreationConfigSignature(quoted.Task, stringValue(quoted.Config["channelId"]), stringValue(quoted.Config["model"]))
	if err != nil {
		return nil, err
	}
	if executionFor(quoted.Task, signature).ConfigHash != SubmissionView(*item).Execution.ConfigHash {
		return nil, Conflict("执行配置已变化，请重新确认")
	}
	input := quoted.Input
	if input == nil {
		if e := json.Unmarshal([]byte(quoted.Task.InputJSON), &input); e != nil {
			return nil, e
		}
	}
	if s.deps.Secrets == nil {
		return nil, kernel.NewAppError(kernel.CodeInternal, "任务密钥保护不可用")
	}
	if err = s.deps.Secrets.Protect(input); err != nil {
		return nil, err
	}
	raw, err := json.Marshal(input)
	if err != nil {
		return nil, kernel.NewAppError(kernel.CodeInternal, msgProtectedInput)
	}
	quoted.Task.InputJSON = string(raw)
	quoted.Task.CreationSubmissionID = &item.ID
	if s.deps.Tasks == nil {
		return nil, kernel.NewAppError(kernel.CodeInternal, "任务准入端口不可用")
	}
	var admitted *model.Task
	err = s.repo.MutateCreationRun(userID, id, func(current *model.CreationRun, repo *repository.Repository) error {
		if e := validateGuard(current, cmd.Guard, s.deps.now()); e != nil {
			return e
		}
		fresh, e := repo.CreationSubmission(userID, id, item.ID)
		if e != nil {
			return e
		}
		if fresh.TaskID != nil {
			existing, e := repo.TaskForUser(userID, *fresh.TaskID)
			if e != nil {
				return e
			}
			admitted = existing
			return nil
		}
		if fresh.ApprovedAt == nil || fresh.RevokedAt != nil {
			return Conflict("任务尚未批准或执行项已撤销")
		}
		if e = ValidateSubmissionScope(current, fresh.ProposalVersion, request); e != nil {
			return e
		}
		if fresh.ProposalVersion > 0 && fresh.ProposalHash != current.ApprovedProposalHash {
			return repository.ErrCreationConflict
		}
		if e = checkConfigSignature(repo, quoted.Task, signature); e != nil {
			return e
		}
		task, e := s.deps.Tasks.Admit(userID, repo, quoted.Task)
		if e != nil {
			return e
		}
		if task == nil || task.ID == "" {
			return kernel.NewAppError(kernel.CodeInternal, msgAdmitNilTask)
		}
		admitted = task
		fresh.TaskID = &task.ID
		return repo.SaveCreationSubmission(fresh)
	})
	if err != nil {
		return nil, MapError(err)
	}
	return admitted, nil
}
