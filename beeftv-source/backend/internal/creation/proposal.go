package creation

import (
	"encoding/json"
	"strings"
	"time"

	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

func (s *Service) approveProposal(userID string, run *model.CreationRun, repo *repository.Repository, cmd Command, now time.Time) (replayed bool, err error) {
	if cmd.Revision != run.Revision || cmd.ProposalVersion <= 0 {
		return false, repository.ErrCreationConflict
	}
	if err := ValidateOps(cmd.Ops); err != nil {
		return false, err
	}
	if err := ValidateJSON(cmd.Proposal); err != nil {
		return false, err
	}
	for _, op := range cmd.Ops {
		if key := stringValue(op.Metadata["storageKey"]); key != "" {
			if !strings.HasPrefix(key, "resource:") {
				return false, kernel.BadAuthRequest("已有素材必须来自当前账号资源库")
			}
			resource, err := repo.ResourceForUser(userID, strings.TrimPrefix(key, "resource:"))
			if err != nil {
				return false, err
			}
			if resource.Status != model.ResourceStatusReady {
				return false, kernel.BadAuthRequest("已有素材尚未就绪")
			}
		}
	}
	hash := Hash([]any{cmd.Proposal, cmd.Ops})
	if cmd.ProposalVersion <= run.ApprovedProposalVersion {
		if cmd.ProposalVersion == run.ApprovedProposalVersion && hash == run.ApprovedProposalHash {
			return true, nil
		}
		return false, repository.ErrCreationConflict
	}
	if err := repo.RevokeCreationSubmissions(run.ID); err != nil {
		return false, err
	}
	raw, _ := json.Marshal(cmd.Ops)
	run.ApprovedOperationsJSON = string(raw)
	run.ApprovedProposalVersion = cmd.ProposalVersion
	run.ApprovedProposalHash = hash
	run.ApprovedAt = &now
	run.ApprovedCanvasJSON = ""
	if run.CanvasID != "" {
		canvas, err := repo.CanvasProjectForUser(userID, run.CanvasID)
		if err != nil {
			return false, err
		}
		baseline, err := ApprovalBaseline(canvas.PayloadJSON, cmd.Ops)
		if err != nil {
			return false, err
		}
		run.ApprovedCanvasJSON = baseline
	}
	return false, nil
}

func (s *Service) invalidateProposal(run *model.CreationRun, repo *repository.Repository, cmd Command) error {
	if cmd.Revision != run.Revision {
		return repository.ErrCreationConflict
	}
	if err := repo.RevokeCreationSubmissions(run.ID); err != nil {
		return err
	}
	run.ApprovedAt = nil
	run.ApprovedProposalHash = ""
	run.ApprovedOperationsJSON = ""
	run.ApprovedCanvasJSON = ""
	return nil
}
