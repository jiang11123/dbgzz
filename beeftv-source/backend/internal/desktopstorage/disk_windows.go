package desktopstorage

import "golang.org/x/sys/windows"

func freeBytes(path string) (uint64, error) {
	ptr, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return 0, err
	}
	var available, total, free uint64
	err = windows.GetDiskFreeSpaceEx(ptr, &available, &total, &free)
	return available, err
}
