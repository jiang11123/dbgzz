package creation

import (
	"encoding/json"
	"errors"
	"strings"

	"gorm.io/gorm"
	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

// Service owns CreationRun lifetime, the execution fence, and submission
// receipts. Persistence is the existing SQLite ledger.
type Service struct {
	repo *repository.Repository
	deps Dependencies
}

func New(repo *repository.Repository, deps Dependencies) *Service {
	return &Service{repo: repo, deps: deps}
}

func (s *Service) CreateRun(userID string, cmd Command) (*Detail, error) {
	if strings.TrimSpace(userID) == "" || strings.TrimSpace(cmd.ClientKey) == "" || len(cmd.ClientKey) > 120 {
		return nil, kernel.BadAuthRequest(msgMissingClientKey)
	}
	if err := ValidateJSON(cmd.State); err != nil {
		return nil, err
	}
	if cmd.CanvasID != "" {
		if _, err := s.repo.CanvasProjectForUser(userID, cmd.CanvasID); err != nil {
			return nil, MapError(err)
		}
	}
	state, _ := json.Marshal(cmd.State)
	run := model.CreationRun{
		ID: s.deps.newID(), UserID: userID, ClientKey: cmd.ClientKey,
		CreateHash: Hash([]any{cmd.CanvasID, cmd.State}), CanvasID: cmd.CanvasID,
		Revision: 1, Status: "idle", StateJSON: string(state),
	}
	if old, err := s.repo.CreationRunByClientKey(userID, cmd.ClientKey); err == nil {
		if old.CreateHash != run.CreateHash {
			return nil, Conflict(msgClientKeyConflict)
		}
		return s.Get(userID, old.ID)
	} else if !errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, err
	}
	if err := s.validateRunQuota(userID, s.repo, true, int64(len(state))); err != nil {
		return nil, err
	}
	if err := s.repo.CreateCreationRun(&run); err != nil {
		return nil, MapError(err)
	}
	return s.Get(userID, run.ID)
}

func (s *Service) Get(userID, id string) (*Detail, error) {
	run, err := s.repo.CreationRun(userID, id)
	if err != nil {
		return nil, MapError(err)
	}
	items, err := s.repo.CreationSubmissions(userID, id)
	if err != nil {
		return nil, err
	}
	out := &Detail{Run: RunView(*run), Submissions: []SubmissionOutput{}}
	for _, item := range items {
		out.Submissions = append(out.Submissions, SubmissionView(item))
	}
	return out, nil
}

func (s *Service) List(userID string) (map[string]any, error) {
	items, err := s.repo.CreationRuns(userID)
	out := []RunOutput{}
	for _, run := range items {
		out = append(out, RunView(run))
	}
	return map[string]any{"runs": out}, err
}

func (s *Service) Change(userID, id, action string, cmd Command) (any, error) {
	var out any
	err := s.repo.MutateCreationRun(userID, id, func(run *model.CreationRun, repo *repository.Repository) error {
		previousBytes := len(run.StateJSON) + len(run.ApprovedOperationsJSON) + len(run.ApprovedCanvasJSON)
		now := s.deps.now()
		if action == "claim" {
			if err := claimLease(run, cmd.Owner, cmd.ExpectedEpoch, now); err != nil {
				return err
			}
		} else {
			if err := validateGuard(run, cmd.Guard, now); err != nil {
				return err
			}
			switch action {
			case "heartbeat":
				until := now.Add(leaseTTL)
				run.LeaseExpiresAt = &until
				out = map[string]any{"leaseExpiresAt": until}
				return nil
			case "release":
				run.LeaseExpiresAt = nil
				out = map[string]any{"released": true}
				return nil
			case "save":
				if cmd.Revision != run.Revision {
					return repository.ErrCreationConflict
				}
				if err := ValidateJSON(cmd.State); err != nil {
					return err
				}
				if !validRunStatus(cmd.Status) {
					return kernel.BadAuthRequest("创作状态无效")
				}
				if run.Status == "cancelled" && cmd.Status != "cancelled" {
					return Conflict("已取消会话不能继续执行")
				}
				state, _ := json.Marshal(cmd.State)
				run.StateJSON = string(state)
				run.Status = cmd.Status
			case "proposal-approve":
				replayed, err := s.approveProposal(userID, run, repo, cmd, now)
				if err != nil {
					return err
				}
				if replayed {
					out = RunView(*run)
					return nil
				}
			case "proposal-invalidate":
				if err := s.invalidateProposal(run, repo, cmd); err != nil {
					return err
				}
			default:
				return kernel.BadAuthRequest(msgUnknownAction)
			}
		}
		run.Revision++
		if action == "save" || action == "proposal-approve" {
			delta := int64(len(run.StateJSON) + len(run.ApprovedOperationsJSON) + len(run.ApprovedCanvasJSON) - previousBytes)
			if err := s.validateRunQuota(userID, repo, false, delta); err != nil {
				return err
			}
		}
		out = RunView(*run)
		return nil
	})
	return out, MapError(err)
}

func (s *Service) validateRunQuota(userID string, repo *repository.Repository, creating bool, delta int64) error {
	if s.deps.Quota == nil {
		return kernel.NewAppError(kernel.CodeInternal, "创作配额服务不可用")
	}
	return s.deps.Quota.ValidateRun(userID, repo, creating, delta)
}
