package desktopstorage

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"time"
)

// Only this owned scratch directory is disposable. Other cache files and .tmp
// files may be durable data and must still be copied and verified.
func skipScratch(root, path string, entry fs.DirEntry) bool {
	return entry.IsDir() && path == filepath.Join(root, "cache", "tmp")
}

func openMigrationFile(path string) (*os.File, error) {
	for attempt := 0; ; attempt++ {
		file, err := os.Open(path)
		if fileInUse(err) && attempt == 2 {
			return nil, fmt.Errorf("文件仍在使用中，请关闭其他 BeefTV 窗口后重试: %w", err)
		}
		if err == nil || !fileInUse(err) || attempt == 2 {
			return file, err
		}
		time.Sleep(time.Duration(attempt+1) * 100 * time.Millisecond)
	}
}
