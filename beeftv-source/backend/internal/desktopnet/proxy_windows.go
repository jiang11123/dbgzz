package desktopnet

import (
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	getUserProxy    = windows.NewLazySystemDLL("winhttp.dll").NewProc("WinHttpGetIEProxyConfigForCurrentUser")
	freeProxyString = windows.NewLazySystemDLL("kernel32.dll").NewProc("GlobalFree")
)

func readSystemProxy() systemProxySettings {
	var config struct {
		AutoDetect    int32
		AutoConfigURL *uint16
		Proxy         *uint16
		Bypass        *uint16
	}
	ok, _, _ := getUserProxy.Call(uintptr(unsafe.Pointer(&config)))
	if ok == 0 {
		return systemProxySettings{}
	}
	defer func() {
		for _, pointer := range []*uint16{config.AutoConfigURL, config.Proxy, config.Bypass} {
			if pointer != nil {
				_, _, _ = freeProxyString.Call(uintptr(unsafe.Pointer(pointer)))
			}
		}
	}()
	// PAC/WPAD are not static proxy endpoints; never treat a script URL as one.
	settings := parseWindowsProxy(windows.UTF16PtrToString(config.Proxy), windows.UTF16PtrToString(config.Bypass))
	settings.autoConfig = config.AutoDetect != 0 || windows.UTF16PtrToString(config.AutoConfigURL) != ""
	return settings
}
