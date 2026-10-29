//go:build unix

package assistantruntime

import "os"

const inheritedListenFD = "3"

func extraListenFiles(file *os.File) []*os.File {
	if file == nil {
		return nil
	}
	return []*os.File{file}
}
