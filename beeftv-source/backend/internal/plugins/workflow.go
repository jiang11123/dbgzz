package plugins

import (
	"strings"

	"infinite-canvas/backend/internal/protocol"
)

func BundledWorkflowManifests() []protocol.Manifest {
	return []protocol.Manifest{
		workflowPluginManifest(WorkflowRunningHub, "RunningHub 工作流", "在画布中拉取并执行 RunningHub Workflow 与 App。"),
	}
}

func workflowPluginManifest(id, name, description string) protocol.Manifest {
	capabilities := []protocol.Capability{protocol.CapabilityImage, protocol.CapabilityVideo, protocol.CapabilityAudio}
	workflows := make([]protocol.ManifestWorkflow, 0, len(capabilities))
	for _, capability := range capabilities {
		workflows = append(workflows, protocol.ManifestWorkflow{
			ID:         id + "-" + string(capability),
			Label:      name + " · " + string(capability),
			ProviderID: id,
			Capability: capability,
			Parameters: []protocol.Parameter{},
		})
	}
	return protocol.Manifest{
		APIVersion: "beeftv.plugin/v1",
		Metadata: protocol.Metadata{
			ID:            id,
			Version:       "1.0.0",
			Name:          name,
			Vendor:        "内置工作流",
			Description:   description,
			Documentation: "# " + name + "\n\n## 宿主运行时合同\n\n该工作流能力由插件运行时统一管理。",
			Enabled:       false,
			Installable:   true,
		},
		Surfaces:    []string{"node", "settings"},
		Runtime:     protocol.ManifestRuntime{Backend: "trusted-backend", Web: "trusted-backend"},
		Permissions: []string{"generation.run", "external.open"},
		Contributes: protocol.ManifestContributions{Workflows: workflows},
	}
}

func WorkflowIDForInterface(value string) (string, bool) {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "runninghub-workflow-image", "runninghub-workflow-video", "runninghub-workflow-audio":
		return WorkflowRunningHub, true
	default:
		return "", false
	}
}
