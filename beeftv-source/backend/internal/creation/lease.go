package creation

import (
	"time"

	"infinite-canvas/backend/internal/model"
)

const leaseTTL = 45 * time.Second

func validateGuard(run *model.CreationRun, guard Guard, now time.Time) error {
	if guard.Owner == "" || run.ExecutionOwner != guard.Owner || run.ExecutionEpoch != guard.ExecutionEpoch || run.LeaseExpiresAt == nil || !run.LeaseExpiresAt.After(now) {
		return Conflict(msgLeaseExpired)
	}
	return nil
}

func leaseHeldByOther(run *model.CreationRun, owner string, now time.Time) bool {
	if run.LeaseExpiresAt == nil || !run.LeaseExpiresAt.After(now) {
		return false
	}
	return run.ExecutionOwner != "" && run.ExecutionOwner != owner
}

func claimLease(run *model.CreationRun, owner string, expectedEpoch int64, now time.Time) error {
	if owner == "" || len(owner) > 120 || expectedEpoch != run.ExecutionEpoch {
		return Conflict(msgEpochChanged)
	}
	if leaseHeldByOther(run, owner, now) {
		return Conflict(msgLeaseHeld)
	}
	run.ExecutionEpoch++
	run.ExecutionOwner = owner
	until := now.Add(leaseTTL)
	run.LeaseExpiresAt = &until
	return nil
}

func validRunStatus(status string) bool {
	switch status {
	case "idle", "running", "waiting_answer", "waiting_proposal", "waiting_canvas", "waiting_execution", "waiting_task", "paused", "completed", "cancelled":
		return true
	default:
		return false
	}
}
