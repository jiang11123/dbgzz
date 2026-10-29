package diagnostics

import (
	"errors"
	"os"
	"path/filepath"
	"strings"

	"infinite-canvas/backend/internal/model"
)

func (s *Service) collectResourceEvidence(userID string, tasks []model.Task, c *collection) {
	store, ok := s.store.(diagnosticResourceStore)
	if !ok {
		c.unavailable("resources", "collector_not_supported")
		return
	}
	taskIDs := make([]string, 0, len(tasks))
	for _, task := range tasks {
		taskIDs = append(taskIDs, task.ID)
	}
	representations, versions, resources, err := store.DiagnosticResources(userID, taskIDs)
	c.setCoverage("resources", len(representations), 1000, err)
	coverage := c.Collectors["resources"]
	coverage.Scope = "materialized_outputs_current_state"
	c.Collectors["resources"] = coverage
	if err != nil {
		return
	}
	if len(representations) > 1000 {
		representations = representations[:1000]
	}
	byID := map[string]model.Resource{}
	assetIDs := map[string]string{}
	for _, version := range versions {
		assetIDs[version.ID] = sanitizeIdentifier(version.AssetID)
	}
	for _, resource := range resources {
		byID[resource.ID] = resource
	}
	// os.Root confines Stat even when an intermediate directory is a symlink.
	// It neither reads media bytes nor creates the resource directory.
	var root *os.Root
	if strings.TrimSpace(s.dataDir) != "" {
		root, _ = os.OpenRoot(filepath.Join(s.dataDir, "resources"))
	}
	if root != nil {
		defer root.Close()
	}
	for _, representation := range representations {
		record := resourceEvidence{ID: sanitizeIdentifier(representation.ID), ResourceID: sanitizeIdentifier(representation.ResourceID), TaskID: sanitizeIdentifier(representation.TaskID), AssetID: assetIDs[representation.AssetVersionID], AssetVersionID: sanitizeIdentifier(representation.AssetVersionID), SampledAt: s.now().UTC(), Storage: "unknown", FileStatus: "unavailable"}
		resource, exists := byID[representation.ResourceID]
		if !exists {
			record.FileStatus = "metadata_missing"
			c.Resources = append(c.Resources, record)
			continue
		}
		record.Kind, record.Status, record.PlaybackStatus, record.RecordedSize = sanitizeIdentifier(resource.Kind), sanitizeIdentifier(string(resource.Status)), sanitizeIdentifier(resource.PlaybackStatus), max(resource.Size, 0)
		if resource.Provider != "local" {
			record.Storage, record.FileStatus = "remote", "not_checked"
		} else {
			record.Storage = "local"
			key := filepath.FromSlash(resource.ObjectKey)
			if !filepath.IsLocal(key) {
				record.FileStatus = "invalid_key"
			} else if root != nil {
				info, statErr := root.Stat(key)
				switch {
				case errors.Is(statErr, os.ErrNotExist):
					record.FileStatus = "missing"
				case statErr != nil:
					record.FileStatus = "unreadable"
				case !info.Mode().IsRegular():
					record.FileStatus = "not_regular"
				default:
					size := info.Size()
					record.FileSize = &size
					record.FileStatus = "present"
				}
			}
		}
		if record.FileStatus == "unavailable" || record.FileStatus == "unreadable" {
			coverage := c.Collectors["resources"]
			coverage.Status, coverage.Reason = "partial", "file_inspection_unavailable"
			c.Collectors["resources"] = coverage
		}
		c.Resources = append(c.Resources, record)
	}
}
