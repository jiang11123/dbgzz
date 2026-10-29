package app

import (
	"encoding/json"

	"infinite-canvas/backend/internal/creation"
	"infinite-canvas/backend/internal/model"
)

type CreationGuard = creation.Guard
type CreationCanvasOp = creation.CanvasOp
type CreationRunOutput = creation.RunOutput
type CreationExecution = creation.Execution
type CreationSubmissionOutput = creation.SubmissionOutput
type CreationDetail = creation.Detail

// CreationRequest keeps the current handler JSON payload, including the
// app-owned CreateTaskRequest until the lead switches transports.
type CreationRequest struct {
	CreationGuard
	ClientKey            string             `json:"clientKey"`
	CanvasID             string             `json:"canvasId"`
	Revision             int64              `json:"revision"`
	ExpectedEpoch        int64              `json:"expectedEpoch"`
	State                map[string]any     `json:"state"`
	Status               string             `json:"status"`
	ProposalVersion      int64              `json:"proposalVersion"`
	Proposal             json.RawMessage    `json:"proposal"`
	Ops                  []CreationCanvasOp `json:"ops"`
	ItemKey              string             `json:"itemKey"`
	Request              CreateTaskRequest  `json:"request"`
	SubmissionIDs        []string           `json:"submissionIds"`
	SubmissionID         string             `json:"submissionId"`
	ExpectedSnapshotHash string             `json:"expectedSnapshotHash"`
	Document             json.RawMessage    `json:"document"`
}

func creationConflict(message string) error {
	return creation.Conflict(message)
}

func creationError(err error) error {
	return creation.MapError(err)
}

func creationHash(value any) string {
	return creation.Hash(value)
}

func (s *Service) CreateCreationRun(userID string, req CreationRequest) (*CreationDetail, error) {
	s.storageMu.Lock()
	defer s.storageMu.Unlock()
	return s.creationDomain().CreateRun(userID, toCreationCommand(req))
}

func (s *Service) GetCreationRun(userID, id string) (*CreationDetail, error) {
	return s.creationDomain().Get(userID, id)
}

func (s *Service) ListCreationRuns(userID string) (map[string]any, error) {
	return s.creationDomain().List(userID)
}

func (s *Service) ChangeCreationRun(userID, id, action string, req CreationRequest) (any, error) {
	if action == "save" || action == "proposal-approve" || action == "proposal-invalidate" {
		s.storageMu.Lock()
		defer s.storageMu.Unlock()
	}
	return s.creationDomain().Change(userID, id, action, toCreationCommand(req))
}

func (s *Service) PrepareCreationSubmission(userID, id string, req CreationRequest) (*CreationSubmissionOutput, error) {
	s.storageMu.Lock()
	defer s.storageMu.Unlock()
	return s.creationDomain().Prepare(userID, id, toCreationCommand(req))
}

func (s *Service) ApproveCreationSubmissions(userID, id string, req CreationRequest) (map[string]any, error) {
	return s.creationDomain().Approve(userID, id, toCreationCommand(req))
}

func (s *Service) ExecuteCreationSubmission(userID, id string, req CreationRequest) (*model.Task, error) {
	s.storageMu.Lock()
	defer s.storageMu.Unlock()
	task, err := s.creationDomain().Execute(userID, id, toCreationCommand(req))
	if err != nil {
		return nil, err
	}
	if task == nil {
		return nil, err
	}
	return taskForOutput(*task), nil
}

func validateCreationSubmissionScope(run *model.CreationRun, version int64, req CreateTaskRequest) error {
	return creation.ValidateSubmissionScope(run, version, toCreationTaskRequest(req))
}
