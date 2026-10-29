package runtimeinfo

import "syscall"

func ProcessAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	// Signal(0) is unsupported on Windows. A terminated process can still have
	// an open handle, so FindProcess alone is not evidence that it is alive.
	handle, err := syscall.OpenProcess(syscall.SYNCHRONIZE, false, uint32(pid))
	if err != nil {
		return false
	}
	defer syscall.CloseHandle(handle)
	status, err := syscall.WaitForSingleObject(handle, 0)
	return err == nil && status == syscall.WAIT_TIMEOUT
}
