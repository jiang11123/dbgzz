package runtimeinfo

import (
	"infinite-canvas/backend/internal/desktopstorage"
	"os"
	"strings"
)

func lockWorkspaceFile(dataDir string) (*os.File, error) {
	path, err := Path(dataDir)
	if err != nil {
		return nil, err
	}
	return desktopstorage.LockFile(strings.TrimSuffix(path, ".json") + ".lock")
}
