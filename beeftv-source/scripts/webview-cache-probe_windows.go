//go:build windows

// CI-only WebView2 host. It opens the production profile and origin while BeefTV
// is stopped; the unmodified production executable is tested separately.
package main

import (
	"fmt"
	"os"
	"runtime"
	"syscall"
	"unsafe"

	"github.com/wailsapp/go-webview2/pkg/edge"
	"golang.org/x/sys/windows"
)

func main() {
	if os.Getenv("GITHUB_ACTIONS") != "true" || len(os.Args) != 3 {
		panic("cache probe requires a disposable CI runner, profile and debug port")
	}
	runtime.LockOSThread()
	user32 := windows.NewLazySystemDLL("user32.dll")
	call := func(name string, args ...uintptr) uintptr {
		result, _, _ := user32.NewProc(name).Call(args...)
		return result
	}
	class, _ := windows.UTF16PtrFromString("STATIC")
	title, _ := windows.UTF16PtrFromString("BeefTV cache probe")
	hwnd := call("CreateWindowExW", 0, uintptr(unsafe.Pointer(class)), uintptr(unsafe.Pointer(title)),
		0x10cf0000, 0, 0, 640, 480, 0, 0, 0, 0)
	if hwnd == 0 {
		panic("cannot create probe window")
	}
	var previous uintptr
	var view *edge.Chromium
	callback := windows.NewCallback(func(window uintptr, message uint32, wparam, lparam uintptr) uintptr {
		if message == 0x10 && view != nil { // WM_CLOSE
			view.ShuttingDown()
			// ICoreWebView2Controller::Close is COM slot 24 (after IUnknown and
			// NotifyParentWindowPositionChanged). The edge wrapper omits Close;
			// call the documented ABI without importing the broken webview2 package.
			controller := view.GetController()
			vtable := *(**[26]uintptr)(unsafe.Pointer(controller))
			if result, _, _ := syscall.SyscallN(vtable[24], uintptr(unsafe.Pointer(controller))); result != 0 {
				panic(fmt.Sprintf("WebView Close failed: %x", result))
			}
			controller.Release()
		}
		if message == 2 { // WM_DESTROY
			call("PostQuitMessage", 0)
		}
		return call("CallWindowProcW", previous, window, uintptr(message), wparam, lparam)
	})
	previous = call("SetWindowLongPtrW", hwnd, ^uintptr(3), callback) // GWLP_WNDPROC
	if previous == 0 {
		panic("cannot subclass probe window")
	}
	view = edge.NewChromium()
	view.DataPath = os.Args[1]
	view.AdditionalBrowserArgs = []string{"--disable-features=msSmartScreenProtection", "--remote-debugging-port=" + os.Args[2]}
	if !view.Embed(hwnd) {
		panic("cannot embed probe WebView")
	}
	view.Resize()
	view.WebResourceRequestedCallback = func(_ *edge.ICoreWebView2WebResourceRequest, args *edge.ICoreWebView2WebResourceRequestedEventArgs) {
		response, err := view.Environment().CreateWebResourceResponse([]byte("<!doctype html><title>BeefTV cache probe</title>"), 200, "OK", "Content-Type: text/html\r\n")
		if err != nil {
			panic(err)
		}
		defer response.Release()
		if err := args.PutResponse(response); err != nil {
			panic(err)
		}
	}
	view.AddWebResourceRequestedFilter("http://wails.localhost/*", edge.COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL)
	view.Navigate("http://wails.localhost/")
	var message struct {
		Window         uintptr
		Message        uint32
		WParam, LParam uintptr
		Time           uint32
		Point          struct{ X, Y int32 }
		Private        uint32
	}
	for {
		result := call("GetMessageW", uintptr(unsafe.Pointer(&message)), 0, 0, 0)
		if result == 0 {
			break
		}
		if result == ^uintptr(0) {
			panic("probe message loop failed")
		}
		call("TranslateMessage", uintptr(unsafe.Pointer(&message)))
		call("DispatchMessageW", uintptr(unsafe.Pointer(&message)))
	}
	view.ShuttingDown()
	fmt.Println("WebView cache probe closed")
}
