//go:build windows

package privatefile

import (
	"errors"
	"os"
	"strings"

	"golang.org/x/sys/windows"
)

func ownerOnlyDescriptor() (*windows.SECURITY_DESCRIPTOR, error) {
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return nil, err
	}
	sid := user.User.Sid.String()
	return windows.SecurityDescriptorFromString("O:" + sid + "D:P(A;;FA;;;" + sid + ")")
}

func Check(name string, _ os.FileInfo) error {
	wanted, err := ownerOnlyDescriptor()
	if err != nil {
		return errors.New("无法核对投稿状态文件的 Windows 权限")
	}
	actual, err := windows.GetNamedSecurityInfo(name, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		return errors.New("无法读取投稿状态文件的 Windows 权限")
	}
	owner, _, err := actual.Owner()
	wantedOwner, _, wantedErr := wanted.Owner()
	control, _, controlErr := actual.Control()
	// Windows may retain the informational auto-inherited control bit after
	// protecting a DACL. Compare its actual ACEs and owner, requiring protection.
	aces := func(sd *windows.SECURITY_DESCRIPTOR) string {
		_, tail, ok := strings.Cut(sd.String(), "D:")
		if !ok {
			return ""
		}
		i := strings.Index(tail, "(")
		if i < 0 {
			return ""
		}
		return tail[i:]
	}
	if err != nil || wantedErr != nil || controlErr != nil || owner == nil || owner.String() != wantedOwner.String() || control&windows.SE_DACL_PROTECTED == 0 || aces(wanted) == "" || aces(actual) != aces(wanted) {
		return errors.New("投稿状态文件必须仅允许当前 Windows 用户访问")
	}
	return nil
}

func Protect(file *os.File) error {
	descriptor, err := ownerOnlyDescriptor()
	if err != nil {
		return err
	}
	owner, _, err := descriptor.Owner()
	if err != nil {
		return err
	}
	dacl, _, err := descriptor.DACL()
	if err != nil {
		return err
	}
	if err = windows.SetNamedSecurityInfo(file.Name(), windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, owner, nil, dacl, nil); err != nil {
		return err
	}
	return Check(file.Name(), nil)
}
