package app

import (
	"infinite-canvas/backend/internal/plugins"
)

const (
	WorkflowPluginRunningHub = plugins.WorkflowRunningHub
)

func workflowPluginIDForInterface(value string) (string, bool) {
	return plugins.WorkflowIDForInterface(value)
}

func (s *Service) WorkflowPluginStatuses() map[string]string {
	return s.pluginDomain().WorkflowStatuses()
}

func (s *Service) WorkflowPluginStatusesForUser(userID string) (map[string]string, error) {
	return s.pluginDomain().WorkflowStatusesForUser(userID)
}

func (s *Service) RequireWorkflowPluginForInterface(interfaceType string) error {
	return mapPluginAccessError(s.pluginDomain().RequireWorkflowForInterface(interfaceType))
}

func (s *Service) RequireWorkflowPluginForUser(userID string, interfaceType string) error {
	return mapPluginAccessError(s.pluginDomain().RequireWorkflowForUser(userID, interfaceType))
}
