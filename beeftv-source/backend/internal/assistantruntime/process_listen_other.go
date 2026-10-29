//go:build !unix

package assistantruntime

import "os"

const inheritedListenFD = ""

func extraListenFiles(*os.File) []*os.File { return nil }
